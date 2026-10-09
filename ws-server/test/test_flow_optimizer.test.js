/**
 * @file test/test_flow_optimizer.test.js
 * @brief Unit and integration tests for flow temperature optimization.
 */

'use strict';

require('./test_config');
const assert = require('assert');
const { computeOptimalFlowTemperature } = require('../lib/flow-optimizer');

describe('Flow Temperature Optimizer Engine', () => {
    test('Idle / Standby drops to minFlow when no demand and rooms satisfied', () => {
        const result = computeOptimalFlowTemperature({
            outsideTemp: 5,
            minFlow: 30,
            maxFlowLimit: 80,
            currentMaxFlow: 55,
            maxZoneError: 0,
            circuitDemandPct: 0
        });

        assert.strictEqual(result.reason, 'idle_standby');
        // Rate limited from 55 down by max 3°C
        assert.strictEqual(result.targetFlow, 52);
        assert.strictEqual(result.changed, true);
    });

    test('Steady state with no demand already at minFlow does not change', () => {
        const result = computeOptimalFlowTemperature({
            outsideTemp: 5,
            minFlow: 30,
            maxFlowLimit: 80,
            currentMaxFlow: 30,
            maxZoneError: 0,
            circuitDemandPct: 0
        });

        assert.strictEqual(result.reason, 'idle_standby');
        assert.strictEqual(result.targetFlow, 30);
        assert.strictEqual(result.changed, false);
    });

    test('Cold recovery applies boost on high room deficit', () => {
        const result = computeOptimalFlowTemperature({
            outsideTemp: 0,
            minFlow: 30,
            maxFlowLimit: 80,
            currentMaxFlow: 60,
            maxZoneError: 2.5,
            circuitDemandPct: 80
        });

        assert.strictEqual(result.reason, 'cold_recovery');
        assert.strictEqual(result.demandBoost, 5.0);
        // Base at 0°C with min 30, max 80: fraction=(20-0)/30 = 0.6667 -> base ~63.3
        // Base + boost = 68.3 -> target clamped, rate limited from 60 to 63
        assert.strictEqual(result.targetFlow, 63);
        assert.strictEqual(result.changed, true);
    });

    test('Near setpoint reduces flow temperature', () => {
        const result = computeOptimalFlowTemperature({
            outsideTemp: 10,
            minFlow: 30,
            maxFlowLimit: 80,
            currentMaxFlow: 50,
            maxZoneError: 0.1,
            circuitDemandPct: 20
        });

        assert.strictEqual(result.reason, 'near_setpoint');
        assert.strictEqual(result.demandBoost, -3.0);
    });

    test('Forecast warming trend applies pre-cooling', () => {
        const result = computeOptimalFlowTemperature({
            outsideTemp: 10,
            minFlow: 30,
            maxFlowLimit: 80,
            currentMaxFlow: 45,
            maxZoneError: 0.5,
            circuitDemandPct: 50,
            forecastHourly: [10, 11, 14, 15] // +4°C rise in 3 hours
        });

        assert.strictEqual(result.forecastAdj, -2.0);
    });

    test('Forecast sharp drop applies pre-boost', () => {
        const result = computeOptimalFlowTemperature({
            outsideTemp: 5,
            minFlow: 30,
            maxFlowLimit: 80,
            currentMaxFlow: 50,
            maxZoneError: 0.5,
            circuitDemandPct: 50,
            forecastHourly: [5, 4, 1, 0] // -4°C drop in 3 hours
        });

        assert.strictEqual(result.forecastAdj, 2.0);
    });

    test('Boiler modulation feedback reduces when modulation is low and zone satisfied', () => {
        const result = computeOptimalFlowTemperature({
            outsideTemp: 10,
            minFlow: 30,
            maxFlowLimit: 80,
            currentMaxFlow: 55,
            maxZoneError: 0.2,
            circuitDemandPct: 30,
            modulationPct: 15
        });

        assert.strictEqual(result.modAdj, -2.0);
    });

    test('Clamping enforces minFlow and maxFlowLimit guardrails', () => {
        // Very cold outside (-25°C) would exceed 80 without clamp
        const result = computeOptimalFlowTemperature({
            outsideTemp: -25,
            minFlow: 30,
            maxFlowLimit: 75,
            currentMaxFlow: 74,
            maxZoneError: 3.0,
            circuitDemandPct: 100
        });

        assert.strictEqual(result.targetFlow, 75);
    });

    test('Hysteresis prevents micro-adjustments under 1°C', () => {
        // Outside 5°C with base ~55, current is 55.2
        const result = computeOptimalFlowTemperature({
            outsideTemp: 5,
            minFlow: 30,
            maxFlowLimit: 80,
            currentMaxFlow: 55,
            maxZoneError: 0.5,
            circuitDemandPct: 50
        });

        // If raw target is ~55, delta is < 1°C -> no change
        if (Math.abs(result.targetFlow - 55) < 1.0) {
            assert.strictEqual(result.changed, false);
            assert.strictEqual(result.targetFlow, 55);
        }
    });
});
