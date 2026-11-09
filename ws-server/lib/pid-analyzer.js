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
 * Extract discrete boiler burn intervals from circuit measurements.
 * 
 * @param {Array<Object>} circuitRows - Chronologically sorted circuit measurements
 * @param {number} [maxGapMinutes=3] - Maximum gap to merge continuous burn
 * @param {number} [microBurnThresholdMinutes=10] - Threshold below which a burn is flagged as a micro-burn
 * @returns {Array<Object>} Extracted burn events [{ circuitNumber, startTime, endTime, durationMinutes, isMicroBurn }]
 */
function extractBurnEvents(circuitRows, maxGapMinutes = 15, microBurnThresholdMinutes = 10) {
    if (!Array.isArray(circuitRows) || circuitRows.length === 0) return [];

    const sorted = [...circuitRows].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const burnEvents = [];
    let currentBurn = null;

    for (const row of sorted) {
        const t = new Date(row.timestamp).getTime();
        if (isNaN(t)) continue;

        const cNum = Number(row.circuit_number) || 1;
        const hasFlameTelemetry = (row.field_0457 !== null && row.field_0457 !== undefined) ||
                                  (row.field_0452 !== null && row.field_0452 !== undefined);
        const isFlameOn = Boolean(row.field_0457) || (Number(row.field_0452) > 0);
        const isActive = hasFlameTelemetry ? isFlameOn : (Number(row.field_4080) > 0);

        if (isActive) {
            if (!currentBurn) {
                currentBurn = {
                    circuitNumber: cNum,
                    startTime: t,
                    endTime: t
                };
            } else {
                const gapMin = (t - currentBurn.endTime) / 60000;
                if (gapMin <= maxGapMinutes && currentBurn.circuitNumber === cNum) {
                    currentBurn.endTime = t;
                } else {
                    const durMin = Math.max(1, Math.round((currentBurn.endTime - currentBurn.startTime) / 60000));
                    const effectiveDurMin = (currentBurn.startTime === currentBurn.endTime) ? 3 : durMin;
                    burnEvents.push({
                        circuitNumber: currentBurn.circuitNumber,
                        startTime: currentBurn.startTime,
                        endTime: currentBurn.endTime,
                        durationMinutes: effectiveDurMin,
                        isMicroBurn: effectiveDurMin < microBurnThresholdMinutes
                    });
                    currentBurn = {
                        circuitNumber: cNum,
                        startTime: t,
                        endTime: t
                    };
                }
            }
        } else if (currentBurn) {
            const durMin = Math.max(1, Math.round((currentBurn.endTime - currentBurn.startTime) / 60000));
            const effectiveDurMin = (currentBurn.startTime === currentBurn.endTime) ? 3 : durMin;
            burnEvents.push({
                circuitNumber: currentBurn.circuitNumber,
                startTime: currentBurn.startTime,
                endTime: currentBurn.endTime,
                durationMinutes: effectiveDurMin,
                isMicroBurn: effectiveDurMin < microBurnThresholdMinutes
            });
            currentBurn = null;
        }
    }

    if (currentBurn) {
        const durMin = Math.max(1, Math.round((currentBurn.endTime - currentBurn.startTime) / 60000));
        const effectiveDurMin = (currentBurn.startTime === currentBurn.endTime) ? 3 : durMin;
        burnEvents.push({
            circuitNumber: currentBurn.circuitNumber,
            startTime: currentBurn.startTime,
            endTime: currentBurn.endTime,
            durationMinutes: effectiveDurMin,
            isMicroBurn: effectiveDurMin < microBurnThresholdMinutes
        });
    }

    return burnEvents;
}

/**
 * Correlate zone demand telemetry with circuit burn events (or identify proxy demand pulses if flame telemetry is absent).
 * 
 * @param {Array<Object>} zoneRows - Chronological zone measurements
 * @param {Array<Object>} [burnEvents=[]] - Extracted circuit burn events
 * @param {number} [totalAnalysisHours=72] - Analysis duration in hours
 * @param {Object} [options={}] - Configurable thresholds
 * @returns {Object} Burn metrics { totalBurns, microBurnCount, microBurnRatio, avgBurnDurationMinutes, shortCyclesPerHour }
 */
