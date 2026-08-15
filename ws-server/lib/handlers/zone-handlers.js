/**
 * @file lib/handlers/zone-handlers.js
 * @brief Handlers for zone timetable and schedule updates.
 */

'use strict';

const { getLogger } = require('../logger');
const log = getLogger();
const coapHelpers = require('./coap-helpers');
const wsBridge = require('../ws-bridge');

let db, coap, tlv, config, ZS_SCHEMA, mqttPublisher;
let ipv6ToDevice;
let extractShortSerial, onStateChange;

function init(deps) {
    db = deps.db;
    coap = deps.coap;
    tlv = deps.tlv;
    config = deps.config;
    ZS_SCHEMA = deps.ZS_SCHEMA;
    mqttPublisher = deps.mqttPublisher;
    ipv6ToDevice = deps.ipv6ToDevice;
    extractShortSerial = deps.extractShortSerial;
    onStateChange = deps.onStateChange;
}

async function handleZoneExtui(ws, frame, coapMsg, decoded, peerInfo, pathInfo) {
    const zoneId = pathInfo.zoneId;
    coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);

    if (!decoded || !decoded.fields) return;
    log('debug', `ZONE_EXTUI z/${zoneId}: ${JSON.stringify(decoded.fields)}`);

    if (zoneId != null) {
        await db.insertZoneState(pathInfo.homeId, zoneId, decoded.fields);
        if (typeof onStateChange === 'function') {
            onStateChange(pathInfo.homeId, 'zone-state', { zoneId });
        }
    }
}

async function handleZoneActuator(ws, frame, coapMsg, decoded, peerInfo, pathInfo) {
    coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
    if (!decoded || !decoded.fields) return;

    const zoneId = pathInfo.zoneId;
    const demand = decoded.fields['0x40a0'] ?? null;

    log('debug', `ZONE_ACT z/${zoneId}: demand=${demand}%`);

    if (zoneId != null && demand !== undefined) {
        let homeId = pathInfo.homeId;
        if (!homeId) {
            const deviceId = ipv6ToDevice.get(peerInfo.ipv6);
            if (deviceId) {
                const shortSerial = extractShortSerial(deviceId);
                if (shortSerial) homeId = await db.getHomeForDevice(shortSerial);
            }
        }
        await db.insertZoneDemand(homeId, zoneId, demand);
    }
}

async function handleZoneFallback(ws, frame, coapMsg, decoded, peerInfo, pathInfo) {
    coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
    if (!decoded || !decoded.fields) return;

    const zoneId = pathInfo.zoneId;
    const homeId = pathInfo.homeId;
    const val = decoded.fields['0x0182'] || Object.values(decoded.fields)[0];

    log('debug', `ZONE_FALLBACK h/${homeId} z/${zoneId}: ${val}`);

    if (zoneId != null && val !== undefined) {
        await db.updateZoneFallback(homeId, zoneId, val);
    }
}

async function handleZoneOpenWindow(ws, frame, coapMsg, decoded, peerInfo, pathInfo) {
    coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16, coap.CODE_CONTENT);
    if (!decoded || !decoded.fields) return;

    const zoneId = pathInfo.zoneId;
    const homeId = pathInfo.homeId;
    const active = !!decoded.fields['0x63e0'];

    log('debug', `ZONE_OW h/${homeId} z/${zoneId}: ${active}`);

    if (zoneId != null) {
        await db.updateZoneOpenWindow(homeId, zoneId, active);
        if (mqttPublisher) {
            mqttPublisher.publishOpenWindow(zoneId, active).catch(() => { });
        }
    }
}

async function handleZoneConfig(ws, frame, coapMsg, decoded, peerInfo, pathInfo) {
    const zoneId = pathInfo.zoneId;
    const homeId = pathInfo.homeId;
    const isGet = coapMsg.code === coap.CODE_GET;

    if (isGet) {
        try {
            const alive = await db.isZoneAlive(homeId, zoneId);
            if (!alive) {
                log('warn', `GW_TIMEOUT: Zone ${zoneId} is inactive (>20m). Sending 5.04.`);
                coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16, coap.CODE_GATEWAY_TIMEOUT);
                return;
            }

            const payload = await db.buildZoneConfigTLV(homeId, zoneId);
            const etags = await db.getZoneEtags(homeId, zoneId);
            const configEtag = (etags && etags.config_real) ? etags.config_real : db.generateEtag(payload);
            await coapHelpers.sendCoAPWithBlock2(ws, coapMsg, payload || Buffer.alloc(0), configEtag, null, peerInfo, wsBridge.DIR_SERVER_TO_CLIENT);
        } catch (e) {
            log('error', `ZONE_CFG GET z/${zoneId}: ${e.message}`, e.stack);
            coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
        }
        return;
    }

    coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
    if (!decoded || !decoded.fields) return;

    log('debug', `ZONE_CFG z/${zoneId}: ${JSON.stringify(decoded.fields)}`);

    if (zoneId != null) {
        await db.updateZoneConfig(homeId, zoneId, decoded.fields, decoded.fields);
        if (typeof onStateChange === 'function') {
            onStateChange(homeId, 'zone-config', { zoneId });
        }
    }
}

