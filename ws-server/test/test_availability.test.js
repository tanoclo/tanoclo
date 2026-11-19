/**
 * @file test/test_availability.test.js
 * @brief Cached device state, live bridge gating and ordered MQTT reconciliation.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const { deviceAvailability, zoneAvailability } = require('../lib/availability');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

const bridge = state => ({ serial_no: 'IB-test', device_type: 'IB01', connection_state: state });
const valve = (state = 1) => ({ serial_no: 'VA-test', device_type: 'VA02', connection_state: state, zone_id: 1 });

describe('effective device and zone availability', () => {
    test('cached online TRVs stay unavailable until the bridge reconnects', () => {
        const devices = [bridge(0), valve()];
        expect(deviceAvailability(devices)(devices[1])).toBe(false);
        expect(devices[1].connection_state).toBe(1);
    });
    test('bridge recovery restores a sleeping TRV without requiring a new report', () => {
        const devices = [bridge(1), valve()];
        expect(deviceAvailability(devices)(devices[1])).toBe(true);
    });
    test('a genuinely offline TRV does not become online with its bridge', () => {
        const devices = [bridge(1), valve(0)];
        expect(deviceAvailability(devices)(devices[1])).toBe(false);
    });
    test('emulated devices are independent of a physical bridge outage', () => {
        const device = { ...valve(), is_emulated: 1 };
        expect(deviceAvailability([bridge(0), device])(device)).toBe(true);
    });
    test('does not infer bridge ownership in multi-bridge homes', () => {
        const devices = [bridge(0), { ...bridge(0), serial_no: 'IB-other' }, valve()];
        expect(deviceAvailability(devices)(devices[2])).toBe(true);
    });
    test('homes without a registered bridge retain direct-device support', () => {
        const device = valve();
        expect(deviceAvailability([device])(device)).toBe(true);
    });
    test.each(['HOT_WATER', 'DHW'])('%s uses circuit leader connectivity rather than zone membership', type => {
        const device = { ...valve(), zone_id: null };
        const devices = [bridge(1), device];
        const circuits = [{ driver_serial_no: device.serial_no }];
        expect(zoneAvailability({ id: 2, type }, devices, circuits, deviceAvailability(devices))).toBe(true);
        devices[0].connection_state = 0;
        expect(zoneAvailability({ id: 2, type }, devices, circuits, deviceAvailability(devices))).toBe(false);
    });
});

function publisherFixture() {
    const filename = path.resolve(__dirname, '../lib/mqtt-publisher.js');
    const realRequire = Module.createRequire(filename);
    const devices = [{ ...bridge(0), home_id: 1 }, { ...valve(), home_id: 1 }];
    const messages = [];
    let held;
    let fullStateHeld;
    const db = {
        async getDeviceBySerial(serial) { return devices.find(device => device.serial_no === serial); },
        async getDevicesInZone(home, zone) { return devices.filter(device => device.zone_id === zone); },
        async getZoneType() { return 'HEATING'; },
        async getDevicesForHome() {
            const snapshot = devices.map(device => ({ ...device }));
            if (held) { const gate = held; held = null; await gate.promise; }
            return snapshot;
        },
        getPool() { return { async execute(sql) {
            if (sql === 'SELECT * FROM homes') return [[{ id: 1 }]];
            if (sql === 'SELECT * FROM zones') return [[{ id: 1, home_id: 1, type: 'HEATING' }]];
            if (sql === 'SELECT * FROM devices') {
                const snapshot = devices.map(device => ({ ...device }));
                if (fullStateHeld) { const gate = fullStateHeld; fullStateHeld = null; await gate.promise; }
                return [snapshot];
            }
            if (sql.startsWith('SELECT id, home_id, type FROM zones')) return [[{ id: 1, home_id: 1, type: 'HEATING' }]];
            if (sql.trimStart().startsWith('SELECT')) return [[]];
            throw new Error('Unexpected availability SQL');
        } }; }
    };
    const context = { module: { exports: {} }, process, require: name => name === './battery' || name === './geo-utils'
        ? {} : realRequire(name) };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    const publisher = context.module.exports;
    publisher.init({ publish(topic, payload) { messages.push({ topic, payload }); } }, db, {}, () => {});
    return { publisher, devices, messages, hold(gate) { held = gate; }, holdFullState(gate) { fullStateHeld = gate; } };
}

describe('MQTT availability reconciliation', () => {
    test('bridge events refresh the whole home, including sleeping TRV zones', async () => {
        const fixture = publisherFixture();
        await fixture.publisher.publishDeviceAvailability('IB-test', false);
        await tick();
        expect(fixture.messages.find(message => message.topic.endsWith('/z/1/availability')).payload).toBe('offline');
        fixture.devices[0].connection_state = 1;
        await fixture.publisher.publishDeviceAvailability('IB-test', true);
        await tick();
        expect(fixture.messages.filter(message => message.topic.endsWith('/z/1/availability')).at(-1).payload).toBe('online');
        expect(fixture.devices[1].connection_state).toBe(1);
    });
    test('a delayed old refresh cannot overwrite the newer bridge recovery', async () => {
        const fixture = publisherFixture();
        const gate = deferred();
        fixture.hold(gate);
        const before = fixture.publisher.publishDeviceAvailability('IB-test', false);
        await tick();
        fixture.devices[0].connection_state = 1;
        const after = fixture.publisher.publishDeviceAvailability('IB-test', true);
        try { await tick(); } finally { gate.resolve(); await Promise.all([before, after]); }
        await tick();
        expect(fixture.messages.filter(message => message.topic.endsWith('/z/1/availability')).map(message => message.payload)).toEqual(['offline', 'online']);
    });
    test('a delayed startup snapshot cannot overwrite a newer online event', async () => {
        const fixture = publisherFixture();
        fixture.devices[0].connection_state = 1;
        fixture.devices[1].connection_state = 0;
        const gate = deferred();
        fixture.holdFullState(gate);
        const initial = fixture.publisher.publishFullState();
        try {
            await tick();
            fixture.devices[1].connection_state = 1;
            await fixture.publisher.publishDeviceAvailability('VA-test', true);
            await tick();
        } finally { gate.resolve(); await initial; }
        await tick();
        expect(fixture.messages.filter(message => message.topic.endsWith('/z/1/availability')).at(-1).payload).toBe('online');
    });
    test('a delayed event boolean cannot override a newer committed offline state', async () => {
        const fixture = publisherFixture();
        fixture.devices[1].connection_state = 0;
        await fixture.publisher.publishDeviceAvailability('VA-test', true);
        await tick();
        expect(fixture.messages.find(message => message.topic.endsWith('/d/VA-test/availability')).payload).toBe('offline');
    });
});
