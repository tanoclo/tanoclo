/**
 * @file lib/db-zones/schedule.js
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

async function getCurrentScheduledTemperature(homeId, zoneId) {
    if (!homeId) throw new Error('homeId is required for getCurrentScheduledTemperature');
    const { targetTemp } = await getZoneScheduleState(homeId, zoneId);
    return targetTemp;
}

async function getCurrentScheduleBlock(homeId, zoneId) {
    if (!homeId) throw new Error('homeId is required for getCurrentScheduleBlock');
    const p = getPool();
    const tzName = await getHomeTimezone(homeId, zoneId);
    if (!tzName) return null;

    const dateObj = (process.env.TEST_PARITY_TIME) ?
        new Date(process.env.TEST_PARITY_TIME) :
        new Date();
    const local = getLocalParts(dateObj, tzName);
    const dayName = local.dayName;
    const timeStr = local.timeStr.slice(0, 5); // HH:mm
    const isoDateStr = local.dateStr;

    const [ttRows] = await p.execute('SELECT id, type FROM zone_timetables WHERE zone_id = ? AND home_id = ? AND is_active = 1 LIMIT 1', [zoneId, homeId]);
    if (ttRows.length === 0) return null;

    const timetableId = ttRows[0].id;

    // Two-pass approach:
    // 1. Find the latest block that started TODAY (at or before current time)
    // 2. If no block started today (e.g., at 00:30 AM), we must be in a block that started YESTERDAY

    const dayNames = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
    const prevDayName = dayNames[(dayNames.indexOf(dayName) + 6) % 7];

    const getBaseSql = () => {
        return `
            SELECT id, day_type, start_time, end_time, setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit 
            FROM schedule_blocks 
            WHERE timetable_id = ? 
              AND (
                day_type = ? 
                OR (day_type = 'MONDAY_TO_FRIDAY' AND ? NOT IN ('SATURDAY', 'SUNDAY'))
                OR (day_type = 'SATURDAY' AND ? = 'SATURDAY')
                OR (day_type = 'SUNDAY' AND ? = 'SUNDAY')
                OR (day_type = 'MONDAY_TO_SUNDAY')
              )
        `;
    };

    // Pass 1: Today (Precision Start-Time Only)
    const [blockRows] = await p.execute(
        getBaseSql() + ` AND start_time <= ? ORDER BY (day_type = ?) DESC, (day_type = 'MONDAY_TO_SUNDAY') ASC, start_time DESC LIMIT 1`,
        [timetableId, dayName, dayName, dayName, dayName, timeStr, dayName]
    );

    let block = blockRows.length > 0 ? blockRows[0] : null;

    // Pass 2: Wraparound (Inherit from Yesterday)
    if (!block) {
        const [yBlockRows] = await p.execute(
            getBaseSql() + ` ORDER BY (day_type = ?) DESC, (day_type = 'MONDAY_TO_SUNDAY') ASC, start_time DESC LIMIT 1`,
            [timetableId, prevDayName, prevDayName, prevDayName, prevDayName, prevDayName]
        );
        block = yBlockRows.length > 0 ? yBlockRows[0] : null;
    }

    if (!block) return null;

    const setting = {
        type: block.setting_type || 'HEATING',
        power: block.setting_power || 'ON',
        temperature: (block.setting_temp_celsius !== null) ? {
            celsius: parseFloat(block.setting_temp_celsius),
            fahrenheit: (block.setting_temp_fahrenheit !== null) ? parseFloat(block.setting_temp_fahrenheit) : null
        } : null
    };

    const startDateTimeLocal = parseLocalTimeInTimezone(`${isoDateStr} ${block.start_time}`, tzName);

    return {
        timetableId,
        blockId: block.id,
        dayType: block.day_type,
        startTime: block.start_time,
        startDateTimeLocal,
        setting
    };
}

async function getNextScheduleBlock(homeId, zoneId) {
    if (!homeId) throw new Error('homeId is required for getNextScheduleBlock');
    const p = getPool();
    const tzName = await getHomeTimezone(homeId, zoneId);
    if (!tzName) return null;

    const dateObj = (process.env.TEST_PARITY_TIME) ?
        new Date(process.env.TEST_PARITY_TIME) :
        new Date();
    const local = getLocalParts(dateObj, tzName);
    const dayName = local.dayName;
    const timeStr = local.timeStr.slice(0, 5); // HH:mm

    const [ttRows] = await p.execute('SELECT id FROM zone_timetables WHERE zone_id = ? AND home_id = ? AND is_active = 1 LIMIT 1', [zoneId, homeId]);
    if (ttRows.length === 0) return null;
    const timetableId = ttRows[0].id;

    // Pass 1: Next block today
    const [blockRows] = await p.execute(`
        SELECT id, day_type, start_time, setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit 
        FROM schedule_blocks 
        WHERE timetable_id = ? 
          AND start_time > ?
          AND (
            day_type = ? 
            OR (day_type = 'MONDAY_TO_FRIDAY' AND ? NOT IN ('SATURDAY', 'SUNDAY'))
            OR (day_type = 'SATURDAY' AND ? = 'SATURDAY')
            OR (day_type = 'SUNDAY' AND ? = 'SUNDAY')
            OR (day_type = 'MONDAY_TO_SUNDAY')
          )
        ORDER BY start_time ASC LIMIT 1
    `, [timetableId, timeStr, dayName, dayName, dayName, dayName]);

    let block = blockRows.length > 0 ? blockRows[0] : null;

    // Pass 2: First block tomorrow if none today
    if (!block) {
        const dayNames = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
        const nextDayName = dayNames[(dayNames.indexOf(dayName) + 1) % 7];
        const [nextDayRows] = await p.execute(`
            SELECT id, day_type, start_time, setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit 
            FROM schedule_blocks 
            WHERE timetable_id = ? 
              AND (
                day_type = ? 
                OR (day_type = 'MONDAY_TO_FRIDAY' AND ? NOT IN ('SATURDAY', 'SUNDAY'))
                OR (day_type = 'SATURDAY' AND ? = 'SATURDAY')
                OR (day_type = 'SUNDAY' AND ? = 'SUNDAY')
                OR (day_type = 'MONDAY_TO_SUNDAY')
              )
            ORDER BY start_time ASC LIMIT 1
        `, [timetableId, nextDayName, nextDayName, nextDayName, nextDayName]);
        block = nextDayRows.length > 0 ? nextDayRows[0] : null;
    }

    if (!block) return null;

    const setting = {
        type: block.setting_type || 'HEATING',
        power: block.setting_power || 'ON',
        temperature: (block.setting_temp_celsius !== null) ? {
            celsius: parseFloat(block.setting_temp_celsius),
            fahrenheit: (block.setting_temp_fahrenheit !== null) ? parseFloat(block.setting_temp_fahrenheit) : null
        } : null
    };

    return {
        startTime: block.start_time,
        setting
    };
}

/**
 * Compute the schedule-driven zone state, factoring in home presence.
 *
 * When presenceMode is 2 (AWAY), the real Tado cloud disables the zone
 * on the wire (0x61e0=0) and omits the target temperature (0x6200).
 * The away_configurations table provides a frost-protection floor
 * (min_away_temp_celsius) or a fixed setting override.
 *
 * @param {number} homeId
 * @param {number} zoneId
 * @param {number} [presenceMode=1] - 1=HOME, 2=AWAY
 * @returns {{ targetTemp: number|null, enabled: number, awayTemp: number|null }}
 */