async function handleCircuitActuator(ws, frame, coapMsg, decoded, peerInfo, pathInfo) {
    coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
    if (!decoded) return;

    const f = decoded.fields;
    const circuitId = pathInfo.circuitId;
    const homeId = pathInfo.homeId;

    let targetTemp = f['0x4000'] ?? null;
    let refTemp = f['0x4040'] ?? null;
    let demandPct = f['0x4080'] ?? null;

    log('debug', `CIRCUIT ${circuitId}: target=${targetTemp}°C ref=${refTemp}°C demand=${demandPct}%`);

    if (homeId != null && circuitId != null) {
        await db.upsertHeatingCircuit(homeId, parseInt(circuitId, 10), f);
        if (mqttPublisher) {
            mqttPublisher.publishCircuitTelemetry(homeId, parseInt(circuitId, 10), f).catch(() => { });
        }
    }
}

async function handleCircuitConfig(ws, frame, coapMsg, decoded, peerInfo, pathInfo) {
    const circuitId = parseInt(pathInfo.circuitId, 10);
    const homeId = pathInfo.homeId;
    const isGet = coapMsg.code === coap.CODE_GET;

    if (isGet) {
        try {
            const payload = await db.buildCircuitConfigTLV(homeId, circuitId);
            const etags = await db.getCircuitEtags(homeId, circuitId);
            const configEtag = etags ? (etags.config_real || etags.config) : null;
            await coapHelpers.sendCoAPWithBlock2(ws, coapMsg, payload || Buffer.alloc(0), configEtag, null, peerInfo, wsBridge.DIR_SERVER_TO_CLIENT);
        } catch (e) {
            log('error', `CIRCUIT_CFG GET h/${homeId}/c/${circuitId}: ${e.message}`, e.stack);
            coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
        }
        return;
    }

    coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
    if (!decoded || !decoded.fields) return;

    log('debug', `CIRCUIT_CFG PUT h/${homeId}/c/${circuitId}: ${JSON.stringify(decoded.fields)}`);

    if (homeId != null && circuitId != null) {
        await db.updateCircuitConfig(homeId, circuitId, decoded.fields, decoded.fields);
    }
}

