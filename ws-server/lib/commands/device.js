/**
 * @file lib/commands/device.js
 * @brief Hardware device configuration command builders.
 */

'use strict';

const coap = require('../coap');
const tlv = require('../tlv');
const crypto = require('crypto');
const api = require('../command-api');

function updateFieldInMap(fields, key, value) {
    let fid = null;
    if (typeof key === 'number') {
        fid = key;
        key = '0x' + fid.toString(16).toLowerCase().padStart(4, '0');
    } else if (key.startsWith('0x')) {
        fid = parseInt(key, 16);
    } else if (key.startsWith('field_')) {
        fid = parseInt(key.substring(6), 16);
        if (!isNaN(fid)) {
            key = '0x' + fid.toString(16).toLowerCase().padStart(4, '0');
        } else {
            fid = null;
        }
    } else {
        fid = tlv.getFidByLabelName(key);
    }

    if (fid === null) {
        fields[key] = value;
        return;
    }

    if (fid === 0x0149) {
        value = api._db.unmapOrientation(value);
    }

    const fidHex = '0x' + fid.toString(16).toLowerCase().padStart(4, '0');
    const fieldKey = 'field_' + fid.toString(16).toLowerCase().padStart(4, '0');
    const label = tlv.getLabel(fid);
    const friendlyName = label ? label.name : null;

    [friendlyName, fidHex, fieldKey].forEach(k => {
        if (k && k !== key) delete fields[k];
    });

    fields[key] = value;
}

async function applyDeviceConfigOverrides(deviceId, fields, updates = null) {
    let dbDev = await api._db.getDeviceByFullSerial(deviceId);
    if (!dbDev) dbDev = await api._db.getDeviceBySerial(deviceId);
    if (dbDev) {
        const pairs = await api._db.getZoneBindingsForDevice(deviceId);
        if (pairs && pairs.length > 0) {
            updateFieldInMap(fields, '0x015e', pairs);
        } else {
            delete fields.zone_binding;
            delete fields['0x015e'];
            delete fields.field_015e;
            delete fields.field_015e_pairs;
        }

        const hasExplicitOffset = updates && (('0x0140' in updates) || ('field_0140' in updates));
        if (!hasExplicitOffset && dbDev.field_0140 !== undefined && dbDev.field_0140 !== null) {
            updateFieldInMap(fields, '0x0140', parseFloat(dbDev.field_0140));
        }

        const hasExplicitOrient = updates && (('0x0149' in updates) || ('field_0149' in updates) || ('va_orientation' in updates) || ('orientation' in updates));
        if (!hasExplicitOrient && dbDev.field_0149 !== undefined && dbDev.field_0149 !== null) {
            updateFieldInMap(fields, '0x0149', api._db.unmapOrientation(dbDev.field_0149));
        }

        if (dbDev.zone_id) {
            const [zoneRows] = await api._db.getPool().execute(
                'SELECT dazzle_enabled, offline_schedule_enabled, open_window_enabled, open_window_timeout FROM zones WHERE id = ? AND home_id = ?',
                [dbDev.zone_id, dbDev.home_id]
            );
            if (zoneRows.length > 0) {
                const dazzleEnabled = zoneRows[0].dazzle_enabled;
                const offlineScheduleEnabled = zoneRows[0].offline_schedule_enabled;
                const owdEnabled = zoneRows[0].open_window_enabled;
                const owdTimeout = zoneRows[0].open_window_timeout;

                updateFieldInMap(fields, 'device_ui_flags_0158', dazzleEnabled ? 0x0200 : 0x0000);
                updateFieldInMap(fields, '0x02b3', offlineScheduleEnabled ? 1 : 0);

                if (owdEnabled !== undefined && owdEnabled !== null) {
                    updateFieldInMap(fields, '0x60e0', owdEnabled ? 1 : 0);
                }
                if (owdTimeout !== undefined && owdTimeout !== null) {
                    updateFieldInMap(fields, '0x62c0', Math.round(owdTimeout / 60));
                }
            }
        }

        const isVA = deviceId.startsWith('VA');
        if (isVA) {
            const hash = api._db.calculateVADeviceETag(fields);
            let suffix = crypto.createHash('sha256').update(deviceId).digest('hex').substring(0, 12);
            if (dbDev.config_etag_real && dbDev.config_etag_real.length === 8) {
                suffix = dbDev.config_etag_real.slice(2).toString('hex');
            } else if (dbDev.config_etag && dbDev.config_etag.length === 8) {
                suffix = dbDev.config_etag.slice(2).toString('hex');
            } else if (dbDev.field_015a && dbDev.field_015a.length === 16) {
                suffix = dbDev.field_015a.substring(4);
            }
            const fullEtag = hash.toString(16).padStart(4, '0') + suffix;
            updateFieldInMap(fields, '0x015a', fullEtag);
        }
    }
}

