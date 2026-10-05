/**
 * @file test/test_thundering_herd_prevention.test.js
 * @brief Vitest unit tests verifying ETag normalization, conditional GET 2.03 Valid, and bridge downlink pacing.
 */

'use strict';

require('./test_config');
const coap = require('../lib/coap');
const wsBridge = require('../lib/ws-bridge');
const coapHelpers = require('../lib/handlers/coap-helpers');

describe('Thundering Herd Prevention & ETag Normalization', () => {
    let sentFrames = [];
    const mockWs = {
        isClosed: false,
        send: (frame) => {
            sentFrames.push(frame);
        }
    };

    const downlinkBlockSessions = new Map();
    const clients = new Map();
    const proxyConnections = new Set();
    const messageCache = { cacheMessage: () => {} };
    const config = { logLevel: 'silent' };

    beforeEach(() => {
        sentFrames = [];
        downlinkBlockSessions.clear();
        coapHelpers.init({
            coap,
            wsBridge,
            clients,
            messageCache,
            proxyConnections,
            config,
            downlinkBlockSessions
        });
    });

    test('normalizeEtag truncates 16-byte buffers and hex strings to 8 bytes', () => {
        // Null / undefined
        expect(coapHelpers.normalizeEtag(null)).toBeNull();
        expect(coapHelpers.normalizeEtag(undefined)).toBeNull();

        // 8-byte buffer
        const buf8 = Buffer.from('1122334455667788', 'hex');
        expect(coapHelpers.normalizeEtag(buf8)).toEqual(buf8);

        // 16-byte buffer (MD5 hash output)
        const buf16 = Buffer.from('112233445566778899aabbccddeeff00', 'hex');
        expect(coapHelpers.normalizeEtag(buf16)).toEqual(buf8);

        // 16-char hex string (8 bytes)
        expect(coapHelpers.normalizeEtag('1122334455667788')).toEqual(buf8);

        // 32-char hex string (16 bytes, e.g. stored in DB)
        expect(coapHelpers.normalizeEtag('112233445566778899aabbccddeeff00')).toEqual(buf8);

        // 0x prefix hex string
        expect(coapHelpers.normalizeEtag('0x112233445566778899aabbccddeeff00')).toEqual(buf8);
    });

    test('sendCoAPWithBlock2 returns 2.03 Valid on 8-byte client ETag matching 16-byte server ETag', async () => {
        const clientEtagBuf = Buffer.from('9977acf989c75df7', 'hex');
        const serverEtagHex = '9977acf989c75df7a1b2c3d4e5f60718'; // 16 bytes in DB

        const getReq = coap.buildRequest({
            code: coap.CODE_GET,
            path: 'z/12/config',
            token: Buffer.from([0x01, 0x02]),
            mid: 0x4321,
            type: coap.TYPE_CON,
            extraOptions: [
                { num: coap.OPT_ETAG, value: clientEtagBuf }
            ]
        });
        const coapMsg = coap.parse(getReq);

        const fullPayload = Buffer.alloc(182, 0xAA);
        const peerInfo = {
            ipv6: 'fd00::1234',
            udpPort: 5683,
            fieldA: 4,
            fieldB: 2,
            fieldC: 5
        };

        await coapHelpers.sendCoAPWithBlock2(
            mockWs,
            coapMsg,
            fullPayload,
            serverEtagHex,
            null,
            peerInfo,
            wsBridge.DIR_SERVER_TO_CLIENT
        );

        expect(sentFrames.length).toBe(1);
        const parsedFrame = wsBridge.parse(sentFrames[0]);
        const resCoap = coap.parse(parsedFrame.coapBytes);

        // RFC 7252 / Tado: 2.03 Valid response code
        expect(resCoap.code).toBe(coap.CODE_VALID);
        // Payload must be empty (0 bytes), preventing RF channel saturation
        expect(resCoap.payload.length).toBe(0);
        // ETag option returned should be 8-byte normalized
        const returnedEtag = coap.optionFirst(resCoap, coap.OPT_ETAG);
        expect(returnedEtag).toEqual(clientEtagBuf);
    });

    test('sendCoAPWithBlock2 transmits 2.05 Content with Block2 when ETag mismatches', async () => {
        const clientEtagBuf = Buffer.from('1111111111111111', 'hex');
        const serverEtagHex = '9977acf989c75df7a1b2c3d4e5f60718';

        const getReq = coap.buildRequest({
            code: coap.CODE_GET,
            path: 'z/12/config',
            token: Buffer.from([0x03, 0x04]),
            mid: 0x4322,
            type: coap.TYPE_CON,
            extraOptions: [
                { num: coap.OPT_ETAG, value: clientEtagBuf }
            ]
        });
        const coapMsg = coap.parse(getReq);
        const fullPayload = Buffer.alloc(182, 0xAA);
        const peerInfo = {
            ipv6: 'fd00::1234',
            udpPort: 5683,
            fieldA: 4,
            fieldB: 2,
            fieldC: 5
        };

        await coapHelpers.sendCoAPWithBlock2(
            mockWs,
            coapMsg,
            fullPayload,
            serverEtagHex,
            null,
            peerInfo,
            wsBridge.DIR_SERVER_TO_CLIENT
        );

        expect(sentFrames.length).toBe(1);
        const parsedFrame = wsBridge.parse(sentFrames[0]);
        const resCoap = coap.parse(parsedFrame.coapBytes);

        expect(resCoap.code).toBe(coap.CODE_CONTENT);
        // Block2 size 128 (szx=3) -> first block is 128 bytes
        expect(resCoap.payload.length).toBe(128);
    });

    test('paceDownlinkBlock enforces inter-block delay between heavy transmissions', async () => {
        const peerInfo = {
            ipv6: 'fd00::1234',
            udpPort: 5683,
            fieldA: 4,
            fieldB: 2,
            fieldC: 5
        };
        const fullPayload = Buffer.alloc(200, 0xBB);

        const req1 = coap.parse(coap.buildRequest({ code: coap.CODE_GET, path: 'd/config', mid: 1 }));
        const start = Date.now();
        await coapHelpers.sendCoAPWithBlock2(mockWs, req1, fullPayload, null, null, peerInfo, wsBridge.DIR_SERVER_TO_CLIENT);

        const req2 = coap.parse(coap.buildRequest({ code: coap.CODE_GET, path: 'd/config', mid: 2 }));
        await coapHelpers.sendCoAPWithBlock2(mockWs, req2, fullPayload, null, null, peerInfo, wsBridge.DIR_SERVER_TO_CLIENT);
        const elapsed = Date.now() - start;

        // Pacing enforces >= 120ms between consecutive blocks
        expect(elapsed).toBeGreaterThanOrEqual(100);
    });
});
