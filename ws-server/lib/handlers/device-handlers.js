/**
 * @file lib/handlers/device-handlers.js
 * @brief Handlers for device pairing and status messages.
 */

'use strict';

const crypto = require('crypto');
const { getLogger } = require('../logger');
const log = getLogger();
const coapHelpers = require('./coap-helpers');
const wsBridge = require('../ws-bridge');

let db, coap, tlv, config, mqttPublisher, workerPool;
let clients, ipv6ToDevice;
let extractShortSerial;

function init(deps) {
    db = deps.db;
    coap = deps.coap;
    tlv = deps.tlv;
    config = deps.config;
    mqttPublisher = deps.mqttPublisher;
    workerPool = deps.workerPool;
    clients = deps.clients;
    ipv6ToDevice = deps.ipv6ToDevice;
    extractShortSerial = deps.extractShortSerial;
}

async function handleDeviceInfo(ws, frame, coapMsg, decoded, peerInfo, pathInfo) {
    const deviceId = pathInfo.deviceId || ipv6ToDevice.get(peerInfo.ipv6);
    coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);

    if (!decoded || !decoded.fields) return;
    log('debug', `DEV_INFO ${deviceId}: ${JSON.stringify(decoded.fields)}`);

    if (deviceId) {
        await db.updateDeviceFirmware(deviceId, decoded.fields);
    }
}

async function handleDeviceActuator(ws, frame, coapMsg, decoded, peerInfo, pathInfo) {
    const isGet = coapMsg.code === coap.CODE_GET;
    const deviceId = pathInfo.deviceId || ipv6ToDevice.get(peerInfo.ipv6);
    if (!deviceId) return coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);

    if (isGet) {
        try {
            const payload = await db.buildDeviceActuatorTLV(deviceId);
            const etags = await db.getDeviceEtags(deviceId);
            await coapHelpers.sendCoAPWithBlock2(ws, coapMsg, payload || Buffer.alloc(0), etags ? etags.act : null, null, peerInfo, wsBridge.DIR_SERVER_TO_CLIENT);
        } catch (e) {
            log('error', `ACT GET ${deviceId}: ${e.message}`);
            coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
        }
        return;
    }

    coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
    if (!decoded || !decoded.fields) return;

    log('debug', `DEV_ACT ${deviceId}: ${JSON.stringify(decoded.fields)}`);

    if (deviceId) {
        const clientInfo = clients.get(deviceId);
        if (clientInfo) clientInfo.lastMessageAt = new Date().toISOString();

        await db.updateDeviceActuator(deviceId, decoded.fields);
        const shortSerial = extractShortSerial(deviceId);
        if (shortSerial) {
            await db.updateDeviceConnectionState(shortSerial, true);
            if (mqttPublisher) {
                db.getDeviceBySerial(shortSerial).then(dev => {
                    if (dev) {
                        mqttPublisher.publishDeviceTelemetry(shortSerial, dev.home_id, dev.zone_id, null, dev).catch(() => { });
                    }
                }).catch(err => { log('warn', `Device telemetry publish database lookup failed: ${err.message}`); });
            }
        }
    }
}