async function handleDeviceConfigPush(req, res, deviceId) {
    const body = req.body;
    if (!body || !body.changes) return api.jsonResponse(res, 400, { error: 'Invalid JSON body: changes required' });

    let dbDev = await api._db.getDeviceByFullSerial(deviceId);
    if (!dbDev) dbDev = await api._db.getDeviceBySerial(deviceId);
    if (!dbDev) return api.jsonResponse(res, 404, { error: `Device ${deviceId} not found in DB` });

    try {
        api._log('info', `[cmd-api] Querying live device config for ${deviceId}`);
        const result = await api.queryDeviceConfig(deviceId, `d/${deviceId}/config`);

        const current = tlv.decode(result.payload);
        if (!current.ok) {
            return api.jsonResponse(res, 500, { error: 'Failed to decode current device config TLV' });
        }

        for (const [k, v] of Object.entries(body.changes)) {
            updateFieldInMap(current.fields, k, v);
        }
        await applyDeviceConfigOverrides(deviceId, current.fields, body.changes);

        const sortedFields = api.sortConfigFields(current.fields);
        const modifiedPayload = tlv.encodeFromFields(sortedFields);
        const etag = api._db.generateEtag(modifiedPayload).toString('hex');

        const extraOptions = [
            { num: 7, value: Buffer.from([0xff, 0xff]) },
            { num: 12, value: Buffer.from([0x2a]) }
        ];

        const mid = await api.internalPushViabridge(deviceId, coap.CODE_PUT, 'd/config', modifiedPayload, null, extraOptions, true);

        await api._db.updateLastConfigJsonFromLive(deviceId, sortedFields, etag);

        api.jsonResponse(res, 200, { ok: true, mid, etag });
    } catch (err) {
        api._log('error', `[cmd-api] handleDeviceConfigPush failed for ${deviceId}: ${err.message}`);
        api.jsonResponse(res, 504, { error: `Gateway Timeout: ${err.message}` });
    }
}

async function handleDeviceLock(req, res, deviceId) {
    const body = req.body || {};
    const enabled = !!body.enabled;
    try {
        await pushDeviceLock(deviceId, enabled);
        api.jsonResponse(res, 200, { ok: true });
    } catch (err) {
        api.jsonResponse(res, 404, { error: err.message });
    }
}

async function pushDeviceLock(deviceId, enabled = true) {
    const fid = 0x0290;
    const payloadBuffer = tlv.encode([{ fid, value: tlv.encodeValue(enabled ? 1 : 0, 'u8') }]);
    const extraOptions = [
        { num: 7, value: Buffer.from([0xff, 0xff]) },
        { num: 12, value: Buffer.from([0x2a]) }
    ];

    return api.internalPushViabridge(deviceId, coap.CODE_PUT, `d/lock`, payloadBuffer, null, extraOptions);
}

async function pushDeviceConfig(deviceId, updates) {
    api._log('info', `[cmd-api] Querying live device config for ${deviceId}`);
    const result = await api.queryDeviceConfig(deviceId, `d/${deviceId}/config`);

    const current = tlv.decode(result.payload);
    if (!current.ok) {
        throw new Error('Failed to decode current device config TLV');
    }

    for (const [k, v] of Object.entries(updates)) {
        updateFieldInMap(current.fields, k, v);
    }
    await applyDeviceConfigOverrides(deviceId, current.fields, updates);

    const sortedFields = api.sortConfigFields(current.fields);
    const modifiedPayload = tlv.encodeFromFields(sortedFields);
    const etag = api._db.generateEtag(modifiedPayload).toString('hex');

    const extraOptions = [
        { num: 7, value: Buffer.from([0xff, 0xff]) },
        { num: 12, value: Buffer.from([0x2a]) }
    ];

    try {
        const mid = await api.internalPushViabridge(deviceId, coap.CODE_PUT, `d/config`, modifiedPayload, null, extraOptions, true);
        await api._db.updateLastConfigJsonFromLive(deviceId, sortedFields, etag);
        return mid;
    } catch (err) {
        throw err;
    }
}

