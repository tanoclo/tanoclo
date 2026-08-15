/**
 * @file test/test_pending_queries.js
 * @brief Vitest testing suite validating server modules.
 */

'use strict';

/**
 * Task 1.7: Unit test for pending live query mechanism
 * Run: node test/test_pending_queries.js
 */

const assert = require('assert');
const commandApi = require('../lib/command-api');
const coap = require('../lib/coap');

let passed = 0;
let failed = 0;

function test(name, condition) {
    if (condition) {
        passed++;
        console.log(`  ✓ ${name}`);
    } else {
        failed++;
        console.log(`  ✗ ${name}`);
    }
}

async function run() {
    console.log('══ Running Pending Query Mechanism Tests ══');

    // 1. Mock DB and Clients
    const mockDb = {
        getDeviceBySerial: async (serial) => ({ serial_no: serial, home_id: 12345, ipv6_address: 'fe80::1', udp_port: 5683 }),
        getDeviceByFullSerial: async (serial) => ({ serial_no: serial, home_id: 12345, ipv6_address: 'fe80::1', udp_port: 5683 }),
        isOffline: () => false
    };

    const mockClients = new Map();
    mockClients.set('IB1234567890', {
        homeId: '12345',
        ipv6: 'fe80::2',
        port: 5683,
        session2048: Buffer.from([1, 2, 3, 4])
    });

    let sentFrames = [];
    const mockSendToDevice = (deviceId, wsFrame) => {
        sentFrames.push({ deviceId, wsFrame });
    };

    // Initialize commandApi with mocks
    commandApi.start({
        clients: mockClients,
        sendToDevice: mockSendToDevice,
        broadcastTime: () => {},
        log: (level, ...args) => {
            // console.log(`[LOG ${level}]`, ...args);
        },
        port: 3999,
        db: mockDb
    });

    // Test 1: isTaNoCloOriginatedMid tracking and cleanup
    try {
        const queryPromise = commandApi.queryDeviceConfig('VA9999999999', 'd/VA9999999999/config');

        // Spin event loop to let async DB lookup and single query attempt run
        await new Promise(resolve => setTimeout(resolve, 50));

        // We expect a CoAP GET message to be sent via the bridge
        test('Frame was sent', sentFrames.length === 1);
        const sent = sentFrames[0];
        test('Target is correct bridge', sent.deviceId === 'IB1234567890');

        // Check if MID was registered as TaNoClo-originated
        const mid = sent.wsFrame.readUInt16BE(28 + 2); // WS Bridge header is 28 bytes. CoAP header MID is at offset 2
        test('MID is registered as TaNoClo-originated', commandApi.isTaNoCloOriginatedMid(mid) === true);

        // Simulate device response (2.05 Content with fake payload)
        const fakePayload = Buffer.from('hello-config');
        const mockResponse = {
            mid,
            code: 0x45, // 2.05 Content
            payload: fakePayload,
            options: [{ num: 4, value: Buffer.from('etag123') }]
        };

        // Trigger ACK receipt
        commandApi.handleAckReceived(mid, mockResponse);

        const result = await queryPromise;
        test('Query resolved successfully', result !== null);
        test('Query payload is correct', result.payload.toString() === 'hello-config');
        test('Query ETag is correct', result.etag.toString() === 'etag123');

        // After resolution, MID should still be tracked for 30s to prevent upstream leak
        test('MID is still tracked briefly after resolution', commandApi.isTaNoCloOriginatedMid(mid) === true);
    } catch (err) {
        console.error('Test 1 failed with error:', err);
        test('Test 1 succeeded', false);
    }

    // Test 2: Timeout behavior
    sentFrames = [];
    try {
        const queryPromise = commandApi.queryDeviceConfig('VA9999999999', 'd/VA9999999999/config');
        
        // Wait for it to time out (our timeout is 5s, let's mock/advance it or just wait if needed, 
        // wait, actually we can adjust the timeout or just wait for it since 5s is fast enough)
        console.log('  Waiting 5.5s for query timeout...');
        await queryPromise;
        test('Timeout did not reject (unexpected)', false);
    } catch (err) {
        test('Timeout rejected as expected', err.message.includes('Timeout querying'));
    }

    // Clean up and stop server
    commandApi.stop();

    console.log('\n══ RESULTS ══');
    console.log(`  Passed: ${passed} | Failed: ${failed}`);
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
    console.error('Unhandled rejection in test run:', err);
    process.exit(1);
});
