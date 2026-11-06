/**
 * @file test/test_gas_energy_analyzer.test.js
 * @brief Unit tests for gas energy usage, cost tracking, DHW differentiation, and room apportionment.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    getHomeEnergySettings,
    saveHomeEnergySettings,
    recordGasMeterReading,
    getGasUsageAndCosts,
    getDailyGasSummary
} from '../lib/gas-energy-analyzer';

describe('Gas Energy Analyzer', () => {
    let mockPool;

    beforeEach(() => {
        mockPool = {
            execute: vi.fn()
        };
    });

    describe('getHomeEnergySettings and saveHomeEnergySettings', () => {
        it('returns default settings when home has no saved settings', async () => {
            mockPool.execute.mockResolvedValueOnce([[]]);
            const settings = await getHomeEnergySettings(mockPool, 1);

            expect(settings.home_id).toBe(1);
            expect(settings.gas_unit_cost).toBe(1.45);
            expect(settings.currency).toBe('€');
            expect(settings.allocation_method).toBe('demand');
            expect(settings.calorific_value_kwh_per_m3).toBe(10.0);
        });

        it('returns configured settings from database', async () => {
            mockPool.execute.mockResolvedValueOnce([[{
                home_id: 1,
                gas_meter_topic: 'home/gas/meter',
                gas_cost_topic: 'home/gas/cost',
                gas_unit_cost: '1.2500',
                currency: '£',
                allocation_method: 'area_weighted',
                calorific_value_kwh_per_m3: '10.50'
            }]]);

            const settings = await getHomeEnergySettings(mockPool, 1);
            expect(settings.gas_meter_topic).toBe('home/gas/meter');
            expect(settings.gas_cost_topic).toBe('home/gas/cost');
            expect(settings.gas_unit_cost).toBe(1.25);
            expect(settings.currency).toBe('£');
            expect(settings.allocation_method).toBe('area_weighted');
            expect(settings.calorific_value_kwh_per_m3).toBe(10.5);
        });

        it('saves and updates settings with proper defaults', async () => {
            mockPool.execute
                .mockResolvedValueOnce([{ affectedRows: 1 }]) // insert
                .mockResolvedValueOnce([[{
                    home_id: 2,
                    gas_meter_topic: 'custom/meter',
                    gas_cost_topic: 'custom/cost',
                    gas_unit_cost: '1.5000',
                    currency: '$',
                    allocation_method: 'demand',
                    calorific_value_kwh_per_m3: '10.00'
                }]]);

            const res = await saveHomeEnergySettings(mockPool, 2, {
                gas_meter_topic: 'custom/meter',
                gas_cost_topic: 'custom/cost',
                gas_unit_cost: 1.50,
                currency: '$'
            });

            expect(mockPool.execute).toHaveBeenCalledTimes(2);
            expect(res.currency).toBe('$');
            expect(res.gas_unit_cost).toBe(1.50);
        });
    });

    describe('recordGasMeterReading', () => {
        it('throws an error on invalid or negative meter reading', async () => {
            await expect(recordGasMeterReading(mockPool, 1, -5)).rejects.toThrow('Invalid meter reading');
            await expect(recordGasMeterReading(mockPool, 1, 'invalid')).rejects.toThrow('Invalid meter reading');
        });

        it('records valid meter reading and updates unit cost if provided', async () => {
            mockPool.execute
                .mockResolvedValueOnce([{ insertId: 42 }]) // insert reading
                .mockResolvedValueOnce([{ affectedRows: 1 }]); // update unit cost

            const reading = await recordGasMeterReading(mockPool, 1, 1500.55, 1.35, 'mqtt');
            expect(reading.id).toBe(42);
            expect(reading.meterM3).toBe(1500.55);
            expect(reading.unitCost).toBe(1.35);
            expect(mockPool.execute).toHaveBeenCalledTimes(2);
        });
    });

    describe('getGasUsageAndCosts', () => {
        it('calculates consumption and splits DHW vs Space Heating using OpenTherm telemetry', async () => {
            // Settings query
            mockPool.execute.mockResolvedValueOnce([[{
                home_id: 1,
                gas_unit_cost: 1.50,
                currency: '€',
                allocation_method: 'demand',
                calorific_value_kwh_per_m3: 10.0
            }]]);

            // Meter readings: 2 readings with delta = 10 m³
            mockPool.execute.mockResolvedValueOnce([[
                { timestamp: '2026-11-06 00:00:00', meter_m3: '1000.000', unit_cost: 1.50 },
                { timestamp: '2026-11-06 12:00:00', meter_m3: '1010.000', unit_cost: 1.50 }
            ]]);

            // Circuit measurements:
            // 1000s DHW (field_045e = 5.0, field_0457 = 1)
            // 3000s Space Heating (field_045e = 0, field_0457 = 1)
            // Total demand seconds = 4000s -> 25% DHW, 75% CH
            mockPool.execute.mockResolvedValueOnce([[
                { timestamp: '2026-11-06 01:00:00', field_0457: 1, field_0452: 100, field_045e: 5.0 },
                { timestamp: '2026-11-06 01:16:40', field_0457: 0, field_0452: 0, field_045e: 0 },
                { timestamp: '2026-11-06 04:00:00', field_0457: 1, field_0452: 100, field_045e: 0 },
                { timestamp: '2026-11-06 04:50:00', field_0457: 0, field_0452: 0, field_045e: 0 }
            ]]);

            // Boiler capacity
            mockPool.execute.mockResolvedValueOnce([[{ boiler_capacity_kw: 24.0 }]]);

            // Heating zones
            mockPool.execute.mockResolvedValueOnce([[
                { id: 1, name: 'Living Room', room_size_sqm: 30, heating_type: 'RADIATOR' },
                { id: 2, name: 'Bedroom', room_size_sqm: 15, heating_type: 'RADIATOR' }
            ]]);

            // Zone measurements: Zone 1 has 3000s @ 100% duty; Zone 2 has 1000s @ 100% duty (3:1 ratio)
            mockPool.execute.mockResolvedValueOnce([[
                { zone_id: 1, timestamp: '2026-11-06 04:00:00', field_40a0: 100 },
                { zone_id: 1, timestamp: '2026-11-06 04:50:00', field_40a0: 0 },
                { zone_id: 2, timestamp: '2026-11-06 04:00:00', field_40a0: 100 },
                { zone_id: 2, timestamp: '2026-11-06 04:16:40', field_40a0: 0 }
            ]]);

            const from = new Date('2026-11-06T00:00:00Z');
            const to = new Date('2026-11-06T12:00:00Z');
            const result = await getGasUsageAndCosts(mockPool, 1, from, to);

            expect(result.totals.totalM3).toBe(10.0);
            expect(result.totals.totalCost).toBe(15.0); // 10 * 1.50
            expect(result.totals.totalKwh).toBe(100.0);

            // DHW (25% = 2.5 m³, €3.75)
            expect(result.dhw.m3).toBe(2.5);
            expect(result.dhw.cost).toBe(3.75);
            expect(result.dhw.percentage).toBe(25.0);

            // Heating (75% = 7.5 m³, €11.25)
            expect(result.heating.m3).toBe(7.5);
            expect(result.heating.cost).toBe(11.25);
            expect(result.heating.percentage).toBe(75.0);

            // Zone breakdown (3:1 ratio = 75% Zone 1, 25% Zone 2)
            expect(result.zones.length).toBe(2);
            const z1 = result.zones.find(z => z.id === 1);
            const z2 = result.zones.find(z => z.id === 2);

            expect(z1.percentage).toBe(75.0);
            expect(z1.m3).toBe(5.625);
            expect(z1.cost).toBe(8.44);

            expect(z2.percentage).toBe(25.0);
            expect(z2.m3).toBe(1.875);
            expect(z2.cost).toBe(2.81);
        });

        it('supports area-weighted room allocation', async () => {
            // Settings with allocation_method: 'area_weighted'
            mockPool.execute.mockResolvedValueOnce([[{
                home_id: 1,
                gas_unit_cost: 1.00,
                currency: '€',
                allocation_method: 'area_weighted',
                calorific_value_kwh_per_m3: 10.0
            }]]);

            // Meter readings: delta = 10 m³
            mockPool.execute.mockResolvedValueOnce([[
                { timestamp: '2026-11-06 00:00:00', meter_m3: '1000.000', unit_cost: 1.00 },
                { timestamp: '2026-11-06 12:00:00', meter_m3: '1010.000', unit_cost: 1.00 }
            ]]);

            // Circuit measurements: only CH firing
            mockPool.execute.mockResolvedValueOnce([[
                { timestamp: '2026-11-06 01:00:00', field_0457: 1, field_0452: 100, field_045e: 0 },
                { timestamp: '2026-11-06 02:00:00', field_0457: 0, field_0452: 0, field_045e: 0 }
            ]]);

            // Boiler capacity
            mockPool.execute.mockResolvedValueOnce([[{ boiler_capacity_kw: 24.0 }]]);

            // Heating zones: Zone 1 (40 m²), Zone 2 (20 m²)
            mockPool.execute.mockResolvedValueOnce([[
                { id: 1, name: 'Main Hall', room_size_sqm: 40, heating_type: 'RADIATOR' },
                { id: 2, name: 'Office', room_size_sqm: 20, heating_type: 'RADIATOR' }
            ]]);

            // Both zones ran for same duration (1000s @ 100% duty)
            // Weight Z1 = 1000 * 40 = 40000; Weight Z2 = 1000 * 20 = 20000 (2:1 ratio)
            mockPool.execute.mockResolvedValueOnce([[
                { zone_id: 1, timestamp: '2026-11-06 01:00:00', field_40a0: 100 },
                { zone_id: 1, timestamp: '2026-11-06 01:16:40', field_40a0: 0 },
                { zone_id: 2, timestamp: '2026-11-06 01:00:00', field_40a0: 100 },
                { zone_id: 2, timestamp: '2026-11-06 01:16:40', field_40a0: 0 }
            ]]);

            const from = new Date('2026-11-06T00:00:00Z');
            const to = new Date('2026-11-06T12:00:00Z');
            const result = await getGasUsageAndCosts(mockPool, 1, from, to);

            const z1 = result.zones.find(z => z.id === 1);
            const z2 = result.zones.find(z => z.id === 2);

            expect(z1.percentage).toBe(66.7);
            expect(z2.percentage).toBe(33.3);
        });

        it('falls back to boiler capacity estimation when no meter readings are found', async () => {
            mockPool.execute.mockResolvedValueOnce([[{
                home_id: 1,
                gas_unit_cost: 1.50,
                currency: '€',
                allocation_method: 'demand',
                calorific_value_kwh_per_m3: 10.0
            }]]);

            // No meter readings
            mockPool.execute.mockResolvedValueOnce([[]]);
            mockPool.execute.mockResolvedValueOnce([[]]);

            // Circuit measurements: 1 hour firing at 100% modulation (3600 seconds)
            mockPool.execute.mockResolvedValueOnce([[
                { timestamp: '2026-11-06 01:00:00', field_0457: 1, field_0452: 100, field_045e: 0 },
                { timestamp: '2026-11-06 02:00:00', field_0457: 0, field_0452: 0, field_045e: 0 }
            ]]);

            // Boiler capacity: 20 kW -> 20 kWh in 1 hour -> 20 / 10 = 2.0 m³
            mockPool.execute.mockResolvedValueOnce([[{ boiler_capacity_kw: 20.0 }]]);
            mockPool.execute.mockResolvedValueOnce([[]]); // No zones

            const from = new Date('2026-11-06T00:00:00Z');
            const to = new Date('2026-11-06T12:00:00Z');
            const result = await getGasUsageAndCosts(mockPool, 1, from, to);

            expect(result.meterReading.isEstimated).toBe(true);
            expect(result.totals.totalM3).toBe(2.0);
            expect(result.totals.totalCost).toBe(3.0);
        });
    });
});