async function pushBridgePairing(deviceId, enabled) {
    return pushDevicePair(deviceId, !!enabled, deviceId);
}

async function handleDeviceIdentify(req, res, deviceId) {
    try {
        await pushDeviceIdentify(deviceId);
        api.jsonResponse(res, 200, { ok: true });
    } catch (err) {
        api.jsonResponse(res, 404, { error: err.message });
    }
}

async function pushDeviceIdentify(deviceId) {
    const extraOptions = [
        { num: 7, value: Buffer.from([0xff, 0xff]) },
        { num: 12, value: Buffer.from([0x2a]) }
    ];

    return api.internalPushViabridge(deviceId, coap.CODE_PUT, `d/identify`, Buffer.alloc(0), null, extraOptions, true);
}

async function handleDeviceReboot(req, res, deviceId) {
    try {
        await pushDeviceReboot(deviceId);
        api.jsonResponse(res, 200, { ok: true, message: `Reboot command sent to ${deviceId}` });
    } catch (err) {
        api.jsonResponse(res, 404, { error: err.message });
    }
}

async function pushDeviceReboot(deviceId) {
    const extraOptions = [
        { num: 7, value: Buffer.from([0xff, 0xff]) },
        { num: 12, value: Buffer.from([0x2a]) }
    ];

    return api.internalPushViabridge(deviceId, coap.CODE_POST, `d/reboot`, Buffer.alloc(0), null, extraOptions, true);
}

async function pushHomeIbReboot(homeId) {
    const parsedHomeId = parseInt(homeId, 10);
    if (isNaN(parsedHomeId)) throw new Error(`Invalid homeId: ${homeId}`);

    const pool = api._db.getPool();
    const [ibDevs] = await pool.execute(
        "SELECT serial_no FROM devices WHERE home_id = ? AND (device_type LIKE 'IB%' OR device_type = 'GW' OR device_type = 'BRIDGE' OR serial_no LIKE 'IB%')",
        [parsedHomeId]
    );

    if (!ibDevs || ibDevs.length === 0) {
        api._log('warn', `[cmd-api] No IB device found in DB for home ${parsedHomeId}`);
        return [];
    }

    const results = [];
    for (const dev of ibDevs) {
        try {
            const mid = await pushDeviceReboot(dev.serial_no);
            api._log('info', `[cmd-api] Sent restart command to IB ${dev.serial_no} for home ${parsedHomeId} (mid: ${mid})`);
            results.push({ serial_no: dev.serial_no, success: true, mid });
        } catch (err) {
            api._log('warn', `[cmd-api] Failed to send restart command to IB ${dev.serial_no} for home ${parsedHomeId}: ${err.message}`);
            results.push({ serial_no: dev.serial_no, success: false, error: err.message });
        }
    }
    return results;
}

async function handleDevicePair(req, res, deviceId) {
    const body = req.body || {};
    const enabled = !!body.enabled;
    const pairId = body.pairId || deviceId;
    try {
        await pushDevicePair(deviceId, enabled, pairId);
        api.jsonResponse(res, 200, { ok: true });
    } catch (err) {
        api.jsonResponse(res, 404, { error: err.message });
    }
}

const PAIRING_TIMEOUT_MS = 5 * 60 * 1000;
const pairingTimers = new Map();

function clearPairingTimer(deviceId) {
    if (pairingTimers.has(deviceId)) {
        clearTimeout(pairingTimers.get(deviceId));
        pairingTimers.delete(deviceId);
    }
}

