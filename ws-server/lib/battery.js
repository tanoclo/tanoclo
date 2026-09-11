/**
 * @file lib/battery.js
 * @brief Battery voltage, remaining capacity estimation, and state transition guards.
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════
// Discharge Curves
//
// Hardware profiles:
// - VA (Radiator Valve Actuator): 2 x AA cells, DC motor load (~100-300mA),
//   motor stall / cutoff at ~2100mV (1.05V/cell).
// - RU (Room Unit / Thermostat): 3 x AAA cells, low-drain sensor and
//   e-ink/LED display, firmware cutoff at 2400mV (0.80V/cell).
// ═══════════════════════════════════════════════════════════════════

// VA = 2 x AA cells (DC motor actuator load)
const VA_ALKALINE_CURVE = [
    [3000, 100.0],
    [2800, 80.0],
    [2640, 60.0],
    [2500, 40.0],
    [2400, 25.0],
    [2300, 12.0],
    [2200, 5.0],
    [2100, 0.0]
];

const VA_NIMH_CURVE = [
    [2700, 100.0],
    [2560, 85.0],
    [2480, 60.0],
    [2420, 35.0],
    [2360, 20.0],
    [2300, 10.0],
    [2200, 5.0],
    [2100, 0.0]
];

// RU = 3 x AAA cells (Low-drain sensor and display)
const RU_ALKALINE_CURVE = [
    [4500, 100.0],
    [4200, 80.0],
    [3900, 60.0],
    [3660, 40.0],
    [3480, 25.0],
    [3300, 12.0],
    [3000, 5.0],
    [2850, 0.0]
];

const RU_NIMH_CURVE = [
    [4050, 100.0],
    [3840, 85.0],
    [3720, 60.0],
    [3630, 35.0],
    [3540, 20.0],
    [3450, 10.0],
    [3300, 5.0],
    [3000, 0.0]
];

/** State ranking for downgrade/upgrade comparison */
const STATE_RANK = {
    'NORMAL': 3,
    'LOW': 2,
    'CRITICAL': 1,
    'DEPLETED': 1
};

/** Default number of consecutive reports needed to confirm a drop or state downgrade */
const DEFAULT_REQUIRED_REPORTS = 5;

/** @type {Map<string, {confirmedMv: number, confirmedPercent: number|null, confirmedState: string, dropCount: number, downgradeCount: number, pendingState: string|null, pendingPercent: number|null}>} */
const _guardState = new Map();

function inferCellsFromMv(mv) {
    if (mv <= 0) return null;
    if (mv >= 3600) return 3; // Typically RU (3 cells x 1.5v = 4.5v max)
    if (mv >= 1800) return 2; // Typically VA (2 cells x 1.5v = 3.0v max)
    return 1;
}

function interpPiecewise(x, curve) {
    // curve is sorted descending by x
    if (x >= curve[0][0]) return curve[0][1];
    if (x <= curve[curve.length - 1][0]) return curve[curve.length - 1][1];

    for (let i = 0; i < curve.length - 1; i++) {
        const x1 = curve[i][0];
        const y1 = curve[i][1];
        const x2 = curve[i + 1][0];
        const y2 = curve[i + 1][1];

        // x is between x1 and x2 (where x1 > x2)
        if (x <= x1 && x > x2) {
            const fraction = (x - x2) / (x1 - x2);
            return y2 + fraction * (y1 - y2);
        }
    }
    return 0.0;
}

function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

/**
 * Determine the cell count for a device (used to compute drop threshold).
 * @param {string|null} deviceId
 * @param {number} mv
 * @returns {number}
 */
function _cellsFor(deviceId, mv) {
    if (deviceId) {
        const prefix = deviceId.substring(0, 2).toUpperCase();
        if (prefix === 'VA') return 2;
        if (prefix === 'RU') return 3;
    }
    return inferCellsFromMv(mv) || 2;
}

/**
 * Classify battery percentage into state.
 * @param {number|null} percent 0-100 percentage
 * @returns {'NORMAL'|'LOW'|'CRITICAL'}
 */
function classifyBatteryState(percent) {
    if (percent == null) return 'NORMAL';
    if (percent > 30) return 'NORMAL';
    if (percent > 5) return 'LOW';
    return 'CRITICAL';
}

/**
 * Calculate battery percentage based on voltage, device model, and chemistry.
 * @param {number} mv Total battery millivolts
 * @param {string} [deviceId] Full device serial (e.g. VA01...) or short serial
 * @param {string} [chemistry='alkaline'] 'alkaline' or 'nimh'
 * @returns {number|null} 0-100 percentage, or null if unknown
 */
