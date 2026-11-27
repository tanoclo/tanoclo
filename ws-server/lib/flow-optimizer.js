/**
 * @file lib/flow-optimizer.js
 * @brief Dynamic flow temperature optimizer based on weather and zone demand.
 *
 * The optimizer only shapes the circuit maximum flow temperature (0x2040). It never
 * switches the boiler on or off: the RU OpenTherm bus module enables CH whenever its
 * circuit demand is > 0 and scales TSet = minCH + demand * (maxCH - minCH) / 100,
 * capped at maxCH (bus-module firmware 0x0800b682 / 0x0800c4fc). Writing 0x2040 = 0
 * does not stop the burner; it leaves CH enabled with TSet = 0 and the boiler then
 * fires on its own internal minimum.
 */

'use strict';

const { getLogger } = require('./logger');
const log = getLogger('flow-optimizer');
const config = require('./config');
const weather = require('./weather');
const interfaceModules = require('./interface-modules');

// Minimum change (°C) before a new max flow temperature is written to the circuit.
const FLOW_DEADBAND = 2;

// Low-load ceiling: in on/off operation the RU commands TSet = 0x2040, so with only a few valves
// open the boiler overshoots and stops within ~100 s. While the RU-reported circuit demand stays
// low the ceiling is capped. Hysteresis keeps the cap from toggling with small demand changes.
const LOW_LOAD_CAP_ON_PCT = 25;
const LOW_LOAD_CAP_OFF_PCT = 35;
const LOW_LOAD_CAP_TEMP = 48;
// A room deficit this large is a recovery, not a low load; the cap does not apply.
const LOW_LOAD_CAP_MAX_ERROR = 1.0;

let _db = null;
let _commandApi = null;
const _lastDriverPushTimes = new Map();
const _pendingEvals = new Map();
const _lowLoadCapActive = new Map();

function init(db, commandApi) {
    _db = db;
    _commandApi = commandApi;
    log('info', 'TaNoClo Flow Temperature Optimizer initialized');
}

/**
 * Schedules a debounced reactive flow optimization evaluation for a home.
 *
 * @param {number|string} homeId
 * @param {number} [delayMs=3000]
 */
function scheduleEvaluation(homeId, delayMs = 3000) {
    if (config.externalController) return;
    if (_pendingEvals.has(homeId)) {
        clearTimeout(_pendingEvals.get(homeId));
    }
    const timer = setTimeout(async () => {
        _pendingEvals.delete(homeId);
        try {
            await evaluateHome(homeId);
        } catch (err) {
            log('warn', `Scheduled evaluation failed for home ${homeId}: ${err.message}`);
        }
    }, delayMs);
    _pendingEvals.set(homeId, timer);
}

/**
 * Pure calculation of the circuit maximum flow temperature.
 *
 * @param {Object} params
 * @param {number} params.outsideTemp - Current outdoor temperature in °C
 * @param {number} params.minFlow - Configured minimum flow temperature bound
 * @param {number} params.maxFlowLimit - Configured maximum flow temperature ceiling
 * @param {number} params.currentMaxFlow - Max flow temperature currently configured on the circuit
 * @param {number} params.maxZoneError - Highest positive error (target - current) among active zones
 * @param {number} params.circuitDemandPct - Circuit demand percent (0 - 100)
 * @param {number[]|null} [params.forecastHourly] - Forecasted outdoor temperatures (next hours)
 * @param {string} [params.activeDemandType='ANY'] - 'ANY' | 'ONLY_UNDERFLOOR' | 'ONLY_RADIATOR' | 'MIXED'
 * @param {Object} [params.guards] - { radiatorFloorEnabled, radiatorFloorTemp, rateLimitEnabled, rateLimitMaxStep }
 * @param {boolean} [params.lowLoad=false] - Cap the ceiling at LOW_LOAD_CAP_TEMP (decided by evaluateHome)
 * @returns {{ targetFlow: number, baseFlow: number, demandBoost: number, forecastAdj: number, reason: string, changed: boolean }}
 */
