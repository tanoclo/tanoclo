/**
 * @file lib/db-zones/overlays.js
 */

'use strict';

/**
 * @file lib/db-zones.js
 * @brief Zone settings, timetables, and schedules database queries.
 */

'use strict';
/**
 * @module db-zones
 * 
 * Zone-related DB operations.
 * Handles zone configurations, states, timetable schedules, overlays, and circuit configurations.
 */
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

const { insertMergedZoneMeasurement } = require('./state');

async function getZoneOverlay(homeId, zoneId) {
    if (!homeId) throw new Error('homeId is required for getZoneOverlay');
    const p = getPool();
    const [rows] = await p.execute('SELECT * FROM zone_overlays WHERE zone_id=? AND home_id=?', [zoneId, homeId]);
    return rows.length > 0 ? rows[0] : null;
}

async function upsertZoneOverlay(homeId, zoneId, mode, temp, hasSetpoint) {
    const p = getPool();
    const settingType = "HEATING";
    const settingPower = "ON";
    const settingTempC = (hasSetpoint && temp !== null) ? temp : null;
    const settingTempF = (hasSetpoint && temp !== null) ? parseFloat((temp * 1.8 + 32).toFixed(2)) : null;

    await p.execute(
        `INSERT INTO zone_overlays (zone_id, home_id, setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit, termination_type)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE 
            home_id = VALUES(home_id), 
            setting_type = VALUES(setting_type), 
            setting_power = VALUES(setting_power), 
            setting_temp_celsius = VALUES(setting_temp_celsius), 
            setting_temp_fahrenheit = VALUES(setting_temp_fahrenheit), 
            termination_type = VALUES(termination_type)`,
        [zoneId, homeId, settingType, settingPower, settingTempC, settingTempF, "MANUAL"]
    );
}

async function updateZoneOverlay(homeId, zoneId, setting, termination) {
    const p = getPool();
    const settingType = setting.type || 'HEATING';
    const settingPower = setting.power || 'ON';
    const settingTempC = setting.temperature?.celsius ?? null;
    const settingTempF = setting.temperature?.fahrenheit ?? null;
    const termType = termination.type || 'MANUAL';
    const termDur = termination.durationInSeconds || null;
    const termExpiry = termination.expiry || null;

    await p.execute(
        `INSERT INTO zone_overlays (zone_id, home_id, setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit, termination_type, termination_duration_seconds, termination_expiry)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE 
            home_id = VALUES(home_id), 
            setting_type = VALUES(setting_type), 
            setting_power = VALUES(setting_power), 
            setting_temp_celsius = VALUES(setting_temp_celsius), 
            setting_temp_fahrenheit = VALUES(setting_temp_fahrenheit), 
            termination_type = VALUES(termination_type),
            termination_duration_seconds = VALUES(termination_duration_seconds),
            termination_expiry = VALUES(termination_expiry)`,
        [zoneId, homeId, settingType, settingPower, settingTempC, settingTempF, termType, termDur, termExpiry]
    );
}

async function deleteZoneOverlay(homeId, zoneId) {
    if (!homeId) throw new Error('homeId is required for deleteZoneOverlay');
    const p = getPool();
    await p.execute('DELETE FROM zone_overlays WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
}

async function updateZoneOpenWindow(homeId, zoneId, active) {
    if (!homeId) throw new Error('homeId is required for updateZoneOpenWindow');
    const p = getPool();
    if (active) {
        const [rows] = await p.execute('SELECT open_window_timeout FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
        const timeout = rows.length > 0 ? (rows[0].open_window_timeout || 900) : 900;
        const expiryDate = new Date(Date.now() + timeout * 1000);
        const expiry = expiryDate.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
        await p.execute('UPDATE zones SET open_window_active = 1, open_window_expiry = ? WHERE id = ? AND home_id = ?', [expiry, zoneId, homeId]);
    } else {
        await p.execute('UPDATE zones SET open_window_active = 0, open_window_expiry = NULL WHERE id = ? AND home_id = ?', [zoneId, homeId]);
    }
    await insertMergedZoneMeasurement(homeId, zoneId, { open_window_detected: active ? 1 : 0 });
}

async function updateZoneOpenWindowSettings(homeId, zoneId, enabled, timeout, deviationLimit = null, owdNvmState = null) {
    if (!homeId) throw new Error('homeId is required for updateZoneOpenWindowSettings');
    const p = getPool();
    // 1. Load last_config_json
    const [rows] = await p.execute('SELECT last_config_json FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
    let mergedConfig = rows.length > 0 ? safeJsonParse(rows[0].last_config_json) : {};

    // 2. Merge updated settings into JSON template
    mergedConfig['0x60e0'] = enabled ? 1 : 0;
    mergedConfig['0x62c0'] = timeout;

    const updates = ['open_window_enabled = ?', 'open_window_timeout = ?'];
    const params = [enabled ? 1 : 0, timeout];

    if (deviationLimit !== null && deviationLimit !== undefined) {
        mergedConfig['0x6080'] = deviationLimit;
        updates.push('field_6080 = ?');
        params.push(deviationLimit);
    }
    if (owdNvmState !== null && owdNvmState !== undefined) {
        mergedConfig['0x6340'] = owdNvmState;
        updates.push('field_6340 = ?');
        params.push(owdNvmState);
    }

    updates.push('last_config_json = ?');
    params.push(JSON.stringify(mergedConfig));

    params.push(zoneId, homeId);

    // 3. Temporarily update columns so buildZoneConfigTLV generates the correct payload
    await p.execute(
        `UPDATE zones SET ${updates.join(', ')} WHERE id = ? AND home_id = ?`,
        params
    );

    // 4. Generate the new config_etag by encoding and hashing the updated payload
    const dbUtils = require('../db-utils');
    const payload = await dbUtils.buildZoneConfigTLV(homeId, zoneId);
    const configEtag = generateEtag(payload);

    // 5. Save the generated ETag
    await p.execute(
        'UPDATE zones SET config_etag = ? WHERE id = ? AND home_id = ?',
        [configEtag, zoneId, homeId]
    );
}

async function getZoneDefaultOverlay(homeId, zoneId) {
    if (!homeId) throw new Error('homeId is required for getZoneDefaultOverlay');
    const p = getPool();
    const [rows] = await p.execute('SELECT default_overlay_type, default_overlay_duration FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
    if (rows.length === 0) return null;
    return {
        type: rows[0].default_overlay_type || 'MANUAL',
        durationInSeconds: rows[0].default_overlay_duration || null
    };
}

async function updateZoneDefaultOverlay(homeId, zoneId, type, duration) {
    if (!homeId) throw new Error('homeId is required for updateZoneDefaultOverlay');
    const p = getPool();
    await p.execute('UPDATE zones SET default_overlay_type=?, default_overlay_duration=? WHERE id=? AND home_id=?', [type, duration, zoneId, homeId]);
}

module.exports = {
    getZoneOverlay,
    upsertZoneOverlay,
    updateZoneOverlay,
    deleteZoneOverlay,
    updateZoneOpenWindow,
    updateZoneOpenWindowSettings,
    getZoneDefaultOverlay,
    updateZoneDefaultOverlay
};
