/**
 * @file test/test_pid_analyzer.test.js
 * @brief Unit tests for thermodynamic PID analyzer.
 */

import { describe, it, expect } from 'vitest';
import {
    extractTransientWindows,
    evaluateZoneTransients,
    calculatePidPreset,
    derivePidSuggestions
} from '../lib/pid-analyzer';

describe('Thermodynamic PID Analyzer', () => {
    describe('extractTransientWindows', () => {
        it('returns empty array on empty or small inputs', () => {
            expect(extractTransientWindows([])).toEqual([]);
            expect(extractTransientWindows(null)).toEqual([]);
            expect(extractTransientWindows([{ timestamp: '2026-10-10 10:00:00', field_012d: 20.0 }])).toEqual([]);
        });

        it('extracts transient windows on setpoint changes and active heating runs', () => {
            const rows = [
                // Setpoint 21.0, starting from 19.5
                { timestamp: '2026-10-10 10:00:00', field_012d: 19.5, field_40a0: 70, field_6200: 21.0, field_6260: 0, field_61e0: 1 },
                { timestamp: '2026-10-10 10:05:00', field_012d: 19.8, field_40a0: 60, field_6200: 21.0, field_6260: 0, field_61e0: 1 },
                { timestamp: '2026-10-10 10:10:00', field_012d: 20.3, field_40a0: 40, field_6200: 21.0, field_6260: 0, field_61e0: 1 },
                { timestamp: '2026-10-10 10:15:00', field_012d: 20.8, field_40a0: 20, field_6200: 21.0, field_6260: 0, field_61e0: 1 },
                { timestamp: '2026-10-10 10:20:00', field_012d: 21.1, field_40a0: 10, field_6200: 21.0, field_6260: 0, field_61e0: 1 },
                // Step change to 23.0
                { timestamp: '2026-10-10 11:30:00', field_012d: 21.0, field_40a0: 100, field_6280: 23.0, field_6260: 1, field_61e0: 1 },
                { timestamp: '2026-10-10 11:35:00', field_012d: 21.5, field_40a0: 80, field_6280: 23.0, field_6260: 1, field_61e0: 1 },
                { timestamp: '2026-10-10 11:40:00', field_012d: 22.2, field_40a0: 60, field_6280: 23.0, field_6260: 1, field_61e0: 1 },
                { timestamp: '2026-10-10 11:45:00', field_012d: 22.8, field_40a0: 30, field_6280: 23.0, field_6260: 1, field_61e0: 1 },
                { timestamp: '2026-10-10 11:50:00', field_012d: 23.0, field_40a0: 10, field_6280: 23.0, field_6260: 1, field_61e0: 1 }
            ];

            const windows = extractTransientWindows(rows);
            expect(windows).toHaveLength(2);
            expect(windows[0].setpoint).toBe(21.0);
            expect(windows[0].startTemp).toBe(19.5);
            expect(windows[1].setpoint).toBe(23.0);
            expect(windows[1].startTemp).toBe(21.0);
        });

        it('ignores night setback step-downs without generating false cooling transients', () => {
            const rows = [
                // Setpoint drops from 21.0 down to 17.0 (night setback)
                { timestamp: '2026-10-10 22:00:00', field_012d: 21.0, field_40a0: 0, field_6200: 17.0, field_6260: 0, field_61e0: 1 },
                { timestamp: '2026-10-10 22:10:00', field_012d: 20.8, field_40a0: 0, field_6200: 17.0, field_6260: 0, field_61e0: 1 },
                { timestamp: '2026-10-10 22:20:00', field_012d: 20.5, field_40a0: 0, field_6200: 17.0, field_6260: 0, field_61e0: 1 },
                { timestamp: '2026-10-10 22:30:00', field_012d: 20.2, field_40a0: 0, field_6200: 17.0, field_6260: 0, field_61e0: 1 },
                { timestamp: '2026-10-10 22:40:00', field_012d: 19.8, field_40a0: 0, field_6200: 17.0, field_6260: 0, field_61e0: 1 }
            ];

            const windows = extractTransientWindows(rows);
            // Must NOT extract a window for cooling/setback
            expect(windows).toHaveLength(0);
        });

        it('discards windows with zero or negligible heating demand (solar gain)', () => {
            const rows = [
                // Target 21.0, room heats naturally from 19.0 to 22.0 while demand is 0
                { timestamp: '2026-10-10 12:00:00', field_012d: 19.0, field_40a0: 0, field_6200: 21.0, field_6260: 0, field_61e0: 1 },
                { timestamp: '2026-10-10 12:15:00', field_012d: 20.0, field_40a0: 0, field_6200: 21.0, field_6260: 0, field_61e0: 1 },
                { timestamp: '2026-10-10 12:30:00', field_012d: 21.0, field_40a0: 0, field_6200: 21.0, field_6260: 0, field_61e0: 1 },
                { timestamp: '2026-10-10 12:45:00', field_012d: 22.0, field_40a0: 0, field_6200: 21.0, field_6260: 0, field_61e0: 1 },
                { timestamp: '2026-10-10 13:00:00', field_012d: 22.5, field_40a0: 0, field_6200: 21.0, field_6260: 0, field_61e0: 1 }
            ];

            const windows = extractTransientWindows(rows);
            expect(windows).toHaveLength(0);
        });

        it('discards window when circuit telemetry shows circuit was inactive throughout', () => {
            const rows = [
                // Zone requests heat, but circuit was off
                { timestamp: '2026-10-10 10:00:00', field_012d: 19.0, field_40a0: 80, field_6200: 21.0, field_6260: 0, field_61e0: 1 },
                { timestamp: '2026-10-10 10:05:00', field_012d: 19.2, field_40a0: 80, field_6200: 21.0, field_6260: 0, field_61e0: 1 },
                { timestamp: '2026-10-10 10:10:00', field_012d: 19.4, field_40a0: 80, field_6200: 21.0, field_6260: 0, field_61e0: 1 },
                { timestamp: '2026-10-10 10:15:00', field_012d: 19.6, field_40a0: 80, field_6200: 21.0, field_6260: 0, field_61e0: 1 }
            ];

            // Circuit only active at 15:00-16:00
            const circuitIntervals = [
                [new Date('2026-10-10 15:00:00').getTime(), new Date('2026-10-10 16:00:00').getTime()]
            ];

            const windows = extractTransientWindows(rows, 120, { circuitIntervals });
            expect(windows).toHaveLength(0);
        });
    });

    describe('evaluateZoneTransients', () => {
        it('handles empty windows gracefully', () => {
            const metrics = evaluateZoneTransients([]);
            expect(metrics.validWindowsCount).toBe(0);
            expect(metrics.avgOvershoot).toBe(0);
        });

        it('correctly calculates overshoot and steady state error', () => {
            const windows = [
                {
                    startTime: new Date('2026-10-10 10:00:00').getTime(),
                    setpoint: 21.0,
                    startTemp: 19.0,
                    points: [
                        { parsedTime: new Date('2026-10-10 10:00:00').getTime(), temp: 19.0 },
                        { parsedTime: new Date('2026-10-10 10:10:00').getTime(), temp: 20.0 },
                        { parsedTime: new Date('2026-10-10 10:20:00').getTime(), temp: 20.8 },
                        { parsedTime: new Date('2026-10-10 10:30:00').getTime(), temp: 21.6 }, // 0.6 overshoot
                        { parsedTime: new Date('2026-10-10 10:40:00').getTime(), temp: 21.5 },
                        { parsedTime: new Date('2026-10-10 10:50:00').getTime(), temp: 21.4 }
                    ]
                }
            ];

            const metrics = evaluateZoneTransients(windows);
            expect(metrics.validWindowsCount).toBe(1);
            expect(metrics.maxOvershoot).toBe(0.6);
            expect(metrics.avgOvershoot).toBe(0.6);
        });
    });

    describe('derivePidSuggestions', () => {
        const defaultGains = { kp: 10.0, ki: 5.0, kd: 15.0 };

        it('detects insufficient data when < 2 windows', () => {
            const metrics = { validWindowsCount: 1, avgOvershoot: 0.1, maxOvershoot: 0.1, avgSteadyStateError: 0.05, oscillationScore: 0, avgRiseTimeMinutes: 30 };
            const res = derivePidSuggestions(metrics, defaultGains);
            expect(res.diagnosis).toBe('INSUFFICIENT_DATA');
            expect(res.suggestedKp).toBe(10.0);
        });

        it('recommends Kp reduction and Kd boost for OVERSHOOT', () => {
            const metrics = { validWindowsCount: 4, avgOvershoot: 0.65, maxOvershoot: 0.85, avgSteadyStateError: 0.05, oscillationScore: 0.5, avgRiseTimeMinutes: 25 };
            const res = derivePidSuggestions(metrics, defaultGains);
            expect(res.diagnosis).toBe('OVERSHOOT');
            expect(res.suggestedKp).toBeLessThan(10.0);
            expect(res.suggestedKd).toBeGreaterThan(15.0);
            expect(res.confidence).toBe('MEDIUM');
        });

        it('recommends Ki boost for DROOP', () => {
            const metrics = { validWindowsCount: 3, avgOvershoot: 0.0, maxOvershoot: 0.0, avgSteadyStateError: 0.45, oscillationScore: 0.2, avgRiseTimeMinutes: 40 };
            const res = derivePidSuggestions(metrics, defaultGains);
            expect(res.diagnosis).toBe('DROOP');
            expect(res.suggestedKi).toBeGreaterThan(5.0);
        });

        it('recommends stabilizing gains for HUNTING/OSCILLATION', () => {
            const metrics = { validWindowsCount: 5, avgOvershoot: 0.4, maxOvershoot: 0.5, avgSteadyStateError: 0.1, oscillationScore: 3.2, avgRiseTimeMinutes: 20 };
            const res = derivePidSuggestions(metrics, defaultGains);
            expect(res.diagnosis).toBe('HUNTING');
            expect(res.suggestedKp).toBeLessThan(10.0);
            expect(res.suggestedKi).toBeLessThan(5.0);
            expect(res.suggestedKd).toBeGreaterThan(15.0);
            expect(res.confidence).toBe('HIGH');
        });

        it('keeps gains for OPTIMAL tracking', () => {
            const metrics = { validWindowsCount: 4, avgOvershoot: 0.1, maxOvershoot: 0.15, avgSteadyStateError: 0.1, oscillationScore: 0.4, avgRiseTimeMinutes: 35 };
            const res = derivePidSuggestions(metrics, defaultGains);
            expect(res.diagnosis).toBe('OPTIMAL');
            expect(res.suggestedKp).toBe(10.0);
            expect(res.suggestedKi).toBe(5.0);
            expect(res.suggestedKd).toBe(15.0);
        });

        it('recommends low Kp and high Kd damping for underfloor heating with thermal overshoot', () => {
            const ufhGains = { kp: 5.0, ki: 2.0, kd: 20.0 };
            const metrics = { validWindowsCount: 4, avgOvershoot: 0.45, maxOvershoot: 0.60, avgSteadyStateError: 0.05, oscillationScore: 0.2, avgRiseTimeMinutes: 120 };
            const res = derivePidSuggestions(metrics, ufhGains, 'UNDERFLOOR');
            expect(res.diagnosis).toBe('OVERSHOOT');
            expect(res.suggestedKp).toBeLessThanOrEqual(5.0);
            expect(res.suggestedKd).toBeGreaterThanOrEqual(20.0);
            expect(res.suggestedKp).toBeLessThanOrEqual(6.0); // clamped to UFH safety ceiling
            expect(res.reason).toContain('Underfloor slab');
        });

        it('returns size-based cold-start preset when data is insufficient', () => {
            const metrics = { validWindowsCount: 0, avgOvershoot: 0, maxOvershoot: 0, avgSteadyStateError: 0, oscillationScore: 0, avgRiseTimeMinutes: 0 };
            const res = derivePidSuggestions(metrics, defaultGains, 'RADIATOR', { roomSizeSqm: 10 });
            expect(res.diagnosis).toBe('INSUFFICIENT_DATA');
            expect(res.suggestedKp).toBe(7.5);
            expect(res.suggestedKi).toBe(4.0);
            expect(res.suggestedKd).toBe(20.0);
            expect(res.sizePreset.tier).toBe('SMALL');
            expect(res.reason).toContain('10 m² (SMALL)');
        });
    });

    describe('calculatePidPreset', () => {
        it('calculates radiator PID presets by room size tiers', () => {
            // Small (< 15 m²)
            const small = calculatePidPreset({ roomSizeSqm: 10, heatingType: 'RADIATOR' });
            expect(small.tier).toBe('SMALL');
            expect(small.kp).toBe(7.5);
            expect(small.ki).toBe(4.0);
            expect(small.kd).toBe(20.0);

            // Medium (15-28 m²)
            const medium = calculatePidPreset({ roomSizeSqm: 20, heatingType: 'RADIATOR' });
            expect(medium.tier).toBe('MEDIUM');
            expect(medium.kp).toBe(10.0);
            expect(medium.ki).toBe(5.0);
            expect(medium.kd).toBe(15.0);

            // Large (28-45 m²)
            const large = calculatePidPreset({ roomSizeSqm: 35, heatingType: 'RADIATOR' });
            expect(large.tier).toBe('LARGE');
            expect(large.kp).toBe(13.5);
            expect(large.ki).toBe(6.0);
            expect(large.kd).toBe(12.0);

            // Extra Large (> 45 m²)
            const xl = calculatePidPreset({ roomSizeSqm: 55, heatingType: 'RADIATOR' });
            expect(xl.tier).toBe('XL');
            expect(xl.kp).toBe(16.5);
            expect(xl.ki).toBe(7.5);
            expect(xl.kd).toBe(10.0);
        });

        it('calculates underfloor screed PID presets by room size tiers', () => {
            const smallUfh = calculatePidPreset({ roomSizeSqm: 12, heatingType: 'UNDERFLOOR', underfloorMass: 'SCREED' });
            expect(smallUfh.tier).toBe('SMALL');
            expect(smallUfh.kp).toBe(3.0);
            expect(smallUfh.ki).toBe(1.0);
            expect(smallUfh.kd).toBe(32.0);

            const xlUfh = calculatePidPreset({ roomSizeSqm: 60, heatingType: 'UNDERFLOOR', underfloorMass: 'SCREED' });
            expect(xlUfh.tier).toBe('XL');
            expect(xlUfh.kp).toBe(5.5);
            expect(xlUfh.ki).toBe(2.2);
            expect(xlUfh.kd).toBe(18.0);
        });

        it('calculates underfloor dry system PID presets', () => {
            const dryMedium = calculatePidPreset({ roomSizeSqm: 25, heatingType: 'UNDERFLOOR', underfloorMass: 'DRY_SYSTEM' });
            expect(dryMedium.tier).toBe('MEDIUM');
            expect(dryMedium.kp).toBe(6.5);
            expect(dryMedium.ki).toBe(2.5);
            expect(dryMedium.kd).toBe(20.0);
        });

        it('clamps all gains to firmware boundaries', () => {
            const result = calculatePidPreset({ roomSizeSqm: 1000, heatingType: 'RADIATOR' });
            expect(result.kp).toBeLessThanOrEqual(30.0);
            expect(result.ki).toBeLessThanOrEqual(20.0);
            expect(result.kd).toBeGreaterThanOrEqual(5.0);
        });
    });
});

