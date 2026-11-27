/**
 * @file lib/boiler-cycle-tracker.js
 * @brief Tracks and logs discrete boiler ignition cycles (start, end, duration, temperatures, modulation).
 */

'use strict';

const { getLogger } = require('./logger');
const log = getLogger('boiler-cycle');

let _db = null;
const _openCycles = new Map();

function getDbPool() {
    if (_db && typeof _db.getPool === 'function') return _db.getPool();
    try {
        const db = require('./db');
        return db.getPool();
    } catch (_) {
        return null;
    }
}

function init(db) {
    _db = db || require('./db');
    log('info', 'Boiler Cycle Tracker initialized');
}

function parseTimestampMs(ts) {
    if (!ts) return Date.now();
    if (ts instanceof Date) return ts.getTime();
    const str = String(ts).trim();
    const iso = str.includes('T') ? str : str.replace(' ', 'T');
    return new Date(iso.endsWith('Z') ? iso : iso + 'Z').getTime();
}

/**
 * Ingests a new circuit measurement and detects flame start/stop transitions.
 * 
 * @param {number|string} homeId
 * @param {number} circuitNumber
 * @param {Object} m Measurement record with circuit and HVAC fields
 */
async function onMeasurement(homeId, circuitNumber = 1, m = {}) {
    if (!homeId) return;
    const pool = getDbPool();
    if (!pool) return;

    const key = `${homeId}:${circuitNumber}`;
    const flameOn = Boolean(m.field_0457) || (m.field_0452 !== null && m.field_0452 !== undefined && Number(m.field_0452) > 0);
    const tsStr = m.timestamp || new Date().toISOString().slice(0, 19).replace('T', ' ');
    const tsMs = parseTimestampMs(tsStr);

    const flowTemp = m.field_044c != null ? parseFloat(m.field_044c) : null;
    const returnTemp = m.field_044d != null ? parseFloat(m.field_044d) : null;
    const modulation = m.field_0452 != null ? parseInt(m.field_0452, 10) : 0;
    const dhwFlow = m.field_045e != null ? parseFloat(m.field_045e) : 0;
    const demand = m.field_4080 != null ? parseInt(m.field_4080, 10) : 0;
    const mode = m.field_2090 != null ? parseInt(m.field_2090, 10) : 1;

    let cycle = _openCycles.get(key);

    if (flameOn) {
        if (!cycle) {
            // New ignition cycle detected
            let cycleType = 'CH';
            if (dhwFlow > 0) {
                cycleType = 'DHW';
            } else if (demand === 0 || mode === 0) {
                cycleType = 'KEEP_WARM';
            }

            cycle = {
                homeId: parseInt(homeId, 10),
                circuitNumber: parseInt(circuitNumber, 10),
                startTime: tsStr,
                startTsMs: tsMs,
                cycleType,
                startFlowTemp: flowTemp,
                maxFlowTemp: flowTemp,
                startReturnTemp: returnTemp,
                maxReturnTemp: returnTemp,
                modulationSum: modulation,
                modulationCount: 1,
                maxModulation: modulation,
                burnerStarts: m.field_0463 != null ? parseInt(m.field_0463, 10) : null,
                chHours: m.field_0467 != null ? parseInt(m.field_0467, 10) : null,
                dhwHours: m.field_0468 != null ? parseInt(m.field_0468, 10) : null
            };
            _openCycles.set(key, cycle);
            log('debug', `Boiler cycle started for home ${homeId} (circuit ${circuitNumber}, type=${cycleType})`);
        } else {
            // Cycle in progress - update extrema
            if (flowTemp !== null) {
                cycle.maxFlowTemp = cycle.maxFlowTemp !== null ? Math.max(cycle.maxFlowTemp, flowTemp) : flowTemp;
            }
            if (returnTemp !== null) {
                cycle.maxReturnTemp = cycle.maxReturnTemp !== null ? Math.max(cycle.maxReturnTemp, returnTemp) : returnTemp;
            }
            cycle.modulationSum += modulation;
            cycle.modulationCount++;
            cycle.maxModulation = Math.max(cycle.maxModulation, modulation);

            // If active DHW flow observed during keep-warm or CH, promote to DHW
            if (dhwFlow > 0 && cycle.cycleType !== 'DHW') {
                cycle.cycleType = 'DHW';
            }
        }
    } else if (cycle) {
        // Flame extinguished - close cycle
        const durationSec = Math.max(1, Math.round((tsMs - cycle.startTsMs) / 1000));
        const avgMod = cycle.modulationCount > 0 ? Math.round((cycle.modulationSum / cycle.modulationCount) * 10) / 10 : 0;

        // Skip micro-glitches under 5 seconds to reduce noise
        if (durationSec >= 5) {
            try {
                await pool.execute(
                    `INSERT INTO boiler_cycles (
                        home_id, circuit_number, start_time, end_time, duration_seconds,
                        cycle_type, start_flow_temp, max_flow_temp, end_flow_temp,
                        start_return_temp, max_return_temp, end_return_temp,
                        avg_modulation, max_modulation,
                        burner_starts_counter, ch_hours_counter, dhw_hours_counter
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        cycle.homeId,
                        cycle.circuitNumber,
                        cycle.startTime,
                        tsStr,
                        durationSec,
                        cycle.cycleType,
                        cycle.startFlowTemp,
                        cycle.maxFlowTemp,
                        flowTemp,
                        cycle.startReturnTemp,
                        cycle.maxReturnTemp,
                        returnTemp,
                        avgMod,
                        cycle.maxModulation,
                        cycle.burnerStarts,
                        cycle.chHours,
                        cycle.dhwHours
                    ]
                );
                log('info', `Boiler cycle logged for home ${homeId}: ${cycle.cycleType} ${durationSec}s, maxFlow=${cycle.maxFlowTemp}°C, avgMod=${avgMod}%`);
            } catch (err) {
                log('warn', `Failed to log boiler cycle for home ${homeId}: ${err.message}`);
            }
        }
        _openCycles.delete(key);
    }
}

/**
 * Returns currently active open cycle for a home/circuit, or null.
 */
function getActiveCycle(homeId, circuitNumber = 1) {
    const key = `${homeId}:${circuitNumber}`;
    return _openCycles.get(key) || null;
}

module.exports = {
    init,
    onMeasurement,
    getActiveCycle
};
