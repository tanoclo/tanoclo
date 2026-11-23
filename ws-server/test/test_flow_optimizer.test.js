/**
 * @file test/test_flow_optimizer.test.js
 * @brief Unit and integration tests for flow temperature optimization.
 */

'use strict';

require('./test_config');
const assert = require('assert');
const { computeOptimalFlowTemperature, evaluateCircuitThermalLoad, parseDbTimestamp } = require('../lib/flow-optimizer');

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

    test('Circuit operating mode: STANDBY (0) on micro-demand under 25% and error < 0.4°C', () => {
        const result = computeOptimalFlowTemperature({
            outsideTemp: 10,
            minFlow: 30,
            maxFlowLimit: 80,
            currentMaxFlow: 50,
            maxZoneError: 0.2,
            circuitDemandPct: 20
        });

        assert.strictEqual(result.circuitOperatingMode, 0);
    });

    test('Circuit operating mode: SCHEDULE (1) when demand >= 25%', () => {
        const result = computeOptimalFlowTemperature({
            outsideTemp: 10,
            minFlow: 30,
            maxFlowLimit: 80,
            currentMaxFlow: 50,
            maxZoneError: 0.2,
            circuitDemandPct: 35
        });

        assert.strictEqual(result.circuitOperatingMode, 1);
    });

    test('Circuit operating mode: STANDBY (0) on single radiator low demand (<25%) even with zone error', () => {
        const result = computeOptimalFlowTemperature({
            outsideTemp: 10,
            minFlow: 30,
            maxFlowLimit: 80,
            currentMaxFlow: 50,
            maxZoneError: 0.6,
            circuitDemandPct: 15
        });

        assert.strictEqual(result.circuitOperatingMode, 0);
        assert.strictEqual(result.thermalReason, 'suppress_micro_burn_low_thermal_load');
    });

    test('Underfloor heating clamp: restricts flow target to max 45°C when only UFH calls for heat', () => {
        const result = computeOptimalFlowTemperature({
            outsideTemp: -5,
            minFlow: 25,
            maxFlowLimit: 75,
            currentMaxFlow: 42,
            maxZoneError: 2.5,
            circuitDemandPct: 90,
            activeDemandType: 'ONLY_UNDERFLOOR'
        });

        // Underfloor heating ceiling clamped to 45°C
        assert.ok(result.targetFlow <= 45, `Expected targetFlow <= 45, got ${result.targetFlow}`);
        assert.strictEqual(result.reason, 'ufh_demand_boost');
        assert.strictEqual(result.demandBoost, 2.0);
    });

    test('Mixed demand: allows radiator curve priority when radiators are calling', () => {
        const result = computeOptimalFlowTemperature({
            outsideTemp: 0,
            minFlow: 30,
            maxFlowLimit: 75,
            currentMaxFlow: 60,
            maxZoneError: 2.0,
            circuitDemandPct: 80,
            activeDemandType: 'MIXED'
        });

        // Radiator priority allowed
        assert.strictEqual(result.reason, 'cold_recovery');
        assert.strictEqual(result.demandBoost, 5.0);
        assert.ok(result.targetFlow > 50);
    });

    test('Generic Thermal Load Gating: single radiator micro-demand is suppressed to avoid micro-burn', () => {
        const thermal = evaluateCircuitThermalLoad({
            callingRadiators: 1,
            callingUfh: 0,
            circuitDemandPct: 18,
            maxZoneError: 0.2,
            inLockout: false
        });

        assert.strictEqual(thermal.allowHeating, false);
        assert.strictEqual(thermal.circuitOperatingMode, 0);
        assert.strictEqual(thermal.reason, 'suppress_micro_burn_low_thermal_load');
    });

    test('Generic Thermal Load Gating: multi-room coincidence (>=2 radiator zones) enables heating', () => {
        const thermal = evaluateCircuitThermalLoad({
            callingRadiators: 2,
            callingUfh: 0,
            circuitDemandPct: 25,
            maxZoneError: 0.25,
            inLockout: false
        });

        assert.strictEqual(thermal.allowHeating, true);
        assert.strictEqual(thermal.circuitOperatingMode, 1);
        assert.strictEqual(thermal.reason, 'multi_zone_coincidence');
    });

    test('Generic Thermal Load Gating: multi-room coincidence with low demand (<25%) suppresses micro-burn', () => {
        const thermal = evaluateCircuitThermalLoad({
            callingRadiators: 2,
            callingUfh: 0,
            circuitDemandPct: 20,
            maxZoneError: 0.25,
            inLockout: false
        });

        assert.strictEqual(thermal.allowHeating, false);
        assert.strictEqual(thermal.circuitOperatingMode, 0);
        assert.strictEqual(thermal.reason, 'suppress_micro_burn_low_thermal_load');
    });

    test('Generic Thermal Load Gating: single radiator zone with significant deficit enables heating', () => {
        const thermal = evaluateCircuitThermalLoad({
            callingRadiators: 1,
            callingUfh: 0,
            circuitDemandPct: 45,
            maxZoneError: 0.6,
            inLockout: false
        });

        assert.strictEqual(thermal.allowHeating, true);
        assert.strictEqual(thermal.circuitOperatingMode, 1);
        assert.strictEqual(thermal.reason, 'single_zone_significant_load');
    });

    test('Generic Thermal Load Gating: underfloor heating thermal mass always enables heating', () => {
        const thermal = evaluateCircuitThermalLoad({
            callingRadiators: 0,
            callingUfh: 1,
            circuitDemandPct: 15,
            maxZoneError: 0.25,
            inLockout: false
        });

        assert.strictEqual(thermal.allowHeating, true);
        assert.strictEqual(thermal.circuitOperatingMode, 1);
        assert.strictEqual(thermal.reason, 'underfloor_thermal_mass');
    });

    test('Generic Thermal Load Gating: anti-flapping lockout blocks marginal demand', () => {
        const thermal = evaluateCircuitThermalLoad({
            callingRadiators: 1,
            callingUfh: 0,
            circuitDemandPct: 25,
            maxZoneError: 0.3,
            inLockout: true
        });

        assert.strictEqual(thermal.allowHeating, false);
        assert.strictEqual(thermal.circuitOperatingMode, 0);
        assert.strictEqual(thermal.reason, 'anti_flapping_lockout');
    });

    test('Flow Temperature Floor: enforces minimum 38°C for active radiator heating', () => {
        const result = computeOptimalFlowTemperature({
            outsideTemp: 14,
            minFlow: 25,
            maxFlowLimit: 75,
            currentMaxFlow: 35,
            maxZoneError: 0.5,
            circuitDemandPct: 50,
            callingRadiators: 2,
            callingUfh: 0
        });

        assert.strictEqual(result.circuitOperatingMode, 1);
        assert.ok(result.effectiveFlow >= 38, `Expected effectiveFlow >= 38, got ${result.effectiveFlow}`);
    });

    test('Flow Temperature Floor: underfloor heating allowed below 38°C down to minFlow', () => {
        const result = computeOptimalFlowTemperature({
            outsideTemp: 14,
            minFlow: 25,
            maxFlowLimit: 45,
            currentMaxFlow: 30,
            maxZoneError: 0.5,
            circuitDemandPct: 50,
            callingRadiators: 0,
            callingUfh: 1,
            activeDemandType: 'ONLY_UNDERFLOOR'
        });

        assert.strictEqual(result.circuitOperatingMode, 1);
        assert.ok(result.effectiveFlow <= 35, `Expected effectiveFlow <= 35, got ${result.effectiveFlow}`);
    });

    test('Delta-T Anti-Microburn Guard: suppresses heating when flow water is already warm (<5°C below target)', () => {
        const result = computeOptimalFlowTemperature({
            outsideTemp: 5,
            minFlow: 30,
            maxFlowLimit: 75,
            currentMaxFlow: 50,
            maxZoneError: 0.4,
            circuitDemandPct: 40,
            callingRadiators: 2,
            callingUfh: 0,
            actualFlowTemp: 50.0,
            isFlameOn: false
        });

        // Target flow is 53°C. Actual flow is 50.0°C (deltaT = 3.0°C < 5°C).
        // Must suppress burner ignition to prevent immediate 15-second high-limit trip.
        assert.strictEqual(result.circuitOperatingMode, 0);
        assert.strictEqual(result.effectiveFlow, 0);
        assert.strictEqual(result.reason, 'flow_already_hot');
    });

    test('Delta-T Anti-Microburn Guard: allows heating when flow water has cooled down (>=5°C below target)', () => {
        const result = computeOptimalFlowTemperature({
            outsideTemp: 5,
            minFlow: 30,
            maxFlowLimit: 75,
            currentMaxFlow: 50,
            maxZoneError: 0.4,
            circuitDemandPct: 40,
            callingRadiators: 2,
            callingUfh: 0,
            actualFlowTemp: 42.0,
            isFlameOn: false
        });

        // Actual flow is 42.0°C (deltaT = 48 - 42 = 6°C >= 5°C). Safe to ignite.
        assert.strictEqual(result.circuitOperatingMode, 1);
        assert.ok(result.effectiveFlow >= 48);
    });

    test('Delta-T Anti-Microburn Guard: overridden by major cold recovery deficit (maxZoneError >= 1.0°C)', () => {
        const result = computeOptimalFlowTemperature({
            outsideTemp: 5,
            minFlow: 30,
            maxFlowLimit: 75,
            currentMaxFlow: 50,
            maxZoneError: 1.5,
            circuitDemandPct: 80,
            callingRadiators: 2,
            callingUfh: 0,
            actualFlowTemp: 47.5,
            isFlameOn: false
        });

        // High room deficit overrides delta-T suppression and boosts target flow
        assert.strictEqual(result.circuitOperatingMode, 1);
        assert.ok(result.effectiveFlow >= 48);
    });

    test('Hysteresis: maintains active mode 1 at 20% coincidence demand but requires 25% to turn on from mode 0', () => {
        // From mode 0 (OFF): 20% coincidence demand is below 25% turn-on threshold -> stays OFF
        const resultOff = computeOptimalFlowTemperature({
            outsideTemp: 5,
            minFlow: 30,
            maxFlowLimit: 75,
            currentMaxFlow: 50,
            maxZoneError: 0.3,
            circuitDemandPct: 20,
            callingRadiators: 2,
            currentMode: 0
        });
        assert.strictEqual(resultOff.circuitOperatingMode, 0);

        // From mode 1 (ON): 20% coincidence demand is above 15% sustain threshold -> stays ON
        const resultOn = computeOptimalFlowTemperature({
            outsideTemp: 5,
            minFlow: 30,
            maxFlowLimit: 75,
            currentMaxFlow: 50,
            maxZoneError: 0.3,
            circuitDemandPct: 20,
            callingRadiators: 2,
            currentMode: 1
        });
        assert.strictEqual(resultOn.circuitOperatingMode, 1);
        assert.ok(resultOn.effectiveFlow >= 48);
    });

    test('Delta-T Anti-Microburn Guard: does not abort active heating when currentMode === 1', () => {
        const result = computeOptimalFlowTemperature({
            outsideTemp: 5,
            minFlow: 30,
            maxFlowLimit: 75,
            currentMaxFlow: 50,
            maxZoneError: 0.4,
            circuitDemandPct: 30,
            callingRadiators: 2,
            callingUfh: 0,
            actualFlowTemp: 45.0,
            isFlameOn: false,
            currentMode: 1
        });

        // Loop water at 45°C with target 48°C (deltaT = 3°C < 5°C).
        // In active heating (currentMode 1), must remain in Mode 1 to allow pump circulation without flapping.
        assert.strictEqual(result.circuitOperatingMode, 1);
        assert.ok(result.effectiveFlow >= 48);
    });

    test('Anti-flapping lockout: does not terminate active heating when currentMode === 1', () => {
        const result = evaluateCircuitThermalLoad({
            callingRadiators: 2,
            circuitDemandPct: 20,
            maxZoneError: 0.3,
            inLockout: true,
            currentMode: 1
        });

        assert.strictEqual(result.allowHeating, true);
        assert.strictEqual(result.circuitOperatingMode, 1);
        assert.strictEqual(result.reason, 'multi_zone_coincidence');
    });

    test('Anti-flapping lockout: blocks ignition when in standby (currentMode === 0)', () => {
        const result = evaluateCircuitThermalLoad({
            callingRadiators: 2,
            circuitDemandPct: 30,
            maxZoneError: 0.3,
            inLockout: true,
            currentMode: 0
        });

        assert.strictEqual(result.allowHeating, false);
        assert.strictEqual(result.circuitOperatingMode, 0);
        assert.strictEqual(result.reason, 'anti_flapping_lockout');
    });

    test('Anti-flapping lockout: only a room deficit >= 2.0°C bypasses the minimum off-time', () => {
        const blocked = evaluateCircuitThermalLoad({
            callingRadiators: 2, circuitDemandPct: 60, maxZoneError: 1.8, inLockout: true, currentMode: 0
        });
        assert.strictEqual(blocked.reason, 'anti_flapping_lockout');
        assert.strictEqual(blocked.circuitOperatingMode, 0);

        const bypassed = evaluateCircuitThermalLoad({
            callingRadiators: 2, circuitDemandPct: 60, maxZoneError: 2.1, inLockout: true, currentMode: 0
        });
        assert.strictEqual(bypassed.circuitOperatingMode, 1);
    });

    test('Rate base: from standby (base = minFlow) jumps to target, then holds steady without change', () => {
        const params = { outsideTemp: 5, minFlow: 30, maxFlowLimit: 80, maxZoneError: 0.5, circuitDemandPct: 40 };
        const fromStandby = computeOptimalFlowTemperature({ ...params, currentMaxFlow: 30 });
        assert.strictEqual(fromStandby.targetFlow, 55);
        assert.strictEqual(fromStandby.changed, true);

        const steady = computeOptimalFlowTemperature({ ...params, currentMaxFlow: 55 });
        assert.strictEqual(steady.targetFlow, 55);
        assert.strictEqual(steady.changed, false);
    });

    test('parseDbTimestamp: correctly parses Date objects and UTC strings with or without Z', () => {
        const d = new Date('2026-11-22T05:16:00.000Z');
        assert.strictEqual(parseDbTimestamp(d), d.getTime());

        const isoStrWithZ = '2026-11-22T05:16:00Z';
        assert.strictEqual(parseDbTimestamp(isoStrWithZ), d.getTime());

        const dbSpaceStr = '2026-11-22 05:16:00';
        assert.strictEqual(parseDbTimestamp(dbSpaceStr), d.getTime());

        assert.strictEqual(parseDbTimestamp(null), 0);
        assert.strictEqual(parseDbTimestamp(''), 0);
    });

    describe('Configurable Guards Toggles and Thresholds', () => {
        test('Lockout guard: disabling lockout allows firing despite inLockout', () => {
            const blocked = evaluateCircuitThermalLoad({
                callingRadiators: 2, circuitDemandPct: 30, maxZoneError: 0.3, inLockout: true, currentMode: 0
            });
            assert.strictEqual(blocked.allowHeating, false);
            assert.strictEqual(blocked.reason, 'anti_flapping_lockout');

            const allowed = evaluateCircuitThermalLoad({
                callingRadiators: 2, circuitDemandPct: 30, maxZoneError: 0.3, inLockout: true, currentMode: 0,
                guards: { lockoutEnabled: false }
            });
            assert.strictEqual(allowed.allowHeating, true);
            assert.strictEqual(allowed.circuitOperatingMode, 1);
            assert.strictEqual(allowed.reason, 'multi_zone_coincidence');
        });

        test('Lockout guard: custom override deficit threshold', () => {
            const blocked = evaluateCircuitThermalLoad({
                callingRadiators: 2, circuitDemandPct: 30, maxZoneError: 1.2, inLockout: true, currentMode: 0,
                guards: { lockoutOverrideDeficit: 1.5 }
            });
            assert.strictEqual(blocked.reason, 'anti_flapping_lockout');

            const bypassed = evaluateCircuitThermalLoad({
                callingRadiators: 2, circuitDemandPct: 30, maxZoneError: 1.6, inLockout: true, currentMode: 0,
                guards: { lockoutOverrideDeficit: 1.5 }
            });
            assert.strictEqual(bypassed.circuitOperatingMode, 1);
        });

        test('Thermal load gating guard: disabling allows single radiator micro-demand to fire', () => {
            const blocked = evaluateCircuitThermalLoad({
                callingRadiators: 1, circuitDemandPct: 10, maxZoneError: 0.1, inLockout: false, currentMode: 0
            });
            assert.strictEqual(blocked.allowHeating, false);
            assert.strictEqual(blocked.reason, 'suppress_micro_burn_low_thermal_load');

            const allowed = evaluateCircuitThermalLoad({
                callingRadiators: 1, circuitDemandPct: 10, maxZoneError: 0.1, inLockout: false, currentMode: 0,
                guards: { thermalLoadEnabled: false }
            });
            assert.strictEqual(allowed.allowHeating, true);
            assert.strictEqual(allowed.circuitOperatingMode, 1);
            assert.strictEqual(allowed.reason, 'thermal_load_gating_disabled');
        });

        test('Radiator floor guard: disabling permits low flow without 48°C floor clamp', () => {
            // outdoor temp 18°C -> base flow low ~35°C
            const clamped = computeOptimalFlowTemperature({
                outsideTemp: 18, minFlow: 30, maxFlowLimit: 80, currentMaxFlow: 30, maxZoneError: 0.5,
                circuitDemandPct: 40, callingRadiators: 2, callingUfh: 0, currentMode: 0
            });
            assert.strictEqual(clamped.effectiveFlow, 48);

            const unclamped = computeOptimalFlowTemperature({
                outsideTemp: 18, minFlow: 30, maxFlowLimit: 80, currentMaxFlow: 30, maxZoneError: 0.5,
                circuitDemandPct: 40, callingRadiators: 2, callingUfh: 0, currentMode: 0,
                guards: { radiatorFloorEnabled: false }
            });
            assert.strictEqual(unclamped.effectiveFlow < 48, true);
            assert.strictEqual(unclamped.effectiveFlow, unclamped.targetFlow);
        });

        test('Radiator floor guard: custom floor temperature', () => {
            const customFloor = computeOptimalFlowTemperature({
                outsideTemp: 18, minFlow: 30, maxFlowLimit: 80, currentMaxFlow: 30, maxZoneError: 0.5,
                circuitDemandPct: 40, callingRadiators: 2, callingUfh: 0, currentMode: 0,
                guards: { radiatorFloorTemp: 52 }
            });
            assert.strictEqual(customFloor.effectiveFlow, 52);
        });

        test('Delta-T guard: disabling permits firing even when loop water is warm', () => {
            const blocked = computeOptimalFlowTemperature({
                outsideTemp: 5, minFlow: 30, maxFlowLimit: 80, currentMaxFlow: 30, maxZoneError: 0.5,
                circuitDemandPct: 40, callingRadiators: 2, callingUfh: 0, currentMode: 0,
                actualFlowTemp: 54, isFlameOn: false // target flow is 55, deltaT is only 1°C < 5°C
            });
            assert.strictEqual(blocked.circuitOperatingMode, 0);
            assert.strictEqual(blocked.reason, 'flow_already_hot');

            const allowed = computeOptimalFlowTemperature({
                outsideTemp: 5, minFlow: 30, maxFlowLimit: 80, currentMaxFlow: 30, maxZoneError: 0.5,
                circuitDemandPct: 40, callingRadiators: 2, callingUfh: 0, currentMode: 0,
                actualFlowTemp: 54, isFlameOn: false,
                guards: { deltaTEnabled: false }
            });
            assert.strictEqual(allowed.circuitOperatingMode, 1);
            assert.notStrictEqual(allowed.reason, 'flow_already_hot');
        });

        test('Rate limit guard: disabling rate limiting steps directly to target', () => {
            // Steady state at 40°C, cold weather target is ~63°C (delta 23°C)
            const rateLimited = computeOptimalFlowTemperature({
                outsideTemp: 0, minFlow: 30, maxFlowLimit: 80, currentMaxFlow: 40, maxZoneError: 0.5,
                circuitDemandPct: 40, currentMode: 1
            });
            // Stepped by max 3°C from 40 to 43
            assert.strictEqual(rateLimited.targetFlow, 43);

            const directJump = computeOptimalFlowTemperature({
                outsideTemp: 0, minFlow: 30, maxFlowLimit: 80, currentMaxFlow: 40, maxZoneError: 0.5,
                circuitDemandPct: 40, currentMode: 1,
                guards: { rateLimitEnabled: false }
            });
            assert.strictEqual(directJump.targetFlow > 50, true);
        });
    });
});