async function pushDevicePair(deviceId, enabled = true, pairId = null, durationSeconds = 300) {
    if (!pairId) pairId = deviceId;

    clearPairingTimer(deviceId);

    if (enabled) {
        const timer = setTimeout(async () => {
            pairingTimers.delete(deviceId);
            try {
                const pool = api._db ? api._db.getPool() : null;
                if (pool) {
                    await pool.execute('UPDATE devices SET in_pairing_mode = 0 WHERE serial_no = ?', [deviceId]).catch(() => {});
                }
                await pushDevicePair(deviceId, false, pairId).catch(() => {});
            } catch (err) {
                // Ignore timeout errors
            }
        }, (durationSeconds || 300) * 1000);
        if (timer.unref) timer.unref();
        pairingTimers.set(deviceId, timer);
    }

    const durationHex = enabled ? Math.max(1, Math.min(65535, durationSeconds || 300)).toString(16).padStart(4, '0') : '0000';
    const payloadBuffer = Buffer.from(`01040000${durationHex}020100`, 'hex');

    const fullPathPart = `IB0000FT0100${pairId.replace(/^IB/, '')}`;
    const extraOptions = [
        { num: 7, value: Buffer.from([0xff, 0xff]) },
        { num: 12, value: Buffer.from([0x2a]) }
    ];

    return api.internalPushViabridge(deviceId, coap.CODE_POST, `d/I/${fullPathPart}/pair`, payloadBuffer, null, extraOptions, true, coap.TYPE_CON, null, 'pair');
}

async function pushDeviceFallback(deviceId, fallbackTempCelsius) {
    const tempScaled = Math.round(fallbackTempCelsius * 100);
    const payload = tlv.encode([
        { fid: 0x6200, value: tlv.encodeValue(tempScaled, 'u16be') }
    ]);
    const extraOptions = [
        { num: 7, value: Buffer.from([0xff, 0xff]) },
        { num: 12, value: Buffer.from([0x2a]) }
    ];
    return api.internalPushViabridge(
        deviceId, coap.CODE_PUT, 'd/fallback',
        payload, null, extraOptions, true, coap.TYPE_CON, null, `pushDeviceFallback:${deviceId}`
    );
}

async function pushDisplaySettings(deviceId, settings = {}) {
    const entries = [];

    if (settings.brightness !== undefined) {
        entries.push({ fid: 0x0a20, value: tlv.encodeValue(settings.brightness & 0xFF, 'u8') });
    }
    if (settings.wakeSensitivity !== undefined) {
        entries.push({ fid: 0x0a40, value: tlv.encodeValue(settings.wakeSensitivity & 0xFF, 'u8') });
    }
    if (settings.temperatureUnit !== undefined) {
        const unit = settings.temperatureUnit === 'FAHRENHEIT' ? 1 : 0;
        entries.push({ fid: 0x0a60, value: tlv.encodeValue(unit, 'u8') });
    }

    if (entries.length === 0) throw new Error('No display settings specified');

    const payload = tlv.encode(entries);
    const extraOptions = [
        { num: 7, value: Buffer.from([0xff, 0xff]) },
        { num: 12, value: Buffer.from([0x2a]) }
    ];
    return api.internalPushViabridge(
        deviceId, coap.CODE_PUT, 'd/dispsettings',
        payload, null, extraOptions, true, coap.TYPE_CON, null, `pushDisplaySettings:${deviceId}`
    );
}

async function pushMountCalibration(deviceId, action = 'start') {
    const actionByte = action === 'cancel' ? 2 : 1;
    const payload = tlv.encode([
        { fid: 0x08a0, value: tlv.encodeValue(actionByte, 'u8') }
    ]);
    const extraOptions = [
        { num: 7, value: Buffer.from([0xff, 0xff]) },
        { num: 12, value: Buffer.from([0x2a]) }
    ];
    return api.internalPushViabridge(
        deviceId, coap.CODE_PUT, 'd/mnt',
        payload, null, extraOptions, true, coap.TYPE_CON, null, `pushMountCalibration:${deviceId}`
    );
}

async function pushActuatorLimits(deviceId, limits = {}) {
    const entries = [];
    if (limits.lowSteps !== undefined && limits.lowSteps !== null) {
        entries.push({ fid: 0x0273, value: tlv.encodeValue(Number(limits.lowSteps) & 0xFFFF, 'u16be') });
    }
    if (limits.highSteps !== undefined && limits.highSteps !== null) {
        entries.push({ fid: 0x027c, value: tlv.encodeValue(Number(limits.highSteps) & 0xFFFF, 'u16be') });
    }
    if (limits.driveConstant !== undefined && limits.driveConstant !== null) {
        entries.push({ fid: 0x0280, value: tlv.encodeValue(Number(limits.driveConstant) & 0xFFFF, 'u16be') });
    }

    if (entries.length === 0) throw new Error('No actuator limits specified');
    const payload = tlv.encode(entries);
    const extraOptions = [
        { num: 7, value: Buffer.from([0xff, 0xff]) },
        { num: 12, value: Buffer.from([0x2a]) }
    ];
    return api.internalPushViabridge(
        deviceId, coap.CODE_PUT, 'd/config',
        payload, null, extraOptions, true, coap.TYPE_CON, null, `pushActuatorLimits:${deviceId}`
    );
}

