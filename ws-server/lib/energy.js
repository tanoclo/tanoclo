/**
 * @file lib/energy.js
 * @brief Hours of boiler activity energy calculation helpers.
 */

'use strict';

/**
 * Energy Analytics — compute energy usage estimates from zone measurements.
 *
 * Uses the field_40a0 percentage from zone_measurements to estimate
 * energy consumption over time periods. The field_40a0 field (0-100%)
 * represents the proportion of time the boiler was firing during each
 * measurement interval.
 *
 * Estimation model:
 *   energy_kWh = Σ (field_40a0/100 * boiler_capacity_kW * interval_hours)
 *
 * Default boiler capacity is 24kW if not configured per-home.
 */

const { getLogger } = require('./logger');
const log = getLogger('energy');

const { parseUtcDate } = require('./utils');

const DEFAULT_BOILER_KW = 24;

/**
 * Compute energy usage for a zone over a time range.
 *
 * @param {object} pool - DB connection pool
 * @param {number} homeId
 * @param {number} zoneId
 * @param {Date} from - Start of range (inclusive)
 * @param {Date} to - End of range (inclusive)
 * @returns {{ totalKwh: number, dataPoints: number, avgPower: number, maxPower: number, dailyBreakdown: object }}
 */
async function getZoneEnergyUsage(pool, homeId, zoneId, from, to) {
    const [rows] = await pool.execute(
        `SELECT timestamp, field_40a0, field_012d, field_6200
         FROM zone_measurements 
         WHERE home_id = ? AND zone_id = ? AND timestamp BETWEEN ? AND ?
         ORDER BY timestamp ASC`,
        [homeId, zoneId, from.toISOString(), to.toISOString()]
    );

    if (rows.length < 2) {
        return { totalKwh: 0, dataPoints: rows.length, avgPower: 0, maxPower: 0, dailyBreakdown: {} };
    }

    // Get boiler capacity for this home (fall back to default)
    let boilerKw = DEFAULT_BOILER_KW;
    try {
        const [hsRows] = await pool.execute(
            'SELECT boiler_capacity_kw FROM heating_systems WHERE home_id = ? LIMIT 1',
            [homeId]
        );
        if (hsRows.length > 0 && hsRows[0].boiler_capacity_kw) {
            boilerKw = hsRows[0].boiler_capacity_kw;
        }
    } catch (e) {
        log('warn', `Failed to fetch boiler capacity for home ${homeId}, using default ${DEFAULT_BOILER_KW}kW: ${e.message}`);
    }

    let totalKwh = 0;
    let maxPower = 0;
    let powerSum = 0;
    const dailyBreakdown = {};

    for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1];
        const curr = rows[i];

        const prevTime = parseUtcDate(prev.timestamp).getTime();
        const currTime = parseUtcDate(curr.timestamp).getTime();
        const intervalHours = (currTime - prevTime) / (1000 * 60 * 60);

        // Cap interval at 1 hour to avoid inflated estimates from gaps
        const cappedInterval = Math.min(intervalHours, 1.0);

        const power = (prev.field_40a0 ?? 0) / 100;
        const kwh = power * boilerKw * cappedInterval;
        totalKwh += kwh;

        if (prev.field_40a0 > maxPower) maxPower = prev.field_40a0;
        powerSum += (prev.field_40a0 ?? 0);

        // Daily breakdown
        const dayKey = parseUtcDate(prev.timestamp).toISOString().split('T')[0];
        if (!dailyBreakdown[dayKey]) dailyBreakdown[dayKey] = 0;
        dailyBreakdown[dayKey] += kwh;
    }

    // Round daily values
    for (const day of Object.keys(dailyBreakdown)) {
        dailyBreakdown[day] = Math.round(dailyBreakdown[day] * 100) / 100;
    }

    return {
        totalKwh: Math.round(totalKwh * 100) / 100,
        dataPoints: rows.length,
        avgPower: Math.round((powerSum / (rows.length - 1)) * 100) / 100,
        maxPower,
        boilerCapacityKw: boilerKw,
        dailyBreakdown,
    };
}

/**
 * Compute energy usage for all zones in a home.
 *
 * @param {object} pool
 * @param {number} homeId
 * @param {Date} from
 * @param {Date} to
 * @returns {{ homeId, totalKwh, zones: Array }}
 */
async function getHomeEnergyUsage(pool, homeId, from, to) {
    const [zones] = await pool.execute(
        'SELECT id, name, type FROM zones WHERE home_id = ?',
        [homeId]
    );

    let homeTotalKwh = 0;
    const zoneResults = [];

    for (const zone of zones) {
        const usage = await getZoneEnergyUsage(pool, homeId, zone.id, from, to);
        homeTotalKwh += usage.totalKwh;
        zoneResults.push({
            zoneId: zone.id,
            zoneName: zone.name,
            zoneType: zone.type,
            ...usage,
        });
    }

    return {
        homeId,
        totalKwh: Math.round(homeTotalKwh * 100) / 100,
        period: { from: from.toISOString(), to: to.toISOString() },
        zones: zoneResults,
    };
}

/**
 * Compute daily energy summary for a home (last N days).
 *
 * @param {object} pool
 * @param {number} homeId
 * @param {number} days - Number of days to look back (default 30)
 * @returns {{ homeId, days, dailySummary: Array<{ date, totalKwh, avgTemp, avgHumidity }> }}
 */
async function getDailyEnergySummary(pool, homeId, days = 30) {
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

    const [rows] = await pool.execute(
        `SELECT 
            DATE(timestamp) as day,
            AVG(field_40a0) as avg_power,
            AVG(field_012d) as avg_temp,
            AVG(field_0135) as avg_humidity,
            COUNT(*) as samples
         FROM zone_measurements 
         WHERE home_id = ? AND timestamp BETWEEN ? AND ?
         GROUP BY DATE(timestamp)
         ORDER BY day ASC`,
        [homeId, from.toISOString(), to.toISOString()]
    );

    // Get boiler capacity
    let boilerKw = DEFAULT_BOILER_KW;
    try {
        const [hsRows] = await pool.execute(
            'SELECT boiler_capacity_kw FROM heating_systems WHERE home_id = ? LIMIT 1',
            [homeId]
        );
        if (hsRows.length > 0 && hsRows[0].boiler_capacity_kw) {
            boilerKw = hsRows[0].boiler_capacity_kw;
        }
    } catch (e) {
        log('warn', `Failed to fetch boiler capacity for home ${homeId}, using default ${DEFAULT_BOILER_KW}kW: ${e.message}`);
    }

    const dailySummary = rows.map(row => ({
        date: row.day instanceof Date ? row.day.toISOString().split('T')[0] : String(row.day),
        totalKwh: Math.round(((row.avg_power || 0) / 100) * boilerKw * 24 * 100) / 100,
        avgPowerPercent: Math.round((row.avg_power || 0) * 100) / 100,
        avgTemperature: row.avg_temp != null ? Math.round(row.avg_temp * 100) / 100 : null,
        avgHumidity: row.avg_humidity != null ? Math.round(row.avg_humidity * 100) / 100 : null,
        samples: row.samples,
    }));

    return {
        homeId,
        days,
        boilerCapacityKw: boilerKw,
        dailySummary,
    };
}

module.exports = { getZoneEnergyUsage, getHomeEnergyUsage, getDailyEnergySummary };
