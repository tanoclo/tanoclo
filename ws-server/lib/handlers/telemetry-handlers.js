/**
 * @file lib/handlers/telemetry-handlers.js
 * @brief Handlers for sensor telemetry measurements packets.
 */

'use strict';

const { getLogger } = require('../logger');
const log = getLogger();
const coapHelpers = require('./coap-helpers');
const wsBridge = require('../ws-bridge');

let db, coap, battery, mqttPublisher;
let clients, ipv6ToDevice;
let extractShortSerial;

function init(deps) {
    db = deps.db;
    coap = deps.coap;
    battery = deps.battery;
    mqttPublisher = deps.mqttPublisher;
    clients = deps.clients;
    ipv6ToDevice = deps.ipv6ToDevice;
    extractShortSerial = deps.extractShortSerial;
}

async function handleSensorData(ws, frame, coapMsg, decoded, peerInfo, pathInfo) {
    const isGet = coapMsg.code === coap.CODE_GET;
    const deviceId = pathInfo.deviceId || ipv6ToDevice.get(peerInfo.ipv6);
    if (!deviceId) return coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);

    if (isGet) {
        try {
            const payload = await db.buildDeviceSensorTLV(deviceId);
            const etags = await db.getDeviceEtags(deviceId);
            await coapHelpers.sendCoAPWithBlock2(ws, coapMsg, payload || Buffer.alloc(0), etags ? etags.sen : null, 42, peerInfo, wsBridge.DIR_SERVER_TO_CLIENT);
        } catch (e) {
            log('error', `SENSOR GET ${deviceId}: ${e.message}`);
            coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
        }
        return;
    }

    coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);

    if (!decoded || !decoded.fields) return;

    const f = decoded.fields;
    if (deviceId.startsWith('IB')) return;

    const clientInfo = clients.get(deviceId);
    if (clientInfo) clientInfo.lastMessageAt = new Date().toISOString();

    const shortSerial = extractShortSerial(deviceId);
    if (!shortSerial) return;

    let tempAmbient = f['0x012d'] ?? null;
    let humidity = f['0x0135'] ?? null;
    const rawBatteryMv = f['0x0162'] ?? null;
    const batteryMv = rawBatteryMv != null ? battery.filterBatteryMv(shortSerial, rawBatteryMv) : null;
    const lightLevel = f['0x0136'] ?? null;
    const otVolt = f['0x0161'] ?? null;
    const resetReason = f['0x0160'] ?? null;

    let tempC = tempAmbient;
    let humPct = humidity;

    if (tempC != null && Math.abs(tempC) > 100) {
        log('debug', `Applying fallback scale (0.01) to raw temperature: ${tempC}`);
        tempC = Math.round(tempC * 0.01 * 100) / 100;
        f['0x012d'] = tempC;
    }
    if (humPct != null && Math.abs(humPct) > 100) {
        log('debug', `Applying fallback scale (0.1) to raw humidity: ${humPct}`);
        humPct = Math.round(humPct * 0.1 * 10) / 10;
        f['0x0135'] = humPct;
    }

    const otVoltV = otVolt !== null ? (otVolt / 1000).toFixed(3) : 'null';
    const resetStr = (resetReason !== null && mqttPublisher && mqttPublisher.getFriendlyResetReason)
        ? mqttPublisher.getFriendlyResetReason(resetReason)
        : (resetReason !== null ? resetReason : 'null');

    if (rawBatteryMv != null && batteryMv !== rawBatteryMv) {
        log('info', `BATTERY GUARD ${shortSerial}: raw=${rawBatteryMv}mV guarded=${batteryMv}mV (transient drop suppressed)`);
    }
    log('debug', `SENSOR ${shortSerial}: temp=${tempC}°C hum=${humPct}% bat=${batteryMv}mV light=${lightLevel} ot_volt=${otVoltV}V reset=${resetStr}`);

    let batteryState = null;
    let batteryPercent = null;

    if (batteryMv != null) {
        const chemistry = await db.getDeviceBatteryConfig(shortSerial);
        batteryPercent = battery.getBatteryPercent(batteryMv, deviceId, chemistry);
        // Update field with guarded value so MQTT/DB use the stabilised reading
        if (batteryMv !== rawBatteryMv) f['0x0162'] = batteryMv;

        if (batteryPercent != null) {
            if (batteryPercent > 30) batteryState = 'NORMAL';
            else if (batteryPercent > 5) batteryState = 'LOW';
            else batteryState = 'DEPLETED';
        }
    }

    const zone = await db.getZoneForDevice(shortSerial);
    const homeId = zone?.homeId || pathInfo?.homeId || await db.getHomeForDevice(shortSerial);

    if (zone && tempC != null) {
        const isLeader = !zone.measuringSerial || zone.measuringSerial === deviceId || zone.measuringSerial === shortSerial;
        log('debug', `Zone ${zone.zoneId} Telemetry: deviceId=${deviceId} shortSerial=${shortSerial} measuringSerial=${zone.measuringSerial} isLeader=${isLeader}`);

        if (isLeader) {
            await db.insertMergedZoneMeasurement(
                zone.homeId,
                zone.zoneId,
                {
                    '0x012d': tempC,
                    '0x0135': humPct ?? 50.0
                }
            );

            const owdDetector = require('../owd-detector');
            try {
                const [measRows] = await db.getPool().execute('SELECT * FROM zone_measurements WHERE zone_id = ? ORDER BY id DESC LIMIT 1', [zone.zoneId]);
                if (measRows.length > 0) {
                    await owdDetector.evaluate(zone.homeId, zone.zoneId, measRows[0]);
                }
            } catch (owdErr) {
                log('warn', `OWD evaluation failed for zone ${zone.zoneId}: ${owdErr.message}`);
            }
        } else {
            log('debug', `Device ${deviceId} is in zone ${zone.zoneId} but NOT the leader. Skipping zone_measurements update.`);
        }
    } else if (!zone) {
        log('warn', `Device ${shortSerial} has no zone assignment`);
    }

    if (homeId) {
        await db.insertDeviceMeasurement(shortSerial, homeId, zone ? zone.zoneId : null, f);
    }
    await db.updateDeviceConnectionState(shortSerial, true, batteryState, batteryPercent);

    if (mqttPublisher && homeId) {
        db.getDeviceBySerial(shortSerial).then(dev => {
            mqttPublisher.publishDeviceTelemetry(shortSerial, homeId, zone ? zone.zoneId : null, f, dev).catch(() => { });
        }).catch(() => {
            mqttPublisher.publishDeviceTelemetry(shortSerial, homeId, zone ? zone.zoneId : null, f, null).catch(() => { });
        });

        mqttPublisher.publishDeviceAvailability(shortSerial, true).catch(() => { });

        if (tempC != null && zone && (!zone.measuringSerial || zone.measuringSerial === deviceId || zone.measuringSerial === shortSerial)) {
            db.getPool().execute('SELECT * FROM zone_measurements WHERE zone_id = ? ORDER BY id DESC LIMIT 1', [zone.zoneId])
                .then(([rows]) => {
                    if (rows.length > 0) {
                        mqttPublisher.publishZoneTelemetry(zone.homeId, zone.zoneId, rows[0]).catch(() => { });
                        mqttPublisher.publishZoneStateTelemetry(zone.homeId, zone.zoneId, rows[0]).catch(() => { });
                    }
                }).catch(() => { });
        }
    }
}