async function pushSelftestTrigger(deviceId) {
    const payload = tlv.encode([
        { fid: 0x0900, value: tlv.encodeValue(1, 'u8') }
    ]);

    return api.internalPushViabridge(
        deviceId, coap.CODE_PUT, `d/${deviceId}/selftest`,
        payload, null, [], true, coap.TYPE_CON, null, `pushSelftestTrigger:${deviceId}`
    );
}

async function handleRfKeyRefresh(req, res, deviceId) {
    let dbDev = await api._db.getDeviceByFullSerial(deviceId);
    if (!dbDev) dbDev = await api._db.getDeviceBySerial(deviceId);
    if (!dbDev) return api.jsonResponse(res, 404, { error: `Device ${deviceId} not found in DB` });

    const bridge = api.findBridgeForHome(dbDev.home_id);
    if (!bridge) return api.jsonResponse(res, 503, { error: `No bridge connected for home ${dbDev.home_id}` });

    const mid = (Math.random() * 0xFFFF) | 0;
    const token = crypto.randomBytes(8);

    const extraOptions = [
        { num: 7, value: Buffer.from([0xff, 0xff]) },
        { num: 12, value: Buffer.from([0x2a]) }
    ];

    const coapBytes = coap.buildRequest({
        code: coap.CODE_GET,
        path: 'd/rfkey',
        token,
        mid,
        type: coap.TYPE_CON,
        payload: Buffer.alloc(0),
        extraOptions,
    });

    try {
        const targetIpv6 = dbDev.ipv6_address || (bridge.bridgeClient && bridge.bridgeClient.ipv6) || '::';
        const targetPort = dbDev.udp_port || (bridge.bridgeClient && bridge.bridgeClient.udpPort) || 5683;
        api.sendViaBridge(bridge.bridgeId, bridge.bridgeClient, targetIpv6, targetPort, coapBytes);
        api.jsonResponse(res, 200, { ok: true, message: `RF Key requested from ${deviceId}` });
    } catch (err) {
        api.jsonResponse(res, 500, { error: `Failed to send: ${err.message}` });
    }
}

async function handleGlobalConfigRefresh(req, res, deviceId) {
    try {
        await pushConfigRefresh(deviceId);
        api.jsonResponse(res, 200, { ok: true });
    } catch (err) {
        api.jsonResponse(res, 404, { error: err.message });
    }
}

async function pushConfigRefresh(deviceId) {
    api._log('info', `[cmd-api] Forcing live config refresh for ${deviceId}`);

    const result = await api.queryDeviceConfig(deviceId, `d/${deviceId}/config`);

    const current = tlv.decode(result.payload);
    if (!current.ok) {
        throw new Error('Failed to decode current device config TLV');
    }

    await applyDeviceConfigOverrides(deviceId, current.fields);

    let etag;
    const isVA = deviceId.startsWith('VA');
    if (isVA) {
        const dbDev = await api._db.getDeviceByFullSerial(deviceId) || await api._db.getDeviceBySerial(deviceId);
        let suffix = crypto.createHash('sha256').update(deviceId).digest('hex').substring(0, 12);
        if (dbDev) {
            if (dbDev.config_etag_real && dbDev.config_etag_real.length === 8) {
                suffix = dbDev.config_etag_real.slice(2).toString('hex');
            } else if (dbDev.config_etag && dbDev.config_etag.length === 8) {
                suffix = dbDev.config_etag.slice(2).toString('hex');
            } else if (dbDev.field_015a && dbDev.field_015a.length === 16) {
                suffix = dbDev.field_015a.substring(4);
            }
        }
        const hash = api._db.calculateVADeviceETag(current.fields);
        etag = hash.toString(16).padStart(4, '0') + suffix;
        updateFieldInMap(current.fields, '0x015a', etag);
    }

    const sortedFields = api.sortConfigFields(current.fields);
    const modifiedPayload = tlv.encodeFromFields(sortedFields);

    if (!isVA) {
        etag = api._db.generateEtag(modifiedPayload).toString('hex');
    }

    const extraOptions = [
        { num: 7, value: Buffer.from([0xff, 0xff]) },
        { num: 12, value: Buffer.from([0x2a]) }
    ];

    const mid = await api.internalPushViabridge(deviceId, coap.CODE_PUT, `d/config`, modifiedPayload, null, extraOptions, true);

    await api._db.updateLastConfigJsonFromLive(deviceId, sortedFields, etag);

    return mid;
}

