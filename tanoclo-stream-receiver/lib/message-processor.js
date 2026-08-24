/**
 * @file lib/message-processor.js
 * @brief Dispatcher for CoAP requests, responses, TLV state mappers, and MQTT telemetry.
 */

'use strict';

const coapParser = require('./coap');
const tlvDecoder = require('./tlv');
const deviceRegistry = require('./device-registry');
const haDiscovery = require('./ha-discovery');
const mqttPublisher = require('./mqtt-publisher');

// Sliding window caches to match requests with ACKs and deduplicate transactions
const midToPathCache = new Map();
const tokenToPathCache = new Map();
const recentCoapCache = new Map();

function cacheRequestPath(mid, token, pathStr) {
    if (!pathStr || pathStr === 'Unknown') return;
    if (mid !== undefined && mid !== null) {
        midToPathCache.set(mid, pathStr);
        if (midToPathCache.size > 1000) {
            const firstKey = midToPathCache.keys().next().value;
            midToPathCache.delete(firstKey);
        }
    }
    if (token && token.length > 0) {
        const tokHex = token.toString('hex');
        tokenToPathCache.set(tokHex, pathStr);
        if (tokenToPathCache.size > 1000) {
            const firstKey = tokenToPathCache.keys().next().value;
            tokenToPathCache.delete(firstKey);
        }
    }
}

function resolvePath(coap, rawPathStr) {
    if (rawPathStr && rawPathStr !== 'Unknown') return rawPathStr;
    if (coap && coap.token && coap.token.length > 0) {
        const tokHex = coap.token.toString('hex');
        if (tokenToPathCache.has(tokHex)) return tokenToPathCache.get(tokHex);
    }
    if (coap && coap.mid !== undefined && midToPathCache.has(coap.mid)) {
        return midToPathCache.get(coap.mid);
    }
    return rawPathStr || 'Unknown';
}

/**
 * Extract serial number from URI path segments (e.g. /d/VA0000000001/sen)
 */
function extractSerialFromPath(pathStr) {
    if (!pathStr) return null;
    const parts = pathStr.split('/');
    const dIdx = parts.indexOf('d');
    if (dIdx >= 0 && dIdx + 1 < parts.length) {
        const candidate = parts[dIdx + 1].toUpperCase();
        if (/^(VA|RU|SU|IB|BP|BR|WR)[0-9A-Z]+$/.test(candidate)) {
            return candidate;
        }
    }
    return null;
}

/**
 * Main processor entry point for decoded CoAP datagrams.
 */
