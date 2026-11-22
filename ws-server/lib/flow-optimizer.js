/**
 * @file lib/flow-optimizer.js
 * @brief Dynamic flow temperature optimizer based on weather, zone demand, and boiler telemetry.
 */

'use strict';

const { getLogger } = require('./logger');
const log = getLogger('flow-optimizer');
const config = require('./config');
const weather = require('./weather');
const interfaceModules = require('./interface-modules');

let _db = null;
let _commandApi = null;
let _mqttPublisher = null;
const _lastDriverPushTimes = new Map();
const _lastBurnStartTimes = new Map();
const _lastBurnEndTimes = new Map();
const _pendingEvals = new Map();

function parseDbTimestamp(ts) {
    if (!ts) return 0;
    if (ts instanceof Date) return ts.getTime();
    const str = String(ts).trim();
    if (!str) return 0;
    const iso = str.includes('T') ? str : str.replace(' ', 'T');
    return new Date(iso.endsWith('Z') ? iso : iso + 'Z').getTime();
}

function init(db, commandApi, mqttPublisher) {
    _db = db;
    _commandApi = commandApi;
    _mqttPublisher = mqttPublisher;
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
 * Evaluates whether the calling heating circuit has sufficient thermal dissipation
 * capacity to absorb the boiler's minimum burner output without short-cycling.
 * 
 * @param {Object} params
 * @param {number} [params.callingRadiators=0] Count of radiator zones calling with active demand
 * @param {number} [params.callingUfh=0] Count of underfloor zones calling with active demand
 * @param {number} [params.circuitDemandPct=0] Aggregate demand percentage across the circuit
 * @param {number} [params.maxZoneError=0] Maximum error (°C) across calling zones
 * @param {boolean} [params.inLockout=false] Whether circuit is in anti-flapping lockout
 * @param {number} [params.currentMode=0] Current circuit operating mode (0=STANDBY, 1=SCHEDULE)
 * @returns {{ allowHeating: boolean, circuitOperatingMode: number, reason: string }}
 */
function evaluateCircuitThermalLoad({ callingRadiators = 0, callingUfh = 0, circuitDemandPct = 0, maxZoneError = 0, inLockout = false, currentMode = 0 }) {
    // 1. Anti-flapping lockout: if boiler recently fired, block reignition on marginal/moderate demand
    // Exception: high deficit cold recovery (>=1.5°C) can override lockout
    // Lockout only gates initial ignition from Standby (currentMode === 0); never aborts active heating.
    if (currentMode === 0 && inLockout && maxZoneError < 1.5) {
        return { allowHeating: false, circuitOperatingMode: 0, reason: 'anti_flapping_lockout' };
    }

    // 2. Underfloor heating has massive screed thermal mass - always safe to absorb boiler output
    if (callingUfh > 0 && (circuitDemandPct >= 10 || maxZoneError >= 0.2)) {
        return { allowHeating: true, circuitOperatingMode: 1, reason: 'underfloor_thermal_mass' };
    }

    // 3. Multi-room coincidence: >= 2 radiator zones calling with active demand
    // Hysteresis: require >= 25% demand to turn ON (currentMode 0), but only >= 15% to sustain active heating (currentMode 1)
    const coincidenceThreshold = (currentMode === 1) ? 15 : 25;
    if (callingRadiators >= 2 && circuitDemandPct >= coincidenceThreshold) {
        return { allowHeating: true, circuitOperatingMode: 1, reason: 'multi_zone_coincidence' };
    }

    // 4. Significant single-zone load:
    // Hysteresis: require >= 35% and error >= 0.4°C to turn ON, maintain active if demand >= 25% and error >= 0.25°C
    const singleDemandThreshold = (currentMode === 1) ? 25 : 35;
    const singleErrorThreshold = (currentMode === 1) ? 0.25 : 0.4;
    if (callingRadiators === 1 && circuitDemandPct >= singleDemandThreshold && maxZoneError >= singleErrorThreshold) {
        return { allowHeating: true, circuitOperatingMode: 1, reason: 'single_zone_significant_load' };
    }

    // 5. High aggregate demand across the circuit (e.g. general recovery)
    const aggregateThreshold = (currentMode === 1) ? 30 : 45;
    if (circuitDemandPct >= aggregateThreshold || (circuitDemandPct >= 30 && maxZoneError >= 0.8)) {
        return { allowHeating: true, circuitOperatingMode: 1, reason: 'high_aggregate_demand' };
    }

    // 6. Insufficient thermal load: single radiator low-demand drift
    return { allowHeating: false, circuitOperatingMode: 0, reason: 'suppress_micro_burn_low_thermal_load' };
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
 * @param {string} [params.activeDemandType='ANY'] - 'ANY' | 'ONLY_UNDERFLOOR' | 'ONLY_RADIATOR' | 'MIXED'
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
    forecastHourly = null,
    activeDemandType = 'ANY',
    callingRadiators = 0,
    callingUfh = 0,
    inLockout = false,
    actualFlowTemp = null,
    isFlameOn = false,
    currentMode = 0
}) {
    // 1. Guardrail sanity checks
    const isOnlyUfh = activeDemandType === 'ONLY_UNDERFLOOR';
    const effectiveMaxLimit = isOnlyUfh ? Math.min(maxFlowLimit, 45) : maxFlowLimit;

    minFlow = Math.max(20, Math.min(minFlow, 50));
    maxFlowLimit = Math.max(minFlow, Math.min(effectiveMaxLimit, 85));
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
            changed: Math.round(steppedFlow) !== currentMaxFlow,
            circuitOperatingMode: 0
        };
    }

    // 3. Weather Heating Curve (Linear outdoor compensation: +20°C -> minFlow, -10°C -> maxFlowLimit)
    const outdoorFraction = Math.max(0, Math.min(1, (20 - outsideTemp) / 30));
    const baseFlow = minFlow + outdoorFraction * (maxFlowLimit - minFlow);

    // 4. Zone Demand Adjustment
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
    // Only apply rate limiting when actively heating in steady state.
    // Transitioning from STANDBY jumps directly to operating target so radiators receive proper heat immediately.
    const fromStandby = (currentMaxFlow <= minFlow);
    const delta = clampedTarget - currentMaxFlow;
    let nextFlow = clampedTarget;
    let changed = false;

    if (!fromStandby && Math.abs(delta) >= 1.0) {
        const step = Math.max(-3.0, Math.min(3.0, delta));
        nextFlow = Math.round(currentMaxFlow + step);
        nextFlow = Math.max(minFlow, Math.min(maxFlowLimit, nextFlow));
        changed = nextFlow !== currentMaxFlow;
    } else if (fromStandby) {
        nextFlow = clampedTarget;
        changed = nextFlow !== currentMaxFlow;
    }

    // Operating mode (0x2090) and thermal load gating
    // If calling counts are not explicitly provided (e.g. basic unit tests), infer from demand & activeDemandType
    let radCount = callingRadiators;
    let ufhCount = callingUfh;
    if (radCount === 0 && ufhCount === 0) {
        if (activeDemandType === 'ONLY_UNDERFLOOR') {
            ufhCount = circuitDemandPct > 0 ? 1 : 0;
        } else if (circuitDemandPct >= 25 || maxZoneError >= 0.4) {
            radCount = (circuitDemandPct >= 30) ? 2 : 1;
        }
    }

    const thermal = evaluateCircuitThermalLoad({
        callingRadiators: radCount,
        callingUfh: ufhCount,
        circuitDemandPct,
        maxZoneError,
        inLockout,
        currentMode
    });
    const circuitOperatingMode = thermal.circuitOperatingMode;

    // Emitter-specific flow temperature floor when heating is active:
    // Radiators require >= 48°C (typical 50-60°C) to radiate heat and prevent instantaneous anti-cycling trip on minimum modulation.
    // Underfloor heating operates safely at lower minFlow floor.
    let effectiveFlow = 0;
    if (circuitOperatingMode === 1) {
        const flowFloor = (ufhCount === 0 && radCount > 0) ? Math.max(minFlow, 48) : minFlow;
        effectiveFlow = Math.max(nextFlow, flowFloor);
        effectiveFlow = Math.min(effectiveFlow, maxFlowLimit);

        // Delta-T Anti-Microburn Guard:
        // When loop water is already warm and burner is off, firing the boiler with small delta-T (< 5°C)
        // trips the boiler's upper temperature limit within seconds, causing a 15-30s micro-burn.
        // Circulate existing heat until water cools down >= 5°C below target, unless room deficit is high (>= 1.0°C).
        // Only gates ignition from Standby (currentMode === 0); must never abort active heating (currentMode === 1).
        if (currentMode === 0 && !isFlameOn && actualFlowTemp !== null && actualFlowTemp > 0) {
            const flowDeltaT = effectiveFlow - actualFlowTemp;
            if (flowDeltaT < 5.0 && maxZoneError < 1.0 && circuitDemandPct < 50) {
                return {
                    targetFlow: nextFlow,
                    effectiveFlow: 0,
                    baseFlow: Math.round(baseFlow * 10) / 10,
                    demandBoost,
                    forecastAdj,
                    modAdj,
                    reason: 'flow_already_hot',
                    thermalReason: 'flow_already_hot',
                    changed,
                    circuitOperatingMode: 0
                };
            }
        }
    }

    return {
        targetFlow: nextFlow,
        effectiveFlow,
        baseFlow: Math.round(baseFlow * 10) / 10,
        demandBoost,
        forecastAdj,
        modAdj,
        reason,
        thermalReason: thermal.reason,
        changed,
        circuitOperatingMode
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

        // Skip if interface module is non-modulating (e.g. Analog Relay)
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
        const currentMaxFlow = settings.max_flow_temperature ? parseInt(settings.max_flow_temperature, 10) : 60;

        // 2. Outdoor temperature
        let outsideTemp = 10.0;
        const [weatherRows] = await pool.execute(
            'SELECT outside_temp_celsius FROM home_weather WHERE home_id = ? ORDER BY timestamp DESC LIMIT 1',
            [homeId]
        );
        if (weatherRows.length > 0 && weatherRows[0].outside_temp_celsius !== null) {
            outsideTemp = parseFloat(weatherRows[0].outside_temp_celsius);
        }

        // 3. Hourly Forecast
        const forecastObj = weather.getHomeForecast ? weather.getHomeForecast(homeId) : null;
        const forecastHourly = forecastObj ? forecastObj.hourly : null;

        // 4. Boiler live telemetry
        const [boilerRows] = await pool.execute(
            'SELECT field_044c, field_044d, field_0452, field_0457 FROM heating_systems WHERE home_id = ? LIMIT 1',
            [homeId]
        );
        const actualFlowTemp = boilerRows.length > 0 && boilerRows[0].field_044c !== null ? parseFloat(boilerRows[0].field_044c) : null;
        const modulationPct = boilerRows.length > 0 && boilerRows[0].field_0452 !== null ? parseInt(boilerRows[0].field_0452, 10) : null;

        // 5. Dynamic circuit determination & demand %
        const [circRows] = await pool.execute(
            'SELECT number, field_4080, field_2040, field_2090, driver_serial_no FROM heating_circuits WHERE home_id = ? ORDER BY number ASC',
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

        // 6. Active zone temperatures, heating types, demand and errors
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
                if (_db && typeof _db.isZoneAlive === 'function') {
                    const alive = await _db.isZoneAlive(homeId, z.id).catch(() => true);
                    if (!alive) {
                        log('debug', `Zone ${z.id} (${z.name}) is offline (>20m), skipping from thermal load evaluation`);
                        continue;
                    }
                }
                const zState = await _db.getZoneState(homeId, z.id);
                if (zState) {
                    const enabled = (zState['0x61e0'] ?? zState.field_61e0 ?? 1) === 1;
                    if (enabled) {
                        const targetTemp = parseFloat(zState['0x6280'] ?? zState.field_6280 ?? zState['0x6200'] ?? zState.field_6200 ?? 20);
                        const currentTemp = z.current_temp !== null && z.current_temp !== undefined ? parseFloat(z.current_temp) : null;
                        const zDemand = parseFloat(zState['0x40a0'] ?? zState.field_40a0 ?? z.demand ?? 0) || 0;
                        if (zDemand > maxZoneDemand) {
                            maxZoneDemand = zDemand;
                        }
                        if (currentTemp !== null && targetTemp > currentTemp) {
                            const err = targetTemp - currentTemp;
                            if (err > maxZoneError) {
                                maxZoneError = err;
                            }
                            // Only count as calling radiator if valve is actively open (>=15%) and room has deficit (>=0.25°C)
                            if (z.heating_type === 'UNDERFLOOR') {
                                if (zDemand >= 10 || err >= 0.2) callingUfh++;
                            } else {
                                if (zDemand >= 15 && err >= 0.25) callingRadiators++;
                            }
                        }
                    }
                }
            } catch (err) {
                log('warn', `Error evaluating zone ${z.id} state for home ${homeId}: ${err.message}`);
            }
        }

        // Lock circuit demand against single-device RU actuator clobbering:
        // When other rooms (e.g. Kamer Luuk) are demanding heat, aggregate demand is at least maxZoneDemand.
        circuitDemandPct = Math.max(circuitDemandPct, maxZoneDemand);

        let activeDemandType = 'ANY';
        if (callingUfh > 0 && callingRadiators === 0) {
            activeDemandType = 'ONLY_UNDERFLOOR';
        } else if (callingUfh > 0 && callingRadiators > 0) {
            activeDemandType = 'MIXED';
        } else if (callingRadiators > 0) {
            activeDemandType = 'ONLY_RADIATOR';
        }

        // 7. Calculate optimal flow temperature and evaluate thermal load
        let lastBurnEnd = _lastBurnEndTimes.get(homeId) || 0;
        const now = Date.now();
        const lockoutMs = 10 * 60 * 1000; // 10 minutes anti-flapping lockout on small loads

        // Check live boiler flame state and recent burn end from DB to prevent memory loss on restart
        const isFlameOn = (boilerRows.length > 0 && (boilerRows[0].field_0457 === 1 || (boilerRows[0].field_0452 && boilerRows[0].field_0452 > 0)));
        try {
            const [recentBurnRows] = await pool.execute(
                `SELECT timestamp FROM circuit_measurements 
                 WHERE home_id = ? AND (field_0457 = 1 OR field_0452 > 0) 
                 ORDER BY id DESC LIMIT 1`,
                [homeId]
            );
            if (recentBurnRows.length > 0 && recentBurnRows[0].timestamp) {
                const dbBurnTime = parseDbTimestamp(recentBurnRows[0].timestamp);
                if (dbBurnTime > lastBurnEnd) {
                    lastBurnEnd = dbBurnTime;
                    _lastBurnEndTimes.set(homeId, lastBurnEnd);
                }
            }
        } catch (_) {}

        const inLockout = !isFlameOn && (now - lastBurnEnd < lockoutMs);

        const currentMode = circRows.length > 0 && circRows[0].field_2090 !== null && circRows[0].field_2090 !== undefined
            ? parseInt(circRows[0].field_2090, 10)
            : 1;
        const currentFlow = circRows.length > 0 && circRows[0].field_2040 !== null
            ? parseFloat(circRows[0].field_2040)
            : null;

        const opt = computeOptimalFlowTemperature({
            outsideTemp,
            minFlow,
            maxFlowLimit,
            currentMaxFlow,
            maxZoneError,
            circuitDemandPct,
            modulationPct,
            forecastHourly,
            activeDemandType,
            callingRadiators,
            callingUfh,
            inLockout,
            actualFlowTemp,
            isFlameOn,
            currentMode
        });

        const newFlow = opt.targetFlow;
        let targetMode = opt.circuitOperatingMode ?? 1;

        // Anti-cycling minimum run-time guard:
        // Once heating mode turns ON (1), hold for at least 3 minutes before permitting mode 0 standby drop,
        // unless all zones are completely satisfied (0 demand and 0 error).
        const minRunTimeMs = 3 * 60 * 1000;
        let lastBurnStart = _lastBurnStartTimes.get(homeId) || 0;
        if (!lastBurnStart && currentMode === 1) {
            try {
                const [mode0Rows] = await pool.execute(
                    `SELECT timestamp FROM circuit_measurements 
                     WHERE home_id = ? AND field_2090 = 0 
                     ORDER BY id DESC LIMIT 1`,
                    [homeId]
                );
                const lastMode0Ts = (mode0Rows.length > 0 && mode0Rows[0].timestamp) ? mode0Rows[0].timestamp : '1970-01-01';
                const [mode1Rows] = await pool.execute(
                    `SELECT timestamp FROM circuit_measurements 
                     WHERE home_id = ? AND field_2090 = 1 AND timestamp > ? 
                     ORDER BY id ASC LIMIT 1`,
                    [homeId, lastMode0Ts]
                );
                if (mode1Rows.length > 0 && mode1Rows[0].timestamp) {
                    lastBurnStart = parseDbTimestamp(mode1Rows[0].timestamp);
                    _lastBurnStartTimes.set(homeId, lastBurnStart);
                }
            } catch (_) {}
        }
        if (currentMode === 1 && targetMode === 0 && (now - lastBurnStart < minRunTimeMs)) {
            if (circuitDemandPct > 0 || maxZoneError > 0) {
                log('debug', `[flow-optimizer] Home ${homeId}: holding mode 1 (minimum run-time guard active, ${Math.round((now - lastBurnStart)/1000)}s / 180s)`);
                targetMode = 1;
            }
        }

        if (currentMode === 0 && targetMode === 1) {
            _lastBurnStartTimes.set(homeId, now);
        } else if (currentMode === 1 && targetMode === 0) {
            _lastBurnEndTimes.set(homeId, now);
        }

        const effectiveFlow = opt.effectiveFlow ?? (targetMode === 0 ? 0 : newFlow);
        const nowIso = new Date().toISOString().slice(0, 19).replace('T', ' ');

        const modeChanged = currentMode !== targetMode;
        const flowChanged = currentFlow !== effectiveFlow;

        const isCircuitActive = targetMode === 1;
        const shouldUpdateCircuit = modeChanged || (isCircuitActive && (flowChanged || opt.changed));

        // 8. If flow changed or circuit operating mode changed, apply and downlink to circuit
        if (shouldUpdateCircuit) {
            log('info', `[flow-optimizer] Home ${homeId}: flow=${currentMaxFlow}°C->${newFlow}°C (effective=${effectiveFlow}°C) mode=${currentMode}->${targetMode} (reason=${opt.reason}, outdoor=${outsideTemp.toFixed(1)}°C, maxZoneError=${maxZoneError.toFixed(1)}°C, demand=${circuitDemandPct}%)`);

            // Update circuit configs dynamically in DB and invalidate ETag so RU / bridge picks it up
            for (const cNum of targetCircuitNumbers) {
                await _db.updateCircuitConfig(homeId, cNum, { '0x2040': effectiveFlow, '0x2090': targetMode });
            }

            // Automated live config resync with rate limiting
            const driverSerial = circRows.length > 0 ? circRows[0].driver_serial_no : null;
            if (driverSerial) {
                const now = Date.now();
                const lastPush = _lastDriverPushTimes.get(homeId) || 0;
                const minDelayMs = 15 * 60 * 1000; // 15-minute cooldown between minor flow tweaks

                let ruCachedMismatch = false;
                if (circRows.length > 0 && circRows[0].field_2040 !== null && circRows[0].field_2040 !== undefined) {
                    const cached2040 = parseFloat(circRows[0].field_2040);
                    if (effectiveFlow > 0 && Math.abs(cached2040 - effectiveFlow) >= 2.0) {
                        ruCachedMismatch = true;
                    }
                }

                const flowStepUp = effectiveFlow > 0 && currentFlow !== null && (effectiveFlow - currentFlow) >= 3.0;
                const isFirstActivePush = lastPush === 0 && effectiveFlow > 0;
                const cooldownExpired = isCircuitActive && (now - lastPush >= minDelayMs);
                const needsPush = modeChanged || flowStepUp || ruCachedMismatch || isFirstActivePush || cooldownExpired;

                // Push immediately on operating mode change, flow step-up, RU mismatch, or when cooldown expired during active heating
                if (needsPush) {
                    try {
                        const cmdApi = _commandApi || require('./command-api');
                        const reason = modeChanged ? 'mode_change' : (flowStepUp ? 'flow_step_up' : (ruCachedMismatch ? 'ru_mismatch' : (isFirstActivePush ? 'first_active_push' : 'cooldown_expired')));
                        log('info', `[flow-optimizer] Triggering live config resync for circuit driver ${driverSerial} (flow=${effectiveFlow}°C, mode=${targetMode}, reason=${reason})`);
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
    evaluateCircuitThermalLoad,
    scheduleEvaluation,
    evaluateHome,
    evaluateAllHomes,
    parseDbTimestamp
};
