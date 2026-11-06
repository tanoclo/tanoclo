/**
 * @file lib/balancing-analyzer.js
 * @brief Advisory hydraulic balancing analyzer based on radiator valve rise rates.
 * 
 * Computes temperature rise rates per Valve Actuator (VA) during active heating runs,
 * compares rates to the house median, and suggests optimal valve sensitivity (FID 0x4160)
 * scaling values to balance hydraulic distribution across rooms.
 */

'use strict';

const db = require('./db');
const { getLogger } = require('./logger');
const log = getLogger('balancing-analyzer');

/**
 * Group consecutive measurements during active heating into discrete runs.
 * 
 * @param {Array<Object>} measurements - Measurements ordered by timestamp ascending
 * @param {number} maxGapMinutes - Max allowed gap before starting a new run (default: 10)
 * @param {number} minDurationMinutes - Min run duration to be statistically valid (default: 5)
 * @param {number} minPoints - Min number of data points required (default: 3)
 * @param {Object} [options] - Optional filters { minDemand: 10, circuitIntervals: null }
 * @returns {Array<Object>} Qualifying heating runs [{ startTime, endTime, durationMinutes, points }]
 */
function groupHeatingRuns(measurements, maxGapMinutes = 10, minDurationMinutes = 5, minPoints = 3, options = {}) {
    if (!Array.isArray(measurements) || measurements.length === 0) return [];

    const minDemand = typeof options.minDemand === 'number' ? options.minDemand : 10;
    const circuitIntervals = options.circuitIntervals || null;

    const activeRows = measurements.filter(m => {
        const heatingPower = Number(m.field_40a0 || 0);
        const mode = (m.tado_mode || 'HOME').toUpperCase();
        if (heatingPower < minDemand || mode !== 'HOME') return false;

        if (Array.isArray(circuitIntervals) && circuitIntervals.length > 0) {
            const t = new Date(m.timestamp).getTime();
            if (!isNaN(t)) {
                const inCircuit = circuitIntervals.some(([cStart, cEnd]) => t >= cStart && t <= cEnd);
                if (!inCircuit) return false;
            }
        }

        return true;
    });

    if (activeRows.length === 0) return [];

    const runs = [];
    let currentRun = [];

    for (let i = 0; i < activeRows.length; i++) {
        const row = activeRows[i];
        const rowTime = new Date(row.timestamp).getTime();
        if (isNaN(rowTime)) continue;

        if (currentRun.length === 0) {
            currentRun.push({ ...row, parsedTime: rowTime });
        } else {
            const prevTime = currentRun[currentRun.length - 1].parsedTime;
            const diffMinutes = (rowTime - prevTime) / (60 * 1000);

            if (diffMinutes <= maxGapMinutes) {
                currentRun.push({ ...row, parsedTime: rowTime });
            } else {
                // End current run and start new
                const start = currentRun[0].parsedTime;
                const end = currentRun[currentRun.length - 1].parsedTime;
                const durMin = (end - start) / (60 * 1000);
                if (durMin >= minDurationMinutes && currentRun.length >= minPoints) {
                    runs.push({
                        startTime: start,
                        endTime: end,
                        durationMinutes: durMin,
                        points: currentRun
                    });
                }
                currentRun = [{ ...row, parsedTime: rowTime }];
            }
        }
    }

    if (currentRun.length > 0) {
        const start = currentRun[0].parsedTime;
        const end = currentRun[currentRun.length - 1].parsedTime;
        const durMin = (end - start) / (60 * 1000);
        if (durMin >= minDurationMinutes && currentRun.length >= minPoints) {
            runs.push({
                startTime: start,
                endTime: end,
                durationMinutes: durMin,
                points: currentRun
            });
        }
    }

    return runs;
}

/**
 * Compute average temperature rise rate (°C/min) for a device over heating runs.
 * 
 * @param {Array<Object>} devicePoints - Device measurements with timestamp & field_012d
 * @param {Array<Object>} heatingRuns - Qualifying heating runs for the device's zone
 * @param {Array<Object>} [fallbackZonePoints] - Fallback zone points if device telemetry is missing
 * @returns {Object} { avgRiseRate, runsCount, runRates }
 */
