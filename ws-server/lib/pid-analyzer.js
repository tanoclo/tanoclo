/**
 * @file lib/pid-analyzer.js
 * @brief Advisory thermodynamic PID tuning analyzer based on room temperature response transients.
 * 
 * Evaluates zone-level temperature transient response (overshoot, droop, oscillations/hunting, rise time)
 * against active setpoints and recommends optimal Kp (0x6080), Ki (0x60a0), and Kd (0x60c0) gains.
 * Correlates recommendations with prior hydraulic balancing snapshots to encourage two-tier tuning.
 */

'use strict';

const db = require('./db');
const { getLogger } = require('./logger');
const log = getLogger('pid-analyzer');

/**
 * Validate whether an extracted window represents a legitimate heating transient.
 * 
 * @param {Object} win - Window candidate
 * @param {number} minDemand - Minimum peak demand threshold (default 10%)
 * @param {Array<Array<number>>|null} circuitIntervals - Active circuit intervals [[start, end]]
 * @returns {boolean}
 */
function isQualifyingWindow(win, minDemand = 10, circuitIntervals = null) {
    if (!win || !Array.isArray(win.points) || win.points.length < 4) return false;

    // Minimum window duration 10 min
    const durMin = (win.endTime - win.startTime) / (60 * 1000);
    if (durMin < 10) return false;

    // Must have active heating demand (not idle / solar gain)
    const demands = win.points.map(p => Number(p.demand) || 0);
    const peakDemand = Math.max(...demands);
    const avgDemand = demands.reduce((a, b) => a + b, 0) / demands.length;

    if (peakDemand < minDemand || avgDemand < 5) {
        return false;
    }

    // If circuit activation intervals are available, verify circuit was active during this window
    if (Array.isArray(circuitIntervals) && circuitIntervals.length > 0) {
        const circuitWasActive = circuitIntervals.some(([cStart, cEnd]) => {
            return win.startTime < cEnd && win.endTime > cStart;
        });
        if (!circuitWasActive) {
            return false;
        }
    }

    return true;
}

/**
 * Group measurements into transient response windows following setpoint changes or heating initiations.
 * 
 * @param {Array<Object>} rows - Chronologically sorted zone measurements
 * @param {number} maxWindowMinutes - Max duration for transient window (default 120m)
 * @param {Object} [options] - Optional filters { minDemand: 10, circuitIntervals: null }
 * @returns {Array<Object>} Transient windows [{ startTime, endTime, setpoint, startTemp, points }]
 */
function extractTransientWindows(rows, maxWindowMinutes = 120, options = {}) {
    if (!Array.isArray(rows) || rows.length < 5) return [];

    const minDemand = typeof options.minDemand === 'number' ? options.minDemand : 10;
    const circuitIntervals = options.circuitIntervals || null;

    const windows = [];
    let currentWindow = null;
    let lastSetpoint = null;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowTime = new Date(row.timestamp).getTime();
        if (isNaN(rowTime)) continue;

        const currentTemp = Number(row.field_012d);
        if (isNaN(currentTemp) || currentTemp <= 0) continue;

        const hasSetpoint = (row.field_6260 === 1 || row.field_6260 === true);
        const overlayTemp = row.field_6280 !== null && row.field_6280 !== undefined ? Number(row.field_6280) : null;
        const scheduleTemp = row.field_6200 !== null && row.field_6200 !== undefined ? Number(row.field_6200) : null;
        const heatingEnabled = row.field_61e0 !== 0;

        let sp = null;
        if (heatingEnabled) {
            if (hasSetpoint && overlayTemp !== null && !isNaN(overlayTemp)) {
                sp = overlayTemp;
            } else if (scheduleTemp !== null && !isNaN(scheduleTemp)) {
                sp = scheduleTemp;
            }
        }

        if (sp === null) {
            if (currentWindow && isQualifyingWindow(currentWindow, minDemand, circuitIntervals)) {
                windows.push(currentWindow);
            }
            currentWindow = null;
            lastSetpoint = null;
            continue;
        }

        const demand = Number(row.field_40a0 || 0);

        // Detect setpoint step change or new heating run
        // Step UP into heating demand (sp > lastSetpoint + 0.4 and currentTemp < sp - 0.2)
        const isSetpointStepUp = (lastSetpoint !== null) && ((sp - lastSetpoint) >= 0.4) && (currentTemp < (sp - 0.2)) && (demand >= minDemand);
        // Heating initiation from cold/idle
        const isHeatingInitiation = (demand >= minDemand && currentTemp < (sp - 0.3) && (!currentWindow || (rowTime - currentWindow.startTime) > maxWindowMinutes * 60 * 1000));

        // Setpoint step DOWN (night setback / lowering target): cooling transient, not heating!
        if (lastSetpoint !== null && (lastSetpoint - sp) >= 0.4) {
            if (currentWindow && isQualifyingWindow(currentWindow, minDemand, circuitIntervals)) {
                windows.push(currentWindow);
            }
            currentWindow = null;
            lastSetpoint = sp;
            continue;
        }

        if (isSetpointStepUp || (isHeatingInitiation && !currentWindow)) {
            if (currentWindow && isQualifyingWindow(currentWindow, minDemand, circuitIntervals)) {
                windows.push(currentWindow);
            }
            currentWindow = {
                startTime: rowTime,
                endTime: rowTime,
                setpoint: sp,
                startTemp: currentTemp,
                points: [{ ...row, parsedTime: rowTime, temp: currentTemp, demand, sp }]
            };
            lastSetpoint = sp;
        } else if (currentWindow) {
            const elapsedMinutes = (rowTime - currentWindow.startTime) / (60 * 1000);
            if (elapsedMinutes <= maxWindowMinutes) {
                currentWindow.points.push({ ...row, parsedTime: rowTime, temp: currentTemp, demand, sp });
                currentWindow.endTime = rowTime;
            } else {
                if (isQualifyingWindow(currentWindow, minDemand, circuitIntervals)) {
                    windows.push(currentWindow);
                }
                currentWindow = null;
            }
        }
        lastSetpoint = sp;
    }

    if (currentWindow && isQualifyingWindow(currentWindow, minDemand, circuitIntervals)) {
        windows.push(currentWindow);
    }

    return windows;
}