async function pushDeviceUnassociation(homeId, deviceId) {
    const dbDev = await api._db.getDeviceByFullSerial(deviceId) || await api._db.getDeviceBySerial(deviceId);
    if (!dbDev) throw new Error(`Device ${deviceId} not found`);

    const bridge = api.findBridgeForHome(homeId);
    if (!bridge) throw new Error(`No bridge connected for home ${homeId}`);

    const fields = {};
    fields['0x0140'] = parseFloat(dbDev.field_0140) || 0;
    fields['0x019e'] = dbDev.display_brightness || 112;
    fields['0x0149'] = api._db.unmapOrientation(dbDev.field_0149);
    fields['0x0158'] = 0;
    fields['0x0143'] = false;

    let etag;
    if (deviceId.startsWith('VA')) {
        const hash = api._db.calculateVADeviceETag(fields);
        let suffix = crypto.createHash('sha256').update(deviceId).digest('hex').substring(0, 12);
        if (dbDev.config_etag_real && dbDev.config_etag_real.length === 8) {
            suffix = dbDev.config_etag_real.slice(2).toString('hex');
        } else if (dbDev.config_etag && dbDev.config_etag.length === 8) {
            suffix = dbDev.config_etag.slice(2).toString('hex');
        } else if (dbDev.field_015a && dbDev.field_015a.length === 16) {
            suffix = dbDev.field_015a.substring(4);
        }
        etag = hash.toString(16).padStart(4, '0') + suffix;
        fields['0x015a'] = etag;
    }

    const sortedFields = api.sortConfigFields(fields);
    const modifiedPayload = tlv.encodeFromFields(sortedFields);

    if (!deviceId.startsWith('VA')) {
        etag = api._db.generateEtag(modifiedPayload).toString('hex');
    }

    const extraOptions = [
        { num: 7, value: Buffer.from([0xff, 0xff]) },
        { num: 12, value: Buffer.from([0x2a]) }
    ];

    api._log('info', `[cmd-api] Pushing unassociation config to ${deviceId}`);
    const mid = await api.internalPushViabridge(
        deviceId, coap.CODE_PUT, 'd/config',
        modifiedPayload, etag, extraOptions, true, coap.TYPE_CON, null, `unassociate:${deviceId}`
    );

    await api._db.updateLastConfigJsonFromLive(deviceId, sortedFields, etag);
    return mid;
}

async function pushDeviceDebug(deviceId, subpath = 'st', params = {}) {
    let targetPath;
    if (typeof subpath === 'string' && subpath.includes('?')) {
        targetPath = subpath.startsWith('d/') ? subpath : `d/${subpath}`;
    } else if (subpath === 'st' || subpath === 'dbg/st') {
        targetPath = 'd/dbg/st';
    } else if (subpath === 'tlvs' || subpath === 'dbg2/tlvs') {
        const fid = params.fid || 320;
        const len = params.len || 2;
        targetPath = `d/dbg2/tlvs?fid=${fid}&len=${len}`;
    } else if (subpath === 'm' || subpath === 'dbg/m') {
        const adr = params.adr || '20000000';
        const len = params.len || 16;
        targetPath = `d/dbg/m?adr=${adr}&len=${len}`;
    } else if (subpath.startsWith('d/')) {
        targetPath = subpath;
    } else {
        targetPath = `d/dbg/${subpath}`;
    }

    const extraOptions = [
        { num: 7, value: Buffer.from([0xff, 0xff]) },
        { num: 12, value: Buffer.from([0x2a]) }
    ];

    return api.internalPushViabridge(deviceId, coap.CODE_GET, targetPath, Buffer.alloc(0), null, extraOptions, true, coap.TYPE_CON, null, `debug:${subpath}`);
}