async function getZoneScheduleState(homeId, zoneId, presenceMode) {
    if (!homeId) throw new Error('homeId is required for getZoneScheduleState');
    const block = await getCurrentScheduleBlock(homeId, zoneId);
    let targetTemp = null;
    let enabled = 1;

    if (block && block.setting) {
        if (block.setting.temperature && block.setting.temperature.celsius != null) {
            targetTemp = parseFloat(block.setting.temperature.celsius);
        }

        // For DHW (Zone 0), power mapping is critical
        if (String(zoneId) === '0' || block.setting.type === 'HOT_WATER') {
            enabled = (block.setting.power === 'ON') ? 1 : 0;
            // For DHW, if temperature is null in block (OFF state), 
            // fallback to a reasonable setpoint (60.0) from the schedule context
            if (targetTemp === null) targetTemp = 60.0;
        }
    } else {
        // Fallback constants
        const isDhw = (String(zoneId) === '0');
        targetTemp = isDhw ? 60.0 : 20.0;
        enabled = 1;
    }

    // ── AWAY mode override ────────────────────────────────────────
    // Tado cloud sends 0x61e0=0 and omits 0x6200 when the home is AWAY.
    // away_configurations may specify a frost-protection floor or fixed setting.
    let awayTemp = null;
    if (presenceMode === 2) {
        const awayCfg = await getAwayConfiguration(homeId, zoneId);

        if (awayCfg) {
            const cfgType = awayCfg.type || 'HEATING';
            if (cfgType === 'FIXED_SETTING') {
                // DHW or explicit fixed setting (e.g. zone 0 hot water OFF)
                enabled = (awayCfg.setting_power === 'ON') ? 1 : 0;
                if (enabled && awayCfg.setting_temp_celsius != null) {
                    awayTemp = parseFloat(awayCfg.setting_temp_celsius);
                }
            } else {
                // HEATING type: Tado disables the zone on the wire but stores
                // min_away_temp as a frost-protection floor for internal use.
                if (awayCfg.min_away_temp_celsius != null) {
                    awayTemp = parseFloat(awayCfg.min_away_temp_celsius);
                }
                enabled = 0;
            }
        } else {
            // No away config → zone fully disabled
            enabled = 0;
        }

        // When disabled, target temp is omitted from the wire
        if (!enabled) {
            targetTemp = null;
        } else {
            // Enabled with away temp (e.g. DHW FIXED_SETTING with power ON)
            if (awayTemp !== null) targetTemp = awayTemp;
        }
    }

    return { targetTemp, enabled, awayTemp };
}

/**
 * Fetch the away configuration for a zone.
 * @param {number} homeId
 * @param {number} zoneId
 * @returns {Object|null} away_configurations row or null
 */
async function getAwayConfiguration(homeId, zoneId) {
    const p = getPool();
    const [rows] = await p.execute(
        'SELECT * FROM away_configurations WHERE zone_id = ? AND home_id = ? LIMIT 1',
        [zoneId, homeId]
    );
    return rows.length > 0 ? rows[0] : null;
}

module.exports = {
    getCurrentScheduledTemperature,
    getCurrentScheduleBlock,
    getNextScheduleBlock,
    getZoneScheduleState,
    getAwayConfiguration
};