async function handleHvacConfig(ws, frame, coapMsg, decoded, peerInfo, pathInfo) {
    coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
    if (!decoded || !decoded.fields) return;

    if (pathInfo.homeId) {
        const sanitizedFields = db.sanitizeHvacFields(decoded.fields);
        await db.upsertHeatingSystem(pathInfo.homeId, sanitizedFields);
        if (mqttPublisher) {
            mqttPublisher.publishHvacTelemetry(pathInfo.homeId, sanitizedFields).catch(() => { });
        }
    }
}

async function handleHvac(ws, frame, coapMsg, decoded, peerInfo, pathInfo) {
    coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
    if (!decoded || !decoded.fields) return;

    let homeId = pathInfo.homeId;

    if (!homeId) {
        const deviceId = ipv6ToDevice.get(peerInfo.ipv6);
        if (deviceId) {
            const shortSerial = extractShortSerial(deviceId);
            if (shortSerial) homeId = await db.getHomeForDevice(shortSerial);
        }
    }

    log('debug', `HVAC ${pathInfo.type}: ${JSON.stringify(decoded.fields)}`);

    if (homeId) {
        const sanitizedFields = db.sanitizeHvacFields(decoded.fields);
        await db.upsertHeatingSystem(homeId, sanitizedFields);
        if (mqttPublisher) {
            mqttPublisher.publishHvacTelemetry(homeId, sanitizedFields).catch(() => { });
        }
    }
}

async function handleHvacGet(ws, frame, coapMsg, peerInfo, pathInfo) {
    let homeId = pathInfo.homeId;
    if (!homeId) {
        const deviceId = ipv6ToDevice.get(peerInfo.ipv6);
        if (deviceId) {
            const shortSerial = extractShortSerial(deviceId);
            if (shortSerial) homeId = await db.getHomeForDevice(shortSerial);
        }
    }

    if (homeId == null) return coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);

    try {
        const payload = await db.buildHvacConfigTLV(homeId);
        const etags = await db.getHomeEtags(homeId);
        await coapHelpers.sendCoAPWithBlock2(ws, coapMsg, payload || Buffer.alloc(0), etags ? etags.hvac : null, 42, peerInfo, wsBridge.DIR_SERVER_TO_CLIENT);
    } catch (e) {
        log('error', `HVAC GET ${homeId}: ${e.message}`);
        coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
    }
}

module.exports = {
    init,
    handleSensorData,
    handleHvacConfig,
    handleHvac,
    handleHvacGet
};
