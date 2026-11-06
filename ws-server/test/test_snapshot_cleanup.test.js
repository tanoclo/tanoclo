/**
 * @file test/test_snapshot_cleanup.test.js
 * @brief Unit tests for balancing and PID tuning snapshot retention pruning.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import db from '../lib/db';
import {
    pruneBalancingSnapshots,
    prunePidTuningSnapshots
} from '../lib/snapshot-cleanup';

describe('Snapshot Retention Pruning', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });
    it('prunes balancing snapshots older than maxDays and beyond maxKeep while preserving latest applied', async () => {
        const deletedIds = [];
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;

        const mockSnapshots = [
            { id: 10, created_at: new Date(now - 0.5 * oneDay).toISOString() }, // Keep (recent #1)
            { id: 9, created_at: new Date(now - 1.0 * oneDay).toISOString() },  // Keep (recent #2)
            { id: 8, created_at: new Date(now - 1.5 * oneDay).toISOString() },  // Keep (recent #3)
            { id: 7, created_at: new Date(now - 2.0 * oneDay).toISOString() },  // Keep (recent #4)
            { id: 6, created_at: new Date(now - 2.5 * oneDay).toISOString() },  // Keep (recent #5)
            { id: 5, created_at: new Date(now - 2.8 * oneDay).toISOString() },  // Delete (beyond max 5)
            { id: 4, created_at: new Date(now - 5.0 * oneDay).toISOString() },  // Delete (old > 3 days)
            { id: 2, created_at: new Date(now - 10.0 * oneDay).toISOString() }  // Preserve because applied!
        ];

        const mockPool = {
            execute: async (sql, params) => {
                if (sql.includes('SELECT id FROM balancing_snapshots') && sql.includes('applied = 1')) {
                    // id 2 is the latest applied snapshot
                    return [[{ id: 2 }]];
                }
                if (sql.includes('SELECT id, created_at FROM balancing_snapshots')) {
                    return [mockSnapshots];
                }
                if (sql.includes('DELETE FROM balancing_snapshots')) {
                    deletedIds.push(...params);
                    return [{ affectedRows: params.length }];
                }
                return [[]];
            }
        };

        await pruneBalancingSnapshots(123, { pool: mockPool, maxKeep: 5, maxDays: 3 });

        expect(deletedIds).toContain(5);
        expect(deletedIds).toContain(4);
        expect(deletedIds).not.toContain(2); // Never delete active applied snapshot
        expect(deletedIds).not.toContain(10);
        expect(deletedIds).not.toContain(9);
    });

    it('prunes PID tuning snapshots according to retention rules', async () => {
        const deletedIds = [];
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;

        const mockSnapshots = [
            { id: 20, created_at: new Date(now - 0.2 * oneDay).toISOString() },
            { id: 19, created_at: new Date(now - 0.4 * oneDay).toISOString() },
            { id: 18, created_at: new Date(now - 4.0 * oneDay).toISOString() } // > 3 days old
        ];

        const mockPool = {
            execute: async (sql, params) => {
                if (sql.includes('SELECT id FROM pid_tuning_snapshots') && sql.includes('applied = 1')) {
                    return [[]];
                }
                if (sql.includes('SELECT id, created_at FROM pid_tuning_snapshots')) {
                    return [mockSnapshots];
                }
                if (sql.includes('DELETE FROM pid_tuning_snapshots')) {
                    deletedIds.push(...params);
                    return [{ affectedRows: params.length }];
                }
                return [[]];
            }
        };

        await prunePidTuningSnapshots(123, { pool: mockPool, maxKeep: 5, maxDays: 3 });

        expect(deletedIds).toEqual([18]);
    });
});
