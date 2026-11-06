/**
 * @file test/test_config_block2.test.js
 * @brief Vitest regressions for complete and multipart configuration capture.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const { collectConfigBlock2: collect } = require('../lib/config-block2');

const firstBlock = 'abcdefghijklmnop';
const packet = (num, more, text, version = 'v1', szx = 0) => ({
    payload: Buffer.from(text),
    block: { num, more, szx, blockSize: 2 ** (szx + 4) },
    etag: Buffer.from(version),
    token: Buffer.from('token')
});

describe('configuration Block2 reassembly', () => {
    test('ordinary complete responses remain supported', () => {
        const part = { ...packet(0, 0, 'config'), block: null };
        expect(collect(new Map(), 'd/config', part).toString()).toBe('config');
    });

    test('a first-and-final Block2 reply is already complete', () => {
        const sessions = new Map();
        expect(collect(sessions, 'd/config', packet(0, 0, 'complete')).toString()).toBe('complete');
        expect(sessions.size).toBe(0);
    });

    test('a room configuration is complete only after all three blocks arrive', () => {
        const sessions = new Map();
        expect(collect(sessions, 'z/config', packet(0, 1, firstBlock))).toBeNull();
        expect(collect(sessions, 'z/config', packet(1, 1, firstBlock))).toBeNull();
        expect(collect(sessions, 'z/config', packet(2, 0, 'tail')).toString()).toBe(firstBlock + firstBlock + 'tail');
        expect(sessions.size).toBe(0);
    });

    test('identical retransmissions neither duplicate bytes nor lose progress', () => {
        const sessions = new Map();
        for (const num of [0, 0, 1, 0, 1]) {
            expect(collect(sessions, 'z', packet(num, 1, firstBlock))).toBeNull();
        }
        expect(collect(sessions, 'z', packet(2, 0, 'tail')).toString()).toBe(firstBlock + firstBlock + 'tail');
    });

    test('orphaned tails and gaps never become captures', () => {
        const sessions = new Map();
        expect(collect(sessions, 'z', packet(2, 0, 'tail'))).toBeNull();
        collect(sessions, 'z', packet(0, 1, firstBlock));
        expect(collect(sessions, 'z', packet(2, 0, 'tail'))).toBeNull();
        expect(sessions.size).toBe(0);
    });

    test('ETag changes cannot splice different representations', () => {
        const sessions = new Map();
        collect(sessions, 'z', packet(0, 1, firstBlock));
        expect(collect(sessions, 'z', packet(1, 0, 'tail', 'v2'))).toBeNull();
        expect(sessions.size).toBe(0);
        collect(sessions, 'z', packet(0, 1, firstBlock));
        collect(sessions, 'z', packet(0, 1, 'ABCDEFGHIJKLMNOP', 'v2'));
        expect(collect(sessions, 'z', packet(1, 0, 'tail', 'v2')).toString()).toBe('ABCDEFGHIJKLMNOPtail');
    });

    test('conflicting repeated blocks reject the assembly', () => {
        const sessions = new Map();
        collect(sessions, 'z', packet(0, 1, firstBlock));
        collect(sessions, 'z', packet(1, 1, firstBlock));
        expect(collect(sessions, 'z', packet(1, 1, 'ABCDEFGHIJKLMNOP'))).toBeNull();
        expect(sessions.size).toBe(0);
    });

    test('devices and resources have isolated assemblies', () => {
        const sessions = new Map();
        collect(sessions, 'A/z1', packet(0, 1, firstBlock));
        collect(sessions, 'B/z1', packet(0, 1, 'ABCDEFGHIJKLMNOP'));
        expect(collect(sessions, 'A/z1', packet(1, 0, 'a')).toString()).toBe(firstBlock + 'a');
        expect(collect(sessions, 'B/z1', packet(1, 0, 'b')).toString()).toBe('ABCDEFGHIJKLMNOPb');
    });

    test('expired transfers cannot accept a tail', () => {
        const sessions = new Map();
        collect(sessions, 'z', packet(0, 1, firstBlock), 0);
        expect(collect(sessions, 'z', packet(1, 0, 'tail'), 120001)).toBeNull();
        expect(sessions.size).toBe(0);
    });

    test('malformed blocks and oversized representations are rejected', () => {
        const invalid = [
            packet(0, 1, 'short'),
            packet(0, 0, firstBlock + 'X'),
            packet(0, 0, 'bad', 'v1', 7),
            packet(8192, 0, 'tail'),
            { ...packet(0, 0, 'bad'), block: { num: -1, more: 0, szx: 0, blockSize: 16 } },
            { ...packet(0, 0, 'bad'), block: { num: 0, more: 2, szx: 0, blockSize: 16 } },
            { ...packet(0, 0, 'bad'), block: { num: 0, more: 0, szx: 0, blockSize: 32 } }
        ];
        for (const part of invalid) expect(collect(new Map(), 'z', part)).toBeNull();
    });

    test('the transfer map has a hard size limit', () => {
        const sessions = new Map();
        for (let index = 0; index < 110; index++) collect(sessions, 'z' + index, packet(0, 1, firstBlock));
        expect(sessions.size).toBe(100);
    });

    test('tokens identify transfers when no ETag is available', () => {
        const sessions = new Map();
        collect(sessions, 'z', { ...packet(0, 1, firstBlock), etag: null });
        const otherRequest = { ...packet(1, 0, 'tail'), etag: null, token: Buffer.from('other') };
        expect(collect(sessions, 'z', otherRequest)).toBeNull();
    });

    test('negotiated smaller blocks are accepted when their byte offsets are contiguous', () => {
        const sessions = new Map();
        collect(sessions, 'z', packet(0, 1, firstBlock + firstBlock, 'v1', 1));
        expect(collect(sessions, 'z', packet(2, 0, 'tail', 'v1', 0)).toString()).toBe(firstBlock + firstBlock + 'tail');
    });
});

/**
 * Load the real handler with isolated persistence/decode boundaries. Vitest's
 * module mocking does not intercept its CommonJS requires, and this suite uses
 * isolate:false. A VM avoids changing shared exports used by other tests.
 */
