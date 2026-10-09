/**
 * @file lib/flow-optimizer.js
 * @brief Dynamic flow temperature optimizer based on weather, zone demand, and boiler telemetry.
 */

'use strict';

const { getLogger } = require('./logger');
const log = getLogger('flow-optimizer');
const weather = require('./weather');

let _db = null;
let _commandApi = null;
let _mqttPublisher = null;

function init(db, commandApi, mqttPublisher) {
    _db = db;
    _commandApi = commandApi;
    _mqttPublisher = mqttPublisher;
    log('info', 'TaNoClo Flow Temperature Optimizer initialized');
}

/**
 * Pure calculation function for computing the optimal supply/flow temperature.
 * 
 * @param {Object} params
 * @param {number} params.outsideTemp - Current outdoor temperature in °C
 * @param {number} params.minFlow - Configured minimum flow temperature bound
 * @param {number} params.maxFlowLimit - Configured maximum flow temperature ceiling
 * @param {number} params.currentMaxFlow - Currently configured max flow temperature
 * @param {number} params.maxZoneError - Highest positive error (target - current) among active zones
 * @param {number} params.circuitDemandPct - Circuit demand percent (0 - 100)
 * @param {number|null} [params.modulationPct] - Live burner modulation percent (0 - 100)
 * @param {number[]|null} [params.forecastHourly] - Array of forecasted outdoor temperatures (next hours)
 * @returns {Object} { targetFlow, baseFlow, demandBoost, forecastAdj, modAdj, reason, changed }
 */
function computeOptimalFlowTemperature({
    outsideTemp = 10,
    minFlow = 30,
    maxFlowLimit = 80,
    currentMaxFlow = 60,
    maxZoneError = 0,
    circuitDemandPct = 0,
    modulationPct = null,
    forecastHourly = null
}) {
    // 1. Guardrail sanity checks
    minFlow = Math.max(20, Math.min(minFlow, 50));
    maxFlowLimit = Math.max(minFlow, Math.min(maxFlowLimit, 85));
    currentMaxFlow = Math.max(minFlow, Math.min(currentMaxFlow, maxFlowLimit));

    // 2. Idle / Standby check: If no circuit demand and all rooms satisfied
    if (circuitDemandPct <= 0 && maxZoneError <= 0) {
        const targetFlow = minFlow;
        const diff = targetFlow - currentMaxFlow;
        const changed = Math.abs(diff) >= 1.0;
        const steppedFlow = changed ? currentMaxFlow + Math.max(-3.0, Math.min(3.0, diff)) : currentMaxFlow;
        return {
            targetFlow: Math.round(steppedFlow),
            baseFlow: minFlow,
            demandBoost: 0,
            forecastAdj: 0,
            modAdj: 0,
            reason: 'idle_standby',
            changed: Math.round(steppedFlow) !== currentMaxFlow
        };
    }

    // 3. Weather Heating Curve (Linear outdoor compensation: +20°C -> minFlow, -10°C -> maxFlowLimit)
    const outdoorFraction = Math.max(0, Math.min(1, (20 - outsideTemp) / 30));
    const baseFlow = minFlow + outdoorFraction * (maxFlowLimit - minFlow);

    // 4. Zone Demand Adjustment
    let demandBoost = 0;
    let reason = 'weather_curve';

    if (maxZoneError >= 2.0) {
        demandBoost = 5.0;
        reason = 'cold_recovery';
    } else if (maxZoneError >= 1.0) {
        demandBoost = 2.5;
        reason = 'demand_recovery';
    } else if (maxZoneError < 0.3) {
        demandBoost = -3.0;
        reason = 'near_setpoint';
    }

    // 5. Weather Forecast Pre-adjustment (Next 3h trend)
    let forecastAdj = 0;
    if (forecastHourly && Array.isArray(forecastHourly) && forecastHourly.length >= 3) {
        const futureTemp = forecastHourly[2]; // ~3 hours ahead
        const trend = futureTemp - outsideTemp;
        if (trend >= 2.0) {
            forecastAdj = -2.0; // Warming up rapidly: pre-cool to avoid overshoot
        } else if (trend <= -2.0) {
            forecastAdj = 2.0;  // Rapid drop coming: pre-boost
        }
    }

    // 6. Boiler Modulation Feedback
    let modAdj = 0;
    if (modulationPct !== null && modulationPct !== undefined) {
        if (modulationPct > 0 && modulationPct < 25 && maxZoneError < 0.5) {
            modAdj = -2.0; // Low modulation and satisfied rooms: flow temp is higher than needed
        } else if (modulationPct > 85 && maxZoneError > 0.8) {
            modAdj = 2.0;  // High modulation and struggling to reach setpoint: raise flow
        }
    }

    // 7. Compute raw target and clamp to user limits
    const rawTarget = Math.round(baseFlow + demandBoost + forecastAdj + modAdj);
    const clampedTarget = Math.max(minFlow, Math.min(maxFlowLimit, rawTarget));

    // 8. Hysteresis & Rate Limiting (Prevent oscillation, max ±3°C per evaluation cycle)
    const delta = clampedTarget - currentMaxFlow;
    let nextFlow = currentMaxFlow;
    let changed = false;

    if (Math.abs(delta) >= 1.0) {
        const step = Math.max(-3.0, Math.min(3.0, delta));
        nextFlow = Math.round(currentMaxFlow + step);
        nextFlow = Math.max(minFlow, Math.min(maxFlowLimit, nextFlow));
        changed = nextFlow !== currentMaxFlow;
    }

    return {
        targetFlow: nextFlow,
        baseFlow: Math.round(baseFlow * 10) / 10,
        demandBoost,
        forecastAdj,
        modAdj,
        reason,
        changed
    };
}

