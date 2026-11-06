/**
 * @file lib/gas-energy-analyzer.js
 * @brief Gas consumption, cost calculation, DHW differentiation, and room apportionment engine.
 */

'use strict';

const { getLogger } = require('./logger');
const log = getLogger('gas-energy');
const { parseUtcDate } = require('./utils');

const DEFAULT_BOILER_KW = 24.0;
const DEFAULT_CALORIFIC_VALUE = 10.0; // ~10 kWh per m³ natural gas
const DEFAULT_UNIT_COST = 1.4500;
const DEFAULT_CURRENCY = '€';

/**
 * Get energy settings for a home.
 */
async function getHomeEnergySettings(pool, homeId) {
    const [rows] = await pool.execute(
        'SELECT * FROM home_energy_settings WHERE home_id = ? LIMIT 1',
        [homeId]
    );

    if (rows.length > 0) {
        const r = rows[0];
        return {
            home_id: r.home_id,
            gas_meter_topic: r.gas_meter_topic || `tado/tanoclo/h/${homeId}/energy/gas_meter`,
            gas_cost_topic: r.gas_cost_topic || `tado/tanoclo/h/${homeId}/energy/gas_cost_per_m3`,
            gas_unit_cost: parseFloat(r.gas_unit_cost || DEFAULT_UNIT_COST),
            currency: r.currency || DEFAULT_CURRENCY,
            allocation_method: r.allocation_method || 'demand',
            calorific_value_kwh_per_m3: parseFloat(r.calorific_value_kwh_per_m3 || DEFAULT_CALORIFIC_VALUE),
            created_at: r.created_at,
            updated_at: r.updated_at
        };
    }

    return {
        home_id: homeId,
        gas_meter_topic: `tado/tanoclo/h/${homeId}/energy/gas_meter`,
        gas_cost_topic: `tado/tanoclo/h/${homeId}/energy/gas_cost_per_m3`,
        gas_unit_cost: DEFAULT_UNIT_COST,
        currency: DEFAULT_CURRENCY,
        allocation_method: 'demand',
        calorific_value_kwh_per_m3: DEFAULT_CALORIFIC_VALUE,
        created_at: null,
        updated_at: null
    };
}

/**
 * Save or update energy settings for a home.
 */
async function saveHomeEnergySettings(pool, homeId, settings) {
    const gasMeterTopic = settings.gas_meter_topic !== undefined ? settings.gas_meter_topic : `tado/tanoclo/h/${homeId}/energy/gas_meter`;
    const gasCostTopic = settings.gas_cost_topic !== undefined ? settings.gas_cost_topic : `tado/tanoclo/h/${homeId}/energy/gas_cost_per_m3`;
    const gasUnitCost = settings.gas_unit_cost !== undefined ? parseFloat(settings.gas_unit_cost) : DEFAULT_UNIT_COST;
    const currency = settings.currency || DEFAULT_CURRENCY;
    const allocationMethod = settings.allocation_method === 'area_weighted' ? 'area_weighted' : 'demand';
    const calorificValue = settings.calorific_value_kwh_per_m3 !== undefined ? parseFloat(settings.calorific_value_kwh_per_m3) : DEFAULT_CALORIFIC_VALUE;

    await pool.execute(
        `INSERT INTO home_energy_settings 
            (home_id, gas_meter_topic, gas_cost_topic, gas_unit_cost, currency, allocation_method, calorific_value_kwh_per_m3)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            gas_meter_topic = VALUES(gas_meter_topic),
            gas_cost_topic = VALUES(gas_cost_topic),
            gas_unit_cost = VALUES(gas_unit_cost),
            currency = VALUES(currency),
            allocation_method = VALUES(allocation_method),
            calorific_value_kwh_per_m3 = VALUES(calorific_value_kwh_per_m3),
            updated_at = CURRENT_TIMESTAMP`,
        [homeId, gasMeterTopic, gasCostTopic, gasUnitCost, currency, allocationMethod, calorificValue]
    );

    return getHomeEnergySettings(pool, homeId);
}

/**
 * Record a new gas meter reading into gas_meter_readings.
 */
