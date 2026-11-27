/**
 * @file test/test_boiler_cycle_tracker.test.js
 * @brief Unit tests for boiler-cycle-tracker ignition detection and cycle logging.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import boilerCycleTracker from '../lib/boiler-cycle-tracker';

describe('Boiler Cycle Tracker', () => {
    let mockPool;

    beforeEach(() => {
        mockPool = {
            execute: vi.fn().mockResolvedValue([{ insertId: 1 }])
        };
        boilerCycleTracker.init({ getPool: () => mockPool });
    });

    it('starts, tracks, and logs a Central Heating cycle on flame transition', async () => {
        const homeId = 99999;
        const circuit = 1;

        // 1. Ignition start: flame 1, demand 50, mode 1
        await boilerCycleTracker.onMeasurement(homeId, circuit, {
            timestamp: '2026-11-23 10:00:00',
            field_0457: 1,
            field_0452: 40,
            field_044c: 45.0,
            field_044d: 35.0,
            field_4080: 50,
            field_2090: 1,
            field_045e: 0,
            field_0463: 100,
            field_0467: 10,
            field_0468: 5
        });

        const active = boilerCycleTracker.getActiveCycle(homeId, circuit);
        expect(active).not.toBeNull();
        expect(active.cycleType).toBe('CH');
        expect(active.startFlowTemp).toBe(45.0);
        expect(active.maxModulation).toBe(40);

        // 2. Mid-cycle telemetry: modulation increases, temp rises
        await boilerCycleTracker.onMeasurement(homeId, circuit, {
            timestamp: '2026-11-23 10:05:00',
            field_0457: 1,
            field_0452: 80,
            field_044c: 55.0,
            field_044d: 42.0,
            field_4080: 50,
            field_2090: 1
        });

        expect(active.maxFlowTemp).toBe(55.0);
        expect(active.maxModulation).toBe(80);

        // 3. Flame extinguishes after 10 minutes (600s)
        await boilerCycleTracker.onMeasurement(homeId, circuit, {
            timestamp: '2026-11-23 10:10:00',
            field_0457: 0,
            field_0452: 0,
            field_044c: 50.0,
            field_044d: 45.0
        });

        expect(boilerCycleTracker.getActiveCycle(homeId, circuit)).toBeNull();
        expect(mockPool.execute).toHaveBeenCalledTimes(1);

        const [sql, params] = mockPool.execute.mock.calls[0];
        expect(sql).toContain('INSERT INTO boiler_cycles');
        expect(params[0]).toBe(homeId); // home_id
        expect(params[1]).toBe(circuit); // circuit_number
        expect(params[2]).toBe('2026-11-23 10:00:00'); // start_time
        expect(params[3]).toBe('2026-11-23 10:10:00'); // end_time
        expect(params[4]).toBe(600); // duration_seconds = 10 min
        expect(params[5]).toBe('CH'); // cycle_type
        expect(params[6]).toBe(45.0); // start_flow_temp
        expect(params[7]).toBe(55.0); // max_flow_temp
        expect(params[8]).toBe(50.0); // end_flow_temp
        expect(params[12]).toBe(60); // avg_modulation = (40 + 80) / 2 = 60%
        expect(params[13]).toBe(80); // max_modulation
    });

    it('classifies cycle as KEEP_WARM when no space heating demand or circuit is standby', async () => {
        const homeId = 99999;
        const circuit = 1;

        // Flame on while demand is 0 and mode is 0 (standby)
        await boilerCycleTracker.onMeasurement(homeId, circuit, {
            timestamp: '2026-11-23 11:00:00',
            field_0457: 1,
            field_0452: 50,
            field_044c: 40.0,
            field_4080: 0,
            field_2090: 0,
            field_045e: 0
        });

        const active = boilerCycleTracker.getActiveCycle(homeId, circuit);
        expect(active).not.toBeNull();
        expect(active.cycleType).toBe('KEEP_WARM');

        // Flame off after 60s
        await boilerCycleTracker.onMeasurement(homeId, circuit, {
            timestamp: '2026-11-23 11:01:00',
            field_0457: 0,
            field_0452: 0,
            field_044c: 48.0
        });

        expect(mockPool.execute).toHaveBeenCalledTimes(1);
        const [, params] = mockPool.execute.mock.calls[0];
        expect(params[4]).toBe(60); // 60s
        expect(params[5]).toBe('KEEP_WARM');
    });

    it('classifies cycle as DHW when tap flow rate is positive', async () => {
        const homeId = 99999;
        const circuit = 1;

        await boilerCycleTracker.onMeasurement(homeId, circuit, {
            timestamp: '2026-11-23 12:00:00',
            field_0457: 1,
            field_0452: 100,
            field_044c: 60.0,
            field_045e: 6.5 // Active tap draw
        });

        const active = boilerCycleTracker.getActiveCycle(homeId, circuit);
        expect(active).not.toBeNull();
        expect(active.cycleType).toBe('DHW');

        await boilerCycleTracker.onMeasurement(homeId, circuit, {
            timestamp: '2026-11-23 12:03:00',
            field_0457: 0,
            field_0452: 0
        });

        expect(mockPool.execute).toHaveBeenCalledTimes(1);
        const [, params] = mockPool.execute.mock.calls[0];
        expect(params[4]).toBe(180);
        expect(params[5]).toBe('DHW');
    });

    it('ignores micro-glitches under 5 seconds', async () => {
        const homeId = 99999;
        const circuit = 1;

        await boilerCycleTracker.onMeasurement(homeId, circuit, {
            timestamp: '2026-11-23 13:00:00',
            field_0457: 1,
            field_0452: 20
        });

        await boilerCycleTracker.onMeasurement(homeId, circuit, {
            timestamp: '2026-11-23 13:00:02', // 2 seconds later
            field_0457: 0,
            field_0452: 0
        });

        expect(mockPool.execute).not.toHaveBeenCalled();
    });
});