function computeDeviceRiseRate(devicePoints, heatingRuns, fallbackZonePoints = []) {
    if (!Array.isArray(heatingRuns) || heatingRuns.length === 0) {
        return { avgRiseRate: 0, runsCount: 0, runRates: [] };
    }

    const points = (Array.isArray(devicePoints) && devicePoints.length > 0) ? devicePoints : fallbackZonePoints;
    const parsedPoints = points
        .map(p => ({
            time: new Date(p.timestamp).getTime(),
            temp: p.field_012d !== null && p.field_012d !== undefined ? Number(p.field_012d) : null
        }))
        .filter(p => !isNaN(p.time) && p.temp !== null && !isNaN(p.temp))
        .sort((a, b) => a.time - b.time);

    const runRates = [];

    for (const run of heatingRuns) {
        const inRun = parsedPoints.filter(p => p.time >= run.startTime && p.time <= run.endTime);
        if (inRun.length < 3) continue;

        const startPt = inRun[0];
        const endPt = inRun[inRun.length - 1];
        const durMin = (endPt.time - startPt.time) / (60 * 1000);

        if (durMin >= 5) {
            const deltaTemp = endPt.temp - startPt.temp;
            const rate = deltaTemp / durMin;
            runRates.push(rate);
        }
    }

    if (runRates.length === 0) {
        return { avgRiseRate: 0, runsCount: 0, runRates: [] };
    }

    const sum = runRates.reduce((acc, r) => acc + r, 0);
    const avg = sum / runRates.length;

    return {
        avgRiseRate: Math.round(avg * 10000) / 10000,
        runsCount: runRates.length,
        runRates
    };
}

/**
 * Calculate median of a number array.
 * 
 * @param {Array<number>} numbers
 * @returns {number}
 */
function calculateMedian(numbers) {
    if (!Array.isArray(numbers) || numbers.length === 0) return 0;
    const sorted = [...numbers].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 !== 0) {
        return sorted[mid];
    }
    return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Generate balancing suggestion for a single VA device.
 * 
 * @param {Object} params
 * @param {number} params.currentSensitivity - Current valve sensitivity (50-100)
 * @param {number} params.deviceRiseRate - Measured rise rate (°C/min)
 * @param {number} params.houseMedianRiseRate - House median rise rate (°C/min)
 * @param {number|null} [params.avgCircuitDeltaT] - Flow/return delta T (°C)
 * @param {number} params.runsCount - Number of qualifying runs
 * @param {number} params.dataSpanHours - Hours of historical data analyzed
 * @param {string} [params.heatingType='RADIATOR'] - Emitter type ('RADIATOR' | 'UNDERFLOOR')
 * @returns {Object} Suggestion details
 */
function generateDeviceSuggestion({
    currentSensitivity = 100,
    deviceRiseRate = 0.05,
    houseMedianRiseRate = 0.05,
    avgCircuitDeltaT = null,
    runsCount = 0,
    dataSpanHours = 24,
    heatingType = 'RADIATOR'
}) {
    let suggestedSensitivity = currentSensitivity;
    let confidence = (runsCount >= 10 && dataSpanHours >= 48) ? 'HIGH' : 'MEDIUM';

    const isUfh = heatingType === 'UNDERFLOOR';
    const defaultMedian = isUfh ? 0.01 : 0.05;
    const safeMedian = houseMedianRiseRate > 0 ? houseMedianRiseRate : defaultMedian;

    if (deviceRiseRate <= 0.001) {
        // Severe heat deficit: radiator heating very slowly or cooling during active call
        suggestedSensitivity = currentSensitivity > 50 ? 50 : Math.max(25, currentSensitivity - 15);
    } else {
        // Dampened proportion: ratio < 1 means room is slower than median -> lower sens (more valve opening)
        // ratio > 1 means room is faster than median -> higher sens up to 100 (standard baseline)
        const ratio = deviceRiseRate / safeMedian;
        let target = currentSensitivity * Math.pow(ratio, 0.5);

        // Secondary weight from flow-return ΔT:
        // If system delta T is narrow (<8°C), water is cycling back too hot -> slight correction
        if (avgCircuitDeltaT !== null && avgCircuitDeltaT !== undefined && avgCircuitDeltaT > 0 && avgCircuitDeltaT < 8) {
            target *= Math.pow(avgCircuitDeltaT / 12, 0.3);
        }

        const clamped = Math.max(25, Math.min(100, target));
        suggestedSensitivity = Math.round(clamped / 5) * 5;
    }

    let changeDirection = 'NO_CHANGE';
    if (suggestedSensitivity < currentSensitivity) {
        changeDirection = 'INCREASE_OPENING';
    } else if (suggestedSensitivity > currentSensitivity) {
        changeDirection = 'DECREASE_OPENING';
    }

    const diffPct = Math.abs(suggestedSensitivity - currentSensitivity);
    let reasoning = '';
    const emitterLabel = isUfh ? 'Underfloor heating loop' : 'Radiator';
    const cohortLabel = isUfh ? 'UFH slab median' : 'house median';

    if (changeDirection === 'INCREASE_OPENING') {
        reasoning = `${emitterLabel} rise rate (+${deviceRiseRate.toFixed(3)}°C/min) is below ${cohortLabel} (+${safeMedian.toFixed(3)}°C/min). Boost valve flow by ${diffPct}%.`;
    } else if (changeDirection === 'DECREASE_OPENING') {
        reasoning = `${emitterLabel} rise rate (+${deviceRiseRate.toFixed(3)}°C/min) exceeds ${cohortLabel} (+${safeMedian.toFixed(3)}°C/min). Reduce valve boost by ${diffPct}%.`;
    } else {
        reasoning = `${emitterLabel} rise rate (+${deviceRiseRate.toFixed(3)}°C/min) is well balanced with ${cohortLabel} (+${safeMedian.toFixed(3)}°C/min).`;
    }

    return {
        currentSensitivity,
        suggestedSensitivity,
        confidence,
        changeDirection,
        reasoning,
        heatingType
    };
}