/**
 * Compute thermodynamic transient metrics for a single zone.
 * 
 * @param {Array<Object>} windows - Extracted transient response windows
 * @returns {Object} Calculated metrics
 */
function evaluateZoneTransients(windows) {
    if (!windows || windows.length === 0) {
        return {
            validWindowsCount: 0,
            avgOvershoot: 0,
            maxOvershoot: 0,
            avgSteadyStateError: 0,
            oscillationScore: 0,
            avgRiseTimeMinutes: 0
        };
    }

    let totalOvershoot = 0;
    let maxOvershoot = 0;
    let totalSteadyStateError = 0;
    let totalOscillationEvents = 0;
    let totalRiseTime = 0;
    let riseTimeCount = 0;

    for (const win of windows) {
        const pts = win.points;
        const sp = win.setpoint;
        let peakTemp = win.startTemp;

        // Measure overshoot: only count peak temperatures reached during active heating
        // or within 35 min thermal inertia period after heating demand was active
        let lastActiveDemandTime = win.startTime;
        for (const pt of pts) {
            if (pt.demand > 5) {
                lastActiveDemandTime = pt.parsedTime;
            }
            const timeSinceActive = (pt.parsedTime - lastActiveDemandTime) / 60000;
            // Attribute temp rise to heating only if within 35 mins of active demand
            if (timeSinceActive <= 35 && pt.temp > peakTemp) {
                peakTemp = pt.temp;
            }
        }
        const overshoot = Math.max(0, peakTemp - sp);
        totalOvershoot += overshoot;
        if (overshoot > maxOvershoot) maxOvershoot = overshoot;

        // Rise time: time to reach within 0.3°C of setpoint
        let reachedTime = null;
        for (const pt of pts) {
            if (pt.temp >= (sp - 0.3)) {
                reachedTime = pt.parsedTime;
                break;
            }
        }
        if (reachedTime) {
            const rtMin = (reachedTime - win.startTime) / (60 * 1000);
            if (rtMin > 0) {
                totalRiseTime += rtMin;
                riseTimeCount++;
            }
        }

        // Steady state error: average error across the last 30% of the window
        // Only evaluate if demand was actively regulating (i.e. heating was engaged)
        if (pts.length >= 6) {
            const tailCount = Math.max(2, Math.floor(pts.length * 0.3));
            const tailPts = pts.slice(-tailCount);
            const avgTailDemand = tailPts.reduce((acc, p) => acc + (p.demand || 0), 0) / tailCount;
            const avgTailTemp = tailPts.reduce((acc, p) => acc + p.temp, 0) / tailCount;
            if (avgTailDemand > 0 || avgTailTemp >= (sp - 0.3)) {
                const sse = sp - avgTailTemp; // positive means undershooting/droop
                totalSteadyStateError += sse;
            }
        }

        // Oscillations: count direction changes around setpoint DURING active regulation
        let directionChanges = 0;
        let lastSlope = 0;
        for (let i = 1; i < pts.length; i++) {
            const dt = (pts[i].parsedTime - pts[i - 1].parsedTime) / 60000;
            if (dt <= 0) continue;
            // Loop hunting requires either current point or previous point to have heating demand
            const hasDemand = ((pts[i].demand || 0) > 0 || (pts[i - 1].demand || 0) > 0);
            if (!hasDemand) continue;

            const slope = (pts[i].temp - pts[i - 1].temp) / dt;
            if (Math.abs(slope) > 0.01) {
                if (lastSlope !== 0 && ((slope > 0 && lastSlope < 0) || (slope < 0 && lastSlope > 0))) {
                    if (Math.abs(pts[i].temp - sp) < 1.0) {
                        directionChanges++;
                    }
                }
                lastSlope = slope;
            }
        }
        totalOscillationEvents += directionChanges;
    }

    const count = windows.length;
    return {
        validWindowsCount: count,
        avgOvershoot: Math.round((totalOvershoot / count) * 100) / 100,
        maxOvershoot: Math.round(maxOvershoot * 100) / 100,
        avgSteadyStateError: Math.round((totalSteadyStateError / count) * 100) / 100,
        oscillationScore: Math.round((totalOscillationEvents / count) * 10) / 10,
        avgRiseTimeMinutes: riseTimeCount > 0 ? Math.round(totalRiseTime / riseTimeCount) : 0
    };
}

