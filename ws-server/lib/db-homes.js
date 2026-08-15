/**
 * @file lib/db-homes.js
 * @brief Home registrations and presence status database helper queries.
 */

'use strict';

/**
 * @module db-homes
 * 
 * Home-related database queries.
 */

const { getPool } = require('./db-base');
const { getLogger } = require('./logger');
const _log = getLogger('db');

async function getHome(homeId) {
    const p = getPool();
    const [rows] = await p.execute('SELECT * FROM homes WHERE id = ? LIMIT 1', [homeId]);
    return rows.length > 0 ? rows[0] : null;
}

async function getHomesWithLocation() {
    const pool = getPool();
    const [rows] = await pool.execute('SELECT id, latitude, longitude FROM homes WHERE latitude IS NOT NULL AND longitude IS NOT NULL');
    return rows;
}

async function getHomeTimezone(homeId, zoneId) {
    if (!homeId) throw new Error('homeId is required for getHomeTimezone');
    const p = getPool();
    const [rows] = await p.execute('SELECT date_time_zone FROM homes WHERE id = ? LIMIT 1', [homeId]);
    if (rows.length > 0 && rows[0].date_time_zone) return rows[0].date_time_zone;
    return 'UTC';
}

async function saveHomeWeather(homeId, temp, solar, state, aqi = null, pollen = null) {
    const pool = getPool();
    let grass = null, birch = null, ragweed = null, olive = null;
    if (pollen) {
        try {
            const pObj = typeof pollen === 'string' ? JSON.parse(pollen) : pollen;
            grass = pObj.grass || null;
            birch = pObj.birch || null;
            ragweed = pObj.ragweed || null;
            olive = pObj.olive || null;
        } catch (e) {
            _log('error', `Failed to parse pollen telemetry: ${e.message}`);
        }
    }
    await pool.execute(`
        INSERT INTO home_weather (home_id, outside_temp_celsius, solar_intensity_percentage, weather_state, aqi, pollen_grass, pollen_birch, pollen_ragweed, pollen_olive, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
    `, [homeId, temp, solar, state, aqi, grass, birch, ragweed, olive]);
}

async function getHomeWeatherForTimeRange(homeId, startUtc, endUtc) {
    const p = getPool();
    const [rows] = await p.execute(`
        SELECT * FROM home_weather 
        WHERE home_id = ? 
          AND timestamp >= ? 
          AND timestamp <= ?
        ORDER BY timestamp ASC
    `, [homeId, startUtc, endUtc]);
    return rows;
}

async function getHomeState(homeId) {
    const dbZones = require('./db-zones');
    const zones = await dbZones.getZonesForHome(homeId);
    return { id: homeId, zones };
}

async function getHomeEtags(homeId) {
    const p = getPool();
    const [rows] = await p.execute('SELECT hvac_etag FROM heating_systems WHERE home_id = ?', [homeId]);
    if (rows.length === 0) return null;
    return {
        hvac: rows[0].hvac_etag
    };
}

module.exports = {
    getHome,
    getHomesWithLocation,
    getHomeTimezone,
    saveHomeWeather,
    getHomeWeatherForTimeRange,
    getHomeState,
    getHomeEtags
};
