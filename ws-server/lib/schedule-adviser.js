/**
 * @file lib/schedule-adviser.js
 * @brief Advisory engine for heating schedules based on room heat emitter physics.
 */

'use strict';

/**
 * Evaluates schedule blocks for a zone and provides actionable advice.
 * 
 * @param {Array<Object>} blocks - List of schedule blocks [{ dayType, start, end, setting }]
 * @param {Object} options - { heatingType: 'RADIATOR' | 'UNDERFLOOR', underfloorMass: 'SCREED' | 'DRY_SYSTEM', earlyStartEnabled: boolean }
 * @returns {Array<Object>} List of advisories [{ id, type, severity, message, suggestedValue }]
 */
function evaluateScheduleAdvice(blocks, options = {}) {
    if (!Array.isArray(blocks) || blocks.length === 0) return [];

    const heatingType = options.heatingType || 'RADIATOR';
    const underfloorMass = options.underfloorMass || 'SCREED';
    const earlyStartEnabled = Boolean(options.earlyStartEnabled);

    const advisories = [];
    const temps = [];

    for (const b of blocks) {
        if (b.setting && b.setting.power === 'ON' && b.setting.temperature && b.setting.temperature.celsius !== null) {
            temps.push(Number(b.setting.temperature.celsius));
        }
    }

    if (temps.length === 0) return advisories;

    const maxTemp = Math.max(...temps);
    const minTemp = Math.min(...temps);
    const setbackDrop = Math.round((maxTemp - minTemp) * 10) / 10;

    if (heatingType === 'UNDERFLOOR') {
        // 1. Deep setback check
        if (setbackDrop > 2.0) {
            advisories.push({
                id: 'ufh_deep_setback',
                type: 'DEEP_SETBACK',
                severity: 'WARNING',
                message: `Underfloor heating temperature drop is ${setbackDrop}°C between comfort and setback. Heavy floor slabs take 2–4 hours to recover; setback drops > 1.5°C cause prolonged cold mornings and boiler cycling.`,
                suggestedSetbackDrop: 1.5
            });
        }

        // 2. Early start check
        if (!earlyStartEnabled && blocks.length > 1) {
            const inertiaText = underfloorMass === 'DRY_SYSTEM' ? '45–75 minutes' : '2–3 hours';
            advisories.push({
                id: 'ufh_early_start_recommended',
                type: 'EARLY_START_ADVICE',
                severity: 'INFO',
                message: `Underfloor heating has significant thermal latency (${inertiaText} warm-up time). Enable Early Start to automatically preheat before your scheduled waking time.`
            });
        }

        // 3. Evening thermal flywheel advice
        advisories.push({
            id: 'ufh_thermal_inertia_evening',
            type: 'EVENING_COASTING',
            severity: 'INFO',
            message: 'Your floor slab radiates stored heat for 1–2 hours after heating stops. Setting night setback 1 hour before bedtime saves energy without comfort loss.'
        });
    }

    return advisories;
}

module.exports = {
    evaluateScheduleAdvice
};