/**
 * @param {Object} metrics - Zone transient metrics
 * @param {Object} currentGains - { kp, ki, kd }
 * @param {string} [heatingType='RADIATOR'] - 'RADIATOR' | 'UNDERFLOOR'
 * @returns {Object} Suggested gains, diagnosis, reason
 */
function derivePidSuggestions(metrics, currentGains, heatingType = 'RADIATOR') {
    const isUfh = heatingType === 'UNDERFLOOR';
    const curKp = Number(currentGains.kp || (isUfh ? 4.00 : 10.00));
    const curKi = Number(currentGains.ki || (isUfh ? 1.50 : 5.00));
    const curKd = Number(currentGains.kd || (isUfh ? 25.00 : 15.00));

    let suggestedKp = curKp;
    let suggestedKi = curKi;
    let suggestedKd = curKd;
    let diagnosis = 'BALANCED';
    const reasons = [];

    const { avgOvershoot, maxOvershoot, avgSteadyStateError, oscillationScore, validWindowsCount } = metrics;

    if (validWindowsCount < 2) {
        return {
            currentKp: curKp,
            currentKi: curKi,
            currentKd: curKd,
            suggestedKp: curKp,
            suggestedKi: curKi,
            suggestedKd: curKd,
            diagnosis: 'INSUFFICIENT_DATA',
            reason: 'Insufficient transient measurement windows. Continue normal heating to collect tuning data.',
            confidence: 'LOW'
        };
    }

    if (isUfh) {
        // Underfloor heating has high thermal capacitance and long delay
        if (oscillationScore >= 2.0) {
            diagnosis = 'HUNTING';
            suggestedKp = Math.max(2.0, Math.min(4.0, Math.round(curKp * 0.75 * 10) / 10));
            suggestedKi = Math.max(0.8, Math.min(1.8, Math.round(curKi * 0.75 * 10) / 10));
            suggestedKd = Math.min(35.0, Math.max(20.0, Math.round(curKd * 1.25 * 10) / 10));
            reasons.push('Underfloor slab hunting. Dampening Kp and Ki, and boosting Kd derivative braking to arrest thermal inertia.');
        } else if (maxOvershoot >= 0.35 || avgOvershoot >= 0.25) {
            diagnosis = 'OVERSHOOT';
            suggestedKp = Math.max(2.0, Math.min(4.0, Math.round(curKp * 0.80 * 10) / 10));
            suggestedKd = Math.min(35.0, Math.max(22.0, Math.round(curKd * 1.30 * 10) / 10));
            reasons.push(`Underfloor slab overshoots target by up to ${maxOvershoot.toFixed(2)}°C. Lowering Kp and increasing Kd dynamic braking to stop heat early.`);
        } else if (avgSteadyStateError >= 0.40) {
            diagnosis = 'DROOP';
            suggestedKi = Math.min(2.5, Math.round(curKi * 1.25 * 10) / 10);
            reasons.push(`Underfloor room settles ${avgSteadyStateError.toFixed(2)}°C below setpoint. Gentle Ki boost with conservative anti-windup.`);
        } else if (metrics.avgRiseTimeMinutes > 180 && avgOvershoot < 0.15 && oscillationScore < 1.0) {
            diagnosis = 'SLUGGISH';
            suggestedKp = Math.min(5.5, Math.round(curKp * 1.20 * 10) / 10);
            reasons.push(`Underfloor heating rise time excessively slow (${metrics.avgRiseTimeMinutes} mins). Gentle Kp boost within radiant safety limits.`);
        } else {
            diagnosis = 'OPTIMAL';
            reasons.push('Underfloor thermal inertia well managed with stable equilibrium.');
        }

        suggestedKp = Math.min(6.0, Math.max(2.0, suggestedKp));
        suggestedKi = Math.min(2.5, Math.max(0.5, suggestedKi));
        suggestedKd = Math.min(40.0, Math.max(15.0, suggestedKd));
    } else {
        // Standard Radiator tuning logic
        // 1. Check for Hunting / Oscillations (High Priority)
        if (oscillationScore >= 2.5) {
            diagnosis = 'HUNTING';
            suggestedKp = Math.max(4.0, Math.round(curKp * 0.80 * 10) / 10);
            suggestedKi = Math.max(2.0, Math.round(curKi * 0.80 * 10) / 10);
            suggestedKd = Math.min(30.0, Math.round(curKd * 1.20 * 10) / 10);
            reasons.push(`Temperature hunts/oscillates around target (${oscillationScore} direction reversals). Decreasing Kp and Ki, and increasing Kd damping to stabilize loop.`);
        }
        // 2. Check for Thermal Overshoot
        else if (maxOvershoot >= 0.50 || avgOvershoot >= 0.35) {
            diagnosis = 'OVERSHOOT';
            suggestedKp = Math.max(3.0, Math.round(curKp * 0.85 * 10) / 10);
            suggestedKd = Math.min(35.0, Math.round(curKd * 1.25 * 10) / 10);
            reasons.push(`Room overshoots target temperature by up to ${maxOvershoot.toFixed(2)}°C. Reducing Kp to soften initial surge and boosting Kd dynamic braking.`);
        }
        // 3. Check for Steady-State Droop (Under-heating)
        else if (avgSteadyStateError >= 0.30) {
            diagnosis = 'DROOP';
            suggestedKi = Math.min(18.0, Math.round(curKi * 1.35 * 10) / 10);
            reasons.push(`Room consistently settles ${avgSteadyStateError.toFixed(2)}°C below setpoint. Increasing Ki integral gain to eliminate steady-state shortfall.`);
        }
        // 4. Check for Sluggish Rise
        else if (metrics.avgRiseTimeMinutes > 75 && avgOvershoot < 0.15 && oscillationScore < 1.0) {
            diagnosis = 'SLUGGISH';
            suggestedKp = Math.min(25.0, Math.round(curKp * 1.25 * 10) / 10);
            reasons.push(`Rise time is slow (${metrics.avgRiseTimeMinutes} mins) without overshoot. Increasing Kp proportional gain to deliver heat faster.`);
        } else {
            diagnosis = 'OPTIMAL';
            reasons.push('Room temperature tracks setpoint accurately with minimal overshoot and stable equilibrium.');
        }

        // Clamp to valid firmware bounds
        suggestedKp = Math.min(30.0, Math.max(2.0, suggestedKp));
        suggestedKi = Math.min(20.0, Math.max(1.0, suggestedKi));
        suggestedKd = Math.min(40.0, Math.max(5.0, suggestedKd));
    }

    const confidence = validWindowsCount >= 5 ? 'HIGH' : (validWindowsCount >= 3 ? 'MEDIUM' : 'LOW');

    return {
        currentKp: curKp,
        currentKi: curKi,
        currentKd: curKd,
        suggestedKp,
        suggestedKi,
        suggestedKd,
        diagnosis,
        reason: reasons.join(' '),
        confidence,
        heatingType
    };
}