function correlateZoneBurns(zoneRows, burnEvents = [], totalAnalysisHours = 72, options = {}) {
    const minDemand = typeof options.minDemand === 'number' ? options.minDemand : 10;
    const microBurnThresholdMinutes = typeof options.microBurnThresholdMinutes === 'number' ? options.microBurnThresholdMinutes : 10;

    if (!Array.isArray(zoneRows) || zoneRows.length === 0) {
        return {
            totalBurns: 0,
            microBurnCount: 0,
            microBurnRatio: 0,
            avgBurnDurationMinutes: 0,
            shortCyclesPerHour: 0
        };
    }

    const sortedZone = [...zoneRows].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Case 1: Circuit burn events available
    if (Array.isArray(burnEvents) && burnEvents.length > 0) {
        let correlatedBurns = 0;
        let microBurns = 0;
        let totalDuration = 0;

        for (const burn of burnEvents) {
            const hadDemand = sortedZone.some(r => {
                const t = new Date(r.timestamp).getTime();
                return t >= burn.startTime && t <= burn.endTime && (Number(r.field_40a0) >= minDemand);
            });

            if (hadDemand) {
                correlatedBurns++;
                totalDuration += burn.durationMinutes;
                if (burn.isMicroBurn) {
                    microBurns++;
                }
            }
        }

        const ratio = correlatedBurns > 0 ? Math.round((microBurns / correlatedBurns) * 100) / 100 : 0;
        const avgDur = correlatedBurns > 0 ? Math.round(totalDuration / correlatedBurns) : 0;
        const cyclesPerHour = totalAnalysisHours > 0 ? Math.round((microBurns / totalAnalysisHours) * 10) / 10 : 0;

        return {
            totalBurns: correlatedBurns,
            microBurnCount: microBurns,
            microBurnRatio: ratio,
            avgBurnDurationMinutes: avgDur,
            shortCyclesPerHour: cyclesPerHour
        };
    }

    // Case 2: Proxy zone-level demand pulses
    let proxyBurns = 0;
    let proxyMicroBurns = 0;
    let totalProxyDuration = 0;
    let currentPulse = null;

    for (const r of sortedZone) {
        const t = new Date(r.timestamp).getTime();
        if (isNaN(t)) continue;
        const demand = Number(r.field_40a0) || 0;

        if (demand >= minDemand) {
            if (!currentPulse) {
                currentPulse = { startTime: t, endTime: t };
            } else {
                const gapMin = (t - currentPulse.endTime) / 60000;
                if (gapMin <= 15) {
                    currentPulse.endTime = t;
                } else {
                    const durMin = Math.max(3, Math.round((currentPulse.endTime - currentPulse.startTime) / 60000));
                    proxyBurns++;
                    totalProxyDuration += durMin;
                    if (durMin < microBurnThresholdMinutes) proxyMicroBurns++;
                    currentPulse = { startTime: t, endTime: t };
                }
            }
        } else if (currentPulse) {
            const durMin = Math.max(3, Math.round((currentPulse.endTime - currentPulse.startTime) / 60000));
            proxyBurns++;
            totalProxyDuration += durMin;
            if (durMin < microBurnThresholdMinutes) proxyMicroBurns++;
            currentPulse = null;
        }
    }

    if (currentPulse) {
        const durMin = Math.max(3, Math.round((currentPulse.endTime - currentPulse.startTime) / 60000));
        proxyBurns++;
        totalProxyDuration += durMin;
        if (durMin < microBurnThresholdMinutes) proxyMicroBurns++;
    }

    const ratio = proxyBurns > 0 ? Math.round((proxyMicroBurns / proxyBurns) * 100) / 100 : 0;
    const avgDur = proxyBurns > 0 ? Math.round(totalProxyDuration / proxyBurns) : 0;
    const cyclesPerHour = totalAnalysisHours > 0 ? Math.round((proxyMicroBurns / totalAnalysisHours) * 10) / 10 : 0;

    return {
        totalBurns: proxyBurns,
        microBurnCount: proxyMicroBurns,
        microBurnRatio: ratio,
        avgBurnDurationMinutes: avgDur,
        shortCyclesPerHour: cyclesPerHour
    };
}

/**
 * Compute thermodynamic transient metrics for a single zone.
 * 
 * @param {Array<Object>} windows - Extracted transient response windows
 * @param {Object} [burnMetrics={}] - Correlated burn metrics
 * @returns {Object} Calculated metrics
 */
