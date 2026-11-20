/**
 * @file test/test_device_lifecycle.test.js
 * @brief Real server callbacks, session-token recovery and connection-write order.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const acorn = require('acorn');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
function findNode(node, predicate) {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    for (const value of Object.values(node)) {
        if (!value || typeof value !== 'object') continue;
        if (Array.isArray(value)) {
            for (const item of value) { const found = findNode(item, predicate); if (found) return found; }
        } else {
            const found = findNode(value, predicate);
            if (found) return found;
        }
    }
    return null;
}
function sourceFile(relative) {
    const filename = path.resolve(__dirname, relative);
    const source = fs.readFileSync(filename, 'utf8');
    return { filename, source, ast: acorn.parse(source, { ecmaVersion: 'latest' }) };
}
function functionFrom(file, name, context) {
    const node = findNode(file.ast, candidate => candidate.type === 'FunctionDeclaration' && candidate.id.name === name);
    return vm.runInNewContext('(' + file.source.slice(node.start, node.end) + ')', context, { filename: file.filename });
}

function socketFixture(shuttingDown = false, replacement = false) {
    const file = sourceFile('../server.js');
    const wsCall = findNode(file.ast, node => node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.property.name === 'ws');
    const node = wsCall.arguments[1].properties.find(property => property.key.name === 'close').value;
    const socket = {};
    const current = replacement ? {} : socket;
    const clients = new Map([['IB-test', { ws: current }]]);
    const stateWrites = [];
    const published = [];
    const gate = deferred();
    const context = {
        wsToBridgeId: new Map([[socket, 'IB-test']]), clients,
        apiProcess: null, proxyConnections: new Map(), isShuttingDown: shuttingDown,
        extractShortSerial: serial => serial, log() {}, metrics: { inc() {}, gauge() {} },
        db: { async updateDeviceConnectionState(serial, online) {
            await gate.promise;
            stateWrites.push(online);
        } },
        mqttPublisher: { async publishDeviceAvailability() { published.push('availability'); } }
    };
    return { socket, clients, stateWrites, published, gate,
        close: vm.runInNewContext('(' + file.source.slice(node.start, node.end) + ')', context, { filename: file.filename }) };
}

describe('server connection lifecycle', () => {
    test('a stale socket close cannot take its active replacement offline', async () => {
        const fixture = socketFixture(false, true);
        fixture.close(fixture.socket, 1000);
        fixture.gate.resolve();
        await tick();
        expect(fixture.clients.size).toBe(1);
        expect(fixture.stateWrites).toEqual([]);
        expect(fixture.published).toEqual([]);
    });
    test('shutdown socket closes do not erase cached physical state', async () => {
        const fixture = socketFixture(true);
        fixture.close(fixture.socket, 1000);
        fixture.gate.resolve();
        await tick();
        expect(fixture.stateWrites).toEqual([]);
        expect(fixture.published).toEqual([]);
    });
    test('a genuine disconnect publishes only after its offline write commits', async () => {
        const fixture = socketFixture();
        fixture.close(fixture.socket, 1000);
        try {
            await tick();
            expect(fixture.published).toEqual([]);
        } finally { fixture.gate.resolve(); await tick(); }
        expect(fixture.stateWrites).toEqual([false]);
        expect(fixture.published).toEqual(['availability']);
        expect(fixture.clients.size).toBe(0);
    });
    test('clean shutdown publishes backend offline without writing all devices offline', async () => {
        const file = sourceFile('../server.js');
        const writes = [];
        const events = [];
        const context = {
            isShuttingDown: false, uwsListenSocket: null, apiProcess: null,
            log() {}, stopProxyServer() { events.push('transport stopped'); }, setTimeout() { return 0; },
            require: () => ({ stop() {} }), workerPool: { async shutdown() {} },
            mqttClient: { async shutdown() { events.push('backend offline'); } },
            commandApi: { stop() {} }, process: { exit(code) { events.push('exit:' + code); } },
            clients: new Map([['IB-test', {}], ['VA-test', {}]]), extractShortSerial: serial => serial,
            db: { async updateDeviceConnectionState(serial, online) { writes.push(online); }, async close() {} }
        };
        await functionFrom(file, 'handleShutdown', context)();
        expect(writes).toEqual([]);
        expect(events).toEqual(['backend offline', 'transport stopped', 'exit:0']);
    });
});

function databaseFixture() {
    const filename = path.resolve(__dirname, '../lib/db-devices.js');
    const realRequire = Module.createRequire(filename);
    const gate = deferred();
    const writes = [];
    const pool = { async execute(sql, values) {
        if (sql.startsWith('UPDATE devices SET connection_state')) {
            if (!values[0]) await gate.promise;
            writes.push({ serial: values.at(-1), online: values[0] });
        } else if (sql.startsWith('UPDATE devices SET ipv6_address')) {
            writes.push({ serial: values.at(-1), online: 1 });
        }
        return [{}];
    } };
    const context = { module: { exports: {} }, Buffer,
        require: name => name === './db-base'
            ? { getPool: () => pool, extractShortSerial: serial => serial, _log() {} }
            : realRequire(name) };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    return { db: context.module.exports, gate, writes };
}

describe('connection-state SQL order', () => {
    test('an older slow offline write cannot overwrite newer IPv6 recovery', async () => {
        const fixture = databaseFixture();
        const offline = fixture.db.updateDeviceConnectionState('VA-test', false);
        const recovered = fixture.db.updateDeviceIPv6('VA-test', 'fd00::1');
        try { await tick(); } finally { fixture.gate.resolve(); await Promise.all([offline, recovered]); }
        expect(fixture.writes.map(write => write.online)).toEqual([0, 1]);
    });
    test('another device is not blocked by one pending connection write', async () => {
        const fixture = databaseFixture();
        const offline = fixture.db.updateDeviceConnectionState('VA-one', false);
        try {
            await fixture.db.updateDeviceIPv6('VA-two', 'fd00::2');
            expect(fixture.writes).toEqual([{ serial: 'VA-two', online: 1 }]);
        } finally { fixture.gate.resolve(); await offline; }
    });
});

describe('session-token reconnect', () => {
    test('replaces the old transport and republishes committed online state', async () => {
        const file = sourceFile('../lib/message-router/index.js');
        const block = findNode(file.ast, node => node.type === 'IfStatement' && file.source.slice(node.test.start, node.test.end).includes('session2048 && !wsToBridgeId.has(ws)'));
        const oldSocket = {};
        const socket = {};
        const clients = new Map([['IB-test', { ws: oldSocket }]]);
        const events = [];
        const db = {
            getPool: () => ({ async execute() { return [[{ serial_no: 'IB-test' }]]; } }),
            async updateDeviceConnectionState() { events.push('connection'); },
            async updateDeviceIPv6() { events.push('ipv6'); }
        };
        const context = { isDownlink: false, session2048: Buffer.from('fixture-session'), ws: socket,
            wsToBridgeId: new Map(), clients, db, log() {}, extractShortSerial: serial => serial,
            getApiProcess: () => null, reconstructBuffers: value => value,
            frame: { ipv6: 'fd00::1', fieldA: 1, fieldB: 2, fieldC: 0, udpPort: 5683 },
            mqttPublisher: { async publishDeviceAvailability() { events.push('published'); } }
        };
        const helper = findNode(file.ast, node => node.type === 'FunctionDeclaration' && node.id.name === 'refreshConnectedDevice');
        if (helper) context.refreshConnectedDevice = functionFrom(file, 'refreshConnectedDevice', context);
        await vm.runInNewContext('(async () => {' + file.source.slice(block.start, block.end) + '})()', context, { filename: file.filename });
        expect(clients.get('IB-test').ws).toBe(socket);
        expect(events).toEqual(['ipv6', 'published']);
    });
});