async function recordGasMeterReading(pool, homeId, meterM3, unitCost = null, source = 'mqtt') {
    const val = parseFloat(meterM3);
    if (isNaN(val) || val < 0) {
        throw new Error(`Invalid meter reading: ${meterM3}`);
    }

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const costVal = (unitCost !== null && !isNaN(parseFloat(unitCost))) ? parseFloat(unitCost) : null;

    const [res] = await pool.execute(
        `INSERT INTO gas_meter_readings (home_id, timestamp, meter_m3, unit_cost, source)
         VALUES (?, ?, ?, ?, ?)`,
        [homeId, now, val, costVal, source]
    );

    // If unit cost is specified, update settings
    if (costVal !== null) {
        await pool.execute(
            `INSERT INTO home_energy_settings (home_id, gas_unit_cost)
             VALUES (?, ?)
             ON DUPLICATE KEY UPDATE gas_unit_cost = VALUES(gas_unit_cost), updated_at = CURRENT_TIMESTAMP`,
            [homeId, costVal]
        );
    }

    return { id: res.insertId, homeId, timestamp: now, meterM3: val, unitCost: costVal, source };
}

/**
 * Fetch latest meter reading for a home.
 */
async function getLatestGasReading(pool, homeId) {
    const [rows] = await pool.execute(
        'SELECT * FROM gas_meter_readings WHERE home_id = ? ORDER BY timestamp DESC LIMIT 1',
        [homeId]
    );
    if (rows.length === 0) return null;
    return {
        timestamp: rows[0].timestamp,
        meterM3: parseFloat(rows[0].meter_m3),
        unitCost: rows[0].unit_cost !== null ? parseFloat(rows[0].unit_cost) : null,
        source: rows[0].source
    };
}

/**
 * Calculate gas usage, DHW split, and per-room costs over a time period.
 */