/**
 * Perform comprehensive thermodynamic PID tuning analysis across all heating zones in a home.
 * 
 * @param {number|string} homeId - Home ID
 * @param {Object} [options] - Analysis options { hours: 72 }
 * @returns {Promise<Object>} Analysis results and zone suggestions
 */
async function analyzePidTuning(homeId, options = {}) {
    const hours = options.hours ? parseInt(options.hours, 10) : 72;
    const pool = db.getPool();

    const cutoffDate = new Date(Date.now() - hours * 3600 * 1000);
    const cutoffStr = cutoffDate.toISOString().slice(0, 19).replace('T', ' ');

    // 1. Fetch heating zones
    const [zones] = await pool.execute(
        `SELECT id, name, heating_circuit, heating_type, underfloor_mass, field_6080, field_60a0, field_60c0 
         FROM zones 
         WHERE home_id = ? AND type = 'HEATING' 
         ORDER BY id ASC`,
        [homeId]
    );

    if (!zones || zones.length === 0) {
        return {
            ok: false,
            error: 'no_heating_zones',
            message: 'No heating zones configured for this home'
        };
    }

    // 2. Query zone measurements
    const [zoneRows] = await pool.execute(
        `SELECT zone_id, timestamp, field_012d, field_40a0, field_61e0, field_6160, field_6200, field_6260, field_6280 
         FROM zone_measurements 
         WHERE home_id = ? AND timestamp >= ? 
         ORDER BY timestamp ASC`,
        [homeId, cutoffStr]
    );

    // 3. Query circuit measurements to track active heating circuit intervals
    const circuitIntervalsByCircuit = new Map();
    try {
        const [circuitRows] = await pool.execute(
            `SELECT timestamp, circuit_number, field_4080, field_0457, field_0452 
             FROM circuit_measurements 
             WHERE home_id = ? AND timestamp >= ? 
             ORDER BY timestamp ASC`,
            [homeId, cutoffStr]
        );

        if (Array.isArray(circuitRows) && circuitRows.length > 0) {
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
    } catch (e) {
        log('warn', `Failed to query circuit measurements for PID tuning: ${e.message}`);
    }

    // 4. Query latest applied hydraulic balancing snapshot
    let hydraulicBaseline = null;
    try {
        const [hRows] = await pool.execute(
            `SELECT id, created_at, applied_at 
             FROM balancing_snapshots 
             WHERE home_id = ? AND applied = 1 
             ORDER BY applied_at DESC 
             LIMIT 1`,
            [homeId]
        );
        if (hRows && hRows.length > 0) {
            hydraulicBaseline = {
                id: hRows[0].id,
                appliedAt: hRows[0].applied_at || hRows[0].created_at
            };
        }
    } catch (e) {
        log('warn', `Failed to query hydraulic baseline snapshot: ${e.message}`);
    }

    // Group measurements per zone
    const zoneMap = new Map();
    for (const r of zoneRows) {
        const zId = Number(r.zone_id);
        if (!zoneMap.has(zId)) zoneMap.set(zId, []);
        zoneMap.get(zId).push(r);
    }

    const zoneResults = [];
    let totalWindows = 0;

    for (const zone of zones) {
        const zId = Number(zone.id);
        const cNum = Number(zone.heating_circuit) || 1;
        const circuitIntervals = circuitIntervalsByCircuit.get(cNum) || null;
        const heatingType = zone.heating_type || 'RADIATOR';
        const underfloorMass = zone.underfloor_mass || 'SCREED';

        const maxWinMinutes = heatingType === 'UNDERFLOOR' ? 240 : 120;
        const rows = zoneMap.get(zId) || [];
        const windows = extractTransientWindows(rows, maxWinMinutes, { circuitIntervals });
        totalWindows += windows.length;

        const metrics = evaluateZoneTransients(windows);
        const defaultKp = heatingType === 'UNDERFLOOR' ? 4.00 : 10.00;
        const defaultKi = heatingType === 'UNDERFLOOR' ? 1.50 : 5.00;
        const defaultKd = heatingType === 'UNDERFLOOR' ? 25.00 : 15.00;

        const currentGains = {
            kp: zone.field_6080 !== null ? parseFloat(zone.field_6080) : defaultKp,
            ki: zone.field_60a0 !== null ? parseFloat(zone.field_60a0) : defaultKi,
            kd: zone.field_60c0 !== null ? parseFloat(zone.field_60c0) : defaultKd
        };

        const suggestions = derivePidSuggestions(metrics, currentGains, heatingType);

        zoneResults.push({
            zoneId: zId,
            zoneName: zone.name,
            heatingType,
            underfloorMass,
            metrics,
            ...suggestions
        });
    }

    const hasData = totalWindows >= 2;

    return {
        ok: true,
        homeId: Number(homeId),
        analysisTimestamp: new Date().toISOString(),
        analyzedHours: hours,
        totalTransientWindows: totalWindows,
        hydraulicBaseline,
        hydraulicRecommendedFirst: hydraulicBaseline === null,
        zones: zoneResults,
        hasSufficientData: hasData
    };
}

module.exports = {
    extractTransientWindows,
    evaluateZoneTransients,
    derivePidSuggestions,
    analyzePidTuning
};
