/**
 * @file lib/mold-detector.js
 * @brief Building physics and VTT Mold Growth Model evaluation engine.
 */

'use strict';

const { getLogger } = require('./logger');
const log = getLogger('mold-detector');

const MIN_CALIBRATION_HOURS = 48;
const DEFAULT_INSULATION_FACTOR = 0.70;
const MIN_INSULATION_FACTOR = 0.40;
const MAX_INSULATION_FACTOR = 0.95;

/**
 * Calculates dew point temperature in Celsius using the Magnus-Tetens formula.
 * @param {number} tempCelsius
 * @param {number} humidityPct (0-100)
 * @returns {number}
 */
function calculateDewPoint(tempCelsius, humidityPct) {
    if (tempCelsius == null || humidityPct == null) return null;
    const t = parseFloat(tempCelsius);
    const rh = Math.max(0.001, Math.min(100.0, parseFloat(humidityPct)));
    const a = 17.27;
    const b = 237.7;
    const alpha = ((a * t) / (b + t)) + Math.log(rh / 100.0);
    const dewPoint = (b * alpha) / (a - alpha);
    return parseFloat(dewPoint.toFixed(2));
}

/**
 * Calculates saturation water vapor pressure in Pascals.
 * @param {number} tempCelsius
 * @returns {number}
 */
function calculateSaturationVaporPressure(tempCelsius) {
    const t = parseFloat(tempCelsius);
    return 610.78 * Math.exp((17.27 * t) / (237.3 + t));
}

/**
 * Resolves effective insulation factor according to hierarchy:
 * zone.insulation_factor ?? home.insulation_factor ?? 0.70
 * @param {number|null} homeFactor
 * @param {number|null} zoneFactor
 * @returns {number}
 */
function getEffectiveInsulationFactor(homeFactor, zoneFactor) {
    let f = DEFAULT_INSULATION_FACTOR;
    if (zoneFactor !== null && zoneFactor !== undefined && !isNaN(Number(zoneFactor))) {
        f = parseFloat(zoneFactor);
    } else if (homeFactor !== null && homeFactor !== undefined && !isNaN(Number(homeFactor))) {
        f = parseFloat(homeFactor);
    }
    return Math.max(MIN_INSULATION_FACTOR, Math.min(MAX_INSULATION_FACTOR, parseFloat(f.toFixed(2))));
}

/**
 * Calculates external wall / thermal bridge surface temperature and relative humidity
 * based on ISO 13788 / DIN 4108-2 building physics.
 * @param {number} indoorTemp (°C)
 * @param {number} indoorHum (%)
 * @param {number|null} outdoorTemp (°C)
 * @param {number} [fRsi=0.70] Temperature factor of thermal bridge
 * @returns {object}
 */
function calculateSurfaceConditions(indoorTemp, indoorHum, outdoorTemp, fRsi = DEFAULT_INSULATION_FACTOR) {
    if (indoorTemp == null || indoorHum == null) {
        return {
            surfaceTemp: null,
            surfaceHumidity: null,
            dewPoint: null,
            condensationRisk: false
        };
    }

    const tIn = parseFloat(indoorTemp);
    const rhIn = Math.max(0.0, Math.min(100.0, parseFloat(indoorHum)));
    const factor = Math.max(MIN_INSULATION_FACTOR, Math.min(MAX_INSULATION_FACTOR, parseFloat(fRsi)));

    // Fallback to indoor temp if outdoor temperature is unknown
    const tOut = outdoorTemp != null && !isNaN(Number(outdoorTemp)) ? parseFloat(outdoorTemp) : tIn;

    // ISO 13788 surface temperature: T_surface = T_in - (1 - f_Rsi) * (T_in - T_out)
    const surfaceTemp = tIn - (1.0 - factor) * (tIn - tOut);

    // Vapor pressure is approximately uniform throughout room air
    const pSatIn = calculateSaturationVaporPressure(tIn);
    const pVapor = (rhIn / 100.0) * pSatIn;

    const pSatSurf = calculateSaturationVaporPressure(surfaceTemp);
    const surfaceHumidity = Math.max(0.0, Math.min(100.0, (pVapor / pSatSurf) * 100.0));

    const dewPoint = calculateDewPoint(tIn, rhIn);
    const condensationMargin = dewPoint != null ? (surfaceTemp - dewPoint) : 99.0;
    const condensationRisk = condensationMargin <= 1.0 || surfaceHumidity >= 98.0;

    return {
        surfaceTemp: parseFloat(surfaceTemp.toFixed(2)),
        surfaceHumidity: parseFloat(surfaceHumidity.toFixed(1)),
        dewPoint: dewPoint,
        condensationMargin: parseFloat(condensationMargin.toFixed(2)),
        condensationRisk: condensationRisk
    };
}

/**
 * Calculates critical relative humidity threshold for mold growth (VTT model).
 * @param {number} surfaceTemp (°C)
 * @returns {number} RH_crit in percent
 */
