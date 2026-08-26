/**
 * @file lib/db-zones/state.js
 * @brief Zone state, timetable schedule, and overlay database queries.
 *
 * @module db-zones/state
 *
 * Zone-related DB operations.
 * Handles zone configurations, states, timetable schedules, overlays, and circuit configurations.
 */

'use strict';
const { getPool, _log, safeJsonParse, generateEtag, cleanFriendlyConfig, tadoHashStep, getFieldVal, calculateVADeviceETag, tlvNameToHex, mapOrientation } = require('../db-base');
const { getDeviceByFullSerial, getDeviceBySerial } = require('../db-devices');
const tlv = require('../tlv');
const { getLocalParts, parseLocalTimeInTimezone } = require('../utils');

// ==========================================
// 1. Zone ETag and Liveness Checking
// ==========================================

const dbHomes = require('../db-homes');
const getHomeTimezone = dbHomes.getHomeTimezone;
const getHome = dbHomes.getHome;
const getHomeState = dbHomes.getHomeState;

const { getZoneScheduleState } = require('./schedule');

async function getZoneState(homeId, zoneId) {
    if (!homeId) throw new Error('homeId is required for getZoneState');
    const p = getPool();
    const [rows] = await p.execute(`SELECT * FROM zone_measurements WHERE zone_id = ? AND home_id = ? AND field_6240 IS NOT NULL ORDER BY timestamp DESC LIMIT 1`, [zoneId, homeId]);
    if (rows.length === 0) return null;
    const state = rows[0];

    // Use live home presence (not stale field_6160 from zone_measurements)
    const home = await getHome(homeId);
    const livePresence = home?.presence === 'AWAY' ? 2 : 1;
    const presenceMode = livePresence;
    const sched = await getZoneScheduleState(homeId, zoneId, presenceMode);

    // Remap to strict hex keys for wire compatibility
    const result = {
        '0x6160': livePresence,
        '0x61e0': sched.enabled,
        '0x6200': sched.targetTemp,
        '0x6020': state.field_6020 ?? 1,
        '0x6180': state.field_6180 ?? 0,
        '0x6240': state.field_6240 ?? 0,
        '0x6280': state.field_6280 ?? null,
        '0x6260': state.field_6260 ?? 0,
        '0x62e0': state.field_62e0 ?? 0,
        '0x6440': state.field_6440 ?? null,
        open_window_detected: state.open_window_detected ?? 0
    };

    // Add field_xxxx keys for compatibility with consumers expecting old schema format
    result.field_6160 = result['0x6160'];
    result.field_61e0 = result['0x61e0'];
    result.field_6200 = result['0x6200'];
    result.field_6020 = result['0x6020'];
    result.field_6180 = result['0x6180'];
    result.field_6240 = result['0x6240'];
    result.field_6280 = result['0x6280'];
    result.field_6260 = result['0x6260'];
    result.field_62e0 = result['0x62e0'];
    result.field_6440 = result['0x6440'];

    return result;
}