function getBatteryPercent(mv, deviceId, chemistry) {
    if (mv == null || mv <= 0) return null;

    chemistry = (chemistry || 'alkaline').toLowerCase();
    const isNimh = chemistry === 'nimh';

    let prefix = null;
    if (deviceId) {
        prefix = String(deviceId).substring(0, 2).toUpperCase();
    }

    let curve;
    if (prefix === 'VA') {
        curve = isNimh ? VA_NIMH_CURVE : VA_ALKALINE_CURVE;
    } else if (prefix === 'RU') {
        curve = isNimh ? RU_NIMH_CURVE : RU_ALKALINE_CURVE;
    } else {
        const cells = inferCellsFromMv(mv);
        if (cells === 3) {
            curve = isNimh ? RU_NIMH_CURVE : RU_ALKALINE_CURVE;
        } else {
            curve = isNimh ? VA_NIMH_CURVE : VA_ALKALINE_CURVE;
        }
    }

    const pct = interpPiecewise(mv, curve);
    return Math.round(clamp(pct, 0, 100));
}

/**
 * Process a battery reading with transient voltage drop filter and state downgrade guard.
 *
 * Rules:
 * 1. Transient voltage drop (>= cells * 50 mV) or state downgrade (NORMAL -> LOW,
 *    NORMAL -> CRITICAL, LOW -> CRITICAL): suppressed until persisting for
 *    requiredReports consecutive reports.
 * 2. State upgrade / battery replacement: accepted immediately on first report.
 * 3. Changes within the same state: accepted smoothly.
 *
 * @param {string} deviceId   Device serial or short serial
 * @param {number} rawMv      Raw millivolts reported by device
 * @param {string} [chemistry='alkaline'] Battery chemistry
 * @param {Object} [options]
 * @param {number} [options.requiredReports=5] Consecutive reports needed
 * @param {string} [options.fullSerial] Full serial for prefix matching
 * @returns {{ mv: number, percent: number|null, batteryState: string, guarded: boolean, guardReason: string|null }}
 */
function processBatteryReading(deviceId, rawMv, chemistry, options = {}) {
    if (rawMv == null || rawMv <= 0) {
        return {
            mv: rawMv,
            percent: null,
            batteryState: 'NORMAL',
            guarded: false,
            guardReason: null
        };
    }

    const key = String(deviceId);
    const fullSerial = options.fullSerial || options.deviceId || key;
    const requiredReports = options.requiredReports ?? DEFAULT_REQUIRED_REPORTS;

    let state = _guardState.get(key);
    if (!state) {
        const initialPercent = getBatteryPercent(rawMv, fullSerial, chemistry);
        const initialState = classifyBatteryState(initialPercent);
        state = {
            confirmedMv: rawMv,
            confirmedPercent: initialPercent,
            confirmedState: initialState,
            dropCount: 0,
            downgradeCount: 0,
            pendingState: null,
            pendingPercent: null
        };
        _guardState.set(key, state);
        return {
            mv: rawMv,
            percent: initialPercent,
            batteryState: initialState,
            guarded: false,
            guardReason: null
        };
    }

    const cells = _cellsFor(fullSerial, rawMv);
    const dropThreshold = cells * 50; // mV
    const mvDrop = state.confirmedMv - rawMv;

    // Candidate percentage and candidate state
    const candidatePercent = getBatteryPercent(rawMv, fullSerial, chemistry);
    const candidateState = classifyBatteryState(candidatePercent);

    const confirmedRank = STATE_RANK[state.confirmedState] || 3;
    const candidateRank = STATE_RANK[candidateState] || 3;

    // 1. State upgrade or significant voltage jump (battery replacement / recovery)
    if (candidateRank > confirmedRank || (candidatePercent !== null && state.confirmedPercent !== null && candidatePercent > state.confirmedPercent + 10)) {
        state.confirmedMv = rawMv;
        state.confirmedPercent = candidatePercent;
        state.confirmedState = candidateState;
        state.downgradeCount = 0;
        state.pendingState = null;
        state.pendingPercent = null;
        return {
            mv: rawMv,
            percent: candidatePercent,
            batteryState: candidateState,
            guarded: false,
            guardReason: null
        };
    }

    const isLargeDrop = mvDrop >= dropThreshold;
    const isDowngrade = candidateRank < confirmedRank;

    // 2. Significant voltage drop or state downgrade requires multiple reports
    if (isLargeDrop || isDowngrade) {
        state.downgradeCount++;
        state.pendingState = candidateState;
        state.pendingPercent = candidatePercent;

        if (state.downgradeCount < requiredReports) {
            const reason = isLargeDrop
                ? `transient voltage drop (${mvDrop}mV >= ${dropThreshold}mV, report ${state.downgradeCount}/${requiredReports})`
                : `pending state downgrade ${state.confirmedState} -> ${candidateState} (report ${state.downgradeCount}/${requiredReports})`;
            return {
                mv: state.confirmedMv,
                percent: state.confirmedPercent,
                batteryState: state.confirmedState,
                guarded: true,
                guardReason: reason
            };
        }

        // Confirmed after requiredReports consecutive readings
        state.confirmedMv = rawMv;
        state.confirmedPercent = candidatePercent;
        state.confirmedState = candidateState;
        state.downgradeCount = 0;
        state.pendingState = null;
        state.pendingPercent = null;
        return {
            mv: rawMv,
            percent: candidatePercent,
            batteryState: candidateState,
            guarded: false,
            guardReason: null
        };
    }

    // 3. Candidate is in the same state without large drop (normal gradual drain)
    state.downgradeCount = 0;
    state.pendingState = null;
    state.pendingPercent = null;
    state.confirmedMv = rawMv;
    state.confirmedPercent = candidatePercent;
    state.confirmedState = candidateState;

    return {
        mv: rawMv,
        percent: candidatePercent,
        batteryState: candidateState,
        guarded: false,
        guardReason: null
    };
}