async function handleDeviceConfig(ws, frame, coapMsg, decoded, peerInfo, pathInfo) {
    const deviceId = pathInfo.deviceId || ipv6ToDevice.get(peerInfo.ipv6);
    const isGet = coapMsg.code === coap.CODE_GET;

    if (isGet) {
        if (!deviceId) {
            coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
            return;
        }

        const dev = await db.getDeviceByFullSerial(deviceId) || await db.getDeviceBySerial(deviceId);
        if (!dev) {
            log('debug', `DEV_CFG GET ${deviceId}: Device is not registered in database. Responding with 4.04 Not Found.`);
            coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16, 0x84);
            return;
        }

        try {
            const alive = await db.isDeviceAlive(deviceId);
            if (!alive) {
                log('warn', `GW_TIMEOUT: Device ${deviceId} is inactive (>20m). Sending 5.04.`);
                coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16, coap.CODE_GATEWAY_TIMEOUT);
                return;
            }

            const payload = await db.buildDeviceConfigTLV(deviceId);
            if (payload) {
                const etags = await db.getDeviceEtags(deviceId);
                const configEtag = etags ? (etags.config_real || etags.config) : null;
                await coapHelpers.sendCoAPWithBlock2(ws, coapMsg, payload, configEtag, null, peerInfo, wsBridge.DIR_SERVER_TO_CLIENT);
                return;
            }
        } catch (e) {
            log('error', `DEV_CFG GET ${deviceId}: Error building payload: ${e.message}`, e.stack);
        }

        coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16, coap.CODE_VALID);
        return;
    }

    coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
    if (!decoded || !decoded.fields) return;

    log('debug', `DEV_CFG ${deviceId}: ${JSON.stringify(decoded.fields)}`);

    if (deviceId) {
        await db.updateDeviceConfig(deviceId, decoded.fields, decoded.fields);
        await db.updateDeviceFirmware(deviceId, decoded.fields);
        const shortSerial = extractShortSerial(deviceId);
        if (shortSerial) {
            await db.updateDeviceConnectionState(shortSerial, true);
        }
    }
}

async function handleDeviceMount(ws, frame, coapMsg, decoded, peerInfo, pathInfo) {
    coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
    if (!decoded || !decoded.fields) return;

    const deviceId = pathInfo.deviceId || ipv6ToDevice.get(peerInfo.ipv6);
    log('debug', `DEV_MNT ${deviceId}: ${JSON.stringify(decoded.fields)}`);

    if (deviceId) {
        await db.updateDeviceMount(deviceId, decoded.fields);
        const shortSerial = extractShortSerial(deviceId);
        if (shortSerial && mqttPublisher) {
            const state = decoded.fields['0x016a'] || decoded.fields['0x01b8'];
            if (state !== undefined) {
                const MOUNT_STATE_MAP = { 0: 'CALIBRATED', 1: 'CALIBRATING', 2: 'MOUNTED' };
                const stateStr = MOUNT_STATE_MAP[state] || String(state);
                mqttPublisher.publishMountingState(shortSerial, stateStr).catch(() => { });
            }
        }
    }
}

async function handleDeviceLock(ws, frame, coapMsg, decoded, peerInfo, pathInfo) {
    const isGet = coapMsg.code === coap.CODE_GET;
    const deviceId = pathInfo.deviceId || ipv6ToDevice.get(peerInfo.ipv6);
    if (!deviceId) return coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);

    if (isGet) {
        try {
            const dbDev = await db.getDeviceByFullSerial(deviceId);
            const etags = await db.getDeviceEtags(deviceId);
            const fallbackLockEtag = crypto.createHash('sha256').update(deviceId + '_lock').digest().slice(0, 8);
            const lockEtag = (etags && (etags.lock_real || etags.lock)) || fallbackLockEtag;

            const enabled = dbDev ? !!dbDev.child_lock_enabled : false;
            const payload = tlv.encode([
                { fid: 0x0290, value: tlv.encodeValue(enabled, 'bool') }
            ]);
            await coapHelpers.sendCoAPWithBlock2(ws, coapMsg, payload, lockEtag, null, peerInfo, wsBridge.DIR_SERVER_TO_CLIENT);
        } catch (e) {
            log('error', `LOCK GET ${deviceId}: ${e.message}`);
            coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
        }
        return;
    }

    coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
    if (!decoded || !decoded.fields) return;

    const enabled = !!decoded.fields['0x0290'];
    log('debug', `DEV_LOCK ${deviceId}: ${enabled}`);
    if (deviceId) {
        await db.updateDeviceLock(deviceId, enabled);
        const shortSerial = extractShortSerial(deviceId);
        if (shortSerial && mqttPublisher) {
            mqttPublisher.publishChildLock(shortSerial, enabled).catch(() => { });
        }
    }
}