function evaluateZoneTransients(windows, burnMetrics = {}) {
    const defaultBurn = {
        totalBurns: 0,
        microBurnCount: 0,
        microBurnRatio: 0,
        avgBurnDurationMinutes: 0,
        shortCyclesPerHour: 0
    };
    const bMetrics = { ...defaultBurn, ...burnMetrics };

    if (!windows || windows.length === 0) {
        return {
            validWindowsCount: 0,
            avgOvershoot: 0,
            maxOvershoot: 0,
            avgSteadyStateError: 0,
            oscillationScore: 0,
            avgRiseTimeMinutes: 0,
            ...bMetrics
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
        avgRiseTimeMinutes: riseTimeCount > 0 ? Math.round(totalRiseTime / riseTimeCount) : 0,
        ...bMetrics
    };
}

/**
 * Calculates physics-grounded PID preset values based on room floor area (m²) and heat emitter type.
 * 
 * Physics rationale:
 * - Small rooms (< 15 m², e.g., 10 m²): Low thermal mass & small air volume. High radiator gain
 *   causes rapid temperature overshoot. Lower Kp softens heat surge; elevated Kd brakes before exceeding setpoint.
 * - Medium rooms (15–28 m², e.g., 20 m²): Reference room. Standard baseline (10.00 / 5.00 / 15.00 for radiators,
 *   4.00 / 1.50 / 25.00 for underfloor screed).
 * - Large rooms (28–45 m², e.g., 35 m²): High thermal mass and air volume. Needs stronger Kp to open valve wider
 *   and deliver adequate thermal flux; lower Kd avoids premature throttling.
 * - Extra large / Open plan (> 45 m², e.g., 55 m²): Massive thermal inertia. Highest Kp and sustained Ki to prevent
 *   sluggish underheating; minimum Kd damping.
 * 
 * @param {Object} [params]
 * @param {number|null} [params.roomSizeSqm=20] - Floor area in m²
 * @param {string} [params.heatingType='RADIATOR'] - 'RADIATOR' | 'UNDERFLOOR'
 * @param {string} [params.underfloorMass='SCREED'] - 'SCREED' | 'DRY_SYSTEM'
 * @returns {Object} { kp, ki, kd, tier, roomSizeSqm, heatingType, underfloorMass }
 */
function calculatePidPreset({ roomSizeSqm = 20, heatingType = 'RADIATOR', underfloorMass = 'SCREED' } = {}) {
    const size = typeof roomSizeSqm === 'number' && !isNaN(roomSizeSqm) && roomSizeSqm > 0 ? roomSizeSqm : 20.0;
    const isUfh = heatingType === 'UNDERFLOOR';
    const isDrySystem = isUfh && underfloorMass === 'DRY_SYSTEM';

    let tier = 'MEDIUM';
    if (size < 15) {
        tier = 'SMALL';
    } else if (size <= 28) {
        tier = 'MEDIUM';
    } else if (size <= 45) {
        tier = 'LARGE';
    } else {
        tier = 'XL';
    }

    let kp, ki, kd;

    if (isUfh) {
        if (isDrySystem) {
            // Dry system: faster response than screed (45–90 min vs 2–4 h), intermediate inertia
            if (tier === 'SMALL') {
                kp = 5.00; ki = 2.00; kd = 24.00;
            } else if (tier === 'MEDIUM') {
                kp = 6.50; ki = 2.50; kd = 20.00;
            } else if (tier === 'LARGE') {
                kp = 8.00; ki = 3.00; kd = 16.00;
            } else {
                kp = 9.50; ki = 3.50; kd = 14.00;
            }
        } else {
            // Concrete slab / screed: high thermal capacitance, long lag (2–4 h)
            if (tier === 'SMALL') {
                kp = 3.00; ki = 1.00; kd = 32.00;
            } else if (tier === 'MEDIUM') {
                kp = 4.00; ki = 1.50; kd = 25.00;
            } else if (tier === 'LARGE') {
                kp = 4.80; ki = 1.80; kd = 22.00;
            } else {
                kp = 5.50; ki = 2.20; kd = 18.00;
            }
        }
    } else {
        // Conventional Radiators (convection + radiant, fast response)
        if (tier === 'SMALL') {
            kp = 7.50; ki = 4.00; kd = 20.00;
        } else if (tier === 'MEDIUM') {
            kp = 10.00; ki = 5.00; kd = 15.00;
        } else if (tier === 'LARGE') {
            kp = 13.50; ki = 6.00; kd = 12.00;
        } else {
            kp = 16.50; ki = 7.50; kd = 10.00;
        }
    }

    // Ensure within firmware boundaries
    kp = Math.min(30.0, Math.max(2.0, kp));
    ki = Math.min(20.0, Math.max(0.5, ki));
    kd = Math.min(40.0, Math.max(5.0, kd));

    return {
        kp,
        ki,
        kd,
        tier,
        roomSizeSqm: size,
        heatingType,
        underfloorMass
    };
}

/**
 * @param {Object} metrics - Zone transient metrics
 * @param {Object} currentGains - { kp, ki, kd }
 * @param {string} [heatingType='RADIATOR'] - 'RADIATOR' | 'UNDERFLOOR'
 * @param {Object} [options] - Optional context { roomSizeSqm, underfloorMass }
 * @returns {Object} Suggested gains, diagnosis, reason
 */
function derivePidSuggestions(metrics, currentGains, heatingType = 'RADIATOR', options = {}) {
    const isUfh = heatingType === 'UNDERFLOOR';
    const underfloorMass = options.underfloorMass || 'SCREED';
    const roomSizeSqm = options.roomSizeSqm !== undefined ? options.roomSizeSqm : null;

    const sizePreset = calculatePidPreset({
        roomSizeSqm: roomSizeSqm || 20,
        heatingType,
        underfloorMass
    });

    const curKp = Number(currentGains.kp || sizePreset.kp);
    const curKi = Number(currentGains.ki || sizePreset.ki);
    const curKd = Number(currentGains.kd || sizePreset.kd);

    let suggestedKp = curKp;
    let suggestedKi = curKi;
    let suggestedKd = curKd;
    let diagnosis = 'BALANCED';
    const reasons = [];

    const { avgOvershoot, maxOvershoot, avgSteadyStateError, oscillationScore, validWindowsCount } = metrics;
    const isMicroBurnProne = (metrics.microBurnRatio >= 0.30 && metrics.microBurnCount >= 2) ||
                             (metrics.shortCyclesPerHour >= 1.5 && metrics.microBurnCount >= 3);

    if (validWindowsCount < 2) {
        return {
            currentKp: curKp,
            currentKi: curKi,
            currentKd: curKd,
            suggestedKp: sizePreset.kp,
            suggestedKi: sizePreset.ki,
            suggestedKd: sizePreset.kd,
            diagnosis: 'INSUFFICIENT_DATA',
            reason: roomSizeSqm 
                ? `Insufficient heating transient history. Recommended cold-start preset based on ${roomSizeSqm} m² (${sizePreset.tier}) ${heatingType.toLowerCase()} heating.`
                : 'Insufficient transient measurement windows. Continue normal heating to collect tuning data, or configure room size for instant preset.',
            confidence: 'LOW',
            heatingType,
            sizePreset
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
            if (isMicroBurnProne) {
                reasons.push(`Coupled with frequent short-cycling (${metrics.microBurnCount} micro-burns, ${Math.round(metrics.microBurnRatio * 100)}% ratio).`);
            }
        } else if (isMicroBurnProne) {
            diagnosis = 'MICRO_BURNING';
            suggestedKp = Math.max(2.0, Math.min(4.0, Math.round(curKp * 0.75 * 10) / 10));
            suggestedKi = Math.max(0.8, Math.min(1.8, Math.round(curKi * 0.70 * 10) / 10));
            suggestedKd = Math.min(35.0, Math.max(20.0, Math.round(curKd * 1.30 * 10) / 10));
            reasons.push(`Underfloor heating triggers frequent short-cycling (${metrics.microBurnCount} burns < 10m, ${Math.round(metrics.microBurnRatio * 100)}% of burns). Reducing Kp and Ki to prevent rapid demand pulsing, and boosting Kd derivative braking.`);
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
            if (isMicroBurnProne) {
                reasons.push(`Also causing frequent short-cycling (${metrics.microBurnCount} micro-burns, ${Math.round(metrics.microBurnRatio * 100)}% ratio).`);
            }
        }
        // 2. Check for Short-Cycling / Micro-Burning
        else if (isMicroBurnProne) {
            diagnosis = 'MICRO_BURNING';
            suggestedKp = Math.max(3.0, Math.round(curKp * 0.80 * 10) / 10);
            suggestedKi = Math.max(1.5, Math.round(curKi * 0.75 * 10) / 10);
            suggestedKd = Math.min(35.0, Math.round(curKd * 1.25 * 10) / 10);
            reasons.push(`Room causes frequent boiler micro-burns (${metrics.microBurnCount} burns < 10m, ${Math.round(metrics.microBurnRatio * 100)}% of burns, avg ${metrics.avgBurnDurationMinutes || 0}m). Reducing Kp and Ki to prevent bursty demand on small temperature dips, and boosting Kd damping to steady the valve.`);
        }
        // 3. Check for Thermal Overshoot
        else if (maxOvershoot >= 0.50 || avgOvershoot >= 0.35) {
            diagnosis = 'OVERSHOOT';
            suggestedKp = Math.max(3.0, Math.round(curKp * 0.85 * 10) / 10);
            suggestedKd = Math.min(35.0, Math.round(curKd * 1.25 * 10) / 10);
            reasons.push(`Room overshoots target temperature by up to ${maxOvershoot.toFixed(2)}°C. Reducing Kp to soften initial surge and boosting Kd dynamic braking.`);
        }
        // 4. Check for Steady-State Droop (Under-heating)
        else if (avgSteadyStateError >= 0.30) {
            diagnosis = 'DROOP';
            suggestedKi = Math.min(18.0, Math.round(curKi * 1.35 * 10) / 10);
            reasons.push(`Room consistently settles ${avgSteadyStateError.toFixed(2)}°C below setpoint. Increasing Ki integral gain to eliminate steady-state shortfall.`);
        }
        // 5. Check for Sluggish Rise
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
        `SELECT id, name, heating_circuit, heating_type, underfloor_mass, field_6080, field_60a0, field_60c0, room_size_sqm 
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

    // 3. Query circuit measurements to track active heating circuit intervals and burn events
    const circuitIntervalsByCircuit = new Map();
    const burnEventsByCircuit = new Map();
    let totalHomeBurns = 0;
    let totalHomeMicroBurns = 0;

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

            const extractedBurns = extractBurnEvents(circuitRows);
            for (const b of extractedBurns) {
                totalHomeBurns++;
                if (b.isMicroBurn) totalHomeMicroBurns++;
                const cNum = b.circuitNumber || 1;
                if (!burnEventsByCircuit.has(cNum)) burnEventsByCircuit.set(cNum, []);
                burnEventsByCircuit.get(cNum).push(b);
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
        const circuitBurns = burnEventsByCircuit.get(cNum) || [];
        const heatingType = zone.heating_type || 'RADIATOR';
        const underfloorMass = zone.underfloor_mass || 'SCREED';

        const maxWinMinutes = heatingType === 'UNDERFLOOR' ? 240 : 120;
        const rows = zoneMap.get(zId) || [];
        const windows = extractTransientWindows(rows, maxWinMinutes, { circuitIntervals });
        totalWindows += windows.length;

        const burnMetrics = correlateZoneBurns(rows, circuitBurns, hours);
        const metrics = evaluateZoneTransients(windows, burnMetrics);
        const roomSizeSqm = zone.room_size_sqm !== null && zone.room_size_sqm !== undefined ? parseFloat(zone.room_size_sqm) : null;
        const defaultKp = heatingType === 'UNDERFLOOR' ? 4.00 : 10.00;
        const defaultKi = heatingType === 'UNDERFLOOR' ? 1.50 : 5.00;
        const defaultKd = heatingType === 'UNDERFLOOR' ? 25.00 : 15.00;

        const currentGains = {
            kp: zone.field_6080 !== null ? parseFloat(zone.field_6080) : defaultKp,
            ki: zone.field_60a0 !== null ? parseFloat(zone.field_60a0) : defaultKi,
            kd: zone.field_60c0 !== null ? parseFloat(zone.field_60c0) : defaultKd
        };

        const sizePreset = calculatePidPreset({
            roomSizeSqm: roomSizeSqm || 20,
            heatingType,
            underfloorMass
        });

        const suggestions = derivePidSuggestions(metrics, currentGains, heatingType, {
            roomSizeSqm,
            underfloorMass
        });

        zoneResults.push({
            zoneId: zId,
            zoneName: zone.name,
            heatingType,
            underfloorMass,
            roomSize: roomSizeSqm,
            sizePreset,
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
        homeMicroBurnCount: totalHomeMicroBurns,
        homeMicroBurnRatio: totalHomeBurns > 0 ? Math.round((totalHomeMicroBurns / totalHomeBurns) * 100) / 100 : 0,
        hydraulicBaseline,
        hydraulicRecommendedFirst: hydraulicBaseline === null,
        zones: zoneResults,
        hasSufficientData: hasData
    };
}

module.exports = {
    extractTransientWindows,
    evaluateZoneTransients,
    calculatePidPreset,
    derivePidSuggestions,
    extractBurnEvents,
    correlateZoneBurns,
    analyzePidTuning
};
