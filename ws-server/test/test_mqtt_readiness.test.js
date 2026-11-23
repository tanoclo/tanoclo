/**
 * @file test/test_mqtt_readiness.test.js
 * @brief Broker readiness, stale reconnect work and HA climate availability.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { buildZoneDiscovery } = require('../lib/ha-discovery/zone-builders');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function brokerFixture() {
    const filename = path.resolve(__dirname, '../lib/mqtt-client.js');
    const connections = [];
    const options = [];
    const publications = [];
    const errors = [];
    const context = { module: { exports: {} },
        // Reconnect timers are recorded, not executed in this isolated fixture.
        setTimeout: () => ({ unref() {} }), clearTimeout() {},
        require: name => {
            if (name !== 'mqtt') throw new Error('Unexpected MQTT dependency');
            return { connect(url, config) {
                options.push(config);
                const connection = new EventEmitter();
                connection.publish = (topic, payload, settings, callback) => {
                    publications.push({ topic, payload });
                    if (callback) callback();
                };
                connection.subscribe = (topic, settings, callback) => { if (callback) callback(); };
                connection.end = (force, settings, callback) => {
                    connection.emit('close');
                    if (callback) callback();
                };
                connections.push(connection);
                return connection;
            } };
        }
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    const mqtt = context.module.exports;
    mqtt.init({ mqtt: { host: 'fixture-mqtt' } }, (level, message) => { if (level === 'error') errors.push(message); });
    return { mqtt, connections, options, publications, errors };
}

describe('backend MQTT readiness', () => {
    test('announces online only after asynchronous state initialization completes', async () => {
        const fixture = brokerFixture();
        const gate = deferred();
        fixture.mqtt.onConnect(() => gate.promise);
        fixture.connections[0].emit('connect');
        try {
            await tick();
            expect(fixture.publications.map(message => message.payload)).toEqual(['offline']);
        } finally { gate.resolve(); await tick(); }
        expect(fixture.publications.map(message => message.payload)).toEqual(['offline', 'online']);
    });
    test('an old initialization cannot declare a disconnected client online', async () => {
        const fixture = brokerFixture();
        const gate = deferred();
        fixture.mqtt.onConnect(() => gate.promise);
        fixture.connections[0].emit('connect');
        fixture.connections[0].emit('close');
        gate.resolve();
        await tick();
        expect(fixture.publications.some(message => message.payload === 'online')).toBe(false);
    });
    test('reconnect initialization is independent of an older unfinished attempt', async () => {
        const fixture = brokerFixture();
        const gate = deferred();
        let count = 0;
        fixture.mqtt.onConnect(() => ++count === 1 ? gate.promise : Promise.resolve());
        fixture.connections[0].emit('connect');
        fixture.connections[0].emit('close');
        fixture.connections[0].emit('connect');
        await tick();
        expect(fixture.publications.filter(message => message.payload === 'online')).toHaveLength(1);
        gate.resolve();
        await tick();
        expect(fixture.publications.filter(message => message.payload === 'online')).toHaveLength(1);
    });
    test('failed initialization remains offline and can be retried on reconnect', async () => {
        const fixture = brokerFixture();
        let first = true;
        fixture.mqtt.onConnect(async () => { if (first) { first = false; throw new Error('fixture state read failed'); } });
        fixture.connections[0].emit('connect');
        await tick();
        expect(fixture.publications.some(message => message.payload === 'online')).toBe(false);
        expect(fixture.errors).toHaveLength(1);
        fixture.connections[0].emit('connect');
        await tick();
        expect(fixture.publications.at(-1).payload).toBe('online');
    });
    test('a clean shutdown supersedes an unfinished initialization', async () => {
        const fixture = brokerFixture();
        const gate = deferred();
        fixture.mqtt.onConnect(() => gate.promise);
        fixture.connections[0].emit('connect');
        await fixture.mqtt.shutdown();
        gate.resolve();
        await tick();
        expect(fixture.publications.some(message => message.payload === 'online')).toBe(false);
    });
    test('availability transitions bypass the telemetry throttle in arrival order', async () => {
        const fixture = brokerFixture();
        fixture.connections[0].emit('connect');
        await tick();
        fixture.publications.length = 0;
        const topic = 'tado/tanoclo/h/1/z/1/availability';
        fixture.mqtt.publish(topic, 'offline');
        fixture.mqtt.publish(topic, 'online');
        expect(fixture.publications.map(message => message.payload)).toEqual(['offline', 'online']);
    });

});

describe('HA climate availability', () => {
    test.each(['HEATING', 'HOT_WATER', 'DHW'])('%s requires both backend readiness and zone availability', type => {
        const entities = [];
        buildZoneDiscovery((component, id, payload) => { if (component === 'climate' && payload) entities.push(payload); },
            [{ id: 1, home_id: 1, name: 'Test room', type }], {});
        expect(entities).toHaveLength(1);
        expect(entities[0].availability_mode).toBe('all');
        expect(entities[0].availability).toEqual([
            { topic: 'tado/tanoclo/status' }, { topic: 'tado/tanoclo/h/1/z/1/availability' }
        ]);
        expect(entities[0].availability_topic).toBeUndefined();
        expect(entities[0].unique_id).toBe('tanoclo_h1_z1_climate');
    });
});