async function handleDeviceError(ws, frame, coapMsg, decoded, peerInfo, pathInfo) {
    coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
    if (!decoded || !decoded.fields) return;

    const deviceId = pathInfo.deviceId || ipv6ToDevice.get(peerInfo.ipv6);
    const flags = decoded.fields['0x01a3'] || 0;
    const friendlyErr = (mqttPublisher && mqttPublisher.getFriendlyErrorFlags)
        ? mqttPublisher.getFriendlyErrorFlags(flags)
        : flags;

    log('debug', `DEV_ERR ${deviceId}: flags=${flags} (${friendlyErr})`);

    if (deviceId) {
        await db.updateDeviceErrorFlags(deviceId, flags);
        if (mqttPublisher) {
            const shortSerial = extractShortSerial(deviceId);
            if (shortSerial) {
                db.getDeviceBySerial(shortSerial).then(dev => {
                    if (dev) {
                        mqttPublisher.publishDeviceTelemetry(shortSerial, dev.home_id, dev.zone_id, null, dev).catch(() => { });
                    }
                }).catch(err => { log('warn', `Device error flags telemetry database lookup failed: ${err.message}`); });
            }
        }
    }
}

async function handleDeviceSelftest(ws, frame, coapMsg, decoded, peerInfo, pathInfo) {
    coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
    if (!decoded || !decoded.fields) return;

    const deviceId = pathInfo.deviceId || ipv6ToDevice.get(peerInfo.ipv6);
    const supplyMv = decoded.fields['0x0168'] !== undefined ? decoded.fields['0x0168'] :
        Object.values(decoded.fields)[0] || 0;

    log('debug', `DEV_SELFTEST ${deviceId}: supply=${supplyMv}mV`);

    if (deviceId) {
        await db.updateDeviceSelftest(deviceId, supplyMv);
    }
}

async function handleDeviceRfKey(ws, frame, coapMsg, decoded, peerInfo, pathInfo) {
    coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
    if (!decoded || !decoded.fields) return;

    const deviceId = pathInfo.deviceId || ipv6ToDevice.get(peerInfo.ipv6);
    const key = decoded.fields['0x0003'] || decoded.fields['0x0155'] || null;

    log('debug', `DEV_RFKEY ${deviceId}: key=${key ? '***' : 'null'}`);

    if (deviceId && key) {
        await db.updateDeviceRfKey(deviceId, key);
    }
}

async function handleDeviceFirmware(ws, frame, coapMsg, decoded, peerInfo, pathInfo) {
    coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
    if (!decoded || !decoded.fields) return;

    const deviceId = pathInfo.deviceId || ipv6ToDevice.get(peerInfo.ipv6);
    log('debug', `DEV_FW ${deviceId}: ${JSON.stringify(decoded.fields)}`);

    if (deviceId) {
        await db.updateDeviceFirmware(deviceId, decoded.fields);
        if (mqttPublisher) {
            const shortSerial = extractShortSerial(deviceId);
            if (shortSerial) {
                db.getDeviceBySerial(shortSerial).then(dev => {
                    if (dev) {
                        mqttPublisher.publishDeviceTelemetry(shortSerial, dev.home_id, dev.zone_id, null, dev).catch(() => { });
                    }
                }).catch(err => { log('warn', `Device firmware telemetry database lookup failed: ${err.message}`); });
            }
        }
    }
}