async function getZoneStateFallback(homeId, zoneId) {
    if (!homeId) throw new Error('homeId is required for getZoneStateFallback');
    const p = getPool();
    const [rows] = await p.execute('SELECT * FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
    if (rows.length === 0) return null;
    const zone = rows[0];
    const actualHomeId = zone.home_id;

    // Try without the field_6240 IS NOT NULL filter
    const [mRows] = await p.execute(
        'SELECT * FROM zone_measurements WHERE zone_id = ? AND home_id = ? ORDER BY timestamp DESC LIMIT 1',
        [zoneId, actualHomeId]
    );

    const isDhw = zone.type === 'HOT_WATER' || String(zoneId) === '0';

    if (mRows.length > 0) {
        const state = mRows[0];
        const home = await getHome(actualHomeId);
        const livePresence = home?.presence === 'AWAY' ? 2 : 1;
        const presenceMode = livePresence;
        const sched = await getZoneScheduleState(actualHomeId, zoneId, presenceMode);
        // Remap to match ZS_SCHEMA in server.js — keep numeric types for wire parity
        const result = {
            '0x6160': livePresence,
            '0x61e0': sched.enabled,
            '0x6200': sched.targetTemp,
            '0x6020': state.field_6020 ?? (isDhw ? 2 : 1),
            '0x6180': state.field_6180 ?? 0,
            '0x6240': state.field_6240 ?? 0,
            '0x6280': state.field_6280 ?? null,
            '0x6260': state.field_6260 ?? 0,
            '0x62e0': state.field_62e0 ?? 0
        };
        result.field_6160 = result['0x6160'];
        result.field_61e0 = result['0x61e0'];
        result.field_6200 = result['0x6200'];
        result.field_6020 = result['0x6020'];
        result.field_6180 = result['0x6180'];
        result.field_6240 = result['0x6240'];
        result.field_6280 = result['0x6280'];
        result.field_6260 = result['0x6260'];
        result.field_62e0 = result['0x62e0'];
        return result;
    }

    // Synthesize minimal state from zone metadata
    const result = {
        '0x6160': 1,
        '0x61e0': zone.heating_enabled ?? 1,
        '0x6200': isDhw ? null : 20,
        '0x6020': isDhw ? 2 : 1,
        '0x6180': 0,
        '0x6240': 0,
        '0x6280': null,
        '0x6260': 0,
        '0x62e0': 0,
    };
    result.field_6160 = result['0x6160'];
    result.field_61e0 = result['0x61e0'];
    result.field_6200 = result['0x6200'];
    result.field_6020 = result['0x6020'];
    result.field_6180 = result['0x6180'];
    result.field_6240 = result['0x6240'];
    result.field_6280 = result['0x6280'];
    result.field_6260 = result['0x6260'];
    result.field_62e0 = result['0x62e0'];
    return result;
}

async function getZonesForHome(homeId) {
    const p = getPool();
    const [rows] = await p.execute('SELECT id, name, type FROM zones WHERE home_id = ?', [homeId]);
    return rows;
}

async function insertZoneMeasurement(homeId, zoneId, tempCelsius, humidityPct, heatingPower, linkState = 'ONLINE', tadoMode = 'HOME') {
    await insertMergedZoneMeasurement(homeId, zoneId, {
        '0x012d': tempCelsius,
        '0x0135': humidityPct,
        '0x40a0': heatingPower,
        link_state: linkState,
        tado_mode: tadoMode
    });
}

async function insertMergedZoneMeasurement(homeId, zoneId, updates) {
    const p = getPool();
    const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    const etag = generateEtag();

    const [rows] = await p.execute(
        'SELECT * FROM zone_measurements WHERE zone_id = ? AND home_id = ? ORDER BY id DESC LIMIT 1',
        [zoneId, homeId]
    );

    const prev = rows.length > 0 ? rows[0] : {};

    const tempCelsius = updates['0x012d'] !== undefined ? updates['0x012d'] : (prev.field_012d ?? null);
    const humidityPct = updates['0x0135'] !== undefined ? updates['0x0135'] : (prev.field_0135 ?? null);
    const heatingPower = updates['0x40a0'] !== undefined ? updates['0x40a0'] : (prev.field_40a0 ?? null);
    const linkState = updates.link_state !== undefined ? updates.link_state : (prev.link_state ?? 'ONLINE');
    const tadoMode = updates.tado_mode !== undefined ? updates.tado_mode : (prev.tado_mode ?? 'HOME');
    const zoneEnabled = updates['0x61e0'] !== undefined ? updates['0x61e0'] : (prev.field_61e0 ?? 1);
    const homeAwayLiteral = updates['0x6160'] !== undefined ? updates['0x6160'] : (prev.field_6160 ?? 1);
    let homeAway = homeAwayLiteral;
    if (homeAway === 'HOME') homeAway = 1;
    else if (homeAway === 'AWAY') homeAway = 2;
    else homeAway = parseInt(homeAway) || 1;

    const overlayMode = updates['0x6240'] !== undefined ? updates['0x6240'] : (prev.field_6240 ?? null);
    const overlayTargetTemp = updates['0x6280'] !== undefined ? updates['0x6280'] : (prev.field_6280 ?? null);
    const scheduleTemp = updates['0x6200'] !== undefined ? updates['0x6200'] : (prev.field_6200 ?? null);
    const overlayHasSetpoint = updates['0x6260'] !== undefined ? updates['0x6260'] : (prev.field_6260 ?? null);
    const zoneServiceType = updates['0x6020'] !== undefined ? updates['0x6020'] : (prev.field_6020 ?? null);
    const zoneStateFlag = updates['0x6180'] !== undefined ? updates['0x6180'] : (prev.field_6180 ?? null);
    const overlayStateAux = updates['0x62e0'] !== undefined ? updates['0x62e0'] : (prev.field_62e0 ?? null);
    const resumeScheduleEvent = updates['0x6440'] !== undefined ? updates['0x6440'] : (prev.field_6440 ?? null);
    const openWindowDetected = updates.open_window_detected !== undefined ? updates.open_window_detected : (prev.open_window_detected ?? 0);

    await p.execute(
        `INSERT INTO zone_measurements 
         (home_id, zone_id, timestamp, field_012d, field_0135, field_40a0, link_state, tado_mode,
          field_61e0, field_6160, field_6240, field_6280, field_6200, field_6260,
          field_6020, field_6180, field_62e0, field_6440, open_window_detected)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            homeId, zoneId, now, tempCelsius, humidityPct, heatingPower, linkState, tadoMode,
            zoneEnabled, homeAway, overlayMode, overlayTargetTemp, scheduleTemp, overlayHasSetpoint,
            zoneServiceType, zoneStateFlag, overlayStateAux, resumeScheduleEvent, openWindowDetected
        ]
    );

    // Update the zone state/config ETags
    if (updates['0x6240'] !== undefined || updates.tado_mode !== undefined) {
        await p.execute('UPDATE zones SET state_etag=? WHERE id=? AND home_id=?', [etag, zoneId, homeId]);
    }
    if (updates['0x61e0'] !== undefined) {
        await p.execute('UPDATE zones SET config_etag=? WHERE id=? AND home_id=?', [etag, zoneId, homeId]);
    }
    // Only log temp/humidity if they're present (DHW zones like zone 0 have no sensors)
    if (tempCelsius != null || humidityPct != null) {
        _log('debug', `zone_measurements: home=${homeId} zone=${zoneId} temp=${tempCelsius}°C hum=${humidityPct}% heat=${heatingPower ?? 0}% sch=${scheduleTemp} ovr=${overlayMode}`);
    } else {
        _log('debug', `zone_measurements: home=${homeId} zone=${zoneId} [DHW] sch=${scheduleTemp}°C ovr=${overlayMode} enabled=${zoneEnabled}`);
    }
}

async function insertDeviceMeasurement(serial, homeId, zoneId, fields) {
    const p = getPool();
    const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    const query = `
        INSERT INTO device_measurements 
        (device_serial, home_id, zone_id, timestamp, 
         field_012d, field_012e, field_01c8, field_0135, 
         field_0162, field_0136, field_027a, field_0137, 
         field_0161, field_0160)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const etag = generateEtag();
    await p.execute(query, [
        serial, homeId, zoneId, now,
        fields['0x012d'] ?? null,
        fields['0x012e'] ?? null,
        fields['0x01c8'] ?? null,
        fields['0x0135'] ?? null,
        fields['0x0162'] ?? null,
        fields['0x0136'] ?? null,
        fields['0x027a'] ?? null,
        fields['0x0137'] ?? null,
        fields['0x0161'] ?? null,
        fields['0x0160'] ?? null
    ]);
    await p.execute('UPDATE devices SET sen_etag=? WHERE serial_no=?', [etag, serial]);
}

async function insertZoneState(homeId, zoneId, fields) {
    await insertMergedZoneMeasurement(homeId, zoneId, {
        '0x61e0': fields['0x61e0'],
        '0x6160': fields['0x6160'],
        '0x6240': fields['0x6240'],
        '0x6260': fields['0x6260'],
        '0x6280': fields['0x6280'],
        '0x6200': fields['0x6200'],
        '0x6020': fields['0x6020'],
        '0x6180': fields['0x6180'],
        '0x62e0': fields['0x62e0'],
    });
}

async function insertZoneDemand(homeId, zoneId, demandPercent) {
    await insertMergedZoneMeasurement(homeId, zoneId, { '0x40a0': demandPercent });
}

async function getZoneMeasurementsForTimeRange(homeId, zoneId, startUtc, endUtc) {
    if (!homeId) throw new Error('homeId is required for getZoneMeasurementsForTimeRange');
    const p = getPool();
    const [rows] = await p.execute(`
        SELECT * FROM zone_measurements 
        WHERE zone_id = ? AND home_id = ?
          AND timestamp >= ? 
          AND timestamp <= ?
        ORDER BY timestamp ASC
    `, [zoneId, homeId, startUtc, endUtc]);
    return rows;
}

async function getZoneType(homeId, zoneId) {
    if (!homeId) throw new Error('homeId is required for getZoneType');
    const p = getPool();
    const [rows] = await p.execute('SELECT type FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
    return rows.length > 0 ? rows[0].type : 'HEATING';
}

async function updateZoneFallback(homeId, zoneId, val) {
    if (!homeId) throw new Error('homeId is required for updateZoneFallback');
    const p = getPool();
    await p.execute('UPDATE zones SET fallback_value=? WHERE id=? AND home_id=?', [val, zoneId, homeId]);
}

async function updateZoneConfig(homeId, zoneId, fields, fullConfigJson) {
    if (!homeId) throw new Error('homeId is required for updateZoneConfig');
    const p = getPool();
    const [rows] = await p.execute('SELECT last_config_json FROM zones WHERE id=? AND home_id=?', [zoneId, homeId]);

    let mergedConfig = rows.length > 0 ? safeJsonParse(rows[0].last_config_json) : {};
    if (fullConfigJson) {
        Object.assign(mergedConfig, fullConfigJson);
    }

    // Inverse Sync: Merge specific DB fields into the JSON template
    if (fields.dazzle_enabled !== undefined) mergedConfig.dazzle_enabled = fields.dazzle_enabled;
    if (fields.field_61e0 !== undefined) mergedConfig.field_61e0 = fields.field_61e0;

    // Merge incoming hex fields
    for (const [k, v] of Object.entries(fields)) {
        if (k.startsWith('0x') && v !== undefined) {
            mergedConfig[k] = v;
        }
    }

    mergedConfig = cleanFriendlyConfig(mergedConfig);

    const etag = generateEtag();
    const sqlUpdates = ['last_config_json=?', 'config_etag=?'];
    const params = [JSON.stringify(mergedConfig), etag];

    if (fields.dazzle_enabled !== undefined) {
        sqlUpdates.push('dazzle_enabled=?');
        params.push(fields.dazzle_enabled ? 1 : 0);
    }

    const tlvMappings = {
        '0x60a0': ['field_60a0', 'frost_min_temperature', 'zone_frost_min_temperature', 'frostMinTemperature'],
        '0x60c0': ['field_60c0', 'temperature_baseline', 'zone_temperature_baseline', 'temperatureBaseline'],
        '0x6080': ['field_6080', 'temperature_deviation_limit', 'zone_temperature_deviation_limit', 'temperatureDeviationLimit'],
        '0x6340': ['field_6340', 'owd_nvm_state', 'owdNvmState']
    };

    for (const [hexId, keys] of Object.entries(tlvMappings)) {
        let val = fields[hexId];
        if (val === undefined) {
            for (const k of keys) {
                if (fields[k] !== undefined) {
                    val = fields[k];
                    break;
                }
            }
        }
        if (val !== undefined) {
            mergedConfig[hexId] = val;
            sqlUpdates.push(`${keys[0]}=?`);
            params.push(val);
        }
    }

    params.push(zoneId);
    params.push(homeId);
    await p.execute(
        `UPDATE zones SET ${sqlUpdates.join(', ')} WHERE id=? AND home_id=?`,
        params
    );
}

async function mergeZoneMeasurement(homeId, zoneId, updates) {
    return insertMergedZoneMeasurement(homeId, zoneId, updates);
}

async function getLatestZoneMeasurement(homeId, zoneId) {
    if (!homeId) throw new Error('homeId is required for getLatestZoneMeasurement');
    const p = getPool();
    const [rows] = await p.execute('SELECT * FROM zone_measurements WHERE zone_id=? AND home_id=? ORDER BY timestamp DESC LIMIT 1', [zoneId, homeId]);
    return rows.length > 0 ? rows[0] : null;
}

async function updateLastConfigJsonFromLive(serial, decodedFields, etag) {
    const p = getPool();
    const dbDev = await getDeviceByFullSerial(serial);
    if (!dbDev) return;

    let mergedConfig = safeJsonParse(dbDev.last_config_json);
    Object.assign(mergedConfig, decodedFields);
    mergedConfig = cleanFriendlyConfig(mergedConfig);

    const tempOffset = decodedFields['0x0140'] ?? decodedFields.field_0140;
    const rawOrient = decodedFields['0x0149'] ?? decodedFields.config_field_0149 ?? decodedFields.va_orientation ?? decodedFields.field_0149;
    const uiFlags = decodedFields['0x0158'] ?? decodedFields.device_ui_flags_0158 ?? decodedFields.field_0158;
    const config15a = decodedFields['0x015a'] ?? decodedFields.actuator_config ?? decodedFields.field_015a;

    const updates = ['last_config_json=?'];
    const params = [JSON.stringify(mergedConfig)];

    if (tempOffset !== undefined && tempOffset !== null) {
        updates.push('field_0140=?');
        params.push(tempOffset);
    }
    if (rawOrient !== undefined && rawOrient !== null) {
        updates.push('field_0149=?');
        params.push(mapOrientation(rawOrient));
    }
    if (uiFlags !== undefined && uiFlags !== null) {
        updates.push('field_0158=?');
        params.push(uiFlags);
    }
    if (config15a !== undefined && config15a !== null) {
        updates.push('field_015a=?');
        params.push(typeof config15a === 'string' ? config15a : (Buffer.isBuffer(config15a) ? config15a.toString('hex') : String(config15a)));
    }
    if (etag !== undefined && etag !== null) {
        updates.push('config_etag=?');
        params.push(typeof etag === 'string' ? Buffer.from(etag, 'hex') : etag);
    }

    params.push(serial);
    await p.execute(`UPDATE devices SET ${updates.join(', ')} WHERE serial_no = ?`, params);
}

async function hasValidConfigForResource(uriPath, homeId = null) {
    const p = getPool();
    let match = uriPath.match(/(?:h\/(\d+)\/)?z\/(\d+)\/config/);
    if (match) {
        const pathHomeId = match[1] ? parseInt(match[1], 10) : homeId;
        const zoneId = parseInt(match[2], 10);
        if (pathHomeId !== null) {
            const [rows] = await p.execute('SELECT last_config_json FROM zones WHERE id = ? AND home_id = ? LIMIT 1', [zoneId, pathHomeId]);
            return rows.length > 0 && !!rows[0].last_config_json;
        }
        const [rows] = await p.execute('SELECT last_config_json FROM zones WHERE id = ? LIMIT 1', [zoneId]);
        return rows.length > 0 && !!rows[0].last_config_json;
    }
    match = uriPath.match(/(?:h\/(\d+)\/)?c\/(\d+)\/config/);
    if (match) {
        const pathHomeId = match[1] ? parseInt(match[1], 10) : homeId;
        const circuitNo = parseInt(match[2], 10);
        let rows;
        if (pathHomeId !== null) {
            [rows] = await p.execute('SELECT last_config_json FROM heating_circuits WHERE home_id = ? AND number = ? LIMIT 1', [pathHomeId, circuitNo]);
        } else {
            [rows] = await p.execute('SELECT last_config_json FROM heating_circuits WHERE number = ? LIMIT 1', [circuitNo]);
        }
        return rows.length > 0 && !!rows[0].last_config_json;
    }
    return false;
}

async function getZoneBindingsForDevice(deviceId) {
    const p = getPool();
    const dbDev = await getDeviceByFullSerial(deviceId) || await getDeviceBySerial(deviceId);
    if (!dbDev) return [];

    const zoneId = dbDev.zone_id || 1;
    const isIB = deviceId.startsWith('IB');
    const isRU = deviceId.startsWith('RU') || deviceId.startsWith('WR') || deviceId.startsWith('SU') || deviceId.startsWith('BP') || deviceId.startsWith('BR');
    const currentDeviceSerial = deviceId;
    const currentDeviceZoneId = dbDev.zone_id;

    // Check if home has boiler/circuit controller
    const [boilerRows] = await p.execute("SELECT serial_no FROM devices WHERE home_id = ? AND (device_type LIKE 'RU%' OR device_type LIKE 'BU%') LIMIT 1", [dbDev.home_id]);
    const homeHasBoiler = boilerRows.length > 0;

    const pairs = [];
    if (isRU || (isIB && homeHasBoiler)) {
        _log('info', `Fetching controlled zones for driver/bridge ${deviceId}...`);
        // Fetch zones controlled by this boiler/bridge
        const [boundZones] = await p.execute(`
            SELECT id, type, heating_circuit, measuring_device_serial FROM zones 
            WHERE home_id = ? 
            AND (type = 'HOT_WATER' OR heating_circuit IS NOT NULL)
            ORDER BY id ASC
        `, [dbDev.home_id]);

        const pairObjs = [];
        for (const z of boundZones) {
            const zoneId = Number(z.id);
            const isMeasuringLeader = (z.measuring_device_serial === currentDeviceSerial);
            const isHotWater = (z.type === 'HOT_WATER');

            let prefix = '02'; // Default: Remote VA leader

            if (isHotWater) {
                prefix = '0d'; // Bridge/Hot Water
            } else if (isMeasuringLeader) {
                prefix = '0b'; // RU is Leader & Controller
            } else {
                // RU is Controller but not leader. Check if RU is in that zone.
                if (currentDeviceZoneId === zoneId) {
                    prefix = '03'; // RU Follower in same room
                } else {
                    prefix = '02'; // RU Controller for room it's not in
                }
            }

            pairObjs.push({ prefix, zoneId, isLeader: isMeasuringLeader });
        }

        // Ensure the zone where this device IS the measuring leader comes first
        pairObjs.sort((a, b) => (b.isLeader - a.isLeader) || (a.zoneId - b.zoneId));

        for (const po of pairObjs) {
            pairs.push(po.prefix + po.zoneId.toString(16).padStart(2, '0'));
        }
    } else {
        _log('info', `Fetching driven circuits for device ${deviceId}...`);
        // For sub-devices (Valves), we find the zone(s) they are in
        const [zoneInfo] = await p.execute('SELECT id, measuring_device_serial FROM zones WHERE id = ? AND home_id = ?', [zoneId, dbDev.home_id]);

        if (zoneInfo.length > 0) {
            const z = zoneInfo[0];
            const isMeasuringLeader = (z.measuring_device_serial === currentDeviceSerial);

            let prefix = '0d';
            if (!isMeasuringLeader) {
                // If not leader, and leader is RU -> 05
                if (z.measuring_device_serial && (z.measuring_device_serial.startsWith('RU') || z.measuring_device_serial.startsWith('WR') || z.measuring_device_serial.startsWith('SU'))) {
                    prefix = '05';
                } else {
                    // Default for VA leader (or VA follow VA)
                    prefix = '0d';
                }
            }
            pairs.push(prefix + Number(z.id).toString(16).padStart(2, '0'));
        }
    }
    return pairs;
}

async function purgeZone(homeId, zoneId) {
    if (!homeId) throw new Error('homeId is required for purgeZone');
    const pool = getPool();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        // Get timetables
        const [timetables] = await conn.execute('SELECT id FROM zone_timetables WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);

        if (timetables.length > 0) {
            const ttIds = timetables.map(t => t.id);
            const placeholders = ttIds.map(() => '?').join(',');
            await conn.execute(`DELETE FROM schedule_blocks WHERE timetable_id IN (${placeholders})`, ttIds);
        }

        // Delete from other tables
        await conn.execute('DELETE FROM zone_timetables WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
        await conn.execute('DELETE FROM away_configurations WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
        await conn.execute('DELETE FROM zone_overlays WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
        await conn.execute('DELETE FROM zone_measurements WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
        await conn.execute('DELETE FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);

        await conn.commit();
        _log('info', `Purged zone ${zoneId} of home ${homeId} successfully`);
    } catch (err) {
        if (conn) await conn.rollback();
        _log('error', `Failed to purge zone ${zoneId}: ${err.message}`);
        throw err;
    } finally {
        if (conn) conn.release();
    }
}

async function getHeatingCircuit(homeId, circuitNumber) {
    const p = getPool();
    const [rows] = await p.execute('SELECT * FROM heating_circuits WHERE home_id = ? AND number = ? LIMIT 1', [homeId, circuitNumber]);
    return rows.length > 0 ? rows[0] : null;
}

async function upsertHeatingCircuit(homeId, number, fields = {}) {
    fields = fields || {};
    const p = getPool();
    const [rows] = await p.execute('SELECT id FROM heating_circuits WHERE home_id=? AND number=?', [homeId, number]);
    if (rows.length === 0) {
        await p.execute(
            `INSERT INTO heating_circuits (home_id, number, field_4040, field_4000, field_4080, field_2090)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [homeId, number, fields['0x4040'] ?? null, fields['0x4000'] ?? null, fields['0x4080'] ?? null, fields['0x2090'] ?? null]
        );
    } else {
        const updates = [];
        const params = [];
        if (fields['0x4040'] !== undefined) { updates.push('field_4040=?'); params.push(fields['0x4040']); }
        if (fields['0x4000'] !== undefined) { updates.push('field_4000=?'); params.push(fields['0x4000']); }
        if (fields['0x4080'] !== undefined) { updates.push('field_4080=?'); params.push(fields['0x4080']); }
        if (fields['0x2090'] !== undefined) { updates.push('field_2090=?'); params.push(fields['0x2090']); }

        if (updates.length > 0) {
            params.push(homeId, number);
            await p.execute(`UPDATE heating_circuits SET ${updates.join(', ')} WHERE home_id=? AND number=?`, params);
        }
    }
}

async function updateCircuitConfig(homeId, circuitNumber, fields, fullConfigJson) {
    const p = getPool();
    const [rows] = await p.execute('SELECT last_config_json FROM heating_circuits WHERE home_id=? AND number=?', [homeId, circuitNumber]);

    let mergedConfig = rows.length > 0 ? safeJsonParse(rows[0].last_config_json) : {};
    if (fullConfigJson) {
        Object.assign(mergedConfig, fullConfigJson);
    }

    const val = fields['0x2040'] ?? fields.circuit_dhw_max_flow_temperature ?? fields.max_temp;
    if (val !== undefined) {
        mergedConfig['0x2040'] = val;
    }

    mergedConfig = cleanFriendlyConfig(mergedConfig);

    const etag = generateEtag();
    if (rows.length > 0) {
        await p.execute(
            'UPDATE heating_circuits SET last_config_json=?, config_etag=?, field_2040=? WHERE home_id=? AND number=?',
            [JSON.stringify(mergedConfig), etag, val !== undefined ? val : null, homeId, circuitNumber]
        );
    } else {
        await p.execute(
            'INSERT INTO heating_circuits (home_id, number, last_config_json, config_etag, field_2040) VALUES (?, ?, ?, ?, ?)',
            [homeId, circuitNumber, JSON.stringify(mergedConfig), etag, val !== undefined ? val : null]
        );
    }
}

async function upsertHeatingSystem(homeId, fields, fullConfigJson = null) {
    // Sanitize 65535 (0xFFFF) sentinel values
    fields = sanitizeHvacFields(fields);
    if (fullConfigJson) {
        fullConfigJson = sanitizeHvacFields(fullConfigJson);
    }

    const p = getPool();
    const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

    const [hsRows] = await p.execute('SELECT last_config_json FROM heating_systems WHERE home_id=?', [homeId]);
    let mergedConfig = hsRows.length > 0 ? safeJsonParse(hsRows[0].last_config_json) : {};

    // Map friendly keys in fullConfigJson to hex
    if (fullConfigJson) {
        for (const [k, v] of Object.entries(fullConfigJson)) {
            const hexKey = k.startsWith('0x') ? k : tlvNameToHex(k);
            if (hexKey) {
                mergedConfig[hexKey] = v;
            } else {
                mergedConfig[k] = v;
            }
        }
    }

    // Merge incoming fields
    for (const [fKey, fVal] of Object.entries(fields)) {
        if (fVal !== undefined) {
            const hexKey = fKey.startsWith('0x') ? fKey : tlvNameToHex(fKey);
            if (hexKey) {
                mergedConfig[hexKey] = fVal;
            }
        }
    }

    const mapping = {
        '0x044c': 'field_044c',
        '0x044d': 'field_044d',
        '0x0450': 'field_0450',
        '0x0458': 'field_0458',
        '0x0457': 'field_0457',
        '0x0452': 'field_0452',
        '0x0460': 'field_0460',
        '0x015d': 'field_015d',
        '0x0471': 'field_0471',
        '0x046f': 'field_046f',
        '0x046c': 'field_046c',
        '0x046d': 'field_046d',
        '0x045b': 'field_045b',
        '0x0463': 'field_0463',
        '0x0466': 'field_0466',
        '0x0467': 'field_0467',
        '0x0468': 'field_0468',
        '0x0464': 'field_0464',
        '0x0465': 'field_0465',
        '0x0481': 'field_0481'
    };

    const etag = generateEtag();
    const jsonStr = JSON.stringify(mergedConfig);

    if (hsRows.length === 0) {
        const cols = ['home_id', 'hvac_updated_at', 'last_config_json', 'hvac_etag'];
        const vals = [homeId, now, jsonStr, etag];
        const placeholders = ['?', '?', '?', '?'];

        for (const [tlv, col] of Object.entries(mapping)) {
            if (fields[tlv] !== undefined) {
                let val = fields[tlv];
                if (tlv === '0x0460' && val != null) {
                    if (Number(val) === 4294901760 || (Number(val) & 0xFFFF0000) === 0xFFFF0000) {
                        val = null;
                    } else {
                        val = Number(val) & 0xFFFF;
                    }
                } else if (Number(val) >= 2000000000) {
                    val = null;
                }
                cols.push(col);
                vals.push(val);
                placeholders.push('?');
            }
        }
        await p.execute(`INSERT INTO heating_systems (${cols.join(',')}) VALUES (${placeholders.join(',')})`, vals);
    } else {
        const updates = ['hvac_updated_at=?', 'last_config_json=?', 'hvac_etag=?'];
        const params = [now, jsonStr, etag];
        for (const [tlv, col] of Object.entries(mapping)) {
            if (fields[tlv] !== undefined) {
                let val = fields[tlv];
                if (tlv === '0x0460' && val != null) {
                    if (Number(val) === 4294901760 || (Number(val) & 0xFFFF0000) === 0xFFFF0000) {
                        val = null;
                    } else {
                        val = Number(val) & 0xFFFF;
                    }
                } else if (Number(val) >= 2000000000) {
                    val = null;
                }
                updates.push(`${col}=?`);
                params.push(val);
            }
        }
        params.push(homeId);
        await p.execute(`UPDATE heating_systems SET ${updates.join(', ')} WHERE home_id=?`, params);
    }
}

function sanitizeHvacFields(fields) {
    if (!fields) return fields;
    const sanitized = { ...fields };
    for (const [k, v] of Object.entries(sanitized)) {
        if (typeof v === 'number') {
            const isHvacKey = k.startsWith('0x04') || k.startsWith('ot_') || k.startsWith('hvac_') || k.startsWith('dhw_') || k.startsWith('field_04') || k.startsWith('field_015d');
            if (isHvacKey) {
                // Sanitize 16-bit and 32-bit sentinel values
                if (v === 65535 || v === 4294967295 || v === 4294901760 || v > 70000000) {
                    sanitized[k] = null;
                }
            }
        }
    }
    return sanitized;
}

module.exports = {
    getZoneState,
    getZoneStateFallback,
    getZonesForHome,
    insertZoneMeasurement,
    insertMergedZoneMeasurement,
    insertDeviceMeasurement,
    insertZoneState,
    insertZoneDemand,
    getZoneMeasurementsForTimeRange,
    getZoneType,
    updateZoneFallback,
    updateZoneConfig,
    mergeZoneMeasurement,
    getLatestZoneMeasurement,
    updateLastConfigJsonFromLive,
    hasValidConfigForResource,
    getZoneBindingsForDevice,
    purgeZone,
    getHeatingCircuit,
    upsertHeatingCircuit,
    updateCircuitConfig,
    upsertHeatingSystem,
    sanitizeHvacFields
};