function calculateRhCrit(surfaceTemp) {
    const t = parseFloat(surfaceTemp);
    if (t <= 0.0) return 100.0; // Frozen, dormant
    if (t <= 20.0) {
        const rhCrit = -0.00267 * Math.pow(t, 3) + 0.160 * Math.pow(t, 2) - 3.13 * t + 100.0;
        return Math.max(75.0, Math.min(95.0, parseFloat(rhCrit.toFixed(2))));
    }
    return 80.0;
}

/**
 * Calculates a single time-step evolution of Mold Index (M) using the VTT formulation.
 * @param {number} currentM Current mold index [0, 6]
 * @param {number} surfaceTemp Surface temperature (°C)
 * @param {number} surfaceHum Surface relative humidity (0-100)
 * @param {number} [dtHours=1.0] Time step duration in hours
 * @param {number} [sensitivityClass=1.0] Material scaling factor k1
 * @returns {number} Updated mold index
 */
function calculateVttStep(currentM, surfaceTemp, surfaceHum, dtHours = 1.0, sensitivityClass = 1.0) {
    let m = Math.max(0.0, Math.min(6.0, parseFloat(currentM) || 0.0));
    const t = parseFloat(surfaceTemp);
    const rh = parseFloat(surfaceHum);
    const dt = Math.max(0.0, parseFloat(dtHours) || 1.0);

    if (t <= 0.1 || rh < 10.0) {
        // Dormancy / dry retreat
        return Math.max(0.0, parseFloat((m - 0.002 * dt).toFixed(3)));
    }

    const rhCrit = calculateRhCrit(t);

    if (rh >= rhCrit) {
        // Growth phase
        const ratio = (rhCrit - rh) / (rhCrit - 100.0);
        const mMax = Math.max(0.0, Math.min(6.0, 1.0 + 7.0 * ratio - 2.0 * ratio * ratio));

        if (m < mMax) {
            const k2 = Math.max(0.0, 1.0 - Math.exp(1.7 * (m - mMax)));
            const k1 = sensitivityClass;
            const lnT = Math.log(Math.max(0.1, t));
            const lnRh = Math.log(Math.max(0.01, rh / 100.0));
            const exponent = -0.68 * lnT - 13.9 * lnRh + 66.02;

            // Clamped daily growth rate to avoid runaway overflow
            const clampedExponent = Math.min(25.0, exponent);
            const rateDaily = (k1 * k2 / 7.0) * Math.exp(clampedExponent);
            const rateHourly = rateDaily / 24.0;

            m = Math.min(6.0, m + rateHourly * dt);
        }
    } else {
        // Unfavorable decline phase (dry spell)
        const dryness = Math.max(0.1, 1.0 - (rh / rhCrit));
        const declineRateHourly = 0.002 * dryness;
        m = Math.max(0.0, m - declineRateHourly * dt);
    }

    return parseFloat(m.toFixed(3));
}

/**
 * Evaluates mold index and risk metrics for a specific zone using historical telemetry.
 * @param {number|string} homeId
 * @param {number|string} zoneId
 * @param {object} pool MariaDB connection pool
 * @returns {Promise<object>}
 */