async function getGasUsageAndCosts(pool, homeId, from, to) {
    const settings = await getHomeEnergySettings(pool, homeId);
    const fromStr = from.toISOString().slice(0, 19).replace('T', ' ');
    const toStr = to.toISOString().slice(0, 19).replace('T', ' ');

    // 1. Fetch meter readings in/around range
    const [readings] = await pool.execute(
        `SELECT timestamp, meter_m3, unit_cost 
         FROM gas_meter_readings 
         WHERE home_id = ? AND timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp ASC`,
        [homeId, fromStr, toStr]
    );

    // Also look for latest reading before range if first reading is after fromStr
    let startReading = null;
    if (readings.length === 0 || readings[0].timestamp > fromStr) {
        const [prevRows] = await pool.execute(
            `SELECT timestamp, meter_m3, unit_cost 
             FROM gas_meter_readings 
             WHERE home_id = ? AND timestamp < ?
             ORDER BY timestamp DESC LIMIT 1`,
            [homeId, fromStr]
        );
        if (prevRows.length > 0) {
            startReading = prevRows[0];
        }
    }

    let endReading = readings.length > 0 ? readings[readings.length - 1] : startReading;
    if (!startReading && readings.length > 0) {
        startReading = readings[0];
    }

    let totalM3 = 0;
    let isEstimated = false;

    if (startReading && endReading && endReading.timestamp !== startReading.timestamp) {
        const delta = parseFloat(endReading.meter_m3) - parseFloat(startReading.meter_m3);
        totalM3 = Math.max(0, delta);
    } else if (startReading && endReading && readings.length >= 2) {
        const delta = parseFloat(readings[readings.length - 1].meter_m3) - parseFloat(readings[0].meter_m3);
        totalM3 = Math.max(0, delta);
    } else {
        // Fallback: estimate from boiler runtime if no meter readings
        isEstimated = true;
    }

    // 2. Fetch OpenTherm circuit measurements to differentiate DHW and CH
    const [cMeas] = await pool.execute(
        `SELECT timestamp, field_4080, field_0457, field_0452, field_045e 
         FROM circuit_measurements 
         WHERE home_id = ? AND timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp ASC`,
        [homeId, fromStr, toStr]
    );

    let dhwDemandSeconds = 0;
    let chDemandSeconds = 0;

    for (let i = 0; i < cMeas.length - 1; i++) {
        const cur = cMeas[i];
        const nxt = cMeas[i + 1];

        const t1 = Math.floor(parseUtcDate(cur.timestamp).getTime() / 1000);
        const t2 = Math.floor(parseUtcDate(nxt.timestamp).getTime() / 1000);
        let deltaSec = t2 - t1;
        if (deltaSec > 3600) deltaSec = 3600;
        if (deltaSec <= 0) continue;

        const isBoilerFiring = Boolean(cur.field_0457) || (parseFloat(cur.field_0452) > 0) || (parseFloat(cur.field_4080) > 0);
        if (!isBoilerFiring) continue;

        const modulation = Math.max(1, parseFloat(cur.field_0452) || 100) / 100;
        const weightedSec = deltaSec * modulation;

        const isDhw = parseFloat(cur.field_045e) > 0;
        if (isDhw) {
            dhwDemandSeconds += weightedSec;
        } else {
            chDemandSeconds += weightedSec;
        }
    }

    // Boiler capacity for kWh estimation
    let boilerKw = DEFAULT_BOILER_KW;
    try {
        const [hsRows] = await pool.execute(
            'SELECT boiler_capacity_kw FROM heating_systems WHERE home_id = ? LIMIT 1',
            [homeId]
        );
        if (hsRows.length > 0 && hsRows[0].boiler_capacity_kw) {
            boilerKw = parseFloat(hsRows[0].boiler_capacity_kw);
        }
    } catch (e) {
        log('warn', `Failed to read boiler_capacity_kw for home ${homeId}: ${e.message}`);
    }

    if (isEstimated) {
        const totalRunHours = (dhwDemandSeconds + chDemandSeconds) / 3600;
        const estKwh = totalRunHours * boilerKw;
        totalM3 = Math.round((estKwh / settings.calorific_value_kwh_per_m3) * 1000) / 1000;
    }

    const totalDemandSeconds = dhwDemandSeconds + chDemandSeconds;
    let dhwRatio = 0;
    if (totalDemandSeconds > 0) {
        dhwRatio = dhwDemandSeconds / totalDemandSeconds;
    } else {
        dhwRatio = 0; // Default to 0 DHW if no firing observed
    }

    const dhwM3 = Math.round(totalM3 * dhwRatio * 1000) / 1000;
    const heatingM3 = Math.round((totalM3 - dhwM3) * 1000) / 1000;

    const unitCost = settings.gas_unit_cost;
    const totalCost = Math.round(totalM3 * unitCost * 100) / 100;
    const dhwCost = Math.round(dhwM3 * unitCost * 100) / 100;
    const heatingCost = Math.round((totalCost - dhwCost) * 100) / 100;

    const totalKwh = Math.round(totalM3 * settings.calorific_value_kwh_per_m3 * 100) / 100;
    const dhwKwh = Math.round(dhwM3 * settings.calorific_value_kwh_per_m3 * 100) / 100;
    const heatingKwh = Math.round(heatingM3 * settings.calorific_value_kwh_per_m3 * 100) / 100;

    // 3. Query zone measurements and room sizes for space heating apportionment
    const [zones] = await pool.execute(
        `SELECT id, name, room_size_sqm, heating_type 
         FROM zones 
         WHERE home_id = ? AND type != 'HOT_WATER' AND type != 'DHW'`,
        [homeId]
    );

    const zoneWeights = {};
    const zoneRunTimes = {};
    zones.forEach(z => {
        zoneWeights[z.id] = 0;
        zoneRunTimes[z.id] = 0;
    });

    if (zones.length > 0) {
        const zoneIds = zones.map(z => z.id);
        const placeholders = zoneIds.map(() => '?').join(',');
        const [zMeas] = await pool.execute(
            `SELECT zone_id, timestamp, field_40a0 
             FROM zone_measurements 
             WHERE home_id = ? AND zone_id IN (${placeholders}) 
               AND timestamp >= ? AND timestamp <= ?
             ORDER BY zone_id, timestamp ASC`,
            [homeId, ...zoneIds, fromStr, toStr]
        );

        const byZone = {};
        zoneIds.forEach(id => byZone[id] = []);
        zMeas.forEach(m => {
            if (byZone[m.zone_id]) byZone[m.zone_id].push(m);
        });

        for (const [zIdStr, mArr] of Object.entries(byZone)) {
            const zId = parseInt(zIdStr, 10);
            const zoneInfo = zones.find(z => z.id === zId);
            const roomSize = (zoneInfo && zoneInfo.room_size_sqm) ? parseFloat(zoneInfo.room_size_sqm) : 1.0;

            for (let i = 0; i < mArr.length - 1; i++) {
                const cur = mArr[i];
                const nxt = mArr[i + 1];

                const power = parseFloat(cur.field_40a0);
                if (power > 0) {
                    const t1 = Math.floor(parseUtcDate(cur.timestamp).getTime() / 1000);
                    const t2 = Math.floor(parseUtcDate(nxt.timestamp).getTime() / 1000);
                    let delta = t2 - t1;
                    if (delta > 3600) delta = 3600;
                    if (delta <= 0) continue;

                    zoneRunTimes[zId] += delta;
                    const dutyEnergy = (power / 100) * delta;

                    if (settings.allocation_method === 'area_weighted' && roomSize > 0) {
                        zoneWeights[zId] += (dutyEnergy * roomSize);
                    } else {
                        zoneWeights[zId] += dutyEnergy;
                    }
                }
            }
        }
    }

    let totalZoneWeight = 0;
    zones.forEach(z => totalZoneWeight += zoneWeights[z.id]);

    const zoneResults = zones.map(z => {
        const zWeight = zoneWeights[z.id];
        const share = totalZoneWeight > 0 ? (zWeight / totalZoneWeight) : (zones.length > 0 ? (1 / zones.length) : 0);
        const zM3 = Math.round(heatingM3 * share * 1000) / 1000;
        const zCost = Math.round(zM3 * unitCost * 100) / 100;
        const zKwh = Math.round(zM3 * settings.calorific_value_kwh_per_m3 * 100) / 100;
        const zPct = totalZoneWeight > 0 ? Math.round(share * 1000) / 10 : 0;

        return {
            id: z.id,
            name: z.name,
            roomSizeSqm: z.room_size_sqm !== null ? parseFloat(z.room_size_sqm) : null,
            heatingType: z.heating_type,
            runningSeconds: Math.round(zoneRunTimes[z.id]),
            m3: zM3,
            kwh: zKwh,
            cost: zCost,
            percentage: zPct
        };
    });

    return {
        homeId,
        period: { from: from.toISOString(), to: to.toISOString() },
        meterReading: {
            start: startReading ? { timestamp: startReading.timestamp, meterM3: parseFloat(startReading.meter_m3) } : null,
            end: endReading ? { timestamp: endReading.timestamp, meterM3: parseFloat(endReading.meter_m3) } : null,
            deltaM3: Math.round(totalM3 * 1000) / 1000,
            isEstimated
        },
        totals: {
            totalM3: Math.round(totalM3 * 1000) / 1000,
            totalKwh,
            totalCost,
            unitCost,
            currency: settings.currency,
            calorificValueKwhPerM3: settings.calorific_value_kwh_per_m3
        },
        dhw: {
            m3: dhwM3,
            kwh: dhwKwh,
            cost: dhwCost,
            percentage: totalM3 > 0 ? Math.round((dhwM3 / totalM3) * 1000) / 10 : 0,
            runningSeconds: Math.round(dhwDemandSeconds)
        },
        heating: {
            m3: heatingM3,
            kwh: heatingKwh,
            cost: heatingCost,
            percentage: totalM3 > 0 ? Math.round((heatingM3 / totalM3) * 1000) / 10 : 0,
            runningSeconds: Math.round(chDemandSeconds)
        },
        allocationMethod: settings.allocation_method,
        zones: zoneResults
    };
}

