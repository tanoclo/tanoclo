/**
 * @file test/test_zone_measurement_dedup.test.js
 * @brief Regressions for sensor and control state in zone measurement deduplication.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

// Keep SQL boundaries local to this test. The shared suite uses isolate:false.
function measurementFixture(previous = {}) {
    const filename = path.resolve(__dirname, '../lib/db-zones/state.js');
    const realRequire = Module.createRequire(filename);
    const inserts = [];
    let latest = {
        timestamp: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
        field_012d: 20, field_0135: 50, field_40a0: 0,
        link_state: 'ONLINE', tado_mode: 'HOME',
        field_61e0: 1, field_6160: 1, field_6240: 2,
        field_6280: 22, field_6200: 22, field_6260: 1,
        field_6020: 1, field_6180: 0, field_62e0: 0,
        field_6440: 0, open_window_detected: 0,
        ...previous
    };
    const pool = {
        async execute(sql, values) {
            if (sql.startsWith('SELECT * FROM zone_measurements')) return [[latest]];
            const insert = /INSERT INTO zone_measurements\s*\(([^)]+)\)/.exec(sql);
            if (insert) {
                const columns = insert[1].split(',').map(column => column.trim());
                latest = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
                inserts.push(latest);
                return [{}];
            }
            if (sql.startsWith('UPDATE zones SET state_etag')) return [{}];
            throw new Error('Unexpected SQL in measurement fixture');
        }
    };
    const context = {
        module: { exports: {} },
        Buffer,
        Date,
        require: name => name === '../db-base'
            ? { getPool: () => pool, _log: () => {}, generateEtag: () => Buffer.alloc(16) }
            : realRequire(name)
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    return { state: context.module.exports, inserts };
}

describe('zone measurement deduplication', () => {
    test('a target correction is stored when sensor readings have not changed', async () => {
        const fixture = measurementFixture();
        await fixture.state.insertMergedZoneMeasurement(1, 1, { '0x6280': 21 });
        expect(fixture.inserts).toHaveLength(1);
        expect(fixture.inserts[0].field_6280).toBe(21);
    });

    test.each([
        ['0x61e0', 'field_61e0', 0],
        ['0x6160', 'field_6160', 2],
        ['0x6240', 'field_6240', 0],
        ['0x6280', 'field_6280', 21],
        ['0x6200', 'field_6200', 19],
        ['0x6260', 'field_6260', 0],
        ['0x6020', 'field_6020', 2],
        ['0x6180', 'field_6180', 1],
        ['0x62e0', 'field_62e0', 1],
        ['0x6440', 'field_6440', 1],
        ['open_window_detected', 'open_window_detected', 1],
        ['link_state', 'link_state', 'OFFLINE'],
        ['tado_mode', 'tado_mode', 'AWAY']
    ])('preserves a change to %s', async (field, column, value) => {
        const fixture = measurementFixture();
        await fixture.state.insertMergedZoneMeasurement(1, 1, { [field]: value });
        expect(fixture.inserts).toHaveLength(1);
        expect(fixture.inserts[0][column]).toBe(value);
    });

    test('field-name updates are compared as well as hexadecimal keys', async () => {
        const fixture = measurementFixture();
        await fixture.state.insertMergedZoneMeasurement(1, 1, { field_6280: 21 });
        expect(fixture.inserts[0].field_6280).toBe(21);
    });

    test('identical sensor and control state remains deduplicated', async () => {
        const fixture = measurementFixture();
        await fixture.state.insertMergedZoneMeasurement(1, 1, {
            '0x012d': 20, '0x0135': 50, '0x40a0': 0, '0x6280': 22
        });
        expect(fixture.inserts).toHaveLength(0);
    });

    test('decimal strings and equivalent numeric values remain duplicates', async () => {
        const fixture = measurementFixture({ field_012d: '20.00', field_6280: '22.00' });
        await fixture.state.insertMergedZoneMeasurement(1, 1, { '0x012d': 20, '0x6280': 22 });
        expect(fixture.inserts).toHaveLength(0);
    });

    test('zero is not deduplicated against a missing sensor value', async () => {
        const fixture = measurementFixture({ field_012d: null });
        await fixture.state.insertMergedZoneMeasurement(1, 1, { '0x012d': 0 });
        expect(fixture.inserts).toHaveLength(1);
        expect(fixture.inserts[0].field_012d).toBe(0);
    });

    test('unchanged samples outside the deduplication window are still stored', async () => {
        const fixture = measurementFixture({
            timestamp: new Date(Date.now() - 30000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
        });
        await fixture.state.insertMergedZoneMeasurement(1, 1, { '0x012d': 20 });
        expect(fixture.inserts).toHaveLength(1);
    });

    test('later demand-only telemetry retains an immediately corrected target', async () => {
        const fixture = measurementFixture();
        await fixture.state.insertMergedZoneMeasurement(1, 1, { '0x6280': 21 });
        await fixture.state.insertZoneDemand(1, 1, 10);
        expect(fixture.inserts).toHaveLength(2);
        expect(fixture.inserts[1].field_6280).toBe(21);
        expect(fixture.inserts[1].field_40a0).toBe(10);
    });
});
