/**
 * @file lib/owd-detector.js
 * @brief Open Window Detection algorithm matching temperature drops.
 */

'use strict';

const { getLogger } = require('./logger');
const log = getLogger('owd-detector');

let db = null;
let commandApi = null;
let mqttPublisher = null;

const COOLDOWN_MS = 15 * 60 * 1000;   // 15 minutes cooldown
const DEFAULT_THRESHOLD = 1.5;         // °C drop default
const HUMIDITY_THRESHOLD = 10;         // % drop confidence boost

const cooldowns = new Map(); // zoneId -> timestamp of last OWD event

function init(_db, _commandApi, _mqttPublisher) {
    db = _db;
    commandApi = _commandApi;
    mqttPublisher = _mqttPublisher;
    log('info', 'TaNoClo OWD Detector initialized');
}

async function evaluate(homeId, zoneId, latestMeasurement) {
    if (!db) return;
    const pool = db.getPool();

    try {
        // 1. Check zone config
        const [zoneRows] = await pool.execute(
            'SELECT tanoclo_owd_enabled, tanoclo_owd_source, open_window_active, open_window_timeout, type FROM zones WHERE id = ? AND home_id = ?',
            [zoneId, homeId]
        );
        if (zoneRows.length === 0) return;
        const zone = zoneRows[0];

        // Skip if not enabled or source doesn't include server
        if (!zone.tanoclo_owd_enabled) return;
        if (zone.tanoclo_owd_source !== 'server' && zone.tanoclo_owd_source !== 'both') return;
        if (zone.open_window_active) return; // Already active
        if (zone.type === 'HOT_WATER' || zone.type === 'DHW') return;

        // 2. Check cooldown
        const lastEvent = cooldowns.get(zoneId);
        if (lastEvent && (Date.now() - lastEvent) < COOLDOWN_MS) return;

        // 3. Check preconditions — heating ON, HOME mode
        const currentTemp = latestMeasurement.temperature_celsius !== undefined ? latestMeasurement.temperature_celsius : latestMeasurement.field_012d;
        const currentHumidity = latestMeasurement.humidity_percentage !== undefined ? latestMeasurement.humidity_percentage : latestMeasurement.field_0135;
        const zoneEnabled = latestMeasurement.field_61e0 !== undefined ? latestMeasurement.field_61e0 : 1;
        const presenceVal = latestMeasurement.field_6160 !== undefined ? latestMeasurement.field_6160 : 1;

        if (zoneEnabled === 0) return; // Zone disabled / OFF
        if (presenceVal === 0) return; // AWAY mode

        // 4. Query temperature history (last 5 minutes)
        const [history] = await pool.execute(
            'SELECT field_012d as temperature_celsius, field_0135 as humidity_percentage, timestamp FROM zone_measurements WHERE zone_id = ? AND home_id = ? AND timestamp > DATE_SUB(NOW(), INTERVAL 5 MINUTE) ORDER BY timestamp ASC',
            [zoneId, homeId]
        );
        if (history.length < 2) return; // Not enough data for delta

        // Fallback or map the fields
        const oldestTemp = history[0].temperature_celsius;
        if (oldestTemp === null || currentTemp === null) return;
        const tempDelta = oldestTemp - currentTemp; // positive = drop

        // 5. Get outside temperature
        const [weather] = await pool.execute(
            'SELECT outside_temp_celsius FROM home_weather WHERE home_id = ? ORDER BY timestamp DESC LIMIT 1',
            [homeId]
        );
        const outsideTemp = weather.length > 0 ? weather[0].outside_temp_celsius : null;

        // 6. Adjust threshold based on outside temperature
        let threshold = DEFAULT_THRESHOLD;
        if (outsideTemp !== null) {
            if (outsideTemp < 5) threshold = 1.0;
            else if (outsideTemp > 15) threshold = 2.5;
        }

        // 7. Humidity cross-check — reduce threshold if humidity also drops (dry outside air entering)
        if (currentHumidity !== null && history[0].humidity_percentage !== null) {
            const humidityDelta = history[0].humidity_percentage - currentHumidity;
            if (humidityDelta > HUMIDITY_THRESHOLD) {
                threshold -= 0.5;
                log('debug', `[zone ${zoneId}] Humidity drop ${humidityDelta.toFixed(1)}% — threshold reduced to ${threshold}°C`);
            }
        }

        // 8. Check if threshold exceeded
        if (tempDelta >= threshold) {
            log('info', `[zone ${zoneId}] OWD TRIGGERED: temp drop ${tempDelta.toFixed(2)}°C (threshold ${threshold}°C, outside ${outsideTemp}°C)`);

            // Set cooldown
            cooldowns.set(zoneId, Date.now());

            // Activate OWD
            await db.updateZoneOpenWindow(homeId, zoneId, true);

            // Push to devices
            if (commandApi) {
                try {
                    await commandApi.pushOpenWindowActivate(homeId, zoneId);
                } catch (e) {
                    log('warn', `Device push failed for zone ${zoneId}: ${e.message}`);
                }
            }

            // Publish MQTT
            if (mqttPublisher) {
                await mqttPublisher.publishOpenWindow(zoneId, true).catch(() => {});
            }
        }
    } catch (err) {
        log('error', `evaluate OWD error: ${err.message}`);
    }
}

function clearCooldown(zoneId) {
    cooldowns.delete(zoneId);
}

module.exports = { init, evaluate, clearCooldown };
