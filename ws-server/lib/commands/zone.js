/**
 * @file lib/commands/zone.js
 * @brief Heating and hot-water zone property commands.
 */

'use strict';

const coap = require('../coap');
const tlv = require('../tlv');
const crypto = require('crypto');
const api = require('../command-api');

async function handleZoneOverlay(req, res, homeId, zoneId) {
    const body = (req.body || {});
    if (!body || !body.setting) return api.jsonResponse(res, 400, { error: 'Invalid body' });
    const { setting, termination } = body;
    api._log('info', `[cmd-api] Overlay H:${homeId} Z:${zoneId} - ${JSON.stringify(setting)}`);

    try {
        await api._db.updateZoneOverlay(homeId, zoneId, setting, termination).catch(err => {
            api._log('warn', `[cmd-api] Failed to save overlay to database: ${err.message}`);
        });
        const result = await pushZoneOverlay(homeId, zoneId, setting, termination);
        return api.jsonResponse(res, 200, result);
    } catch (err) {
        return api.jsonResponse(res, 500, { error: err.message });
    }
}

async function pushZoneOverlay(homeId, zoneId, setting, termination) {
    const dbDevices = await api._db.getDevicesInZone(homeId, zoneId);
    const prevState = await api._db.getZoneState(homeId, zoneId) || {};

    const [zoneRows] = await api._db.getPool().execute('SELECT * FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
    const zone = zoneRows.length > 0 ? zoneRows[0] : null;
    const [circuits] = await api._db.getPool().execute('SELECT * FROM heating_circuits WHERE home_id = ?', [homeId]);

    let targetDevices = [...(dbDevices || [])];
    const circuit = circuits.find(c => (c.number === 1 || c.number === zoneId || (zone && zone.type === 'HOT_WATER')));
    if (targetDevices.length === 0 && zone) {
        if (circuit && circuit.driver_serial_no) {
            const driver = await api._db.getDeviceByFullSerial(circuit.driver_serial_no);
            if (driver) targetDevices.push(driver);
        }
    }

    let mode = 0;
    let temp = null;
    let hasSetpoint = 0;

    let resolvedTermination = termination;
    if (!resolvedTermination) {
        const defaults = await api._db.getZoneDefaultOverlay(homeId, zoneId);
        if (defaults) {
            resolvedTermination = {
                type: defaults.type,
                typeSkillBasedApp: defaults.type,
                durationInSeconds: defaults.durationInSeconds
            };
        }
    }

    if (resolvedTermination) {
        const type = resolvedTermination.typeSkillBasedApp || resolvedTermination.type;
        if (type === 'NEXT_TIME_BLOCK' || type === 'TIMER') {
            mode = 3;
        } else {
            mode = 2;
        }
    } else {
        mode = 2;
    }

    if (setting.power === 'ON') {
        if (setting.temperature) {
            temp = setting.temperature.celsius;
            hasSetpoint = 1;
        }
    } else {
        hasSetpoint = 0;
        temp = undefined;
        if (zone && zone.type !== 'HOT_WATER') {
            mode = 1;
        }
    }

    const tlvPayload = {
        '0x6160': prevState.field_6160 ?? 1,
        '0x6180': prevState.field_6180 ?? 0,
        '0x6020': (zone && zone.type === 'HOT_WATER') ? 2 : (prevState.field_6020 ?? 1),
        '0x61e0': prevState.field_61e0 ?? 1,
        '0x6200': prevState.field_6200 ?? 20,
        '0x6240': mode,
        '0x62e0': 0
    };

    if (mode !== 0) {
        const type = resolvedTermination ? (resolvedTermination.typeSkillBasedApp || resolvedTermination.type) : null;
        let include6440 = false;
        if (zone && zone.type === 'HOT_WATER') {
            if (type === 'TIMER' || type === 'MANUAL' || setting.power !== 'ON') {
                include6440 = true;
            }
        } else {
            if (type === 'TIMER') {
                include6440 = true;
            }
        }
        if (include6440) {
            tlvPayload['0x6440'] = 1;
        }
        tlvPayload['0x6260'] = hasSetpoint;
        tlvPayload['0x6280'] = temp;
    }

    Object.keys(tlvPayload).forEach(k => tlvPayload[k] === undefined && delete tlvPayload[k]);

    const sortedPayload = api.sortZoneStateFields(tlvPayload);

    const entries = [];
    for (const [key, val] of Object.entries(sortedPayload)) {
        const schema = api.ZS_SCHEMA[key];
        if (schema && schema.fid !== 0) {
            let rawVal = val;
            if (schema.scale && typeof val === 'number') {
                rawVal = Math.round(val / schema.scale);
            }
            try {
                entries.push({ fid: schema.fid, value: tlv.encodeValue(rawVal, schema.type) });
            } catch (e) {
                api._log('error', `[cmd-api] Error encoding ${key}: ${e.message}`);
            }
        }
    }

    const path = 'z/s';
    const payloadBuffer = tlv.encode(entries);

    let sentCount = 0;
    const bridge = api.findBridgeForHome(homeId);
    if (!bridge) {
        api._log('warn', `[cmd-api] No bridge connected for home ${homeId}, cannot push overlay`);
    } else if (targetDevices && targetDevices.length > 0) {
        const [zoneRows] = await api._db.getPool().execute('SELECT type, measuring_device_serial FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
        const leaderSerial = zoneRows.length > 0 ? zoneRows[0].measuring_device_serial : null;
        const zoneType = zoneRows.length > 0 ? zoneRows[0].type : null;

        const driverSerial = (circuit && circuit.driver_serial_no) ? circuit.driver_serial_no : null;

        for (const dev of targetDevices) {
            if (!dev.ipv6_address) continue;

            const isLeader = leaderSerial && dev.serial_no === leaderSerial;
            const isDriver = driverSerial && dev.serial_no === driverSerial;

            if (!isLeader && !isDriver && zoneType !== 'HOT_WATER') {
                api._log('debug', `[cmd-api] Skipping non-leader/non-driver device ${dev.serial_no} for z/s push`);
                continue;
            }

            api._log('info', `[cmd-api] Sending z/s to ${dev.serial_no} (${dev.ipv6_address}) via bridge ${bridge.bridgeId}`);

            const mid = (Math.random() * 0xFFFF) | 0;
            const token = crypto.randomBytes(6);

            const extraOptions = [
                { num: 7, value: Buffer.from([0xff, 0xff]) }
            ];

            const coapBytes = coap.buildRequest({
                code: coap.CODE_PUT,
                path,
                token,
                mid,
                type: coap.TYPE_CON,
                payload: payloadBuffer,
                contentFormat: 42,
                query: `id=${zoneId}`,
                extraOptions
            });

            api.sendViaBridge(bridge.bridgeId, bridge.bridgeClient, dev.ipv6_address, dev.udp_port || 5683, coapBytes);
            sentCount++;
        }
    } else {
        api._log('warn', `[cmd-api] No devices found in DB for H:${homeId} Z:${zoneId}`);
    }

    return {
        type: 'Overlay',
        setting,
        termination,
        devicesTargeted: sentCount
    };
}

async function handleZoneOverlayDelete(req, res, homeId, zoneId) {
    api._log('info', `[cmd-api] DELETE Overlay H:${homeId} Z:${zoneId}`);

    try {
        await api._db.deleteZoneOverlay(homeId, zoneId).catch(err => {
            api._log('warn', `[cmd-api] Failed to delete overlay from database: ${err.message}`);
        });
        const result = await pushZoneOverlayDelete(homeId, zoneId);
        return api.jsonResponse(res, 200, result);
    } catch (err) {
        return api.jsonResponse(res, 500, { error: err.message });
    }
}

async function pushZoneOverlayDelete(homeId, zoneId) {
    const dbDevices = await api._db.getDevicesInZone(homeId, zoneId);
    const prevState = await api._db.getZoneState(homeId, zoneId) || {};

    const [zoneRows] = await api._db.getPool().execute('SELECT * FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
    const zone = zoneRows.length > 0 ? zoneRows[0] : null;
    const [circuits] = await api._db.getPool().execute('SELECT * FROM heating_circuits WHERE home_id = ?', [homeId]);

    let targetDevices = [...(dbDevices || [])];
    const circuit = circuits.find(c => (c.number === 1 || c.number === zoneId || (zone && zone.type === 'HOT_WATER')));
    if (targetDevices.length === 0 && zone) {
        if (circuit && circuit.driver_serial_no) {
            const driver = await api._db.getDeviceByFullSerial(circuit.driver_serial_no);
            if (driver) targetDevices.push(driver);
        }
    }

    const finalEnabled = prevState.field_61e0 ?? 1;
    let tlvPayload = {
        '0x6160': prevState.field_6160 ?? 1,
        '0x6180': prevState.field_6180 ?? 0,
        '0x6020': (zone && zone.type === 'HOT_WATER') ? 2 : (prevState.field_6020 ?? 1),
        '0x61e0': finalEnabled,
        '0x6200': finalEnabled ? (prevState.field_6200 ?? 20) : undefined,
        '0x6240': 0,
        '0x62e0': 0,
        '0x6440': 1
    };

    Object.keys(tlvPayload).forEach(k => tlvPayload[k] === undefined && delete tlvPayload[k]);

    tlvPayload = api.sortZoneStateFields(tlvPayload);

    const entries = [];
    for (const [key, val] of Object.entries(tlvPayload)) {
        const schema = api.ZS_SCHEMA[key];
        if (schema && schema.fid !== 0) {
            let rawVal = val;
            if (schema.scale && typeof val === 'number') {
                rawVal = Math.round(val / schema.scale);
            }
            entries.push({ fid: schema.fid, value: tlv.encodeValue(rawVal, schema.type) });
        }
    }

    const payloadBuffer = tlv.encode(entries);
    let sentCount = 0;
    const bridge = api.findBridgeForHome(homeId);
    if (!bridge) {
        api._log('warn', `[cmd-api] No bridge connected for home ${homeId}, cannot push overlay delete`);
    } else if (targetDevices && targetDevices.length > 0) {
        const [zoneRows] = await api._db.getPool().execute('SELECT type, measuring_device_serial FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
        const leaderSerial = zoneRows.length > 0 ? zoneRows[0].measuring_device_serial : null;
        const zoneType = zoneRows.length > 0 ? zoneRows[0].type : null;

        const driverSerial = (circuit && circuit.driver_serial_no) ? circuit.driver_serial_no : null;

        for (const dev of targetDevices) {
            if (!dev.ipv6_address) continue;

            const isLeader = leaderSerial && dev.serial_no === leaderSerial;
            const isDriver = driverSerial && dev.serial_no === driverSerial;

            if (!isLeader && !isDriver && zoneType !== 'HOT_WATER') {
                api._log('debug', `[cmd-api] Skipping non-leader/non-driver device ${dev.serial_no} for overlay delete push`);
                continue;
            }

            const mid = (Math.random() * 0xFFFF) | 0;
            const token = crypto.randomBytes(6);
            const extraOptions = [
                { num: 7, value: Buffer.from([0xff, 0xff]) }
            ];

            const coapBytes = coap.buildRequest({
                code: coap.CODE_PUT,
                path: 'z/s',
                token,
                mid,
                type: coap.TYPE_CON,
                payload: payloadBuffer,
                contentFormat: 42,
                query: `id=${zoneId}`,
                extraOptions
            });

            api.sendViaBridge(bridge.bridgeId, bridge.bridgeClient, dev.ipv6_address, dev.udp_port || 5683, coapBytes);
            sentCount++;
        }
    }

    return {
        type: 'OverlayDelete',
        field_6240: 'SCHEDULE',
        devicesTargeted: sentCount
    };
}

async function pushScheduleTransition(homeId, zoneId) {
    const dbDevices = await api._db.getDevicesInZone(homeId, zoneId);
    const prevState = await api._db.getZoneState(homeId, zoneId) || {};

    const [zoneRows] = await api._db.getPool().execute('SELECT * FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
    const zone = zoneRows.length > 0 ? zoneRows[0] : null;
    const [circuits] = await api._db.getPool().execute('SELECT * FROM heating_circuits WHERE home_id = ?', [homeId]);

    let targetDevices = [...(dbDevices || [])];
    const circuit = circuits.find(c => (c.number === 1 || c.number === zoneId || (zone && zone.type === 'HOT_WATER')));

    if (targetDevices.length === 0 && zone) {
        if (circuit && circuit.driver_serial_no) {
            const driver = await api._db.getDeviceByFullSerial(circuit.driver_serial_no);
            if (driver) targetDevices.push(driver);
        }
    }

    const isHotWater = (zone && zone.type === 'HOT_WATER');
    const tlvPayload = {
        '0x6160': prevState.field_6160 ?? 1,
        '0x6180': prevState.field_6180 ?? 0,
        '0x6020': isHotWater ? 2 : (prevState.field_6020 ?? 1),
        '0x61e0': prevState.field_61e0 ?? 1,
        '0x6200': !(prevState.field_61e0 ?? 1) ? undefined : (prevState.field_6200 ?? (isHotWater ? 60 : 20)),
        '0x6240': prevState.field_6240 ?? 0,
        '0x62e0': prevState.field_62e0 ?? 0,
    };

    const overlayMode = prevState.field_6240 ?? 0;
    if (overlayMode > 0) {
        const ovTemp = prevState.field_6280;
        tlvPayload['0x6260'] = ovTemp != null ? 1 : 0;
        if (ovTemp != null) {
            tlvPayload['0x6280'] = ovTemp;
        }
    }

    Object.keys(tlvPayload).forEach(k => tlvPayload[k] === undefined && delete tlvPayload[k]);
    const sortedPayload = api.sortZoneStateFields(tlvPayload);

    const entries = [];
    for (const [key, val] of Object.entries(sortedPayload)) {
        const schema = api.ZS_SCHEMA[key];
        if (schema && schema.fid !== 0 && val !== undefined && val !== null) {
            let rawVal = val;
            if (schema.scale && typeof val === 'number') {
                rawVal = Math.round(val / schema.scale);
            }
            entries.push({ fid: schema.fid, value: tlv.encodeValue(rawVal, schema.type) });
        }
    }

    const payloadBuffer = tlv.encode(entries);
    let sentCount = 0;
    const bridge = api.findBridgeForHome(homeId);
    if (!bridge) {
        api._log('warn', `[cmd-api] No bridge connected for home ${homeId}, cannot push schedule transition`);
    } else if (targetDevices && targetDevices.length > 0) {
        const leaderSerial = zone ? zone.measuring_device_serial : null;
        const driverSerial = (circuit && circuit.driver_serial_no) ? circuit.driver_serial_no : null;

        for (const dev of targetDevices) {
            if (!dev.ipv6_address) continue;

            const isLeader = leaderSerial && dev.serial_no === leaderSerial;
            const isDriver = driverSerial && dev.serial_no === driverSerial;

            if (!isLeader && !isDriver && (!zone || zone.type !== 'HOT_WATER')) {
                api._log('debug', `[cmd-api] Skipping non-leader/non-driver device ${dev.serial_no} for schedule transition push`);
                continue;
            }

            api._log('info', `[cmd-api] Schedule transition push to ${dev.serial_no} Z:${zoneId} via bridge ${bridge.bridgeId}`);

            const mid = (Math.random() * 0xFFFF) | 0;
            const token = crypto.randomBytes(8);
            const extraOptions = [
                { num: 7, value: Buffer.from([0xff, 0xff]) }
            ];

            const coapBytes = coap.buildRequest({
                code: coap.CODE_PUT,
                path: 'z/s',
                token,
                mid,
                type: coap.TYPE_CON,
                payload: payloadBuffer,
                contentFormat: 42,
                query: `id=${zoneId}`,
                extraOptions
            });

            api.sendViaBridge(bridge.bridgeId, bridge.bridgeClient, dev.ipv6_address, dev.udp_port || 5683, coapBytes);
            sentCount++;
        }
    }

    return { type: 'ScheduleTransition', zoneId, devicesTargeted: sentCount };
}

async function pushZoneDazzleMode(homeId, zoneId, enabled) {
    if (!homeId) throw new Error('homeId is required for pushZoneDazzleMode');
    const { isReadOnly, devBypass } = await api.checkZoneConfigReadonly(homeId);
    if (isReadOnly && !devBypass) throw new Error('Zone config modifications are disabled (readonly)');
    
    const [devices] = await api._db.getPool().execute('SELECT serial_no FROM devices WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
    const serials = devices.map(d => d.serial_no);

    api._log('info', `[cmd-api] Pushing Dazzle ${enabled ? 'ON' : 'OFF'} to Z:${zoneId} (${serials.length} devices)`);

    await api._db.updateZoneConfig(homeId, zoneId, { dazzle_enabled: enabled ? 1 : 0 });

    for (const serial of serials) {
        await api.pushConfigRefresh(serial);
    }
}

async function pushZoneOWD(homeId, zoneId, active) {
    if (!homeId) throw new Error('homeId is required for pushZoneOWD');
    const { isReadOnly, devBypass } = await api.checkZoneConfigReadonly(homeId);
    if (isReadOnly && !devBypass) throw new Error('Zone config modifications are disabled (readonly)');
    await api._db.updateZoneOpenWindow(homeId, zoneId, active);
    
    const [devRows] = await api._db.getPool().execute('SELECT serial_no FROM devices WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
    const serials = devRows.map(d => d.serial_no);

    for (const serial of serials) {
        await api.pushConfigRefresh(serial);
    }
}

async function pushZoneFallback(homeId, zoneId, fallbackTempCelsius) {
    if (!homeId) throw new Error('homeId is required for pushZoneFallback');
    const pool = api._db.getPool();
    const [devRows] = await pool.execute(
        `SELECT d.serial_no FROM devices d
         WHERE d.zone_id = ? AND d.home_id = ?`, [zoneId, homeId]
    );
    if (devRows.length === 0) throw new Error(`No devices found for zone ${zoneId}`);

    const tempScaled = Math.round(fallbackTempCelsius * 100);
    const payload = tlv.encode([
        { fid: 0x6200, value: tlv.encodeValue(tempScaled, 'u16be') }
    ]);

    const extraOptions = [
        { num: 7, value: Buffer.from([0xff, 0xff]) },
        { num: 12, value: Buffer.from([0x2a]) }
    ];
    const mids = [];
    for (const dev of devRows) {
        const mid = await api.internalPushViabridge(
            dev.serial_no, coap.CODE_PUT, 'd/fallback',
            payload, null, extraOptions, true, coap.TYPE_CON, null, `pushZoneFallback:z${zoneId}`
        );
        mids.push(mid);
    }
    return mids;
}

async function pushOpenWindowCancel(homeId, zoneId) {
    if (zoneId === undefined) {
        zoneId = homeId;
        homeId = null;
    }
    const pool = api._db.getPool();
    if (!homeId) {
        const [rows] = await pool.execute('SELECT home_id FROM zones WHERE id = ?', [zoneId]);
        if (rows.length > 0) {
            homeId = rows[0].home_id;
        } else {
            throw new Error(`No home found for zone ${zoneId}`);
        }
    }
    const [devRows] = await pool.execute(
        `SELECT d.serial_no FROM devices d
         WHERE d.zone_id = ? AND d.home_id = ?`, [zoneId, homeId]
    );
    if (devRows.length === 0) throw new Error(`No devices found for zone ${zoneId}`);

    const payload = tlv.encode([
        { fid: 0x0c00, value: tlv.encodeValue(0, 'u8') }
    ]);

    await api._db.updateZoneOpenWindow(homeId, zoneId, false);

    const mids = [];
    for (const dev of devRows) {
        const mid = await api.internalPushViabridge(
            dev.serial_no, coap.CODE_PUT, `z/ow`,
            payload, null, [{ num: coap.OPT_URI_QUERY, value: Buffer.from(`id=${zoneId}`) }],
            true, coap.TYPE_CON, null, `pushOpenWindowCancel:z${zoneId}`
        );
        mids.push(mid);
    }
    return mids;
}

async function pushOpenWindowActivate(homeId, zoneId) {
    if (zoneId === undefined) {
        zoneId = homeId;
        homeId = null;
    }
    const pool = api._db.getPool();
    if (!homeId) {
        const [rows] = await pool.execute('SELECT home_id FROM zones WHERE id = ?', [zoneId]);
        if (rows.length > 0) {
            homeId = rows[0].home_id;
        } else {
            throw new Error(`No home found for zone ${zoneId}`);
        }
    }
    const [devRows] = await pool.execute(
        `SELECT d.serial_no FROM devices d
         WHERE d.zone_id = ? AND d.home_id = ?`, [zoneId, homeId]
    );
    if (devRows.length === 0) throw new Error(`No devices found for zone ${zoneId}`);

    const payload = tlv.encode([
        { fid: 0x0c00, value: tlv.encodeValue(1, 'u8') }
    ]);

    await api._db.updateZoneOpenWindow(homeId, zoneId, true);

    const mids = [];
    for (const dev of devRows) {
        const mid = await api.internalPushViabridge(
            dev.serial_no, coap.CODE_PUT, `z/ow`,
            payload, null, [{ num: coap.OPT_URI_QUERY, value: Buffer.from(`id=${zoneId}`) }],
            true, coap.TYPE_CON, null, `pushOpenWindowActivate:z${zoneId}`
        );
        mids.push(mid);
    }
    return mids;
}

async function pushZoneExtUI(homeId, zoneId, uiState = {}) {
    if (!homeId) throw new Error('homeId is required for pushZoneExtUI');
    const pool = api._db.getPool();
    const [devRows] = await pool.execute(
        `SELECT d.serial_no FROM devices d
         WHERE d.zone_id = ? AND d.home_id = ? AND d.device_type IN ('VA', 'SU', 'WR')`, [zoneId, homeId]
    );
    if (devRows.length === 0) throw new Error(`No display devices found for zone ${zoneId}`);

    const entries = [];
    if (uiState.mode !== undefined) entries.push({ fid: 0x6600, value: tlv.encodeValue(uiState.mode & 0xFF, 'u8') });
    if (uiState.icon !== undefined) entries.push({ fid: 0x6620, value: tlv.encodeValue(uiState.icon & 0xFF, 'u8') });
    if (uiState.text !== undefined) entries.push({ fid: 0x6640, value: tlv.encodeValue(uiState.text, 'string') });

    if (entries.length === 0) throw new Error('No ExtUI state specified');
    const payload = tlv.encode(entries);

    const mids = [];
    for (const dev of devRows) {
        const mid = await api.internalPushViabridge(
            dev.serial_no, coap.CODE_PUT, `z/extui`,
            payload, null, [{ num: coap.OPT_URI_QUERY, value: Buffer.from(`id=${zoneId}`) }],
            true, coap.TYPE_CON, null, `pushZoneExtUI:z${zoneId}`
        );
        mids.push(mid);
    }
    return mids;
}

async function pushHomeAway(homeId, isAway) {
    const pool = api._db.getPool();
    const [zones] = await pool.execute('SELECT id, name, type FROM zones WHERE home_id = ?', [homeId]);
    if (!zones || zones.length === 0) {
        api._log('warn', `[cmd-api] No zones found for home ${homeId}`);
        return { type: 'HomeAway', homePresence: isAway ? 'AWAY' : 'HOME', zonesTargeted: 0 };
    }

    const bridge = api.findBridgeForHome(homeId);
    if (!bridge) {
        api._log('warn', `[cmd-api] No bridge connected for home ${homeId}`);
        return { type: 'HomeAway', homePresence: isAway ? 'AWAY' : 'HOME', zonesTargeted: 0, devicesPushed: 0 };
    }

    const [awayConfigs] = await pool.execute('SELECT * FROM away_configurations WHERE home_id = ?', [homeId]);
    const [circuits] = await pool.execute('SELECT * FROM heating_circuits WHERE home_id = ?', [homeId]);

    const ZS_FIELDS = api.ZS_SCHEMA;

    let totalSent = 0;

    for (const zone of zones) {
        const prevState = await api._db.getZoneState(homeId, zone.id) || {};
        const dbDevices = await api._db.getDevicesInZone(homeId, zone.id);
        const awayConfig = awayConfigs.find(c => c.zone_id === zone.id);

        let targetDevices = [...dbDevices];

        const circuitForZone = circuits.find(c => c.number === 1 || c.number === zone.id || zone.type === 'HOT_WATER');
        const driverSerial = (circuitForZone && circuitForZone.driver_serial_no) ? circuitForZone.driver_serial_no : null;

        if (targetDevices.length === 0 && driverSerial) {
            const driver = await api._db.getDeviceByFullSerial(driverSerial);
            if (driver) targetDevices.push(driver);
        }

        if (targetDevices.length === 0) {
            api._log('debug', `[cmd-api] No target devices found for Z:${zone.id} (${zone.name})`);
            continue;
        }

        let enabled = isAway ? 0 : 1;
        let temp = null;

        if (isAway && awayConfig) {
            const type = awayConfig.type || 'HEATING';
            if (type === 'HEATING') {
                enabled = 1;
                if (awayConfig.min_away_temp_celsius !== null && awayConfig.min_away_temp_celsius !== undefined) {
                    temp = parseFloat(awayConfig.min_away_temp_celsius);
                }
            } else if (type === 'FIXED_SETTING') {
                enabled = awayConfig.setting_power === 'ON' ? 1 : 0;
                if (awayConfig.setting_temp_celsius !== null && awayConfig.setting_temp_celsius !== undefined) {
                    temp = parseFloat(awayConfig.setting_temp_celsius);
                }
            }
        } else if (!isAway) {
            enabled = prevState.field_61e0 ?? 1;
            temp = prevState.field_6200 ?? 20;
        }

        const finalEnabled = enabled;
        const tlvPayload = {
            '0x6160': isAway ? 2 : 1,
            '0x6180': prevState.field_6180 ?? 0,
            '0x6020': zone.type === 'HOT_WATER' ? 2 : 1,
            '0x61e0': finalEnabled,
            '0x6240': 0,
            '0x62e0': 0,
            '0x6440': 1
        };

        if (finalEnabled && temp !== null) {
            tlvPayload['0x6200'] = temp;
        }

        Object.keys(tlvPayload).forEach(k => tlvPayload[k] === undefined && delete tlvPayload[k]);
        const sortedPayload = api.sortZoneStateFields(tlvPayload);

        const entries = [];
        for (const [key, val] of Object.entries(sortedPayload)) {
            const schema = ZS_FIELDS[key];
            if (schema && schema.fid !== 0) {
                let rawVal = val;
                if (schema.scale && typeof val === 'number') {
                    rawVal = Math.round(val / schema.scale);
                }
                try {
                    entries.push({ fid: schema.fid, value: tlv.encodeValue(rawVal, schema.type) });
                } catch (e) {
                    api._log('error', `[cmd-api] Error encoding ${key}: ${e.message}`);
                }
            }
        }

        const payloadBuffer = tlv.encode(entries);

        const [zoneRows] = await pool.execute('SELECT measuring_device_serial FROM zones WHERE id = ? AND home_id = ?', [zone.id, homeId]);
        const leaderSerial = zoneRows.length > 0 ? zoneRows[0].measuring_device_serial : null;

        for (const dev of targetDevices) {
            if (!dev.ipv6_address) continue;

            const isLeader = leaderSerial && dev.serial_no === leaderSerial;
            const isDriver = driverSerial && dev.serial_no === driverSerial;

            if (!isLeader && !isDriver && zone.type !== 'HOT_WATER') {
                api._log('debug', `[cmd-api] Skipping non-leader/non-driver device ${dev.serial_no} for home/away push`);
                continue;
            }

            api._log('info', `[cmd-api] Home/Away push to ${dev.serial_no} Z:${zone.id} via bridge ${bridge.bridgeId}`);

            const mid = (Math.random() * 0xFFFF) | 0;
            const tokenLen = Math.floor(Math.random() * 8) + 1;
            const token = crypto.randomBytes(tokenLen);

            const extraOptions = [
                { num: 7, value: Buffer.from([0xff, 0xff]) }
            ];

            const coapBytes = coap.buildRequest({
                code: coap.CODE_PUT,
                path: 'z/s',
                token,
                mid,
                type: coap.TYPE_CON,
                payload: payloadBuffer,
                contentFormat: 42,
                query: `id=${zone.id}`,
                extraOptions
            });

            api.sendViaBridge(bridge.bridgeId, bridge.bridgeClient, dev.ipv6_address, dev.udp_port || 5683, coapBytes);
            totalSent++;
        }
    }

    return {
        type: 'HomeAway',
        homePresence: isAway ? 'AWAY' : 'HOME',
        zonesTargeted: zones.length,
        devicesPushed: totalSent
    };
}

module.exports = {
    handleZoneOverlay,
    pushZoneOverlay,
    handleZoneOverlayDelete,
    pushZoneOverlayDelete,
    pushScheduleTransition,
    pushZoneDazzleMode,
    pushZoneOWD,
    pushZoneFallback,
    pushOpenWindowCancel,
    pushOpenWindowActivate,
    pushZoneExtUI,
    pushHomeAway
};
