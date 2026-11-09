/**
 * @file lib/valve-exercise.js
 * @brief Anti-seize monthly radiator valve motor exercise.
 */

'use strict';

const db = require('./db');
const commandApi = require('./command-api');
const { getLogger } = require('./logger');
const log = getLogger('valve-exercise');

const DEFAULT_STAGGER_MS = 45000; // 45 seconds between valves

/**
 * Exercise a single valve actuator if eligible.
 * @param {string} deviceId 
 * @param {number} homeId 
 * @param {Object} options - { force: boolean }
 * @returns {Promise<{ ok: boolean, deviceId: string, status: string, reason?: string }>}
 */
async function exerciseValve(deviceId, homeId, options = {}) {
    if (!deviceId || !deviceId.startsWith('VA')) {
        return { ok: false, deviceId, status: 'skipped', reason: 'not_a_valve' };
    }

    const pool = db.getPool();
    const [devRows] = await pool.execute(
        `SELECT d.serial_no, d.device_type, d.home_id, d.zone_id, d.connection_state, 
                d.battery_state, d.battery_percent, d.last_exercised_at, d.auto_valve_exercise_enabled,
                zm.field_40a0 as latest_demand, zm.field_4060 as current_temp
         FROM devices d
         LEFT JOIN (
             SELECT zm1.zone_id, zm1.home_id, zm1.field_40a0, zm1.field_4060
             FROM zone_measurements zm1
             INNER JOIN (
                 SELECT zone_id, MAX(id) as max_id
                 FROM zone_measurements
                 WHERE home_id = ?
                 GROUP BY zone_id
             ) latest ON zm1.id = latest.max_id
         ) zm ON zm.zone_id = d.zone_id
         WHERE d.serial_no = ? AND d.home_id = ?`,
        [homeId, deviceId, homeId]
    );

    if (devRows.length === 0) {
        return { ok: false, deviceId, status: 'skipped', reason: 'device_not_found' };
    }

    const dev = devRows[0];

    // Unless forced, evaluate safety lockouts:
    if (!options.force) {
        // 0. Per-device toggle
        if (dev.auto_valve_exercise_enabled === 0) {
            log('info', `[ValveExercise] Skipping ${deviceId}: valve exercise is disabled for this device`);
            return { ok: false, deviceId, status: 'skipped', reason: 'device_exercise_disabled' };
        }

        // 1. Connection check
        if (dev.connection_state === 0) {
            log('warn', `[ValveExercise] Skipping ${deviceId}: device is offline`);
            return { ok: false, deviceId, status: 'skipped', reason: 'device_offline' };
        }

        // 2. Battery check: skip if low battery or < 15%
        if (dev.battery_state === 'LOW' || (dev.battery_percent !== null && dev.battery_percent !== undefined && Number(dev.battery_percent) < 15)) {
            log('warn', `[ValveExercise] Skipping ${deviceId}: low battery state (${dev.battery_state}, ${dev.battery_percent}%)`);
            return { ok: false, deviceId, status: 'skipped', reason: 'low_battery' };
        }

        // 3. Active heating check: if latest demand > 0, room is actively heating
        const demand = dev.latest_demand !== null && dev.latest_demand !== undefined ? Number(dev.latest_demand) : 0;
        if (demand > 0) {
            log('info', `[ValveExercise] Skipping ${deviceId}: zone ${dev.zone_id} is actively heating (${demand}%)`);
            return { ok: false, deviceId, status: 'skipped', reason: 'zone_heating' };
        }
    }

    log('info', `[ValveExercise] Triggering motor calibration exercise for ${deviceId}`);
    await commandApi.pushMountCalibration(deviceId, 'start');

    // Update last_exercised_at timestamp
    await pool.execute(
        'UPDATE devices SET last_exercised_at = NOW() WHERE serial_no = ? AND home_id = ?',
        [deviceId, homeId]
    );

    const exercisedAt = new Date().toISOString();
    try {
        const mqttPublisher = require('./mqtt-publisher');
        if (mqttPublisher && typeof mqttPublisher.publishMountingState === 'function') {
            mqttPublisher.publishMountingState(deviceId, homeId, 'CALIBRATING');
        }
    } catch (e) {
        log('debug', `[ValveExercise] MQTT state notify warning: ${e.message}`);
    }

    return { ok: true, deviceId, status: 'exercised', exercisedAt };
}

