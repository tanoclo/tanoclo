/**
 * @file test/test_superseded_zone_commands.test.js
 * @brief New zone-state intent must not be overwritten by paced frames or retries.
 */

'use strict';

const transport = require('../lib/coap-transport');
const coap = require('../lib/coap');
const wsBridge = require('../lib/ws-bridge');

let sent;
const originalPacing = transport.getDownlinkPacingMs();

function send(mid, overrides = {}) {
    const { bridge = 'IB-test', address = 'fd00::1', port = 5683,
        zone = '1', path = 'z/s', code = coap.CODE_PUT,
        query = `id=${zone}`, extraOptions = [] } = overrides;
    const bytes = coap.buildRequest({
        code, path, query, extraOptions, mid, type: coap.TYPE_CON,
        token: Buffer.alloc(0), payload: Buffer.from([mid & 0xff])
    });
    transport.sendViaBridge(bridge, null, address, port, bytes, `test:${mid}`);
}

function mids() { return sent.map(item => item.mid); }

beforeEach(() => {
    vi.useFakeTimers();
    transport.clearPendingRetries();
    transport._commandTracker.clear();
    transport.setDownlinkPacingMs(0);
    sent = [];
    transport.init({
        db: {}, clients: new Map(), log: () => {},
        sendFn(bridge, frame) {
            const wrapped = wsBridge.parse(frame);
            sent.push({ bridge, mid: coap.parse(wrapped.coapBytes).mid });
        }
    });
});

afterEach(() => {
    transport.clearPendingRetries();
    transport._commandTracker.clear();
    transport.setDownlinkPacingMs(originalPacing);
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe('superseded zone-state commands', () => {
    test('keeps only the latest queued state and never retries an older state', () => {
        transport.setDownlinkPacingMs(100);
        send(0x7001);
        send(0x7002);
        send(0x7003);
        expect(mids()).toEqual([0x7001]);
        expect(transport.getBridgePacingQueue('IB-test')).toHaveLength(1);
        vi.advanceTimersByTime(100);
        expect(mids()).toEqual([0x7001, 0x7003]);
        vi.advanceTimersByTime(6000);
        expect(mids()).toEqual([0x7001, 0x7003, 0x7003]);
    });

    test('cancels an in-flight retry even while the replacement is waiting for pacing', () => {
        transport.setDownlinkPacingMs(10000);
        send(0x7001);
        send(0x7002);
        vi.advanceTimersByTime(6000);
        expect(mids()).toEqual([0x7001]);
        vi.advanceTimersByTime(4000);
        expect(mids()).toEqual([0x7001, 0x7002]);
    });

    test('marks the old sent command superseded rather than failed or acknowledged', () => {
        send(0x7001);
        send(0x7002);
        const commands = [...transport._commandTracker.values()];
        expect(commands.find(item => item.mid === 0x7001).status).toBe('superseded');
        expect(commands.find(item => item.mid === 0x7002).status).toBe('pending');
        vi.advanceTimersByTime(6000);
        expect(mids()).toEqual([0x7001, 0x7002, 0x7002]);
    });

    test.each([false, true])('rejects superseded ACK waiters, queued=%s', async queued => {
        if (queued) {
            transport.setDownlinkPacingMs(100);
            send(0x7000, { zone: '2' });
        }
        send(0x7001);
        const result = transport.waitForAck(String(0x7001)).then(
            () => ({ resolved: true }), error => ({ code: error.code })
        );
        send(0x7002);
        expect(await result).toEqual({ code: 'COMMAND_SUPERSEDED' });
        transport.handleAckReceived(0x7001, 'VA-test');
        expect(transport._commandTracker.size).toBe(queued ? 1 : 2);
    });

    test('an already-scheduled retry cannot send after supersession or MID reuse', () => {
        const timers = vi.spyOn(global, 'setTimeout');
        send(0x7001);
        const oldRetry = timers.mock.calls.find(([, delay]) => delay === 6000)[0];
        send(0x7001); // A later intent may reuse a MID after the generator wraps.
        oldRetry();
        expect(mids()).toEqual([0x7001, 0x7001]);
    });

    test('a late ACK for an old command does not stop the newest retry', () => {
        send(0x7001);
        send(0x7002);
        transport.handleAckReceived(0x7001, 'VA-test');
        vi.advanceTimersByTime(6000);
        expect(mids()).toEqual([0x7001, 0x7002, 0x7002]);
        transport.handleAckReceived(0x7002, 'VA-test');
        vi.advanceTimersByTime(20000);
        expect(mids()).toEqual([0x7001, 0x7002, 0x7002]);
    });

    test.each([
        { zone: '2' }, { address: 'fd00::2' }, { port: 5684 }, { bridge: 'IB-other' }
    ])('does not supersede another resource: %j', overrides => {
        send(0x7001);
        send(0x7002, overrides);
        vi.advanceTimersByTime(6000);
        expect(mids()).toEqual([0x7001, 0x7002, 0x7001, 0x7002]);
    });

    test('numeric zone and IPv6 aliases share the same endpoint resource', () => {
        send(0x7001, { zone: '001', address: 'FD00:0:0:0:0:0:0:1', port: 0 });
        send(0x7002, { zone: '1', address: 'fd00::1', port: 5683 });
        vi.advanceTimersByTime(6000);
        expect(mids()).toEqual([0x7001, 0x7002, 0x7002]);
    });

    test.each([
        { code: coap.CODE_GET }, { path: 'z/p' }, { path: 'd/config' },
        { path: 'd/reboot', code: coap.CODE_POST }, { query: '' },
        { query: 'id=invalid' }, { query: 'id=1&other=2' },
        { extraOptions: [{ num: coap.OPT_BLOCK1, value: Buffer.from([0x08]) }] }
    ])('preserves retries for non-replaceable commands: %j', overrides => {
        send(0x7001, overrides);
        send(0x7002, overrides);
        vi.advanceTimersByTime(6000);
        expect(mids()).toEqual([0x7001, 0x7002, 0x7001, 0x7002]);
    });

    test('removing queued zone states preserves unrelated paced commands', () => {
        transport.setDownlinkPacingMs(100);
        send(0x7000, { zone: '2' });
        send(0x7001);
        send(0x7002, { path: 'd/config' });
        send(0x7003);
        vi.advanceTimersByTime(200);
        expect(mids()).toEqual([0x7000, 0x7002, 0x7003]);
    });

    test('the newest command still times out normally when no ACK arrives', () => {
        send(0x7001);
        send(0x7002);
        vi.advanceTimersByTime(185000);
        expect(mids()).toEqual([0x7001, 0x7002, 0x7002, 0x7002, 0x7002, 0x7002, 0x7002]);
        const commands = [...transport._commandTracker.values()];
        expect(commands.find(item => item.mid === 0x7001).status).toBe('superseded');
        expect(commands.find(item => item.mid === 0x7002).status).toBe('failed');
    });

    test('clearing transport state prevents a captured old retry from sending', () => {
        const timers = vi.spyOn(global, 'setTimeout');
        send(0x7001);
        const retry = timers.mock.calls.find(([, delay]) => delay === 6000)[0];
        transport.clearPendingRetries();
        retry();
        expect(mids()).toEqual([0x7001]);
    });
});
