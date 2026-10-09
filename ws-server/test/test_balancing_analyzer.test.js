/**
 * @file test/test_balancing_analyzer.test.js
 * @brief Unit tests for advisory hydraulic balancing analyzer.
 */

import { describe, it, expect } from 'vitest';
import {
    groupHeatingRuns,
    computeDeviceRiseRate,
    calculateMedian,
    generateDeviceSuggestion,
    analyzeBalancing
} from '../lib/balancing-analyzer';

describe('Hydraulic Balancing Analyzer', () => {
    describe('groupHeatingRuns', () => {
        it('returns empty array on empty or invalid input', () => {
            expect(groupHeatingRuns([])).toEqual([]);
            expect(groupHeatingRuns(null)).toEqual([]);
        });

        it('filters out inactive or AWAY mode rows', () => {
            const rows = [
                { timestamp: '2026-10-09 10:00:00', field_40a0: 0, tado_mode: 'HOME' },
                { timestamp: '2026-10-09 10:05:00', field_40a0: 50, tado_mode: 'AWAY' }
            ];
            expect(groupHeatingRuns(rows)).toEqual([]);
        });

        it('discards runs shorter than minDurationMinutes or fewer than minPoints', () => {
            const rows = [
                { timestamp: '2026-10-09 10:00:00', field_40a0: 50, tado_mode: 'HOME' },
                { timestamp: '2026-10-09 10:02:00', field_40a0: 50, tado_mode: 'HOME' }
            ];
            // Only 2 min duration, 2 points
            expect(groupHeatingRuns(rows)).toEqual([]);
        });

        it('correctly identifies valid heating runs and splits on gaps > 10 min', () => {
            const rows = [
                // Run 1: 10:00 to 10:15 (15 min, 4 points)
                { timestamp: '2026-10-09 10:00:00', field_40a0: 100, tado_mode: 'HOME' },
                { timestamp: '2026-10-09 10:05:00', field_40a0: 100, tado_mode: 'HOME' },
                { timestamp: '2026-10-09 10:10:00', field_40a0: 100, tado_mode: 'HOME' },
                { timestamp: '2026-10-09 10:15:00', field_40a0: 100, tado_mode: 'HOME' },
                // Gap of 30 min
                // Run 2: 10:45 to 10:55 (10 min, 3 points)
                { timestamp: '2026-10-09 10:45:00', field_40a0: 80, tado_mode: 'HOME' },
                { timestamp: '2026-10-09 10:50:00', field_40a0: 80, tado_mode: 'HOME' },
                { timestamp: '2026-10-09 10:55:00', field_40a0: 80, tado_mode: 'HOME' }
            ];

            const runs = groupHeatingRuns(rows);
            expect(runs).toHaveLength(2);
            expect(runs[0].durationMinutes).toBe(15);
            expect(runs[0].points).toHaveLength(4);
            expect(runs[1].durationMinutes).toBe(10);
            expect(runs[1].points).toHaveLength(3);
        });
    });

    describe('computeDeviceRiseRate', () => {
        it('calculates average rate correctly across runs', () => {
            const heatingRuns = [
                {
                    startTime: new Date('2026-10-09 10:00:00').getTime(),
                    endTime: new Date('2026-10-09 10:20:00').getTime(),
                    durationMinutes: 20
                }
            ];

            const devicePoints = [
                { timestamp: '2026-10-09 10:00:00', field_012d: 20.0 },
                { timestamp: '2026-10-09 10:10:00', field_012d: 21.0 },
                { timestamp: '2026-10-09 10:20:00', field_012d: 22.0 } // +2.0°C in 20 min = 0.1°C/min
            ];

            const result = computeDeviceRiseRate(devicePoints, heatingRuns);
            expect(result.runsCount).toBe(1);
            expect(result.avgRiseRate).toBe(0.1);
        });

        it('uses fallback zone points if device telemetry is empty', () => {
            const heatingRuns = [
                {
                    startTime: new Date('2026-10-09 10:00:00').getTime(),
                    endTime: new Date('2026-10-09 10:20:00').getTime(),
                    durationMinutes: 20
                }
            ];

            const fallbackPoints = [
                { timestamp: '2026-10-09 10:00:00', field_012d: 19.0 },
                { timestamp: '2026-10-09 10:10:00', field_012d: 19.5 },
                { timestamp: '2026-10-09 10:20:00', field_012d: 20.0 } // +1.0°C in 20 min = 0.05°C/min
            ];

            const result = computeDeviceRiseRate([], heatingRuns, fallbackPoints);
            expect(result.runsCount).toBe(1);
            expect(result.avgRiseRate).toBe(0.05);
        });
    });

    describe('calculateMedian', () => {
        it('calculates median for odd and even arrays', () => {
            expect(calculateMedian([0.05, 0.10, 0.15])).toBe(0.10);
            expect(calculateMedian([0.05, 0.15])).toBe(0.10);
            expect(calculateMedian([])).toBe(0);
        });
    });

    describe('generateDeviceSuggestion', () => {
        it('suggests lower sensitivity (boost opening) when rise rate is below house median', () => {
            const suggestion = generateDeviceSuggestion({
                currentSensitivity: 100,
                deviceRiseRate: 0.05,
                houseMedianRiseRate: 0.10,
                runsCount: 12,
                dataSpanHours: 50
            });

            expect(suggestion.suggestedSensitivity).toBeLessThan(100);
            expect(suggestion.changeDirection).toBe('INCREASE_OPENING');
            expect(suggestion.confidence).toBe('HIGH');
            expect(suggestion.suggestedSensitivity % 5).toBe(0);
        });

        it('suggests higher sensitivity (reduce opening) when rise rate exceeds median', () => {
            const suggestion = generateDeviceSuggestion({
                currentSensitivity: 80,
                deviceRiseRate: 0.15,
                houseMedianRiseRate: 0.10,
                runsCount: 6,
                dataSpanHours: 20
            });

            expect(suggestion.suggestedSensitivity).toBeGreaterThan(80);
            expect(suggestion.changeDirection).toBe('DECREASE_OPENING');
            expect(suggestion.confidence).toBe('MEDIUM');
        });

        it('suggests max boost (50) for near-zero or cooling rise rates', () => {
            const suggestion = generateDeviceSuggestion({
                currentSensitivity: 100,
                deviceRiseRate: 0.0,
                houseMedianRiseRate: 0.10
            });

            expect(suggestion.suggestedSensitivity).toBe(50);
            expect(suggestion.changeDirection).toBe('INCREASE_OPENING');
        });

        it('factors narrow flow-return ΔT into suggestion when available', () => {
            const normalDelta = generateDeviceSuggestion({
                currentSensitivity: 90,
                deviceRiseRate: 0.08,
                houseMedianRiseRate: 0.10,
                avgCircuitDeltaT: 15
            });

            const narrowDelta = generateDeviceSuggestion({
                currentSensitivity: 90,
                deviceRiseRate: 0.08,
                houseMedianRiseRate: 0.10,
                avgCircuitDeltaT: 5 // Narrow delta T pulls suggestion lower
            });

            expect(narrowDelta.suggestedSensitivity).toBeLessThanOrEqual(normalDelta.suggestedSensitivity);
        });
    });

    describe('analyzeBalancing', () => {
        it('hard refuses when minimum data threshold is not met (<12h or <5 runs)', async () => {
            const mockPool = {
                execute: async (sql) => {
                    if (sql.includes('FROM zones')) {
                        return [[{ id: 1, name: 'Living Room', type: 'HEATING' }]];
                    }
                    if (sql.includes('FROM devices')) {
                        return [[{ serial_no: 'VA001', device_type: 'VA02', zone_id: 1, valve_sensitivity: 100 }]];
                    }
                    if (sql.includes('FROM zone_measurements')) {
                        // Only 2 runs over 4 hours
                        return [[
                            { zone_id: 1, timestamp: '2026-10-09 10:00:00', field_012d: 20, field_40a0: 50, tado_mode: 'HOME' },
                            { zone_id: 1, timestamp: '2026-10-09 10:05:00', field_012d: 20.5, field_40a0: 50, tado_mode: 'HOME' },
                            { zone_id: 1, timestamp: '2026-10-09 10:10:00', field_012d: 21, field_40a0: 50, tado_mode: 'HOME' },
                            { zone_id: 1, timestamp: '2026-10-09 14:00:00', field_012d: 20, field_40a0: 50, tado_mode: 'HOME' },
                            { zone_id: 1, timestamp: '2026-10-09 14:05:00', field_012d: 20.5, field_40a0: 50, tado_mode: 'HOME' },
                            { zone_id: 1, timestamp: '2026-10-09 14:10:00', field_012d: 21, field_40a0: 50, tado_mode: 'HOME' }
                        ]];
                    }
                    if (sql.includes('FROM device_measurements')) {
                        return [[]];
                    }
                    if (sql.includes('FROM circuit_measurements')) {
                        return [[]];
                    }
                    return [[]];
                }
            };

            const result = await analyzeBalancing(12345, { pool: mockPool });
            expect(result.ok).toBe(false);
            expect(result.error).toBe('insufficient_data');
            expect(result.minimumRequired).toEqual({ hours: 12, runs: 5 });
        });

        it('returns comprehensive analysis when data meets requirements', async () => {
            // Generate 6 heating runs over 20 hours
            const zoneRows = [];
            for (let r = 0; r < 6; r++) {
                const baseHour = r * 3; // 0, 3, 6, 9, 12, 15
                const hStr = String(baseHour).padStart(2, '0');
                zoneRows.push(
                    { zone_id: 1, timestamp: `2026-10-09 ${hStr}:00:00`, field_012d: 20.0, field_40a0: 100, tado_mode: 'HOME' },
                    { zone_id: 1, timestamp: `2026-10-09 ${hStr}:05:00`, field_012d: 20.5, field_40a0: 100, tado_mode: 'HOME' },
                    { zone_id: 1, timestamp: `2026-10-09 ${hStr}:10:00`, field_012d: 21.0, field_40a0: 100, tado_mode: 'HOME' }
                );
            }

            const mockPool = {
                execute: async (sql) => {
                    if (sql.includes('FROM zones')) {
                        return [[{ id: 1, name: 'Living Room', type: 'HEATING' }]];
                    }
                    if (sql.includes('FROM devices')) {
                        return [[{ serial_no: 'VA001', device_type: 'VA02', zone_id: 1, valve_sensitivity: 100 }]];
                    }
                    if (sql.includes('FROM zone_measurements')) {
                        return [zoneRows];
                    }
                    if (sql.includes('FROM device_measurements')) {
                        return [[]];
                    }
                    if (sql.includes('FROM circuit_measurements')) {
                        return [[
                            { timestamp: '2026-10-09 00:05:00', field_044c: 60.0, field_044d: 45.0 }
                        ]];
                    }
                    return [[]];
                }
            };

            const result = await analyzeBalancing(12345, { pool: mockPool });
            expect(result.ok).toBe(true);
            expect(result.heatingRunsTotal).toBe(6);
            expect(result.dataSpanHours).toBeGreaterThanOrEqual(12);
            expect(result.zones).toHaveLength(1);
            expect(result.zones[0].devices).toHaveLength(1);
            expect(result.zones[0].devices[0].suggestedSensitivity).toBeGreaterThanOrEqual(50);
            expect(result.zones[0].devices[0].suggestedSensitivity).toBeLessThanOrEqual(100);
            expect(result.avgCircuitDeltaT).toBe(15.0);
        });
    });
});
