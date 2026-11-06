/**
 * @file test/test_unit_mold_detector.test.js
 * @brief Vitest unit tests for building physics and VTT Mold Growth Model engine.
 */

'use strict';

import { describe, it, expect } from 'vitest';
import moldDetector from '../lib/mold-detector.js';

describe('Mold Detector Unit Tests', () => {
    describe('calculateDewPoint', () => {
        it('calculates standard dew point accurately against psychrometric benchmarks', () => {
            // Benchmark: 20°C @ 50% RH -> ~9.27°C
            const dp1 = moldDetector.calculateDewPoint(20.0, 50.0);
            expect(dp1).toBeCloseTo(9.27, 1);

            // Benchmark: 25°C @ 80% RH -> ~21.3°C
            const dp2 = moldDetector.calculateDewPoint(25.0, 80.0);
            expect(dp2).toBeCloseTo(21.3, 1);

            // 100% RH: Dew point equals dry bulb temperature
            const dp3 = moldDetector.calculateDewPoint(18.0, 100.0);
            expect(dp3).toBeCloseTo(18.0, 1);
        });

        it('handles null and invalid inputs gracefully', () => {
            expect(moldDetector.calculateDewPoint(null, 50)).toBeNull();
            expect(moldDetector.calculateDewPoint(20, null)).toBeNull();
        });
    });

    describe('calculateRhCrit', () => {
        it('returns 80% for temperatures above 20°C', () => {
            expect(moldDetector.calculateRhCrit(21.0)).toBe(80.0);
            expect(moldDetector.calculateRhCrit(28.0)).toBe(80.0);
        });

        it('returns temperature-dependent curve for T <= 20°C', () => {
            // At 20°C: curve evaluates to ~80%
            expect(moldDetector.calculateRhCrit(20.0)).toBeCloseTo(80.0, 1);

            // At 10°C: higher RH is required to grow mold
            const rh10 = moldDetector.calculateRhCrit(10.0);
            expect(rh10).toBeGreaterThan(80.0);
            expect(rh10).toBeLessThan(90.0);

            // At 5°C: even higher RH required
            const rh5 = moldDetector.calculateRhCrit(5.0);
            expect(rh5).toBeGreaterThan(rh10);
        });

        it('returns 100% for frozen temperatures T <= 0', () => {
            expect(moldDetector.calculateRhCrit(0.0)).toBe(100.0);
            expect(moldDetector.calculateRhCrit(-5.0)).toBe(100.0);
        });
    });

    describe('getEffectiveInsulationFactor', () => {
        it('uses zone override when specified', () => {
            expect(moldDetector.getEffectiveInsulationFactor(0.70, 0.55)).toBe(0.55);
            expect(moldDetector.getEffectiveInsulationFactor(0.85, 0.60)).toBe(0.60);
        });

        it('falls back to home factor when zone is null or undefined', () => {
            expect(moldDetector.getEffectiveInsulationFactor(0.85, null)).toBe(0.85);
            expect(moldDetector.getEffectiveInsulationFactor(0.55, undefined)).toBe(0.55);
        });

        it('falls back to default 0.70 when both are null', () => {
            expect(moldDetector.getEffectiveInsulationFactor(null, null)).toBe(0.70);
        });

        it('clamps values between 0.40 and 0.95', () => {
            expect(moldDetector.getEffectiveInsulationFactor(null, 0.10)).toBe(0.40);
            expect(moldDetector.getEffectiveInsulationFactor(null, 1.20)).toBe(0.95);
        });
    });

    describe('calculateSurfaceConditions (ISO 13788)', () => {
        it('calculates wall surface temperature and increased surface RH on cold exterior walls', () => {
            // Indoor 20°C, 60% RH; Outdoor 0°C; Standard insulation f_Rsi = 0.70
            // Surface temp: 20 - (1 - 0.70) * (20 - 0) = 14°C
            const res = moldDetector.calculateSurfaceConditions(20.0, 60.0, 0.0, 0.70);

            expect(res.surfaceTemp).toBe(14.0);
            // When air cools from 20°C to 14°C, relative humidity increases dramatically:
            // pSat(20) ~ 2338 Pa -> pVapor ~ 1403 Pa; pSat(14) ~ 1598 Pa -> RH ~ 87.8%
            expect(res.surfaceHumidity).toBeGreaterThan(80.0);
            expect(res.surfaceHumidity).toBeLessThan(92.0);
            expect(res.dewPoint).toBeCloseTo(12.0, 1);
            expect(res.condensationMargin).toBeCloseTo(2.0, 1);
        });

        it('detects acute condensation risk when surface temperature reaches dew point', () => {
            // Indoor 22°C, 75% RH (dew point ~17.3°C); Poor insulation f_Rsi = 0.50; Outdoor -2°C
            // Surface temp: 22 - 0.5 * (22 - (-2)) = 10°C (far below dew point 17.3°C!)
            const res = moldDetector.calculateSurfaceConditions(22.0, 75.0, -2.0, 0.50);

            expect(res.surfaceTemp).toBeLessThan(res.dewPoint);
            expect(res.condensationRisk).toBe(true);
        });
    });

    describe('calculateVttStep', () => {
        it('increases mold index M under warm, humid conditions exceeding RHcrit', () => {
            // T = 22°C, RH = 92% (well above RHcrit = 80%)
            let m = 0.0;
            for (let i = 0; i < 24; i++) {
                m = moldDetector.calculateVttStep(m, 22.0, 92.0, 1.0);
            }
            expect(m).toBeGreaterThan(0.0);
        });

        it('decreases mold index M during dry conditions below RHcrit', () => {
            // Initial M = 1.5; Dry conditions: T = 20°C, RH = 35%
            let m = 1.5;
            for (let i = 0; i < 48; i++) {
                m = moldDetector.calculateVttStep(m, 20.0, 35.0, 1.0);
            }
            expect(m).toBeLessThan(1.5);
            expect(m).toBeGreaterThanOrEqual(0.0);
        });

        it('does not grow when temperature is freezing', () => {
            let m = 0.0;
            for (let i = 0; i < 24; i++) {
                m = moldDetector.calculateVttStep(m, -2.0, 95.0, 1.0);
            }
            expect(m).toBe(0.0);
        });
    });
});