function captureFixture() {
    const filename = path.resolve(__dirname, '../lib/message-router/downlink.js');
    const realRequire = Module.createRequire(filename);
    const coap = realRequire('../coap');
    const decoded = [];
    const stored = [];
    const persisted = [];
    const snapshots = [];
    const fakeDb = {
        async getHomeForDevice() { return 1; },
        async updateDeviceConfig(device, fields) { persisted.push({ device, fields }); },
        async storeRealEtag() {}
    };
    const mocks = {
        '../db': fakeDb,
        '../worker-pool': {
            async tlvDecode(payload) {
                decoded.push(payload);
                return { ok: true, fields: { '0x0140': 0 } };
            }
        },
        '../config-capture': { async capture(record) { stored.push(record); } },
        '../state-snapshot': {
            isCapturing: () => true,
            async recordMessage(...args) { snapshots.push(args); }
        }
    };
    const context = {
        module: { exports: {} },
        Buffer,
        console,
        require: name => Object.hasOwn(mocks, name) ? mocks[name] : realRequire(name)
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    const handler = context.module.exports;
    handler.init({ log: () => {}, extractShortSerial: serial => serial, downlinkBlockSessions: new Map() });
    const send = async (num, more, payload, blockOption = coap.encodeBlock2(num, more, 0)) => {
        await handler.captureDownlinkConfig({
            options: [
                { num: coap.OPT_BLOCK2, value: blockOption },
                { num: coap.OPT_ETAG, value: Buffer.from('v1') }
            ],
            code: coap.CODE_CONTENT,
            token: Buffer.from('test'),
            payload: Buffer.from(payload)
        }, 'd/VA-test/config', 'VA-test', {});
    };
    return { send, decoded, stored, persisted, snapshots };
}

describe('configuration capture handler', () => {
    test('complete single-block replies carrying Block2 reach persistence and snapshots', async () => {
        const fixture = captureFixture();
        await fixture.send(0, 0, 'complete');
        expect(fixture.decoded).toHaveLength(1);
        expect(fixture.stored[0].payload.toString()).toBe('complete');
        expect(fixture.persisted).toHaveLength(1);
        expect(fixture.snapshots).toHaveLength(1);
    });

    test('only an assembled body reaches the decoder and persistence', async () => {
        const fixture = captureFixture();
        await fixture.send(0, 1, firstBlock);
        expect(fixture.decoded).toHaveLength(0);
        expect(fixture.stored).toHaveLength(0);
        await fixture.send(1, 0, 'tail');
        expect(fixture.decoded).toHaveLength(1);
        expect(fixture.decoded[0].toString()).toBe(firstBlock + 'tail');
        expect(fixture.stored[0].payload.toString()).toBe(firstBlock + 'tail');
        expect(fixture.persisted).toHaveLength(1);
        expect(fixture.snapshots).toHaveLength(1);
    });

    test('a zero-length Block2 option encodes a complete first block', async () => {
        const fixture = captureFixture();
        await fixture.send(0, 0, 'complete', Buffer.alloc(0));
        expect(fixture.decoded).toHaveLength(1);
        expect(fixture.stored[0].payload.toString()).toBe('complete');
    });
});