function computeOptimalFlowTemperature({
    outsideTemp = 10,
    minFlow = 30,
    maxFlowLimit = 80,
    currentMaxFlow = 60,
    maxZoneError = 0,
    circuitDemandPct = 0,
    forecastHourly = null,
    activeDemandType = 'ANY',
    guards = {},
    lowLoad = false
}) {
    const rateLimitEnabled = guards.rateLimitEnabled !== undefined ? Boolean(guards.rateLimitEnabled) : true;
    const rateLimitMaxStep = guards.rateLimitMaxStep !== undefined ? Number(guards.rateLimitMaxStep) : 3.0;
    const radiatorFloorEnabled = guards.radiatorFloorEnabled !== undefined ? Boolean(guards.radiatorFloorEnabled) : true;
    const radiatorFloorTemp = guards.radiatorFloorTemp !== undefined ? Number(guards.radiatorFloorTemp) : 48;

    // 1. Guardrail sanity checks
    const isOnlyUfh = activeDemandType === 'ONLY_UNDERFLOOR';
    const effectiveMaxLimit = isOnlyUfh ? Math.min(maxFlowLimit, 45) : maxFlowLimit;

    minFlow = Math.max(20, Math.min(minFlow, 50));
    maxFlowLimit = Math.max(minFlow, Math.min(effectiveMaxLimit, 85));
    currentMaxFlow = Math.max(minFlow, Math.min(currentMaxFlow, maxFlowLimit));

    // 2. Weather heating curve (+20°C -> minFlow, -10°C -> maxFlowLimit)
    const outdoorFraction = Math.max(0, Math.min(1, (20 - outsideTemp) / 30));
    const baseFlow = minFlow + outdoorFraction * (maxFlowLimit - minFlow);

    // 3. Nothing calls for heat: keep the current ceiling so the next call starts from it.
    if (circuitDemandPct <= 0 && maxZoneError <= 0) {
        return {
            targetFlow: currentMaxFlow,
            baseFlow: Math.round(baseFlow * 10) / 10,
            demandBoost: 0,
            forecastAdj: 0,
            reason: 'idle_hold',
            changed: false
        };
    }

    // 4. Zone demand adjustment
    let demandBoost = 0;
    let reason = isOnlyUfh ? 'weather_curve_ufh' : (activeDemandType === 'MIXED' ? 'mixed_radiator_priority' : 'weather_curve');

    if (maxZoneError >= 2.0) {
        demandBoost = isOnlyUfh ? 2.0 : 5.0;
        reason = isOnlyUfh ? 'ufh_demand_boost' : 'cold_recovery';
    } else if (maxZoneError >= 1.0) {
        demandBoost = isOnlyUfh ? 1.0 : 2.5;
        reason = isOnlyUfh ? 'ufh_demand_boost' : 'demand_recovery';
    } else if (maxZoneError < 0.3) {
        demandBoost = isOnlyUfh ? -2.0 : -3.0;
        reason = isOnlyUfh ? 'ufh_near_setpoint' : 'near_setpoint';
    }

    // 5. Weather forecast pre-adjustment (next 3h trend)
    let forecastAdj = 0;
    if (forecastHourly && Array.isArray(forecastHourly) && forecastHourly.length >= 3) {
        const trend = forecastHourly[2] - outsideTemp;
        if (trend >= 2.0) {
            forecastAdj = -2.0;
        } else if (trend <= -2.0) {
            forecastAdj = 2.0;
        }
    }

    // 6. Raw target, user limits and radiator floor
    let target = Math.round(baseFlow + demandBoost + forecastAdj);
    if (radiatorFloorEnabled && (activeDemandType === 'ONLY_RADIATOR' || activeDemandType === 'ANY')) {
        target = Math.max(target, radiatorFloorTemp);
    }
    if (lowLoad && maxZoneError < LOW_LOAD_CAP_MAX_ERROR && target > LOW_LOAD_CAP_TEMP) {
        target = LOW_LOAD_CAP_TEMP;
        reason = 'low_load_cap';
    }
    target = Math.max(minFlow, Math.min(maxFlowLimit, target));

    // 7. Deadband and rate limit
    const delta = target - currentMaxFlow;
    if (Math.abs(delta) < FLOW_DEADBAND) {
        return {
            targetFlow: currentMaxFlow,
            baseFlow: Math.round(baseFlow * 10) / 10,
            demandBoost,
            forecastAdj,
            reason,
            changed: false
        };
    }
    let nextFlow = target;
    if (rateLimitEnabled) {
        nextFlow = Math.round(currentMaxFlow + Math.max(-rateLimitMaxStep, Math.min(rateLimitMaxStep, delta)));
    }

    return {
        targetFlow: nextFlow,
        baseFlow: Math.round(baseFlow * 10) / 10,
        demandBoost,
        forecastAdj,
        reason,
        changed: nextFlow !== currentMaxFlow
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
        // 1. Flow temperature settings
        const [settingsRows] = await pool.execute(
            'SELECT * FROM flow_temperature_settings WHERE home_id = ?',
            [homeId]
        );
        if (settingsRows.length === 0) return null;
        const settings = settingsRows[0];
        if (!settings.auto_adaptation_enabled) return null;

        // Skip non-modulating interface modules (e.g. analog relay)
        const [hsModRows] = await pool.execute('SELECT field_015d FROM heating_systems WHERE home_id = ? LIMIT 1', [homeId]);
        let effectiveMod015d = hsModRows.length > 0 ? hsModRows[0].field_015d : null;
        if (effectiveMod015d === null || effectiveMod015d === undefined) {
            const [driverDevs] = await pool.execute(
                "SELECT field_015d FROM devices WHERE home_id = ? AND device_type IN ('RU01', 'RU02', 'BU01') AND field_015d IS NOT NULL ORDER BY (field_015d = 200) ASC LIMIT 1",
                [homeId]
            );
            if (driverDevs.length > 0) effectiveMod015d = driverDevs[0].field_015d;
        }
        if (!interfaceModules.isModulatingBus(effectiveMod015d)) {
            log('debug', `[flow-optimizer] Home ${homeId}: Skipping flow optimization (non-modulating interface module: ${effectiveMod015d})`);
            return null;
        }

        const minFlow = settings.min_flow_temperature ? parseInt(settings.min_flow_temperature, 10) : 30;
        const maxFlowLimit = settings.max_flow_temperature_limit ? parseInt(settings.max_flow_temperature_limit, 10) : 80;
        const settingsMaxFlow = settings.max_flow_temperature ? parseInt(settings.max_flow_temperature, 10) : 60;

        // 2. Outdoor temperature
        let outsideTemp = 10.0;
        const weatherStatus = await require('./weather-source').getReading(_db, homeId);
        if (weatherStatus.source === 'mqtt' && weatherStatus.stale) return null;
        if (!weatherStatus.stale && weatherStatus.reading?.outside_temp_celsius != null) {
            outsideTemp = Number(weatherStatus.reading.outside_temp_celsius);
        }

        // 3. Hourly forecast
        const forecastObj = weatherStatus.source === 'open_meteo' && weather.getHomeForecast ? weather.getHomeForecast(homeId) : null;
        const forecastHourly = weatherStatus.source === 'mqtt'
            ? weatherStatus.reading?.forecast?.filter(point => Date.parse(point.datetime) >= Date.now()).slice(0, 6).map(point => point.temperature) ?? null
            : forecastObj ? forecastObj.hourly : null;

        // 4. Boiler live telemetry (history only)
        const [boilerRows] = await pool.execute(
            'SELECT field_044c, field_0452 FROM heating_systems WHERE home_id = ? LIMIT 1',
            [homeId]
        );
        const actualFlowTemp = boilerRows.length > 0 && boilerRows[0].field_044c !== null ? parseFloat(boilerRows[0].field_044c) : null;
        const modulationPct = boilerRows.length > 0 && boilerRows[0].field_0452 !== null ? parseInt(boilerRows[0].field_0452, 10) : null;

        // 5. Circuits and circuit demand reported by the circuit driver
        const [circRows] = await pool.execute(
            'SELECT number, field_4080, field_2040, driver_serial_no FROM heating_circuits WHERE home_id = ? ORDER BY number ASC',
            [homeId]
        );

        let targetCircuitNumbers = [];
        let circuitDemandPct = 0;
        let ruCircuitDemandPct = null;

        if (circRows.length > 0) {
            targetCircuitNumbers = circRows.map(r => r.number);
            circuitDemandPct = Math.max(0, ...circRows.map(r => r.field_4080 || 0));
            ruCircuitDemandPct = circuitDemandPct;
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

        // 6. Zone errors, demand and emitter types
        const [zoneRows] = await pool.execute(
            `SELECT z.id, z.name, z.heating_type, zm.field_012d AS current_temp, zm.field_40a0 AS demand
             FROM zones z
             LEFT JOIN (
                 SELECT zone_id, field_012d, field_40a0
                 FROM zone_measurements
                 WHERE id IN (SELECT MAX(id) FROM zone_measurements WHERE home_id = ? GROUP BY zone_id)
             ) zm ON zm.zone_id = z.id
             WHERE z.home_id = ? AND z.type != 'HOT_WATER' AND z.type != 'DHW'`,
            [homeId, homeId]
        );

        let maxZoneError = 0;
        let maxZoneDemand = 0;
        let callingRadiators = 0;
        let callingUfh = 0;

        for (const z of zoneRows) {
            try {
                if (typeof _db.isZoneAlive === 'function') {
                    const alive = await _db.isZoneAlive(homeId, z.id).catch(() => true);
                    if (!alive) continue;
                }
                const zState = await _db.getZoneState(homeId, z.id);
                if (!zState) continue;
                const enabled = (zState['0x61e0'] ?? zState.field_61e0 ?? 1) === 1;
                if (!enabled) continue;

                const overlayActive = (zState['0x6240'] ?? 0) > 0 && zState['0x6280'] != null;
                const targetTemp = parseFloat(overlayActive ? zState['0x6280'] : (zState['0x6200'] ?? 20));
                const currentTemp = z.current_temp !== null && z.current_temp !== undefined ? parseFloat(z.current_temp) : null;
                const zDemand = parseFloat(z.demand ?? 0) || 0;
                const err = currentTemp !== null && targetTemp > currentTemp ? targetTemp - currentTemp : 0;

                maxZoneDemand = Math.max(maxZoneDemand, zDemand);
                maxZoneError = Math.max(maxZoneError, err);
                if (zDemand > 0 || err > 0) {
                    if (z.heating_type === 'UNDERFLOOR') callingUfh++;
                    else callingRadiators++;
                }
            } catch (err) {
                log('warn', `Error evaluating zone ${z.id} state for home ${homeId}: ${err.message}`);
            }
        }

        circuitDemandPct = Math.max(circuitDemandPct, maxZoneDemand);

        let activeDemandType = 'ANY';
        if (callingUfh > 0 && callingRadiators === 0) activeDemandType = 'ONLY_UNDERFLOOR';
        else if (callingUfh > 0 && callingRadiators > 0) activeDemandType = 'MIXED';
        else if (callingRadiators > 0) activeDemandType = 'ONLY_RADIATOR';

        // 7. Compute the new circuit ceiling from the flow last commanded to the circuit
        const currentFlow = circRows.length > 0 && circRows[0].field_2040 !== null && parseFloat(circRows[0].field_2040) > 0
            ? parseFloat(circRows[0].field_2040)
            : settingsMaxFlow;

        const guards = {
            radiatorFloorEnabled: settings.guard_radiator_floor_enabled !== undefined ? Boolean(settings.guard_radiator_floor_enabled) : true,
            radiatorFloorTemp: settings.guard_radiator_floor_temp !== undefined ? parseInt(settings.guard_radiator_floor_temp, 10) : 48,
            rateLimitEnabled: settings.guard_rate_limit_enabled !== undefined ? Boolean(settings.guard_rate_limit_enabled) : true,
            rateLimitMaxStep: settings.guard_rate_limit_max_step !== undefined ? parseFloat(settings.guard_rate_limit_max_step) : 3.0
        };

        // Low-load cap with hysteresis on the demand the circuit driver reports to the boiler
        let lowLoad = _lowLoadCapActive.get(homeId) || false;
        if (ruCircuitDemandPct !== null) {
            if (lowLoad && ruCircuitDemandPct >= LOW_LOAD_CAP_OFF_PCT) lowLoad = false;
            else if (!lowLoad && ruCircuitDemandPct > 0 && ruCircuitDemandPct < LOW_LOAD_CAP_ON_PCT) lowLoad = true;
        }
        _lowLoadCapActive.set(homeId, lowLoad);

        const opt = computeOptimalFlowTemperature({
            outsideTemp,
            minFlow,
            maxFlowLimit,
            currentMaxFlow: currentFlow,
            maxZoneError,
            circuitDemandPct,
            forecastHourly,
            activeDemandType,
            guards,
            lowLoad
        });
        const newFlow = opt.targetFlow;

        // 8. Apply and downlink only when the ceiling actually moves
        if (opt.changed) {
            log('info', `[flow-optimizer] Home ${homeId}: flow=${currentFlow}°C->${newFlow}°C (reason=${opt.reason}, outdoor=${outsideTemp.toFixed(1)}°C, maxZoneError=${maxZoneError.toFixed(1)}°C, demand=${circuitDemandPct}%)`);

            for (const cNum of targetCircuitNumbers) {
                await _db.updateCircuitConfig(homeId, cNum, { '0x2040': newFlow });
            }

            const driverSerial = circRows.length > 0 ? circRows[0].driver_serial_no : null;
            if (driverSerial) {
                const now = Date.now();
                const lastPush = _lastDriverPushTimes.get(homeId) || 0;
                const minDelayMs = 15 * 60 * 1000;
                const flowStepUp = (newFlow - currentFlow) >= 3.0;
                const cooldownExpired = now - lastPush >= minDelayMs;

                // A step up is pushed immediately; smaller changes wait for the cooldown or the driver's own poll.
                if (flowStepUp || cooldownExpired) {
                    try {
                        const cmdApi = _commandApi || require('./command-api');
                        log('info', `[flow-optimizer] Triggering live config resync for circuit driver ${driverSerial} (flow=${newFlow}°C, reason=${flowStepUp ? 'flow_step_up' : 'cooldown_expired'})`);
                        await cmdApi.pushConfigRefresh(driverSerial);
                        _lastDriverPushTimes.set(homeId, now);
                    } catch (pushErr) {
                        log('warn', `[flow-optimizer] Live config resync failed for ${driverSerial}: ${pushErr.message}`);
                    }
                } else {
                    log('debug', `[flow-optimizer] Live config resync for ${driverSerial} deferred by cooldown (${Math.round((minDelayMs - (now - lastPush)) / 60000)}m remaining)`);
                }
            }
        }

        // 9. History
        try {
            await pool.execute(
                `INSERT INTO flow_temperature_history
                 (home_id, timestamp, computed_flow_temp, actual_flow_temp, outside_temp, max_zone_error, modulation_pct, demand_pct, reason)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    homeId,
                    new Date().toISOString().slice(0, 19).replace('T', ' '),
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
            currentMaxFlow: currentFlow,
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
 * Runs flow optimization for all homes with auto-adaptation enabled.
 */
async function evaluateAllHomes() {
    if (config.externalController) return;
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
    scheduleEvaluation,
    evaluateHome,
    evaluateAllHomes
};
