/**
 * @file api/routes/homes/weather.js
 * @brief Home weather conditions, outdoor temperatures, and Indoor Air Quality (IAQ) routes.
 * 
 * Computes dynamic air comfort assessments (freshness, comfort metrics), returns current
 * weather summaries from the weather database, and returns comfort indicators.
 */

const express = require('express');
const db = require('../../../lib/db');
const config = require('../../../lib/config');
const { getLogger } = require('../../../lib/logger');
const { mapDevice } = require('../../../lib/mappers');
const geoUtils = require('../../../lib/geo-utils');
const fs = require('fs');
const path = require('path');
const { buildHomeDetails, checkZoneConfigReadonly } = require('./helpers');

const router = express.Router();
const _log = getLogger('homes-api');

// --- lines 235 to 410 ---
const getAirComfortHandler = async (req, res) => {
    try {
        const homeId = req.params.homeId;
        // Check if v1 (acme) or v2
        const isV1 = req.headers['user-agent']?.includes('Tado/1') || req.originalUrl.includes('/v1/') || req.originalUrl.includes('/acme/');
        const pool = db.getPool();

        // Dynamic Freshness Calculation
        const [lastWindow] = await pool.execute(
            'SELECT timestamp FROM zone_measurements WHERE home_id = ? AND open_window_detected = 1 ORDER BY timestamp DESC LIMIT 1',
            [homeId]
        );
        const lastOpenWindow = lastWindow.length > 0 ? lastWindow[0].timestamp : null;

        let freshnessValue = 'FRESH';
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const [recentHumid] = await pool.execute(
            'SELECT COUNT(*) as high_hum FROM zone_measurements WHERE home_id = ? AND timestamp > ? AND field_0135 > 60',
            [homeId, twentyFourHoursAgo]
        );
        if (recentHumid[0].high_hum > 0) {
            freshnessValue = 'FAIR';
        }
        if (lastOpenWindow) {
            const lastWinDate = new Date(lastOpenWindow);
            if (Date.now() - lastWinDate.getTime() > 48 * 60 * 60 * 1000) {
                // If it's been more than 2 days since any window was opened, downgrade freshness if humidity was high
                if (freshnessValue === 'FAIR') freshnessValue = 'POOR';
            }
        }

        const hac = { freshness: freshnessValue, last_open_window: lastOpenWindow };

        const [zones] = await pool.execute('SELECT id, type, name FROM zones WHERE home_id = ?', [homeId]);
        const zoneComforts = [];
        const roomMessages = [];

        // Fetch latest measurement for all zones in a single query to prevent N+1 loop performance bottleneck
        const [ms] = await pool.execute(
            `SELECT zm.zone_id, zm.field_012d, zm.field_0135 
             FROM zone_measurements zm
             INNER JOIN (
                 SELECT MAX(id) as max_id
                 FROM zone_measurements
                 WHERE home_id = ?
                 GROUP BY zone_id
             ) latest ON zm.id = latest.max_id`,
            [homeId]
        );

        const measurementsMap = new Map();
        for (const row of ms) {
            measurementsMap.set(row.zone_id, row);
        }

        for (const zone of zones) {
            if (zone.type === 'HOT_WATER') continue;

            const m = measurementsMap.get(zone.id) || { field_012d: 21.0, field_0135: 45.0 };

            const temp = m.field_012d !== null && m.field_012d !== undefined ? parseFloat(m.field_012d) : 21.0;
            const hum = m.field_0135 !== null && m.field_0135 !== undefined ? parseFloat(m.field_0135) : 45.0;

            // Coordinate Math: 0=Humid, 90=Warm, 180=Dry, 270=Cold
            const dx = (hum - 45.0) / 30.0;
            const dy = (temp - 20.5) / 5.0;

            let radial = Math.sqrt(dx * dx + dy * dy);
            let angular = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;

            // Mapping to levels
            let tempLevel = 'COMFY';
            if (temp < 16) tempLevel = 'TOO_COLD';
            else if (temp < 18) tempLevel = 'COLD';
            else if (temp > 25) tempLevel = 'HOT';
            else if (temp > 23) tempLevel = 'WARM';

            let humLevel = 'COMFY';
            if (hum < 25) humLevel = 'TOO_DRY';
            else if (hum < 30) humLevel = 'DRY';
            else if (hum > 70) humLevel = 'TOO_HUMID';
            else if (hum > 60) humLevel = 'HUMID';

            if (isV1) {
                let message = null;
                let visual = null;
                let link = null;

                if (tempLevel === 'COLD' || tempLevel === 'TOO_COLD') {
                    message = temp < 18.5
                        ? "Feel like getting under a warm blanket? Turn up your heating a bit to stay comfy in here."
                        : "This room feels a bit too cold. Raise the temperature to stay warm in here.";
                    link = { text: "Adjust heating", type: "internal", url: `tado://zones/${zone.id}` };
                } else if (humLevel === 'HUMID' || humLevel === 'TOO_HUMID') {
                    message = "Can you feel the humidity rising? Vent your room and let some breeze in.";
                    visual = "open_window";
                }

                roomMessages.push({
                    roomId: parseInt(zone.id, 10),
                    message: message,
                    visual: visual,
                    link: link
                });
            } else {
                zoneComforts.push({
                    roomId: parseInt(zone.id, 10),
                    temperatureLevel: tempLevel,
                    humidityLevel: humLevel,
                    coordinate: {
                        radial: parseFloat(Math.min(1.0, radial).toFixed(2)),
                        angular: Math.round(angular)
                    }
                });
            }
        }

        if (isV1) {
            const [weather] = await pool.execute('SELECT aqi, pollen_grass, pollen_birch, pollen_ragweed, pollen_olive FROM home_weather WHERE home_id = ? ORDER BY timestamp DESC LIMIT 1', [homeId]);
            const w = weather.length > 0 ? weather[0] : { aqi: null, pollen_grass: null, pollen_birch: null, pollen_ragweed: null, pollen_olive: null };
            const pollen = {
                grass: w.pollen_grass,
                birch: w.pollen_birch,
                ragweed: w.pollen_ragweed,
                olive: w.pollen_olive
            };

            function mapAqiToLevel(aqi) {
                if (aqi == null) return 'UNKNOWN';
                if (aqi <= 50) return 'GOOD';
                if (aqi <= 100) return 'FAIR';
                if (aqi <= 150) return 'MODERATE';
                if (aqi <= 200) return 'POOR';
                return 'VERY_POOR';
            }

            res.json({
                roomMessages: roomMessages,
                outdoorQuality: {
                    aqi: { level: mapAqiToLevel(w.aqi) },
                    pollens: {
                        dominant: { level: pollen ? (pollen.grass || 'UNKNOWN') : 'UNKNOWN', name: 'Grass' },
                        types: [
                            { name: "Grass", level: pollen ? (pollen.grass || 'UNKNOWN') : 'UNKNOWN' },
                            { name: "Birch", level: pollen ? (pollen.birch || 'UNKNOWN') : 'UNKNOWN' },
                            { name: "Ragweed", level: pollen ? (pollen.ragweed || 'UNKNOWN') : 'UNKNOWN' },
                            { name: "Olive", level: pollen ? (pollen.olive || 'UNKNOWN') : 'UNKNOWN' }
                        ]
                    },
                    pollutants: []
                }
            });
        } else {
            // V2 Freshness logic (FAIR if any window recently opened or humidity issues)
            let freshnessValue = hac.freshness || 'FRESH';
            if (freshnessValue === 'FRESH' && zoneComforts.some(c => c.humidityLevel.includes('HUMID'))) {
                freshnessValue = 'FAIR';
            }

            res.json({
                freshness: {
                    value: freshnessValue,
                    lastOpenWindow: hac.last_open_window ? (typeof hac.last_open_window === 'string' ? hac.last_open_window : hac.last_open_window.toISOString()) : null
                },
                comfort: zoneComforts
            });
        }
    } catch (err) {
        _log('error', `airComfort error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
};

router.get('/:homeId/airComfort', getAirComfortHandler);
router.get('/:homeId/climateQuality', getAirComfortHandler);



// GET /api/v2/homes/{homeId}/weather


// --- lines 411 to 445 ---
router.get('/:homeId/weather', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const pool = db.getPool();
        const [weather] = await pool.execute('SELECT * FROM home_weather WHERE home_id = ? ORDER BY timestamp DESC LIMIT 1', [homeId]);
        const w = weather.length > 0 ? weather[0] : { outside_temp_celsius: 18.0, solar_intensity_percentage: 10.0, weather_state: 'SUNNY', timestamp: new Date().toISOString() };

        res.json({
            solarIntensity: {
                type: 'PERCENTAGE',
                percentage: parseFloat(parseFloat(w.solar_intensity_percentage).toFixed(1)),
                timestamp: w.timestamp ? (typeof w.timestamp === 'string' ? w.timestamp : w.timestamp.toISOString()) : new Date().toISOString()
            },
            outsideTemperature: {
                celsius: parseFloat(parseFloat(w.outside_temp_celsius).toFixed(2)),
                fahrenheit: parseFloat((w.outside_temp_celsius * 1.8 + 32).toFixed(2)),
                timestamp: w.timestamp ? (typeof w.timestamp === 'string' ? w.timestamp : w.timestamp.toISOString()) : new Date().toISOString(),
                type: 'TEMPERATURE',
                precision: {
                    celsius: 0.01,
                    fahrenheit: 0.01
                }
            },
            weatherState: {
                type: 'WEATHER_STATE',
                value: w.weather_state,
                timestamp: w.timestamp ? (typeof w.timestamp === 'string' ? w.timestamp : w.timestamp.toISOString()) : new Date().toISOString()
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/{homeId}/installations


module.exports = router;