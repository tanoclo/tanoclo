/**
 * @file test/test_sleepy_queue.test.js
 * @brief Unit tests verifying sleepy device downlink queuing for battery-powered valves.
 */

'use strict';

require('./test_config');
const assert = require('assert');
const commandApi = require('../lib/command-api');
const coap = require('../lib/coap');
const wsBridge = require('../lib/ws-bridge');

test('Sleepy Device Downlink Queue operations', async () => {
    let sentFrames = [];

    const mockDb = {
        isOffline: () => false,
        getDeviceByFullSerial: async (serial) => {
            if (serial === 'VA0000000001') {
                return {
                    serial_no: 'VA0000000001',
                    device_type: 'VA01',
                    home_id: 100,
                    ipv6_address: 'fd00::2',
                    udp_port: 5683
                };
            }
            if (serial === 'IB0000000001') {
                return {
                    serial_no: 'IB0000000001',
                    device_type: 'IB01',
                    home_id: 100,
                    ipv6_address: 'fd00::1',
                    udp_port: 5683
                };
            }
            return null;
        },
        getDeviceBySerial: async (serial) => null
    };

    const mockClients = new Map();
    mockClients.set('IB0000000001', {
        ws: { send: () => { } },
        ipv6: 'fd00::1',
        homeId: 100,
        session2048: Buffer.from('mocksession2048')
    });

    commandApi.initialize({
        clients: mockClients,
        sendToDevice: async (bridgeId, frame) => {
            sentFrames.push({ bridgeId, frame });
        },
        broadcastTime: () => { },
        db: mockDb
    });

    commandApi.clearPendingRetries();

    // 1. identifies sleepy devices by prefix
    assert.strictEqual(commandApi.isSleepyDevice('VA0000000001'), true);
    assert.strictEqual(commandApi.isSleepyDevice('VA1234567890'), true);
    assert.strictEqual(commandApi.isSleepyDevice('IB0000000001'), false);
    assert.strictEqual(commandApi.isSleepyDevice('RU0000000001'), false);
    assert.strictEqual(commandApi.isSleepyDevice(null), false);

    // 2. queues downlink config for sleeping VA devices instead of immediate transmission
    assert.strictEqual(commandApi.isDeviceAwake('VA0000000001'), false);

    const mid = await commandApi.internalPushViabridge(
        'VA0000000001',
        coap.CODE_PUT,
        'd/config',
        Buffer.from([0x01, 0x02])
    );

    assert.ok(mid > 0);
    // No frame sent immediately to sleeping device
    assert.strictEqual(sentFrames.length, 0);

    // Command is stored in sleepy downlink queue
    const queue = commandApi.getSleepyQueue('VA0000000001');
    assert.ok(queue);
    assert.strictEqual(queue.has('d/config'), true);
    assert.strictEqual(queue.get('d/config').mid, mid);

    // 3. drains queued commands when device wakes up and sends uplink
    commandApi.drainSleepyDownlink('VA0000000001');

    // Queue is cleared immediately to prevent double drains
    assert.strictEqual(commandApi.getSleepyQueue('VA0000000001'), null);

    // Wait for the 120ms turnaround delay
    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(sentFrames.length, 1);
    const parsed = wsBridge.parse(sentFrames[0].frame);
    assert.strictEqual(parsed.ok, true);
    const coapMsg = coap.parse(parsed.coapBytes);
    assert.strictEqual(coapMsg.ok, true);
    assert.strictEqual(coap.uriPath(coapMsg), 'd/config');

    try {
        // 4. immediately sends downlink config to awake VA devices
        sentFrames = [];
        commandApi.recordDeviceActivity('VA0000000001');
        assert.strictEqual(commandApi.isDeviceAwake('VA0000000001'), true);

        const mid2 = await commandApi.internalPushViabridge(
            'VA0000000001',
            coap.CODE_PUT,
            'd/config',
            Buffer.from([0x03, 0x04])
        );

        assert.ok(mid2 > 0);
        assert.strictEqual(sentFrames.length, 1);
        assert.strictEqual(sentFrames[0].bridgeId, 'IB0000000001');

        const parsed2 = wsBridge.parse(sentFrames[0].frame);
        assert.strictEqual(parsed2.ok, true);
        assert.strictEqual(parsed2.ipv6, 'fd00:0:0:0:0:0:0:2');
    } finally {
        commandApi.initialize({ db: require('../lib/db'), clients: new Map(), sendToDevice: () => {} });
    }
});