async function handleZoneState(ws, frame, coapMsg, decoded, peerInfo, pathInfo) {
    let zoneId = pathInfo.zoneId;
    let homeId = pathInfo.homeId;
    const isGet = coapMsg.code === coap.CODE_GET;

    if (isGet) {
        if (zoneId == null) {
            coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
            return;
        }

        const alive = await db.isZoneAlive(homeId, zoneId);
        if (!alive) {
            log('warn', `GW_TIMEOUT: Zone ${zoneId} is inactive (>20m). Sending 5.04.`);
            coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16, coap.CODE_GATEWAY_TIMEOUT);
            return;
        }

        let state = await db.getZoneState(homeId, zoneId);

        if (!state) {
            state = await db.getZoneStateFallback(homeId, zoneId);
        }

        if (state) {
            const zoneType = await db.getZoneType(homeId, zoneId);
            const isHotWater = (zoneType === 'HOT_WATER');
            const entries = [];
            const fields = {
                '0x6160': state.field_6160 ?? 1,
                '0x6180': state.field_6180 ?? 0,
                '0x6020': isHotWater ? 2 : (state.field_6020 ?? 1),
                '0x61e0': state.field_61e0 ?? 1,
                '0x6200': !(state.field_61e0 ?? 1) ? undefined : (state.field_6200 !== undefined ? state.field_6200 : (isHotWater ? 60 : 20)),
                '0x6240': state.field_6240 ?? 0,
                '0x62e0': state.field_62e0 ?? 0,
            };

            const overlayMode = state.field_6240 ?? 0;
            if (overlayMode > 0) {
                const ovTemp = state.field_6280;
                fields['0x6260'] = ovTemp != null ? 1 : 0;
                if (ovTemp != null) {
                    fields['0x6280'] = ovTemp;
                }
            }

            const sortedFields = coapHelpers.sortZoneStateFields(fields);

            for (const [key, val] of Object.entries(sortedFields)) {
                const schema = ZS_SCHEMA[key];
                if (schema && val !== undefined && val !== null) {
                    let v = val;
                    if (typeof v === 'string') v = parseFloat(v);

                    if ((schema.fid === 0x6200 || schema.fid === 0x6280) && typeof v === 'number' && !isNaN(v)) {
                        v = Math.round(v * 100);
                    } else if (schema.scale && typeof v === 'number' && !isNaN(v)) {
                        v = Math.round(v / schema.scale);
                    }

                    entries.push({ fid: schema.fid, value: tlv.encodeValue(v, schema.type) });
                }
            }

            const payload = tlv.encode(entries);
            const etags = await db.getZoneEtags(homeId, zoneId);
            const stateEtag = etags ? (etags.state_real || etags.state) : null;
            await coapHelpers.sendCoAPWithBlock2(ws, coapMsg, payload, stateEtag, null, peerInfo, wsBridge.DIR_SERVER_TO_CLIENT);
            return;
        }

        coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
        return;
    }

    coapHelpers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
    if (!decoded || !decoded.fields) return;

    if (!zoneId || !homeId) {
        const deviceId = ipv6ToDevice.get(peerInfo.ipv6);
        if (deviceId) {
            const zt = await db.getZoneForDevice(deviceId);
            if (zt) {
                if (!zoneId) zoneId = zt.zoneId;
                if (!homeId) homeId = zt.homeId;
            }
            if (!homeId) {
                const shortSerial = extractShortSerial(deviceId);
                if (shortSerial) homeId = await db.getHomeForDevice(shortSerial);
            }
        }
    }

    log('debug', `ZONE_STATE z/${zoneId || 'null'}: ${JSON.stringify(decoded.fields)}`);

    if (zoneId != null) {
        await db.insertZoneState(homeId, zoneId, decoded.fields);

        const mode = decoded.fields['0x6240'];
        const resumeEvent = decoded.fields['0x6440'];

        if (resumeEvent || mode === 0) {
            log('debug', `ZONE_STATE: Removing overlay for Z:${zoneId} (resumeEvent=${resumeEvent}, mode=${mode})`);
            await db.deleteZoneOverlay(homeId, zoneId).catch(err => {
                log('error', `Failed to delete overlay for ${zoneId}: ${err.message}`);
            });
            try {
                const currentBlock = await db.getCurrentScheduleBlock(homeId, zoneId).catch(() => null);
                const targetTemp = currentBlock?.setting?.temperature?.celsius || 19.0;
                await db.insertMergedZoneMeasurement(homeId, zoneId, {
                    '0x6240': 0,
                    '0x6280': null,
                    '0x6260': 0,
                    '0x6200': targetTemp,
                    '0x6440': 0
                });
            } catch (err) {
                log('error', `Failed to insert cleared overlay state measurement for ${zoneId}: ${err.message}`);
            }
        } else if (mode === 3 || mode === 1 || mode === 2) {
            const temp = decoded.fields['0x6280'];
            const hasSetpoint = decoded.fields['0x6260'];
            log('debug', `ZONE_STATE: Syncing active overlay for Z:${zoneId} (mode=${mode}, temp=${temp})`);
            await db.upsertZoneOverlay(homeId, zoneId, mode, temp, hasSetpoint).catch(err => {
                log('error', `Failed to upsert overlay for ${zoneId}: ${err.message}`);
            });
        }

        if (mqttPublisher) {
            db.getPool().execute('SELECT * FROM zone_measurements WHERE zone_id = ? AND home_id = ? ORDER BY id DESC LIMIT 1', [zoneId, homeId])
                .then(([rows]) => {
                    if (rows.length > 0) {
                        mqttPublisher.publishZoneStateTelemetry(homeId, zoneId, rows[0]).catch(() => { });
                    }
                }).catch(() => { });
        }

        if (typeof onStateChange === 'function') {
            onStateChange(homeId, 'zone-state', { zoneId });
        }
    }
}

module.exports = {
    init,
    handleZoneExtui,
    handleZoneActuator,
    handleZoneFallback,
    handleZoneOpenWindow,
    handleZoneConfig,
    handleCircuitActuator,
    handleCircuitConfig,
    handleZoneState
};
