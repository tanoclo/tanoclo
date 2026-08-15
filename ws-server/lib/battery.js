/**
 * @file lib/battery.js
 * @brief Battery voltage and remaining capacity estimation helpers.
 */

'use strict';

/**
 * Battery estimation logic
 */

const ALKALINE_CURVE = [
    [1.50, 100.0],
    [1.45, 92.0],
    [1.40, 82.0],
    [1.35, 70.0],
    [1.30, 55.0],
    [1.25, 38.0],
    [1.20, 20.0],
    [1.15, 10.0],
    [1.10, 4.0],
    [1.05, 0.0]
];

const NIMH_CURVE = [
    [1.35, 100.0],
    [1.30, 80.0],
    [1.28, 50.0],
    [1.27, 20.0],
    [1.26, 10.0],
    [1.25, 5.0],
    [1.20, 0.0]
];

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
 * Calculate battery percentage based on voltage and chemistry.
 * @param {number} mv Total battery millivolts
 * @param {string} deviceId Full device serial (e.g. VA01...)
 * @param {string} chemistry 'alkaline' or 'nimh'
 * @returns {number|null} 0-100 percentage, or null if unknown
 */
function getBatteryPercent(mv, deviceId, chemistry) {
    if (mv == null || mv <= 0) return null;

    let cells = null;
    if (deviceId) {
        const prefix = deviceId.substring(0, 2).toUpperCase();
        if (prefix === 'VA') cells = 2;
        else if (prefix === 'RU') cells = 3;
    }

    if (!cells) {
        cells = inferCellsFromMv(mv);
    }
    if (!cells) return null;

    const cellV = (mv / 1000.0) / cells;

    chemistry = (chemistry || 'alkaline').toLowerCase();
    const curve = (chemistry === 'nimh') ? NIMH_CURVE : ALKALINE_CURVE;

    let pct = interpPiecewise(cellV, curve);
    return Math.round(clamp(pct, 0, 100));
}

// ═══════════════════════════════════════════════════════════════════
// Battery voltage drop guard
//
// Transient voltage drops (motor load, RF spikes) can cause a single
// report to dip significantly before recovering.  This guard requires
// a large drop to persist for REQUIRED_REPORTS consecutive reports
// before it is accepted as genuine.
// ═══════════════════════════════════════════════════════════════════

/** @type {Map<string, {confirmedMv: number, dropCount: number}>} */
const _guardState = new Map();

/** Default number of consecutive low reports needed to accept a significant drop */
const DEFAULT_REQUIRED_REPORTS = 5;

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
 * Filter a raw battery millivolt reading through the drop guard.
 *
 * - Voltage increase or minor change: accepted immediately.
 * - Significant drop (>= cells * 100 mV): suppressed until it
 *   persists for `requiredReports` consecutive readings.
 *
 * @param {string} deviceId  Short or full serial (map key)
 * @param {number} rawMv     Raw battery millivolts from the device
 * @param {number} [requiredReports=5]  Consecutive low readings needed
 * @returns {number} Effective (possibly guarded) millivolts
 */
function filterBatteryMv(deviceId, rawMv, requiredReports) {
    if (rawMv == null || rawMv <= 0) return rawMv;
    if (requiredReports == null) requiredReports = DEFAULT_REQUIRED_REPORTS;

    const key = String(deviceId);
    let state = _guardState.get(key);

    // First reading for this device — accept as-is
    if (!state) {
        _guardState.set(key, { confirmedMv: rawMv, dropCount: 0 });
        return rawMv;
    }

    const cells = _cellsFor(deviceId, rawMv);
    const dropThreshold = cells * 100; // mV
    const drop = state.confirmedMv - rawMv;

    if (drop < dropThreshold) {
        // Voltage increased, stayed level, or only dropped a small amount
        // → accept immediately (covers battery replacement & gradual drain)
        state.confirmedMv = rawMv;
        state.dropCount = 0;
        return rawMv;
    }

    // Significant drop detected
    state.dropCount++;

    if (state.dropCount >= requiredReports) {
        // Drop has persisted long enough — accept it as genuine
        state.confirmedMv = rawMv;
        state.dropCount = 0;
        return rawMv;
    }

    // Suppress the drop — return last confirmed voltage
    return state.confirmedMv;
}

/**
 * Reset guard state for a specific device or all devices.
 * Useful for testing or when a device is re-paired.
 * @param {string} [deviceId]  If omitted, clears all state
 */
function resetBatteryGuardState(deviceId) {
    if (deviceId) _guardState.delete(String(deviceId));
    else _guardState.clear();
}

module.exports = {
    getBatteryPercent,
    inferCellsFromMv,
    filterBatteryMv,
    resetBatteryGuardState
};
