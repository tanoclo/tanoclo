'use strict';
const assert = require('node:assert/strict');
const {collectConfigBlock2: collect} = require('../lib/config-block2');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const packet = (num, more, text, version = 'v1', szx = 0) => ({
    payload: Buffer.from(text), block: {num, more, szx, blockSize: 2 ** (szx + 4)},
    etag: Buffer.from(version), token: Buffer.from('token')
});
const first = 'abcdefghijklmnop';

test('ordinary complete response remains supported', () => {
    assert.equal(collect(new Map(), 'd/config', {...packet(0, 0, 'config'), block: null}).toString(), 'config');
});
test('complete first-and-final Block2 is captured (production bridge/TRV case)', () => {
    const sessions = new Map();
    assert.equal(collect(sessions, 'd/config', packet(0, 0, 'complete')).toString(), 'complete');
    assert.equal(sessions.size, 0);
});
test('room configuration is decoded only after all three blocks arrive', () => {
    const s = new Map();
    assert.equal(collect(s, 'z/config', packet(0, 1, first)), null);
    assert.equal(collect(s, 'z/config', packet(1, 1, first)), null);
    assert.equal(collect(s, 'z/config', packet(2, 0, 'tail')).toString(), first + first + 'tail');
    assert.equal(s.size, 0);
});
test('identical repeated blocks do not duplicate bytes or lose progress', () => {
    const s = new Map();
    for (const n of [0, 0, 1, 0, 1]) assert.equal(collect(s, 'z', packet(n, 1, first)), null);
    assert.equal(collect(s, 'z', packet(2, 0, 'tail')).toString(), first + first + 'tail');
});
test('orphaned tail and gaps never become captures', () => {
    const s = new Map();
    assert.equal(collect(s, 'z', packet(2, 0, 'tail')), null);
    collect(s, 'z', packet(0, 1, first));
    assert.equal(collect(s, 'z', packet(2, 0, 'tail')), null);
    assert.equal(s.size, 0);
});
test('ETag changes cannot splice two configurations', () => {
    const s = new Map();
    collect(s, 'z', packet(0, 1, first));
    assert.equal(collect(s, 'z', packet(1, 0, 'tail', 'v2')), null);
    assert.equal(s.size, 0);
    collect(s, 'z', packet(0, 1, first));
    collect(s, 'z', packet(0, 1, 'ABCDEFGHIJKLMNOP', 'v2'));
    assert.equal(collect(s, 'z', packet(1, 0, 'tail', 'v2')).toString(), 'ABCDEFGHIJKLMNOPtail');
});
test('conflicting duplicate block rejects the assembly', () => {
    const s = new Map();
    collect(s, 'z', packet(0, 1, first));
    collect(s, 'z', packet(1, 1, first));
    assert.equal(collect(s, 'z', packet(1, 1, 'ABCDEFGHIJKLMNOP')), null);
    assert.equal(s.size, 0);
});
test('different devices/resources have isolated assemblies', () => {
    const s = new Map();
    collect(s, 'A/z1', packet(0, 1, first));
    collect(s, 'B/z1', packet(0, 1, 'ABCDEFGHIJKLMNOP'));
    assert.equal(collect(s, 'A/z1', packet(1, 0, 'a')).toString(), first + 'a');
    assert.equal(collect(s, 'B/z1', packet(1, 0, 'b')).toString(), 'ABCDEFGHIJKLMNOPb');
});
test('expired transfers cannot accept a tail', () => {
    const s = new Map();
    collect(s, 'z', packet(0, 1, first), 0);
    assert.equal(collect(s, 'z', packet(1, 0, 'tail'), 120001), null);
    assert.equal(s.size, 0);
});
test('malformed blocks and overlarge representations are rejected', () => {
    const invalid = [packet(0, 1, 'short'), packet(0, 0, first + 'X'),
        packet(0, 0, 'bad', 'v1', 7), packet(8192, 0, 'tail'),
        {...packet(0, 0, 'bad'), block: {num: -1, more: 0, szx: 0, blockSize: 16}},
        {...packet(0, 0, 'bad'), block: {num: 0, more: 2, szx: 0, blockSize: 16}},
        {...packet(0, 0, 'bad'), block: {num: 0, more: 0, szx: 0, blockSize: 32}}];
    for (const p of invalid) assert.equal(collect(new Map(), 'z', p), null);
});
test('transfer map has a hard size limit', () => {
    const s = new Map();
    for (let i = 0; i < 110; i++) collect(s, 'z' + i, packet(0, 1, first));
    assert.equal(s.size, 100);
});
test('token identifies transfer when ETag is absent', () => {
    const s = new Map(), p = {...packet(0, 1, first), etag: null};
    collect(s, 'z', p);
    assert.equal(collect(s, 'z', {...packet(1, 0, 'tail'), etag: null, token: Buffer.from('other')}), null);
});

// Execute the actual capture handler with isolated persistence/decode boundaries.
// Avoid mutating shared CommonJS exports: the upstream suite uses isolate:false.
function captureFixture() {
    const filename = path.resolve(__dirname, '../lib/message-router/downlink.js');
    const realRequire = Module.createRequire(filename);
    const coap = realRequire('../coap');
    const decoded = [], stored = [], persisted = [], snapshots = [];
    const fakeDb = {
        async getHomeForDevice() { return 1; },
        async updateDeviceConfig(device, fields) { persisted.push({device, fields}); },
        async storeRealEtag() {}
    };
    const mocks = {
        '../db': fakeDb,
        '../worker-pool': {async tlvDecode(payload) { decoded.push(payload); return {ok:true, fields:{'0x0140':0}}; }},
        '../config-capture': {async capture(record) { stored.push(record); }},
        '../state-snapshot': {isCapturing:()=>true, async recordMessage(...args) { snapshots.push(args); }}
    };
    const context = {module:{exports:{}}, Buffer, console,
        require:name=>Object.hasOwn(mocks,name)?mocks[name]:realRequire(name)};
    vm.runInNewContext(fs.readFileSync(filename,'utf8'),context,{filename});
    const handler = context.module.exports;
    handler.init({log:()=>{}, extractShortSerial:serial=>serial, downlinkBlockSessions:new Map()});
    const send = async (num, more, payload) => handler.captureDownlinkConfig({
        options:[{num:coap.OPT_BLOCK2,value:coap.encodeBlock2(num,more,0)},
            {num:coap.OPT_ETAG,value:Buffer.from('v1')}],
        code:coap.CODE_CONTENT, token:Buffer.from('test'), payload:Buffer.from(payload)
    }, 'd/VA-test/config', 'VA-test', {});
    return {send, decoded, stored, persisted, snapshots};
}

test('capture handler persists complete single-block replies carrying Block2', async () => {
    const f=captureFixture();
    await f.send(0,0,'complete');
    assert.equal(f.decoded.length,1);
    assert.equal(f.stored[0].payload.toString(),'complete');
    assert.equal(f.persisted.length,1);
    assert.equal(f.snapshots.length,1);
});

test('capture handler decodes/stores the assembled body, never a partial fragment', async () => {
    const f=captureFixture();
    await f.send(0,1,first);
    assert.equal(f.decoded.length,0);
    assert.equal(f.stored.length,0);
    await f.send(1,0,'tail');
    assert.equal(f.decoded.length,1);
    assert.equal(f.decoded[0].toString(),first+'tail');
    assert.equal(f.stored[0].payload.toString(),first+'tail');
    assert.equal(f.persisted.length,1);
    assert.equal(f.snapshots.length,1);
});