/**
 * Exercise all eligible valves in a home sequentially with a stagger delay.
 * @param {number} homeId 
 * @param {Object} options - { force: boolean, staggerMs: number, mqttPublisher: Object }
 * @returns {Promise<{ homeId: number, total: number, exercised: number, skipped: Array }>}
 */
async function exerciseHomeValves(homeId, options = {}) {
    const pool = db.getPool();
    const [valves] = await pool.execute(
        `SELECT serial_no, auto_valve_exercise_enabled FROM devices WHERE home_id = ? AND device_type LIKE 'VA%' ORDER BY zone_id ASC, serial_no ASC`,
        [homeId]
    );

    const staggerMs = options.staggerMs !== undefined ? options.staggerMs : DEFAULT_STAGGER_MS;
    const results = {
        homeId,
        total: valves.length,
        exercised: 0,
        skipped: []
    };

    log('info', `[ValveExercise] Starting valve exercise batch for home ${homeId} (${valves.length} valves)`);

    for (let i = 0; i < valves.length; i++) {
        const v = valves[i];
        try {
            const res = await exerciseValve(v.serial_no, homeId, options);
            if (res.ok) {
                results.exercised++;
            } else {
                results.skipped.push({ serialNo: v.serial_no, reason: res.reason });
            }
        } catch (err) {
            log('error', `[ValveExercise] Failed to exercise ${v.serial_no}: ${err.message}`);
            results.skipped.push({ serialNo: v.serial_no, reason: err.message });
        }

        // Delay between valves (if more remain and staggerMs > 0)
        if (i < valves.length - 1 && staggerMs > 0) {
            await new Promise(r => setTimeout(r, staggerMs));
        }
    }

    log('info', `[ValveExercise] Completed batch for home ${homeId}: ${results.exercised}/${results.total} exercised, ${results.skipped.length} skipped`);
    return results;
}

/**
 * Routine check called daily by cron.
 * Runs on the 1st of the month at scheduled hour (11:00 AM home local time).
 */
async function checkMonthlyValveExercise(pool = null, mqttPublisher = null, customNow = null) {
    if (pool instanceof Date) {
        customNow = pool;
        pool = null;
    }
    if (!pool) pool = db.getPool();
    const now = customNow || new Date();
    const summary = {};

    const [homes] = await pool.execute('SELECT id, date_time_zone, auto_valve_exercise_enabled FROM homes');

    for (const home of homes) {
        if (home.auto_valve_exercise_enabled === 0) {
            summary[home.id] = { status: 'skipped_disabled' };
            continue;
        }

        const tz = home.date_time_zone || 'Europe/Berlin';
        let localDay = 1;
        let localHour = 11;
        try {
            const formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: tz,
                day: 'numeric',
                hour: 'numeric',
                hour12: false
            });
            const parts = formatter.formatToParts(now);
            const dPart = parts.find(p => p.type === 'day');
            const hPart = parts.find(p => p.type === 'hour');
            if (dPart) localDay = parseInt(dPart.value, 10);
            if (hPart) localHour = parseInt(hPart.value, 10);
        } catch (e) {
            localDay = now.getDate();
            localHour = now.getHours();
        }

        // Only run on 1st of month at 11 AM
        if (localDay !== 1 || localHour !== 11) {
            summary[home.id] = { status: 'skipped_time' };
            continue;
        }

        // Verify if already exercised in the current calendar month
        const [recent] = await pool.execute(
            `SELECT MAX(last_exercised_at) as last_run FROM devices 
             WHERE home_id = ? AND device_type LIKE 'VA%'`,
            [home.id]
        );

        if (recent.length > 0 && recent[0].last_run) {
            const lastDate = new Date(recent[0].last_run);
            if (lastDate.getFullYear() === now.getFullYear() && lastDate.getMonth() === now.getMonth()) {
                // Already exercised this month
                summary[home.id] = { status: 'skipped_already_exercised' };
                continue;
            }
        }

        // Run monthly exercise batch
        const batchRes = await exerciseHomeValves(home.id, { mqttPublisher }).catch(err => {
            log('error', `[ValveExercise] Error running monthly exercise for home ${home.id}: ${err.message}`);
            return { error: err.message };
        });
        summary[home.id] = { status: 'triggered', result: batchRes };
    }

    return summary;
}

module.exports = {
    exerciseValve,
    exerciseHomeValves,
    checkMonthlyValveExercise
};