async function parseNeighborsPayload(decoded) {
    if (!decoded || !decoded.items) return null;

    let selfIpv6 = null;
    const neighbors = [];

    if (decoded.fields && decoded.fields['0x01d0']) {
        const selfIpv6Raw = decoded.fields['0x01d0'];
        try {
            selfIpv6 = wsBridge.ipv6FromBytes(Buffer.from(selfIpv6Raw, 'hex'));
        } catch (e) {
            selfIpv6 = selfIpv6Raw;
        }
    }

    const items = decoded.items;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.fid === '0x01d1') {
            const neighborValBuf = Buffer.from(item.rawHex, 'hex');
            const subDecoded = await workerPool.tlvDecode(neighborValBuf);

            let neighborIpv6 = null;
            if (subDecoded.fields && subDecoded.fields['0x01d2']) {
                const ipRaw = subDecoded.fields['0x01d2'];
                try {
                    neighborIpv6 = wsBridge.ipv6FromBytes(Buffer.from(ipRaw, 'hex'));
                } catch (e) {
                    neighborIpv6 = ipRaw;
                }
            }

            let metrics = null;
            if (i + 1 < items.length && items[i + 1].fid === '0x01d3') {
                metrics = items[i + 1].rawHex;
                i++;
            }

            neighbors.push({
                d1: '0x' + item.len.toString(16),
                neighbor_ipv6: neighborIpv6,
                d3: metrics || ''
            });
        }
    }

    return {
        neighbors,
        self_ipv6: selfIpv6,
        neighbors_count: neighbors.length
    };
}

async function handleDeviceNeighbors(ws, frame, coapMsg, decoded, peerInfo, pathInfo) {
    const isGet = coapMsg.code === coap.CODE_GET;
    const deviceId = pathInfo.deviceId || ipv6ToDevice.get(peerInfo.ipv6);

    if (isGet) {
        coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16, coap.CODE_VALID);
        return;
    }

    coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
    if (!decoded || !decoded.fields) return;

    log('debug', `DEV_NEIGHBORS ${deviceId}: ${JSON.stringify(decoded.fields)}`);

    if (deviceId) {
        const structuredTopology = await parseNeighborsPayload(decoded);
        if (structuredTopology) {
            log('info', `DEV_NEIGHBORS ${deviceId} parsed topology: self_ipv6=${structuredTopology.self_ipv6}, neighborsCount=${structuredTopology.neighbors_count}, neighbors=${JSON.stringify(structuredTopology.neighbors)}`);
            try {
                const ibDev = await db.getDeviceByFullSerial(deviceId) || await db.getDeviceBySerial(deviceId);
                const homeId = ibDev ? ibDev.home_id : null;
                await db.upsertDeviceNeighbors(deviceId, homeId, structuredTopology);
            } catch (e) {
                log('error', `DEV_NEIGHBORS ${deviceId} DB update failed: ${e.message}`);
            }
        }
    }
}

async function handleDeviceFallback(ws, frame, coapMsg, decoded, peerInfo, pathInfo) {
    coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
    if (!decoded || !decoded.fields) return;

    const deviceId = pathInfo.deviceId || ipv6ToDevice.get(peerInfo.ipv6);
    const val = decoded.fields['0x0182'] !== undefined ? decoded.fields['0x0182'] :
        Object.values(decoded.fields)[0];

    let finalVal = val;
    let valStr = 'ext';
    if (val !== undefined) {
        if (Buffer.isBuffer(val)) {
            if (val.length === 1) finalVal = val.readUInt8(0);
            else if (val.length === 2) finalVal = val.readUInt16BE(0);
            else if (val.length === 4) finalVal = val.readUInt32BE(0);
            else finalVal = val.toString('hex');
            valStr = String(finalVal);
        } else {
            valStr = String(val);
        }
    }

    log('debug', `DEV_FALLBACK ${deviceId}: ${valStr}`);

    if (deviceId && finalVal !== undefined) {
        await db.updateDeviceFallback(deviceId, finalVal);
    }
}

module.exports = {
    init,
    handleDeviceInfo,
    handleDeviceActuator,
    handleDeviceConfig,
    handleDeviceMount,
    handleDeviceLock,
    handleDeviceError,
    handleDeviceSelftest,
    handleDeviceRfKey,
    handleDeviceFirmware,
    handleDeviceNeighbors,
    handleDeviceFallback
};