/**
 * Get daily gas summary array for the last N days.
 */
async function getDailyGasSummary(pool, homeId, days = 30) {
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

    const dailySummary = [];
    const curr = new Date(from);
    curr.setUTCHours(0, 0, 0, 0);

    while (curr < to) {
        const next = new Date(curr.getTime() + 24 * 60 * 60 * 1000);
        const dayTo = next > to ? to : next;
        const dayResult = await getGasUsageAndCosts(pool, homeId, curr, dayTo);

        dailySummary.push({
            date: curr.toISOString().split('T')[0],
            totalM3: dayResult.totals.totalM3,
            totalKwh: dayResult.totals.totalKwh,
            totalCost: dayResult.totals.totalCost,
            dhwM3: dayResult.dhw.m3,
            dhwCost: dayResult.dhw.cost,
            heatingM3: dayResult.heating.m3,
            heatingCost: dayResult.heating.cost,
            isEstimated: dayResult.meterReading.isEstimated
        });

        curr.setTime(curr.getTime() + 24 * 60 * 60 * 1000);
    }

    return {
        homeId,
        days,
        dailySummary
    };
}

module.exports = {
    getHomeEnergySettings,
    saveHomeEnergySettings,
    recordGasMeterReading,
    getLatestGasReading,
    getGasUsageAndCosts,
    getDailyGasSummary
};