/**
 * Run hydraulic balancing analysis for a home.
 * 
 * @param {number|string} homeId - Home ID
 * @param {Object} [options]
 * @param {number} [options.hours=72] - Timeframe in hours (min 12)
 * @param {Object} [options.pool] - Optional MariaDB connection pool
 * @param {number} [options.now] - Current timestamp in ms
 * @returns {Promise<Object>} Analysis result or refusal payload
 */
async function analyzeBalancing(homeId, options = {}) {
    const hours = Math.max(12, Math.min(720, Number(options.hours) || 72));
    const now = options.now || Date.now();
    const pool = options.pool || db.getPool();

    const cutoffDate = new Date(now - hours * 3600 * 1000);
    const cutoffStr = cutoffDate.toISOString().slice(0, 19).replace('T', ' ');

    // 1. Fetch heating zones
    const [zones] = await pool.execute(
        'SELECT id, name, type, heating_circuit, heating_type, underfloor_mass FROM zones WHERE home_id = ? AND type = "HEATING"',
        [homeId]
    );

    if (!zones || zones.length === 0) {
        return {
            ok: false,
            error: 'no_heating_zones',
            message: 'No heating zones configured for this home'
        };
    }

    // 2. Fetch VA devices
    const [devices] = await pool.execute(
        `SELECT serial_no, device_type, zone_id, valve_sensitivity 
         FROM devices 
         WHERE home_id = ? AND device_type LIKE "VA%" AND zone_id IS NOT NULL`,
        [homeId]
    );

    if (!devices || devices.length === 0) {
        return {
            ok: false,
            error: 'no_va_devices',
            message: 'No radiator valve devices (VA) found in home'
        };
    }

    // 3. Fetch zone measurements during active period
    const [zoneRows] = await pool.execute(
        `SELECT zone_id, timestamp, field_012d, field_40a0, tado_mode 
         FROM zone_measurements 
         WHERE home_id = ? AND timestamp >= ? 
         ORDER BY timestamp ASC`,
        [homeId, cutoffStr]
    );

    // 4. Fetch device measurements for VA devices
    const [devRows] = await pool.execute(
        `SELECT device_serial, zone_id, timestamp, field_012d, field_0162 
         FROM device_measurements 
         WHERE home_id = ? AND timestamp >= ? AND field_012d IS NOT NULL
         ORDER BY timestamp ASC`,
        [homeId, cutoffStr]
    );

    // 5. Fetch circuit measurements if available
    let avgCircuitDeltaT = null;
    const circuitIntervalsByCircuit = new Map();
    try {
        const [circuitRows] = await pool.execute(
            `SELECT timestamp, circuit_number, field_4080, field_0457, field_0452, field_044c, field_044d 
             FROM circuit_measurements 
             WHERE home_id = ? AND timestamp >= ? 
             ORDER BY timestamp ASC`,
            [homeId, cutoffStr]
        );

        if (circuitRows && circuitRows.length > 0) {
            const validDeltas = circuitRows.filter(r => r.field_044c !== null && r.field_044d !== null && Number(r.field_044c) > Number(r.field_044d));
            if (validDeltas.length > 0) {
                const sumDelta = validDeltas.reduce((acc, row) => acc + (Number(row.field_044c) - Number(row.field_044d)), 0);
                avgCircuitDeltaT = Math.round((sumDelta / validDeltas.length) * 10) / 10;
            }

            for (const cRow of circuitRows) {
                const cNum = Number(cRow.circuit_number) || 1;
                const isCircuitActive = (Number(cRow.field_4080) > 0) || Boolean(cRow.field_0457) || (Number(cRow.field_0452) > 0);
                if (isCircuitActive) {
                    const t = new Date(cRow.timestamp).getTime();
                    if (!isNaN(t)) {
                        if (!circuitIntervalsByCircuit.has(cNum)) circuitIntervalsByCircuit.set(cNum, []);
                        const intervals = circuitIntervalsByCircuit.get(cNum);
                        if (intervals.length > 0 && (t - intervals[intervals.length - 1][1]) <= 15 * 60 * 1000) {
                            intervals[intervals.length - 1][1] = t + 5 * 60 * 1000;
                        } else {
                            intervals.push([t, t + 10 * 60 * 1000]);
                        }
                    }
                }
            }
        }
    } catch (err) {
        log('warn', `Failed to query circuit measurements for home ${homeId}: ${err.message}`);
    }

    // Calculate actual data span in hours
    let minTime = Infinity;
    let maxTime = -Infinity;
    for (const r of zoneRows) {
        const t = new Date(r.timestamp).getTime();
        if (!isNaN(t)) {
            if (t < minTime) minTime = t;
            if (t > maxTime) maxTime = t;
        }
    }

    const dataSpanHours = (minTime !== Infinity && maxTime !== -Infinity && maxTime > minTime)
        ? Math.round(((maxTime - minTime) / (3600 * 1000)) * 10) / 10
        : 0;

    // Group heating runs per zone
    const zoneMeasurementsMap = new Map();
    for (const r of zoneRows) {
        const zId = Number(r.zone_id);
        if (!zoneMeasurementsMap.has(zId)) zoneMeasurementsMap.set(zId, []);
        zoneMeasurementsMap.get(zId).push(r);
    }

    const devMeasurementsMap = new Map();
    for (const r of devRows) {
        const serial = r.device_serial;
        if (!devMeasurementsMap.has(serial)) devMeasurementsMap.set(serial, []);
        devMeasurementsMap.get(serial).push(r);
    }

    const zoneRunsMap = new Map();
    let totalHeatingRuns = 0;

    for (const zone of zones) {
        const zId = Number(zone.id);
        const cNum = Number(zone.heating_circuit) || 1;
        const circuitIntervals = circuitIntervalsByCircuit.get(cNum) || null;

        const zRows = zoneMeasurementsMap.get(zId) || [];
        const runs = groupHeatingRuns(zRows, 10, 5, 3, { circuitIntervals });
        zoneRunsMap.set(zId, runs);
        totalHeatingRuns += runs.length;
    }

    // 6. Hard refusal if minimum data threshold is not met:
    // Require >= 12h data span and >= 5 qualifying heating runs total
    if (dataSpanHours < 12 || totalHeatingRuns < 5) {
        return {
            ok: false,
            error: 'insufficient_data',
            message: 'Insufficient heating data for hydraulic balancing analysis. Minimum 12 hours and 5 heating runs required.',
            dataSpanHours,
            heatingRunsTotal: totalHeatingRuns,
            minimumRequired: { hours: 12, runs: 5 }
        };
    }

    // Compute rise rates for each VA device
    const zoneHeatingTypeMap = new Map(zones.map(z => [Number(z.id), z.heating_type || 'RADIATOR']));

    const deviceResults = [];
    for (const dev of devices) {
        const zId = Number(dev.zone_id);
        const runs = zoneRunsMap.get(zId) || [];
        const devPoints = devMeasurementsMap.get(dev.serial_no) || [];
        const fallbackPoints = zoneMeasurementsMap.get(zId) || [];

        const { avgRiseRate, runsCount, runRates } = computeDeviceRiseRate(devPoints, runs, fallbackPoints);

        deviceResults.push({
            device: dev,
            zoneId: zId,
            heatingType: zoneHeatingTypeMap.get(zId) || 'RADIATOR',
            avgRiseRate,
            runsCount,
            runRates
        });
    }

    // Compute separate cohort medians: Radiators vs Underfloor Heating
    const radiatorRates = deviceResults
        .filter(d => d.heatingType !== 'UNDERFLOOR' && d.avgRiseRate > 0.001)
        .map(d => d.avgRiseRate);
    const ufhRates = deviceResults
        .filter(d => d.heatingType === 'UNDERFLOOR' && d.avgRiseRate > 0.001)
        .map(d => d.avgRiseRate);

    const radiatorMedianRiseRate = radiatorRates.length > 0
        ? Math.round(calculateMedian(radiatorRates) * 10000) / 10000
        : 0.05;
    const ufhMedianRiseRate = ufhRates.length > 0
        ? Math.round(calculateMedian(ufhRates) * 10000) / 10000
        : 0.01;

    // Overall house median fallback
    const allPositiveRates = deviceResults.map(d => d.avgRiseRate).filter(r => r > 0.001);
    const houseMedianRiseRate = allPositiveRates.length > 0
        ? Math.round(calculateMedian(allPositiveRates) * 10000) / 10000
        : 0.05;

    // Build zone and device suggestion response structure
    const zoneMap = new Map();
    for (const zone of zones) {
        const zRows = zoneMeasurementsMap.get(Number(zone.id)) || [];
        const activeRows = zRows.filter(r => Number(r.field_40a0 || 0) > 0);
        const avgHeatingPower = activeRows.length > 0
            ? Math.round((activeRows.reduce((acc, r) => acc + Number(r.field_40a0), 0) / activeRows.length) * 10) / 10
            : 0;

        zoneMap.set(Number(zone.id), {
            zoneId: Number(zone.id),
            zoneName: zone.name,
            heatingType: zone.heating_type || 'RADIATOR',
            underfloorMass: zone.underfloor_mass || 'SCREED',
            avgHeatingPower,
            devices: []
        });
    }

    for (const res of deviceResults) {
        const dev = res.device;
        const currentSens = dev.valve_sensitivity !== null && dev.valve_sensitivity !== undefined
            ? Number(dev.valve_sensitivity)
            : 100;

        const cohortMedian = res.heatingType === 'UNDERFLOOR' ? ufhMedianRiseRate : radiatorMedianRiseRate;

        const suggestion = generateDeviceSuggestion({
            currentSensitivity: currentSens,
            deviceRiseRate: res.avgRiseRate,
            houseMedianRiseRate: cohortMedian,
            avgCircuitDeltaT,
            runsCount: res.runsCount,
            dataSpanHours,
            heatingType: res.heatingType
        });

        const devEntry = {
            serial: dev.serial_no,
            avgRiseRate: res.avgRiseRate,
            runsCount: res.runsCount,
            currentSensitivity: suggestion.currentSensitivity,
            suggestedSensitivity: suggestion.suggestedSensitivity,
            confidence: suggestion.confidence,
            changeDirection: suggestion.changeDirection,
            reasoning: suggestion.reasoning
        };

        const targetZone = zoneMap.get(res.zoneId);
        if (targetZone) {
            targetZone.devices.push(devEntry);
        }
    }

    // Compute average rise rate per zone
    const resultZones = [];
    for (const z of zoneMap.values()) {
        const rates = z.devices.map(d => d.avgRiseRate).filter(r => r > 0);
        z.avgRiseRate = rates.length > 0
            ? Math.round((rates.reduce((acc, r) => acc + r, 0) / rates.length) * 10000) / 10000
            : 0;
        resultZones.push(z);
    }

    return {
        ok: true,
        analyzedAt: new Date(now).toISOString(),
        dataSpanHours,
        heatingRunsTotal: totalHeatingRuns,
        houseMedianRiseRate,
        avgCircuitDeltaT,
        zones: resultZones
    };
}

module.exports = {
    groupHeatingRuns,
    computeDeviceRiseRate,
    calculateMedian,
    generateDeviceSuggestion,
    analyzeBalancing
};