async function pushUnassociateNeighborByIp(homeId, targetIpv6) {
    const bridge = api.findBridgeForHome(homeId);
    if (!bridge) throw new Error(`No bridge connected for home ${homeId}`);

    const fields = {};
    fields['0x0140'] = 0;
    fields['0x019e'] = 112;
    fields['0x0149'] = 0;
    fields['0x0158'] = 0;
    fields['0x0143'] = false;

    const sortedFields = api.sortConfigFields(fields);
    const modifiedPayload = tlv.encodeFromFields(sortedFields);

    const extraOptions = [
        { num: 7, value: Buffer.from([0xff, 0xff]) },
        { num: 12, value: Buffer.from([0x2a]) }
    ];

    api._log('info', `[cmd-api] Pushing unassociation config to neighbor IP ${targetIpv6} via bridge ${bridge.bridgeId}`);

    if (typeof api._db?.getDeviceByIPv6 === 'function') {
        const matchingDevSerial = await api._db.getDeviceByIPv6(targetIpv6);
        if (matchingDevSerial && typeof api._db?.updateDeviceConnectionState === 'function') {
            await api._db.updateDeviceConnectionState(matchingDevSerial, false);
        }
    }

    const coapBytes = coap.buildRequest({
        code: coap.CODE_PUT,
        path: 'd/config',
        token: crypto.randomBytes(4),
        mid: api.getNextMid(),
        type: coap.TYPE_CON,
        payload: modifiedPayload,
        extraOptions
    });

    api.sendViaBridge(bridge.bridgeId, bridge.bridgeClient, targetIpv6, 5683, coapBytes, `unassociate-neighbor:${targetIpv6}`);
    return true;
}

async function handleUnassociateNeighbor(req, res, deviceId) {
    const homeId = req.params.homeId || (req.body && req.body.homeId);
    const targetIpv6 = req.body && req.body.neighborIpv6;
    if (!targetIpv6) return api.jsonResponse(res, 400, { error: 'neighborIpv6 required' });
    try {
        await pushUnassociateNeighborByIp(homeId, targetIpv6);
        api.jsonResponse(res, 200, { ok: true, message: `Unassociation sent for neighbor IP ${targetIpv6}` });
    } catch (err) {
        api.jsonResponse(res, 500, { error: err.message });
    }
}

async function handleDeviceDebug(req, res, deviceId) {
    const body = req.body || {};
    const subpath = body.subpath || req.query.subpath || 'st';
    const params = {
        adr: body.adr || req.query.adr,
        fid: body.fid || req.query.fid,
        len: body.len || req.query.len
    };
    try {
        const mid = await pushDeviceDebug(deviceId, subpath, params);
        api.jsonResponse(res, 200, { ok: true, mid, message: `Debug request sent to ${deviceId}` });
    } catch (err) {
        api.jsonResponse(res, 500, { error: err.message });
    }
}

function targetPathName(subpath) {
    if (subpath === 'dbg2') return 'd/dbg2';
    if (subpath === 'st' || subpath === 'dbg/st') return 'd/dbg/st';
    if (subpath === 'tlvs' || subpath === 'dbg2/tlvs') return 'd/dbg2/tlvs';
    if (subpath === 'm' || subpath === 'dbg/m') return 'd/dbg/m';
    return 'd/dbg';
}

module.exports = {
    updateFieldInMap,
    applyDeviceConfigOverrides,
    handleDeviceConfigPush,
    handleDeviceLock,
    pushDeviceLock,
    pushDeviceConfig,
    pushBridgePairing,
    handleDeviceIdentify,
    pushDeviceIdentify,
    handleDeviceReboot,
    pushDeviceReboot,
    pushHomeIbReboot,
    handleDevicePair,
    pushDevicePair,
    pushDeviceFallback,
    pushDisplaySettings,
    pushMountCalibration,
    pushActuatorLimits,
    pushSelftestTrigger,
    handleRfKeyRefresh,
    handleGlobalConfigRefresh,
    pushConfigRefresh,
    pushDeviceUnassociation,
    pushUnassociateNeighborByIp,
    handleUnassociateNeighbor,
    pushDeviceDebug,
    handleDeviceDebug
};