/**
 * Evaluates and optimizes flow temperature for a single home.
 * 
 * @param {number|string} homeId 
 * @returns {Promise<Object|null>}
 */
async function evaluateHome(homeId) {
    if (!_db || _db.isOffline()) return null;
    const pool = _db.getPool();

    try {
        // 1. Fetch flow temperature settings
        const [settingsRows] = await pool.execute(
            'SELECT * FROM flow_temperature_settings WHERE home_id = ?',
            [homeId]
        );
        if (settingsRows.length === 0) return null;
        const settings = settingsRows[0];

        // Skip if auto-adaptation is turned off by the user
        if (!settings.auto_adaptation_enabled) return null;

        const minFlow = settings.min_flow_temperature ? parseInt(settings.min_flow_temperature, 10) : 30;
        const maxFlowLimit = settings.max_flow_temperature_limit ? parseInt(settings.max_flow_temperature_limit, 10) : 80;
        const currentMaxFlow = settings.max_flow_temperature ? parseInt(settings.max_flow_temperature, 10) : 60;

        // 2. Outdoor temperature
        let outsideTemp = 10.0;
        const [weatherRows] = await pool.execute(
            'SELECT outside_temp_celsius FROM home_weather WHERE home_id = ? ORDER BY timestamp DESC LIMIT 1',
            [homeId]
        );
        if (weatherRows.length > 0 && weatherRows[0].outside_temp_celsius !== null) {
            outsideTemp = parseFloat(weatherRows[0].outside_temp_celsius);
        } else {
            // Fallback to boiler sensor (OT ID 27 / 0x044f) in heating_systems
            const [hsRows] = await pool.execute(
                'SELECT last_config_json FROM heating_systems WHERE home_id = ?',
                [homeId]
            );
            if (hsRows.length > 0 && hsRows[0].last_config_json) {
                try {
                    const cfg = typeof hsRows[0].last_config_json === 'object'
                        ? hsRows[0].last_config_json
                        : JSON.parse(hsRows[0].last_config_json);
                    if (cfg['0x044f'] !== undefined) {
                        outsideTemp = parseFloat(cfg['0x044f']);
                    }
                } catch (e) {}
            }
        }

        // 3. Hourly Forecast
        const forecastObj = weather.getHomeForecast ? weather.getHomeForecast(homeId) : null;
        const forecastHourly = forecastObj ? forecastObj.hourly : null;

        // 4. Boiler live telemetry
        const [boilerRows] = await pool.execute(
            'SELECT field_044c, field_044d, field_0452 FROM heating_systems WHERE home_id = ? LIMIT 1',
            [homeId]
        );
        const actualFlowTemp = boilerRows.length > 0 && boilerRows[0].field_044c !== null ? parseFloat(boilerRows[0].field_044c) : null;
        const modulationPct = boilerRows.length > 0 && boilerRows[0].field_0452 !== null ? parseInt(boilerRows[0].field_0452, 10) : null;

        // 5. Dynamic circuit determination & demand %
        const [circRows] = await pool.execute(
            'SELECT number, field_4080, field_2040, driver_serial_no FROM heating_circuits WHERE home_id = ? ORDER BY number ASC',
            [homeId]
        );

        let targetCircuitNumbers = [];
        let circuitDemandPct = 0;

        if (circRows.length > 0) {
            targetCircuitNumbers = circRows.map(r => r.number);
            circuitDemandPct = Math.max(0, ...circRows.map(r => r.field_4080 || 0));
        } else {
            const [devCircRows] = await pool.execute(
                `SELECT z.heating_circuit 
                 FROM devices d 
                 JOIN zones z ON d.zone_id = z.id 
                 WHERE d.home_id = ? AND d.device_type IN ('RU01', 'RU02', 'BU01') AND z.heating_circuit IS NOT NULL LIMIT 1`,
                [homeId]
            );
            if (devCircRows.length > 0 && devCircRows[0].heating_circuit) {
                targetCircuitNumbers.push(parseInt(devCircRows[0].heating_circuit, 10));
            } else {
                targetCircuitNumbers.push(1);
            }
        }

        // 6. Active zone temperatures and errors
        const [zoneRows] = await pool.execute(
            `SELECT z.id, z.name, zm.field_012d AS current_temp
             FROM zones z
             LEFT JOIN (
                 SELECT zone_id, field_012d
                 FROM zone_measurements
                 WHERE id IN (SELECT MAX(id) FROM zone_measurements WHERE home_id = ? GROUP BY zone_id)
             ) zm ON zm.zone_id = z.id
             WHERE z.home_id = ? AND z.type != 'HOT_WATER' AND z.type != 'DHW'`,
            [homeId, homeId]
        );

        let maxZoneError = 0;
        for (const z of zoneRows) {
            try {
                const zState = await _db.getZoneState(homeId, z.id);
                if (zState) {
                    const enabled = (zState['0x61e0'] ?? zState.field_61e0 ?? 1) === 1;
                    if (enabled) {
                        const targetTemp = parseFloat(zState['0x6280'] ?? zState.field_6280 ?? zState['0x6200'] ?? zState.field_6200 ?? 20);
                        const currentTemp = z.current_temp !== null && z.current_temp !== undefined ? parseFloat(z.current_temp) : null;
                        if (currentTemp !== null && targetTemp > currentTemp) {
                            const err = targetTemp - currentTemp;
                            if (err > maxZoneError) {
                                maxZoneError = err;
                            }
                        }
                    }
                }
            } catch (err) {
                log('warn', `Error evaluating zone ${z.id} state for home ${homeId}: ${err.message}`);
            }
        }

        // 7. Calculate optimal flow temperature
        const opt = computeOptimalFlowTemperature({
            outsideTemp,
            minFlow,
            maxFlowLimit,
            currentMaxFlow,
            maxZoneError,
            circuitDemandPct,
            modulationPct,
            forecastHourly
        });

        const newFlow = opt.targetFlow;
        const nowIso = new Date().toISOString().slice(0, 19).replace('T', ' ');

        // 8. If changed, apply new flow temperature
        if (opt.changed) {
            log('info', `[flow-optimizer] Home ${homeId}: max flow temp adjusted ${currentMaxFlow}°C -> ${newFlow}°C (reason=${opt.reason}, outdoor=${outsideTemp.toFixed(1)}°C, maxZoneError=${maxZoneError.toFixed(1)}°C, demand=${circuitDemandPct}%)`);

            await pool.execute(
                'UPDATE flow_temperature_settings SET max_flow_temperature = ? WHERE home_id = ?',
                [newFlow, homeId]
            );

            // Update circuit configs dynamically in DB and invalidate ETag so RU / bridge picks it up
            for (const cNum of targetCircuitNumbers) {
                await _db.updateCircuitConfig(homeId, cNum, { '0x2040': newFlow });
            }
        }

        // 9. Record history log
        try {
            await pool.execute(
                `INSERT INTO flow_temperature_history 
                 (home_id, timestamp, computed_flow_temp, actual_flow_temp, outside_temp, max_zone_error, modulation_pct, demand_pct, reason)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    homeId,
                    nowIso,
                    newFlow,
                    actualFlowTemp,
                    outsideTemp,
                    maxZoneError,
                    modulationPct,
                    circuitDemandPct,
                    opt.reason
                ]
            );
        } catch (histErr) {
            log('warn', `Failed to record flow_temperature_history for home ${homeId}: ${histErr.message}`);
        }

        return {
            homeId,
            currentMaxFlow,
            newFlow,
            changed: opt.changed,
            reason: opt.reason,
            outsideTemp,
            actualFlowTemp,
            maxZoneError
        };
    } catch (err) {
        log('error', `evaluateHome failed for home ${homeId}: ${err.message}\n${err.stack}`);
        return null;
    }
}

/**
 * Runs flow optimization evaluation cycle for all homes with auto-adaptation enabled.
 */
async function evaluateAllHomes() {
    if (!_db || _db.isOffline()) return;
    const pool = _db.getPool();

    try {
        const [homes] = await pool.execute(
            'SELECT home_id FROM flow_temperature_settings WHERE auto_adaptation_enabled = 1'
        );

        for (const row of homes) {
            await evaluateHome(row.home_id);
        }
    } catch (err) {
        log('error', `evaluateAllHomes failed: ${err.message}`);
    }
}

module.exports = {
    init,
    computeOptimalFlowTemperature,
    evaluateHome,
    evaluateAllHomes
};