async function evaluateZoneMold(homeId, zoneId, pool) {
    // 1. Get home and zone insulation settings
    const [homeRows] = await pool.execute('SELECT insulation_factor FROM homes WHERE id = ?', [homeId]);
    const [zoneRows] = await pool.execute('SELECT insulation_factor FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);

    const homeFactor = homeRows.length > 0 ? homeRows[0].insulation_factor : DEFAULT_INSULATION_FACTOR;
    const zoneFactor = zoneRows.length > 0 ? zoneRows[0].insulation_factor : null;
    const effectiveInsulation = getEffectiveInsulationFactor(homeFactor, zoneFactor);
    const isInherited = zoneFactor === null || zoneFactor === undefined;

    // 2. Query outdoor temperature
    const [weatherRows] = await pool.execute(
        'SELECT outside_temp_celsius FROM home_weather WHERE home_id = ? ORDER BY timestamp DESC LIMIT 1',
        [homeId]
    );
    const currentOutsideTemp = weatherRows.length > 0 ? weatherRows[0].outside_temp_celsius : null;

    // 3. Query historical hourly readings (up to 14 days)
    const [measurements] = await pool.execute(
        `SELECT 
            field_012d AS temp,
            field_0135 AS hum,
            timestamp
         FROM zone_measurements
         WHERE home_id = ? AND zone_id = ? AND field_012d IS NOT NULL AND field_0135 IS NOT NULL
           AND timestamp >= DATE_SUB(NOW(), INTERVAL 14 DAY)
         ORDER BY timestamp ASC`,
        [homeId, zoneId]
    );

    let m = 0.0;
    let hoursEvaluated = 0;
    let prevTime = null;

    for (const row of measurements) {
        const t = parseFloat(row.temp);
        const rh = parseFloat(row.hum);
        if (isNaN(t) || isNaN(rh)) continue;

        const rowTime = new Date(row.timestamp).getTime();
        let dtHours = 1.0;
        if (prevTime !== null && !isNaN(rowTime)) {
            const diffHours = (rowTime - prevTime) / (3600 * 1000);
            if (diffHours > 0 && diffHours <= 6) {
                dtHours = diffHours;
            }
        }
        prevTime = rowTime;

        // Apply thermal bridge surface conditions
        const surf = calculateSurfaceConditions(t, rh, currentOutsideTemp, effectiveInsulation);
        m = calculateVttStep(m, surf.surfaceTemp, surf.surfaceHumidity, dtHours);
        hoursEvaluated += dtHours;
    }

    // 4. Current ambient and surface conditions
    const latest = measurements.length > 0 ? measurements[measurements.length - 1] : { temp: 21.0, hum: 45.0 };
    const latestTemp = latest.temp != null ? parseFloat(latest.temp) : 21.0;
    const latestHum = latest.hum != null ? parseFloat(latest.hum) : 45.0;

    const currentSurface = calculateSurfaceConditions(latestTemp, latestHum, currentOutsideTemp, effectiveInsulation);
    const rhCrit = calculateRhCrit(currentSurface.surfaceTemp);

    const isReady = hoursEvaluated >= MIN_CALIBRATION_HOURS;
    const progressPercentage = Math.min(100, Math.round((hoursEvaluated / MIN_CALIBRATION_HOURS) * 100));

    let riskLevel = 'LOW';
    if (m >= 2.0) {
        riskLevel = 'HIGH';
    } else if (m >= 1.0) {
        riskLevel = 'ELEVATED';
    }

    return {
        homeId: parseInt(homeId, 10),
        zoneId: parseInt(zoneId, 10),
        level: riskLevel,
        index: parseFloat(m.toFixed(2)),
        status: isReady ? 'READY' : 'CALIBRATING',
        progressPercentage: progressPercentage,
        surfaceTemperature: currentSurface.surfaceTemp,
        surfaceRelativeHumidity: currentSurface.surfaceHumidity,
        dewPoint: currentSurface.dewPoint,
        criticalHumidity: rhCrit,
        condensationRisk: currentSurface.condensationRisk,
        effectiveInsulationFactor: effectiveInsulation,
        isInherited: isInherited,
        hoursEvaluated: Math.round(hoursEvaluated)
    };
}

/**
 * Evaluates and syncs mold states for all non-DHW zones in a home.
 * Persists results into zone_mold_state table and detects transitions.
 * @param {number|string} homeId
 * @param {object} pool MariaDB connection pool
 * @returns {Promise<Array<object>>}
 */
async function syncHomeMoldState(homeId, pool) {
    const [zones] = await pool.execute(
        "SELECT id, type, name FROM zones WHERE home_id = ? AND type != 'HOT_WATER' AND type != 'DHW'",
        [homeId]
    );

    const results = [];
    const now = new Date();

    for (const zone of zones) {
        try {
            const mold = await evaluateZoneMold(homeId, zone.id, pool);

            // Fetch previous state for transition detection
            const [prevRows] = await pool.execute(
                'SELECT risk_level FROM zone_mold_state WHERE home_id = ? AND zone_id = ?',
                [homeId, zone.id]
            );

            let lastTransition = null;
            if (prevRows.length > 0 && prevRows[0].risk_level !== mold.level) {
                lastTransition = now;
                log('info', `[Zone ${zone.id} (${zone.name})] Mold risk transition: ${prevRows[0].risk_level} -> ${mold.level} (M=${mold.index})`);
            }

            await pool.execute(
                `INSERT INTO zone_mold_state (
                    home_id, zone_id, mold_index, risk_level, surface_temp,
                    surface_humidity, dew_point, critical_humidity, condensation_risk,
                    effective_insulation_factor, hours_evaluated, status, last_transition, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    mold_index = VALUES(mold_index),
                    risk_level = VALUES(risk_level),
                    surface_temp = VALUES(surface_temp),
                    surface_humidity = VALUES(surface_humidity),
                    dew_point = VALUES(dew_point),
                    critical_humidity = VALUES(critical_humidity),
                    condensation_risk = VALUES(condensation_risk),
                    effective_insulation_factor = VALUES(effective_insulation_factor),
                    hours_evaluated = VALUES(hours_evaluated),
                    status = VALUES(status),
                    last_transition = COALESCE(VALUES(last_transition), last_transition),
                    updated_at = VALUES(updated_at)`,
                [
                    homeId, zone.id, mold.index, mold.level, mold.surfaceTemperature,
                    mold.surfaceRelativeHumidity, mold.dewPoint, mold.criticalHumidity,
                    mold.condensationRisk ? 1 : 0, mold.effectiveInsulationFactor,
                    mold.hoursEvaluated, mold.status, lastTransition, now
                ]
            );

            results.push(mold);
        } catch (err) {
            log('error', `Error syncing mold state for home ${homeId} zone ${zone.id}: ${err.message}`);
        }
    }

    return results;
}

module.exports = {
    calculateDewPoint,
    calculateSaturationVaporPressure,
    calculateSurfaceConditions,
    calculateRhCrit,
    calculateVttStep,
    getEffectiveInsulationFactor,
    evaluateZoneMold,
    syncHomeMoldState,
    DEFAULT_INSULATION_FACTOR,
    MIN_INSULATION_FACTOR,
    MAX_INSULATION_FACTOR,
    MIN_CALIBRATION_HOURS
};
