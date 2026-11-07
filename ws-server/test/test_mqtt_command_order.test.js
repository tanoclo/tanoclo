/**
 * @file test/test_mqtt_command_order.test.js
 * @brief Per-resource queue behavior and regressions through real MQTT subscribers.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const { SerialCommandQueue, commandScope } = require('../lib/serial-command-queue');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

const nextTurn = () => new Promise(resolve => setTimeout(resolve, 0));

describe('per-resource command queue', () => {
    test('waits for the whole previous action before starting the next one', async () => {
        const queue = new SerialCommandQueue();
        const gate = deferred();
        const events = [];
        const first = queue.run('room', async () => {
            events.push('mode:start');
            await gate.promise;
            events.push('mode:end');
        });
        const second = queue.run('room', () => { events.push('temperature'); });
        try {
            await nextTurn();
            expect(events).toEqual(['mode:start']);
        } finally {
            gate.resolve();
            await Promise.all([first, second]);
        }
        expect(events).toEqual(['mode:start', 'mode:end', 'temperature']);
    });

    test('different resources can progress independently', async () => {
        const queue = new SerialCommandQueue();
        const gate = deferred();
        const first = queue.run('one', () => gate.promise);
        try {
            expect(await queue.run('two', () => 19)).toBe(19);
        } finally {
            gate.resolve();
            await first;
        }
    });

    test('reports failures without poisoning later actions', async () => {
        const queue = new SerialCommandQueue();
        const first = queue.run('room', () => { throw new Error('fixture failure'); });
        const second = queue.run('room', () => 20);
        await expect(first).rejects.toThrow('fixture failure');
        expect(await second).toBe(20);
        await nextTurn();
        expect(queue.tails.size).toBe(0);
    });

    test('finishing an earlier action does not remove a newer queued action', async () => {
        const queue = new SerialCommandQueue();
        const gate = deferred();
        const first = queue.run('room', () => 19);
        const second = queue.run('room', () => gate.promise);
        await first;
        await nextTurn();
        expect(queue.tails.size).toBe(1);
        gate.resolve();
        await second;
        await nextTurn();
        expect(queue.tails.size).toBe(0);
    });

    test('home, zone and device commands use distinct resource scopes', () => {
        const mode = 'tado/tanoclo/h/1/z/2/set/mode';
        expect(commandScope(mode)).toBe(commandScope('tado/tanoclo/h/1/z/2/set/target_temperature'));
        expect(commandScope(mode)).not.toBe(commandScope('tado/tanoclo/h/1/z/3/set/mode'));
        expect(commandScope(mode)).not.toBe(commandScope('tado/tanoclo/h/2/z/2/set/mode'));
        expect(commandScope(mode)).not.toBe(commandScope('tado/tanoclo/h/1/d/VA-test/set/child_lock'));
        expect(commandScope(mode)).not.toBe(commandScope('tado/tanoclo/h/1/set/presence'));
    });

    test('numeric aliases share the same handler resource', () => {
        expect(commandScope('tado/tanoclo/h/01/z/002/set/mode'))
            .toBe(commandScope('tado/tanoclo/h/1/z/2/set/target_temperature'));
        expect(commandScope('tado/tanoclo/h/01/set/presence'))
            .toBe(commandScope('tado/tanoclo/h/1/set/proxy_logging'));
    });
});

// Isolate the CommonJS subscriber's module state without replacing exports used
// by the shared upstream suites. SQL, hardware and MQTT publication are fakes.
function subscriberFixture({ holdMode = false, failMode = false } = {}) {
    const filename = path.resolve(__dirname, '../lib/mqtt-commands.js');
    const realRequire = Module.createRequire(filename);
    const context = { module: { exports: {} }, require: realRequire, console, Buffer, setTimeout, clearTimeout };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    const subscribers = new Map();
    const gate = deferred();
    const writes = [];
    const hardware = [];
    const errors = [];
    const published = [];
    let overlay = 22;
    const measurement = { field_6200: 22, field_6280: 22, field_6240: 2 };
    const pool = {
        async execute(sql, values) {
            if (sql.includes('COALESCE(dm.field_012d') || sql.includes('FROM home_energy_settings')) return [[]];
            if (sql.startsWith('SELECT home_id, type, name')) return [[{ home_id: 1, type: 'HEATING', name: 'Test room' }]];
            if (sql.startsWith('SELECT setting_power')) return [[{ setting_power: 'ON', termination_type: 'MANUAL' }]];
            if (sql.startsWith('SELECT default_overlay_type')) return [[{ default_overlay_type: 'MANUAL', default_overlay_duration: 3600 }]];
            if (sql.startsWith('SELECT setting_temp_celsius')) return [[{ setting_temp_celsius: overlay }]];
            if (sql.includes('INSERT INTO zone_overlays')) {
                const target = values[4];
                if (target === 22 && failMode) throw new Error('fixture write failure');
                if (target === 22 && holdMode) await gate.promise;
                overlay = target;
                writes.push(target);
                return [{}];
            }
            if (sql.startsWith('SELECT * FROM zone_measurements')) return [[{ ...measurement }]];
            throw new Error('Unexpected SQL in subscriber fixture');
        }
    };
    const db = {
        getPool: () => pool,
        async insertMergedZoneMeasurement(home, zone, update) {
            for (const [field, value] of Object.entries(update)) measurement['field_' + field.slice(2)] = value;
        }
    };
    context.module.exports.init({
        subscribe(topic, callback) { subscribers.set(topic, callback); },
        publish() {}
    }, db, {
        async pushZoneOverlay(home, zone, setting) { hardware.push(setting.temperature.celsius); }
    }, {
        async publishZoneStateTelemetry(home, zone, row) { published.push(row.field_6280); },
        async publishZoneTelemetry() {}
    }, (level, message) => { if (level === 'error' || level === 'warn') errors.push(message); }, () => {});
    const callback = subscribers.get('tado/tanoclo/h/+/+/+/set/#');
    return {
        send: (command, payload) => callback('tado/tanoclo/h/1/z/1/set/' + command, payload),
        release: gate.resolve, writes, hardware, errors, published, measurement
    };
}

describe('MQTT mode and temperature subscriber', () => {
    test('does not process a new temperature while the preceding mode write is pending', async () => {
        const fixture = subscriberFixture({ holdMode: true });
        const mode = fixture.send('mode', 'heat');
        const target = fixture.send('target_temperature', '20');
        try {
            await nextTurn();
            expect(fixture.writes).toEqual([]);
            expect(fixture.hardware).toEqual([]);
        } finally {
            fixture.release();
            await Promise.all([mode, target]);
            await nextTurn();
        }
    });

    test('a slower mode write cannot restore its stale target after an explicit temperature', async () => {
        const fixture = subscriberFixture({ holdMode: true });
        const mode = fixture.send('mode', 'heat');
        const target = fixture.send('target_temperature', '20');
        try {
            await nextTurn();
        } finally {
            fixture.release();
            await Promise.all([mode, target]);
            await nextTurn();
        }
        expect(fixture.errors).toEqual([]);
        expect(fixture.writes).toEqual([22, 20]);
        expect(fixture.hardware).toEqual([22, 20]);
        expect(fixture.measurement.field_6280).toBe(20);
        expect(fixture.published.at(-1)).toBe(20);
    });

    test('a failed mode handler is logged and the next target still runs', async () => {
        const fixture = subscriberFixture({ failMode: true });
        await Promise.all([
            fixture.send('mode', 'heat'),
            fixture.send('target_temperature', '20')
        ]);
        await nextTurn();
        expect(fixture.errors).toHaveLength(1);
        expect(fixture.errors[0]).toContain('fixture write failure');
        expect(fixture.hardware).toEqual([20]);
        expect(fixture.measurement.field_6280).toBe(20);
    });
});