function processCoapPacket(packet, type, meta = {}) {
    const coap = packet.coap;
    const macInfo = packet.macInfo;
    const isRequest = coapParser.isRequest(coap.code);

    let pathStr = coap.options
        .filter(o => o.num === coapParser.OPT_URI_PATH)
        .map(o => o.value.toString('utf-8'))
        .join('/') || 'Unknown';

    if (isRequest && pathStr !== 'Unknown') {
        cacheRequestPath(coap.mid, coap.token, pathStr);
    } else {
        pathStr = resolvePath(coap, pathStr);
    }

    // Check transaction deduplication (15-second window)
    const midKey = `${macInfo.srcClean}:${coap.mid}`;
    const now = Date.now();
    if (recentCoapCache.has(midKey)) {
        const last = recentCoapCache.get(midKey);
        if (now - last < 15000) {
            return { isDuplicate: true, pathStr };
        }
    }
    recentCoapCache.set(midKey, now);

    // Housekeeping
    if (recentCoapCache.size > 300) {
        for (const [k, ts] of recentCoapCache.entries()) {
            if (now - ts > 30000) recentCoapCache.delete(k);
        }
    }

    // Determine device serial and identity
    let detectedSerial = extractSerialFromPath(pathStr);
    let detectedDeviceType = null;
    let detectedFwVersion = null;
    let detectedHwRev = null;

    const tlv = packet.tlv;
    const updates = {};

    if (meta.rssi !== undefined) updates.rssi = meta.rssi;
    updates.connection_state = true;

    // Process TLV fields if present
    if (tlv && tlv.fields) {
        const f = tlv.fields;

        // Device identity FIDs
        if (f['0x0188'] && typeof f['0x0188'] === 'string') {
            detectedSerial = f['0x0188'].trim().toUpperCase();
        }
        if (f['0x0180'] !== undefined) {
            detectedHwRev = Number(f['0x0180']);
            if (f['0x0180'] === 4 && (!detectedSerial || detectedSerial.startsWith('RU'))) {
                detectedDeviceType = 'RU02';
            }
        }
        if (f['0x0190'] !== undefined) {
            detectedFwVersion = String(f['0x0190']);
            updates.firmware_version = detectedFwVersion;
        }

        // Environmental metrics
        const temp = f['0x012d'] !== undefined ? f['0x012d'] : f.temperature_ambient;
        const auxTemp = f['0x012e'] !== undefined ? f['0x012e'] : f.aux_temperature_1;
        const hum = f['0x0135'] !== undefined ? f['0x0135'] : f.humidity_percent;
        const light = f['0x0136'] !== undefined ? f['0x0136'] : f.ambient_light_level;

        if (temp !== undefined) updates.temperature = temp;
        if (auxTemp !== undefined) updates.aux_temperature = auxTemp;
        if (hum !== undefined) updates.humidity = hum;
        if (light !== undefined) updates.light_level = light;

        // Battery fields
        const batMv = f['0x021c'] !== undefined ? f['0x021c'] : (f['0x021b'] !== undefined ? f['0x021b'] : f.battery_mv);
        if (batMv !== undefined && typeof batMv === 'number') {
            updates.battery_mv = batMv;
            updates.battery_percent = Math.max(0, Math.min(100, Math.round((batMv - 2000) / 10)));
            updates.battery_state = batMv < 2400 ? 'LOW' : 'NORMAL';
        }

        // Reset Reason & Error Flags
        const resetCode = f['0x01a0'] !== undefined ? f['0x01a0'] : f.reset_reason;
        if (resetCode !== undefined) {
            updates.reset_reason = tlvDecoder.decodeResetReason(resetCode);
        }
        const errCode = f['0x01a3'] !== undefined ? f['0x01a3'] : f.error_flags;
        if (errCode !== undefined) {
            updates.error_flags = tlvDecoder.decodeErrorFlags(errCode);
        }

        // Valve Actuator parameters
        const valvePos = f['0x0265'] !== undefined ? f['0x0265'] : f.va_act_position_steps;
        const actActive = f['0x028c'] !== undefined ? f['0x028c'] : f.actuator_active;
        const mountState = f['0x016a'] !== undefined ? f['0x016a'] : f.va_mount_state;
        const actDev = f['0x0283'] !== undefined ? f['0x0283'] : f.va_act_deviation;
        const childLock = f['0x0140'] !== undefined ? f['0x0140'] : f.child_lock;
        const orientation = f['0x0149'] !== undefined ? f['0x0149'] : f.display_orientation;
        const actLow = f['0x0273'] !== undefined ? f['0x0273'] : f.actuator_limit_low;
        const actHigh = f['0x027c'] !== undefined ? f['0x027c'] : f.actuator_limit_high;
        const actDrive = f['0x0280'] !== undefined ? f['0x0280'] : f.actuator_drive_constant;

        if (valvePos !== undefined) updates.valve_position = valvePos;
        if (actActive !== undefined) updates.actuator_active = Number(actActive) === 1;
        if (mountState !== undefined) updates.mounting_state = tlvDecoder.decodeMountState(mountState);
        if (actDev !== undefined && Number(actDev) !== 32767) updates.actuator_deviation = Number(actDev);
        if (childLock !== undefined) updates.child_lock = Number(childLock) === 1;
        if (orientation !== undefined) updates.orientation = tlvDecoder.decodeOrientation(orientation);
        if (actLow !== undefined) updates.actuator_limit_low = Number(actLow);
        if (actHigh !== undefined) updates.actuator_limit_high = Number(actHigh);
        if (actDrive !== undefined) updates.actuator_drive_constant = Number(actDrive);

        // Calculate valve percentage if steps and limits are known
        if (updates.valve_position !== undefined && updates.actuator_limit_low !== undefined && updates.actuator_limit_high !== undefined) {
            updates.valve_position_pct = tlvDecoder.calculateValvePositionPct(updates.valve_position, updates.actuator_limit_low, updates.actuator_limit_high);
        }

        // OpenTherm / Boiler parameters
        const flowTemp = f['0x044c'] !== undefined ? f['0x044c'] : f.ot_ch_flow_temperature;
        const retTemp = f['0x044d'] !== undefined ? f['0x044d'] : f.ot_ch_return_temperature;
        const boilerActive = f['0x0457'] !== undefined ? f['0x0457'] : f.boiler_active;
        const waterPress = f['0x0460'] !== undefined ? f['0x0460'] : f.hvac_water_pressure_mbar;
        const dhwTarget = f['0x045b'] !== undefined ? f['0x045b'] : f.dhw_target_temperature;
        const outTemp = f['0x044f'] !== undefined ? f['0x044f'] : f.ot_outside_temperature;
        const exhTemp = f['0x044e'] !== undefined ? f['0x044e'] : f.ot_exhaust_temperature;
        const dhwMeas = f['0x045a'] !== undefined ? f['0x045a'] : f.ot_dhw_temperature;

        if (flowTemp !== undefined) updates.flow_temperature = flowTemp;
        if (retTemp !== undefined) updates.return_temperature = retTemp;
        if (boilerActive !== undefined) updates.boiler_active = Number(boilerActive) === 1;
        if (waterPress !== undefined && typeof waterPress === 'number') {
            const raw = Number(waterPress);
            if (raw !== 65535 && raw !== 4294967295 && raw !== 4294901760) {
                updates.water_pressure_bar = parseFloat(((raw & 0xFFFF) / 1000.0).toFixed(3));
            }
        }
        if (dhwTarget !== undefined) updates.dhw_target_temperature = dhwTarget;
        if (outTemp !== undefined) updates.outside_temperature = outTemp;
        if (exhTemp !== undefined) updates.exhaust_temperature = exhTemp;
        if (dhwMeas !== undefined) updates.dhw_measured_temperature = dhwMeas;
    }

    // Determine target device identifier (for uplink: source MAC; for downlink: dest MAC or path serial)
    const senderMac = macInfo.srcMac;
    const isUplink = !macInfo.isSrcIb;
    const targetMac = isUplink ? senderMac : macInfo.dstMac;

    const deviceRecord = deviceRegistry.getOrCreate(targetMac, {
        mac: targetMac,
        serial: detectedSerial,
        deviceType: detectedDeviceType,
        fwVersion: detectedFwVersion,
        hardwareRevision: detectedHwRev,
        rssi: meta.rssi
    });

    if (detectedSerial && !deviceRecord.serial) {
        deviceRegistry.bindMacToSerial(targetMac, detectedSerial, detectedDeviceType);
    }

    // Emulated check (FW 13762 or HW 4 on RU)
    if (deviceRecord.serial && deviceRecord.serial.startsWith('RU') && (deviceRecord.fwVersion === '13762' || detectedHwRev === 4)) {
        deviceRecord.isEmulated = true;
        updates.is_emulated = true;
    }

    // Update state in registry
    deviceRegistry.updateState(targetMac, updates, {
        rssi: meta.rssi,
        serial: detectedSerial,
        fwVersion: detectedFwVersion,
        hardwareRevision: detectedHwRev,
        isEmulated: deviceRecord.isEmulated
    });

    // 1. Publish Home Assistant Auto-Discovery
    haDiscovery.publishDeviceDiscovery(deviceRecord);

    // 2. Publish Discrete MQTT Telemetry (tado/sniffer/d/{serial}/...)
    mqttPublisher.publishDeviceTelemetry(deviceRecord, updates);

    // 3. Publish Raw Sniffer Packet (tado/sniffer/{mac}/{path})
    const tlvFriendly = {};
    if (tlv && tlv.items) {
        tlv.items.forEach(item => {
            tlvFriendly[item.name] = item.value;
        });
    }

    const payloadData = {
        coap: {
            type: ['CON', 'NON', 'ACK', 'RST'][coap.type],
            code: coapParser.codeStr(coap.code),
            mid: coap.mid,
            token: coap.token.toString('hex'),
            options: coap.options.map(o => ({ num: o.num, name: o.name, hex: o.value.toString('hex') })),
            payload: coap.payload.toString('hex')
        },
        tlv: tlvFriendly,
        tlvRaw: tlv ? tlv.fields : {},
        rawHex: meta.rawHex,
        rawCoapHex: meta.rawCoapHex
    };

    const cleanSenderMac = macInfo.srcMac.split(' ')[0];
    mqttPublisher.publishRawTelemetry(cleanSenderMac, pathStr, payloadData);

    return {
        isDuplicate: false,
        pathStr,
        deviceRecord,
        updates
    };
}

module.exports = {
    processCoapPacket,
    resolvePath,
    extractSerialFromPath
};
