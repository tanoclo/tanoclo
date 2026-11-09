'use strict';

const assert = require('assert');

describe('Anti-seize Valve Exercise', () => {
    const db = require('../lib/db');
    const commandApi = require('../lib/command-api');
    const realGetPool = db.getPool;
    const realPushMountCalibration = commandApi.pushMountCalibration;

    let pushedCalibrations = [];
    let updatedRows = [];
    let mockDevices = [];
    let mockHomes = [];

    const fakePool = {
        execute: async (sql, params = []) => {
            if (/SELECT\s+d\.serial_no/i.test(sql)) {
                const [homeId, deviceId] = params;
                const found = mockDevices.find(d => d.serial_no === deviceId && d.home_id === homeId);
                return [found ? [{ ...found }] : []];
            }
            if (/SELECT\s+serial_no.*?FROM\s+devices\s+WHERE\s+home_id/i.test(sql)) {
                const [homeId] = params;
                const found = mockDevices.filter(d => d.home_id === homeId && d.serial_no.startsWith('VA'));
                return [found.map(d => ({ serial_no: d.serial_no, auto_valve_exercise_enabled: d.auto_valve_exercise_enabled ?? 1 }))];
            }
            if (/SELECT\s+id,\s+date_time_zone,\s+auto_valve_exercise_enabled/i.test(sql)) {
                return [mockHomes.map(h => ({ ...h }))];
            }
            if (/SELECT\s+MAX\(last_exercised_at\)/i.test(sql)) {
                return [[{ last_run: null }]];
            }
            if (/UPDATE\s+devices\s+SET\s+last_exercised_at/i.test(sql)) {
                const [serial, homeId] = params;
                updatedRows.push({ serial, homeId });
                return [{ affectedRows: 1 }];
            }
            return [[]];
        }
    };

    let valveExercise;

    beforeAll(() => {
        db.getPool = () => fakePool;
        commandApi.pushMountCalibration = async (deviceId, action) => {
            pushedCalibrations.push({ deviceId, action });
            return { ok: true };
        };
        valveExercise = require('../lib/valve-exercise');
    });

    afterAll(() => {
        db.getPool = realGetPool;
        commandApi.pushMountCalibration = realPushMountCalibration;
    });

    beforeEach(() => {
        pushedCalibrations = [];
        updatedRows = [];
        mockDevices = [];
        mockHomes = [];
    });

    test('rejects non-valve devices', async () => {
        const res = await valveExercise.exerciseValve('RU1234567890', 1);
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.status, 'skipped');
        assert.strictEqual(res.reason, 'not_a_valve');
        assert.strictEqual(pushedCalibrations.length, 0);
    });

    test('returns skipped if device not found in home', async () => {
        const res = await valveExercise.exerciseValve('VA1234567890', 1);
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.status, 'skipped');
        assert.strictEqual(res.reason, 'device_not_found');
    });

    test('safety lockout: skips offline valve when not forced', async () => {
        mockDevices.push({
            serial_no: 'VA1234567890',
            device_type: 'VA02',
            home_id: 1,
            zone_id: 10,
            connection_state: 0,
            battery_state: 'NORMAL',
            battery_percent: 90,
            latest_demand: 0
        });

        const res = await valveExercise.exerciseValve('VA1234567890', 1);
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.reason, 'device_offline');
        assert.strictEqual(pushedCalibrations.length, 0);

        // Can bypass with force = true
        const forced = await valveExercise.exerciseValve('VA1234567890', 1, { force: true });
        assert.strictEqual(forced.ok, true);
        assert.strictEqual(pushedCalibrations.length, 1);
    });

    test('safety lockout: skips low battery valve (< 15% or battery_state LOW)', async () => {
        mockDevices.push({
            serial_no: 'VA1234567891',
            device_type: 'VA02',
            home_id: 1,
            zone_id: 10,
            connection_state: 1,
            battery_state: 'LOW',
            battery_percent: 10,
            latest_demand: 0
        });

        const res = await valveExercise.exerciseValve('VA1234567891', 1);
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.reason, 'low_battery');
        assert.strictEqual(pushedCalibrations.length, 0);

        // Force override allows battery maintenance test
        const forced = await valveExercise.exerciseValve('VA1234567891', 1, { force: true });
        assert.strictEqual(forced.ok, true);
        assert.strictEqual(pushedCalibrations.length, 1);
    });

    test('safety lockout: skips valve if zone is actively heating (demand > 0)', async () => {
        mockDevices.push({
            serial_no: 'VA1234567892',
            device_type: 'VA02',
            home_id: 1,
            zone_id: 10,
            connection_state: 1,
            battery_state: 'NORMAL',
            battery_percent: 85,
            latest_demand: 45 // 45% heating demand
        });

        const res = await valveExercise.exerciseValve('VA1234567892', 1);
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.reason, 'zone_heating');
        assert.strictEqual(pushedCalibrations.length, 0);
    });

    test('successfully exercises eligible valve and updates database', async () => {
        mockDevices.push({
            serial_no: 'VA1234567893',
            device_type: 'VA02',
            home_id: 1,
            zone_id: 10,
            connection_state: 1,
            battery_state: 'NORMAL',
            battery_percent: 85,
            latest_demand: 0
        });

        const res = await valveExercise.exerciseValve('VA1234567893', 1);
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.status, 'exercised');
        assert.ok(res.exercisedAt);
        assert.strictEqual(pushedCalibrations.length, 1);
        assert.strictEqual(pushedCalibrations[0].deviceId, 'VA1234567893');
        assert.strictEqual(pushedCalibrations[0].action, 'start');
        assert.strictEqual(updatedRows.length, 1);
        assert.strictEqual(updatedRows[0].serial, 'VA1234567893');
    });

    test('exerciseHomeValves staggers execution across home valves', async () => {
        mockDevices.push(
            {
                serial_no: 'VA0000000001',
                device_type: 'VA02',
                home_id: 1,
                zone_id: 1,
                connection_state: 1,
                battery_state: 'NORMAL',
                battery_percent: 90,
                latest_demand: 0
            },
            {
                serial_no: 'VA0000000002',
                device_type: 'VA02',
                home_id: 1,
                zone_id: 2,
                connection_state: 1,
                battery_state: 'NORMAL',
                battery_percent: 85,
                latest_demand: 0
            }
        );

        // Use staggerMs = 5 for fast unit test execution
        const summary = await valveExercise.exerciseHomeValves(1, { staggerMs: 5 });
        assert.strictEqual(summary.total, 2);
        assert.strictEqual(summary.exercised, 2);
        assert.strictEqual(summary.skipped.length, 0);
        assert.strictEqual(pushedCalibrations.length, 2);
        assert.strictEqual(pushedCalibrations[0].deviceId, 'VA0000000001');
        assert.strictEqual(pushedCalibrations[1].deviceId, 'VA0000000002');
    });

    test('monthly cron check respects auto_valve_exercise_enabled flag', async () => {
        mockHomes.push(
            { id: 1, date_time_zone: 'Europe/Amsterdam', auto_valve_exercise_enabled: 0 },
            { id: 2, date_time_zone: 'Europe/Amsterdam', auto_valve_exercise_enabled: 1 }
        );

        // Pass a mock Date corresponding to 1st of month at 11:00 AM
        // Note: Months in JS Date are 0-indexed (10 = November)
        const mockFirstOfMonth = new Date(Date.UTC(2026, 10, 1, 10, 0, 0)); // 11:00 CET

        mockDevices.push({
            serial_no: 'VA0000000002',
            device_type: 'VA02',
            home_id: 2,
            zone_id: 2,
            connection_state: 1,
            battery_state: 'NORMAL',
            battery_percent: 80,
            latest_demand: 0
        });

        const results = await valveExercise.checkMonthlyValveExercise(mockFirstOfMonth);
        // Home 1 was skipped because auto_valve_exercise_enabled is 0
        assert.strictEqual(results[1].status, 'skipped_disabled');
        // Home 2 was triggered
        assert.strictEqual(results[2].status, 'triggered');
    });
});
