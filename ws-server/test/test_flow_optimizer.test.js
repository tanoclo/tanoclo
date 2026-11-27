/**
 * @file test/test_flow_optimizer.test.js
 * @brief Unit tests for flow temperature optimization (flow shaping only, no on/off gating).
 */

'use strict';

require('./test_config');
const { computeOptimalFlowTemperature } = require('../lib/flow-optimizer');

const base = { outsideTemp: 0, minFlow: 30, maxFlowLimit: 70, maxZoneError: 0.5, circuitDemandPct: 40 };

describe('Flow Temperature Optimizer', () => {
    test('holds the current ceiling when nothing calls for heat (never drops to 0)', () => {
        const r = computeOptimalFlowTemperature({ ...base, currentMaxFlow: 58, maxZoneError: 0, circuitDemandPct: 0 });
        expect(r.changed).toBe(false);
        expect(r.targetFlow).toBe(58);
        expect(r.reason).toBe('idle_hold');
    });

    test('follows the weather curve: 0°C outdoor -> 30 + 2/3 * 40', () => {
        const r = computeOptimalFlowTemperature({ ...base, currentMaxFlow: 57, guards: { rateLimitEnabled: false } });
        expect(r.baseFlow).toBeCloseTo(56.7, 1);
        expect(r.reason).toBe('weather_curve');
    });

    test('deadband: changes below 2°C are not written', () => {
        // target 57 (curve) vs current 56
        const r = computeOptimalFlowTemperature({ ...base, currentMaxFlow: 56 });
        expect(r.changed).toBe(false);
        expect(r.targetFlow).toBe(56);
    });

    test('rate limit steps at most rateLimitMaxStep per evaluation', () => {
        const r = computeOptimalFlowTemperature({ ...base, currentMaxFlow: 40 });
        expect(r.changed).toBe(true);
        expect(r.targetFlow).toBe(43);
    });

    test('rate limit disabled jumps to target', () => {
        const r = computeOptimalFlowTemperature({ ...base, currentMaxFlow: 40, guards: { rateLimitEnabled: false } });
        expect(r.targetFlow).toBe(57);
    });

    test('cold recovery boosts by 5°C on a deficit >= 2°C', () => {
        const r = computeOptimalFlowTemperature({ ...base, currentMaxFlow: 40, maxZoneError: 2.5, guards: { rateLimitEnabled: false } });
        expect(r.reason).toBe('cold_recovery');
        expect(r.targetFlow).toBe(62);
    });

    test('near setpoint lowers flow by 3°C', () => {
        const r = computeOptimalFlowTemperature({ ...base, currentMaxFlow: 40, maxZoneError: 0.1, guards: { rateLimitEnabled: false, radiatorFloorEnabled: false } });
        expect(r.reason).toBe('near_setpoint');
        expect(r.targetFlow).toBe(54);
    });

    test('forecast drop pre-boosts by 2°C', () => {
        const r = computeOptimalFlowTemperature({ ...base, currentMaxFlow: 40, forecastHourly: [0, -1, -3], guards: { rateLimitEnabled: false } });
        expect(r.forecastAdj).toBe(2);
        expect(r.targetFlow).toBe(59);
    });

    test('radiator floor raises mild-weather flow for radiator-only demand', () => {
        const mild = { ...base, outsideTemp: 15, currentMaxFlow: 30, activeDemandType: 'ONLY_RADIATOR', guards: { rateLimitEnabled: false } };
        expect(computeOptimalFlowTemperature(mild).targetFlow).toBe(48);
        expect(computeOptimalFlowTemperature({ ...mild, guards: { rateLimitEnabled: false, radiatorFloorEnabled: false } }).targetFlow).toBe(37);
    });

    test('underfloor-only demand is clamped to 45°C and gets no radiator floor', () => {
        const r = computeOptimalFlowTemperature({ ...base, outsideTemp: -10, currentMaxFlow: 30, activeDemandType: 'ONLY_UNDERFLOOR', guards: { rateLimitEnabled: false } });
        expect(r.targetFlow).toBe(45);
    });

    test('result is always within [minFlow, maxFlowLimit] and never 0', () => {
        for (const outsideTemp of [-20, 0, 25]) {
            for (const maxZoneError of [0.1, 3]) {
                const r = computeOptimalFlowTemperature({ ...base, outsideTemp, maxZoneError, currentMaxFlow: 0, guards: { rateLimitEnabled: false } });
                expect(r.targetFlow).toBeGreaterThanOrEqual(30);
                expect(r.targetFlow).toBeLessThanOrEqual(70);
            }
        }
    });

    test('low-load cap limits the ceiling to 48°C at low circuit demand', () => {
        const r = computeOptimalFlowTemperature({ ...base, currentMaxFlow: 56, lowLoad: true, guards: { rateLimitEnabled: false } });
        expect(r.reason).toBe('low_load_cap');
        expect(r.targetFlow).toBe(48);
    });

    test('low-load cap does not apply to a cold-recovery deficit', () => {
        const r = computeOptimalFlowTemperature({ ...base, currentMaxFlow: 40, maxZoneError: 2.5, lowLoad: true, guards: { rateLimitEnabled: false } });
        expect(r.targetFlow).toBe(62);
    });
});