/**
 * Legacy wrapper: Filter a raw battery millivolt reading through the guard.
 *
 * @param {string} deviceId  Short or full serial (map key)
 * @param {number} rawMv     Raw battery millivolts from the device
 * @param {number} [requiredReports=5]  Consecutive readings needed
 * @returns {number} Effective (possibly guarded) millivolts
 */
function filterBatteryMv(deviceId, rawMv, requiredReports) {
    if (rawMv == null || rawMv <= 0) return rawMv;
    const res = processBatteryReading(deviceId, rawMv, 'alkaline', { requiredReports });
    return res.mv;
}

/**
 * Seed the guard state from persistent storage (e.g. database latest readings on startup).
 * @param {Array<Object>|Map<string, Object>|Object} data
 */
function seedBatteryGuardState(data) {
    if (!data) return;

    const processRow = (row) => {
        const serial = row.device_serial || row.serial_no || row.serial;
        const mv = Number(row.field_0162 || row.mv || row.battery_mv);
        if (serial && mv > 0) {
            const rawState = row.battery_state;
            const normalizedState = (rawState === 'DEPLETED' || rawState === 'CRITICAL')
                ? 'CRITICAL'
                : (rawState === 'LOW' ? 'LOW' : 'NORMAL');
            const percent = row.battery_percent != null
                ? Number(row.battery_percent)
                : getBatteryPercent(mv, serial, row.battery_type || 'alkaline');

            _guardState.set(String(serial), {
                confirmedMv: mv,
                confirmedPercent: percent,
                confirmedState: normalizedState,
                dropCount: 0,
                downgradeCount: 0,
                pendingState: null,
                pendingPercent: null
            });
        }
    };

    if (Array.isArray(data)) {
        for (const row of data) processRow(row);
    } else if (data instanceof Map) {
        for (const [serial, val] of data.entries()) {
            if (typeof val === 'object' && val !== null) {
                processRow({ serial, ...val });
            } else {
                processRow({ serial, mv: val });
            }
        }
    } else if (typeof data === 'object') {
        for (const [serial, val] of Object.entries(data)) {
            if (typeof val === 'object' && val !== null) {
                processRow({ serial, ...val });
            } else {
                processRow({ serial, mv: val });
            }
        }
    }
}

/**
 * Reset guard state for a specific device or all devices.
 * @param {string} [deviceId]  If omitted, clears all state
 */
function resetBatteryGuardState(deviceId) {
    if (deviceId) _guardState.delete(String(deviceId));
    else _guardState.clear();
}

module.exports = {
    VA_ALKALINE_CURVE,
    VA_NIMH_CURVE,
    RU_ALKALINE_CURVE,
    RU_NIMH_CURVE,
    STATE_RANK,
    DEFAULT_REQUIRED_REPORTS,
    getBatteryPercent,
    classifyBatteryState,
    processBatteryReading,
    inferCellsFromMv,
    filterBatteryMv,
    seedBatteryGuardState,
    resetBatteryGuardState
};