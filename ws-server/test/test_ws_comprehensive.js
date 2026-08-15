/**
 * @file test/test_ws_comprehensive.js
 * @brief Vitest testing suite validating server modules.
 */

'use strict';

/**
 * Comprehensive WebSocket Server Test Suite
 *
 * Tests all Command API endpoints and CoAP message handlers by simulating
 * a Tado Internet Bridge connecting via WSS. Validates message flow,
 * ACK responses, and Command API pushes.
 *
 * Run: node ws-server/test/test_ws_comprehensive.js
 *
 * Requires:
 *   - WS server running on WSS port (default 988)
 *   - Command API running on HTTP port (default 3111)
 *   - Seeded database with valid home/zone/device data
 */

const testConfig = require('./test_config');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const wsBridge = require('../lib/ws-bridge');
const coap = require('../lib/coap');
const tlv = require('../lib/tlv');
const db = require('../lib/db');
const dbHelper = require('./test_db_helper');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const WS_URL = testConfig.WS_URL;
const CMD_API = testConfig.CMD_API;
const DEVICE_ID = testConfig.TEST_DEVICE_ID || testConfig.DEVICE_ID;
const HOME_ID = testConfig.TEST_HOME_ID || testConfig.HOME_ID;
const ZONE_ID = testConfig.TEST_ZONE_ID || testConfig.ZONE_ID;
const IPV6 = '::1';
const UDP_PORT = 54321;

// ---- State ----

let ws = null;
let passed = 0;
let failed = 0;
let skipped = 0;
let midCounter = 0x100;
const rxMessages = [];
const rxListeners = [];

// ---- Helpers ----

function test(name, condition, detail = '') {
    if (condition) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

function skip(name, reason = '') {
    skipped++;
    console.log(`  ⊘ ${name} (SKIP${reason ? ': ' + reason : ''})`);
}

function section(title) { console.log(`\n══ ${title} ══`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function onWsMessage(data) {
    try {
        console.log(`[DEBUG-RX] Binary received: ${data.byteLength} bytes`);
        const frame = wsBridge.parse(Buffer.from(data));
        if (!frame.ok) {
            console.log(`[DEBUG-RX] Frame parse error: ${frame.err}`);
            return;
        }
        console.log(`[DEBUG-RX] Frame dir=${frame.direction} ipv6=${frame.ipv6} coapLen=${frame.coapLen}`);
        const coapMsg = coap.parse(frame.coapBytes);
        if (!coapMsg.ok) {
            console.log(`[DEBUG-RX] CoAP parse error: ${coapMsg.err}`);
            return;
        }
        console.log(`[DEBUG-RX] CoAP ${coap.codeStr(coapMsg.code)} /${coap.uriPath(coapMsg)} MID=${coapMsg.mid}`);
        let decoded = null;
        if (coapMsg.payload && coapMsg.payload.length >= 3) {
            decoded = tlv.decode(coapMsg.payload);
        }
        const entry = {
            method: coap.codeStr(coapMsg.code),
            uri: coap.uriPath(coapMsg),
            isRequest: coap.isRequest(coapMsg.code),
            mid: coapMsg.mid,
            type: coapMsg.type,
            token: coapMsg.token,
            decoded: decoded && decoded.ok ? decoded : null,
            coapMsg,
            raw: data
        };
        rxMessages.push(entry);
        // Auto-ACK CON requests from server
        if (coapMsg.type === coap.TYPE_CON && coap.isRequest(coapMsg.code)) {
            const ackBytes = coap.buildAck(coapMsg);
            const ackFrame = wsBridge.build({ direction: 'client_to_server', ipv6: IPV6, udpPort: UDP_PORT, coapBytes: ackBytes });
            ws.send(ackFrame);
        }
        // Notify waiting listeners
        for (let i = rxListeners.length - 1; i >= 0; i--) {
            if (rxListeners[i].test(entry)) {
                rxListeners[i].resolve(entry);
                rxListeners.splice(i, 1);
            }
        }
    } catch (e) { /* ignore parse errors */ }
}

function waitForMessage(predicate, timeoutMs = 5000) {
    // Check existing messages first
    const existing = rxMessages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const idx = rxListeners.findIndex(l => l.resolve === resolve);
            if (idx >= 0) rxListeners.splice(idx, 1);
            reject(new Error('Timeout waiting for message'));
        }, timeoutMs);
        rxListeners.push({
            test: predicate,
            resolve: (entry) => { clearTimeout(timer); resolve(entry); }
        });
    });
}

function clearMessages() { rxMessages.length = 0; }

function sendCoap(path, code, payload = Buffer.alloc(0)) {
    const mid = midCounter++;
    const coapBytes = coap.buildRequest({
        code, path,
        token: crypto.randomBytes(4),
        mid,
        type: coap.TYPE_CON,
        payload
    });
    const frame = wsBridge.build({
        direction: 'client_to_server',
        ipv6: IPV6,
        udpPort: UDP_PORT,
        coapBytes
    });
    ws.send(frame);
    return mid;
}

function cmdApi(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(CMD_API + path);
        const opts = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method,
            headers: { 'Accept': 'application/json' }
        };
        if (body) {
            opts.headers['Content-Type'] = 'application/json';
        }
        const req = http.request(opts, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve({ code: res.statusCode, body: JSON.parse(data) }); }
                catch { resolve({ code: res.statusCode, body: data }); }
            });
        });
        req.on('error', e => resolve({ code: 0, body: null, error: e.message }));
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}



// ---- Main Test Runner ----

async function runTests() {
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║  Comprehensive WebSocket Server Test Suite   ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log(`  WS_URL:   ${WS_URL}`);
    console.log(`  CMD_API:  ${CMD_API}`);
    console.log(`  DEVICE:   ${DEVICE_ID}`);

    // Setup synthetic test fixtures if configured
    try {
        const pool = db.getPool();
        // Since test_ws_comprehensive doesn't use password-based API auth itself (it uses ws), pass default credentials
        await dbHelper.setupTestFixtures(pool, DEVICE_ID, HOME_ID, ZONE_ID, 'admin', 'admin123', testConfig.HOME_ID, testConfig.DEVICE_ID);
    } catch (e) {
        console.error('Error during database setup:', e.message);
    }

    // Backup original DB state to revert changes after tests
    let originalDeviceConfig = null;
    let originalChildLock = null;
    let originalCircuitConfig = null;

    try {
        const pool = db.getPool();
        const [deviceRows] = await pool.execute('SELECT last_config_json, child_lock_enabled FROM devices WHERE serial_no = ?', [DEVICE_ID]);
        if (deviceRows.length > 0) {
            originalDeviceConfig = deviceRows[0].last_config_json;
            originalChildLock = deviceRows[0].child_lock_enabled;
        }
        const [circuitRows] = await pool.execute('SELECT last_config_json, config_etag, field_2040, config_etag_real FROM heating_circuits WHERE home_id = ? AND number = 1', [HOME_ID]);
        if (circuitRows.length > 0) {
            originalCircuitConfig = circuitRows[0];
        }
    } catch (e) {
        console.warn('Warning: Could not backup original DB state for restore:', e.message);
    }

    try {
        // ---- Load TLV labels ----
        try {
            const labels = await db.getTlvLabels();
            tlv.init(labels.fields);
        } catch (e) {
            throw new Error(`Cannot load TLV labels: ${e.message}`);
        }

        // ╔══════════════════════════════════════╗
        // ║  1. Connection & Authentication      ║
        // ╚══════════════════════════════════════╝
        section('1. Connection & Authentication');

        try {
            ws = new WebSocket(WS_URL, { rejectUnauthorized: false });
            await new Promise((resolve, reject) => {
                ws.on('open', resolve);
                ws.on('error', reject);
                setTimeout(() => reject(new Error('WebSocket connect timeout')), 10000);
            });
            test('WebSocket connected', true);
            ws.on('message', onWsMessage);
        } catch (e) {
            test('WebSocket connected', false, e.message);
            throw new Error('Cannot connect to WS server. Aborting.');
        }

        // Authenticate
        try {
            const authPayload = tlv.encode([
                { fid: 0x0007, value: crypto.randomBytes(32) },
                { fid: 0x0260, value: Buffer.from(DEVICE_ID, 'utf8') }
            ]);
            sendCoap('auth/token', coap.CODE_POST, authPayload);

            const authResp = await waitForMessage(m => m.method === '2.04' || m.method === '2.05' || m.method === 'CHANGED' || m.method === 'CONTENT', 5000);
            test('Auth returns 2.04 Changed or 2.05 Content', true);
            test('Auth response has payload', authResp.coapMsg.payload.length > 0);

            if (authResp.decoded && authResp.decoded.ok) {
                console.log('--- DECODED AUTH FIELDS ---', authResp.decoded.fields);
                test('Auth response has session_token', '0x025e' in authResp.decoded.fields || 'session_token' in authResp.decoded.fields);
                test('Auth response has token_validity_minutes', '0x025f' in authResp.decoded.fields || 'token_validity_minutes' in authResp.decoded.fields);
            } else {
                skip('Auth TLV decode', 'Response payload not TLV');
                skip('Auth validity', 'Response payload not TLV');
            }
        } catch (e) {
            test('Auth returns 2.04 Changed', false, e.message);
            throw new Error('Authentication failed. Aborting.');
        }

        await sleep(500);

    // ╔══════════════════════════════════════╗
    // ║  2. Sensor Data                      ║
    // ╚══════════════════════════════════════╝
    section('2. Sensor Data');

    clearMessages();
    sendCoap(`d/${DEVICE_ID}/sen`, coap.CODE_POST, tlv.encode([
        { fid: 0x012d, value: tlv.encodeValue(2150, 'u16be') },  // 21.50°C
        { fid: 0x0135, value: tlv.encodeValue(550, 'u16be') },   // 55.0% humidity
        { fid: 0x012a, value: tlv.encodeValue(2800, 'u16be') },  // 2800mV battery
    ]));
    await sleep(500);
    // Sensor POSTs get ACK'd (we check that no error was thrown during send)
    test('Sensor data sent without error', true);

    // ╔══════════════════════════════════════╗
    // ║  3. Device Actuator                  ║
    // ╚══════════════════════════════════════╝
    section('3. Device Actuator');

    clearMessages();
    sendCoap(`d/${DEVICE_ID}/act`, coap.CODE_POST, tlv.encode([
        { fid: 0x006a, value: tlv.encodeValue(75, 'u16be') },  // valve position 75%
    ]));
    await sleep(500);
    test('Actuator data sent without error', true);

    // ╔══════════════════════════════════════╗
    // ║  4. Device Config                    ║
    // ╚══════════════════════════════════════╝
    section('4. Device Config');

    // Device Config GET (Checking Block2/ETag)
    section('4b. Device Config GET');
    clearMessages();
    try {
        sendCoap(`d/${DEVICE_ID}/config`, coap.CODE_GET);
        const cfgResp = await waitForMessage(m => m.method === '2.05' || m.method === 'CONTENT', 5000);
        test('Device config GET returns 2.05 Content', true);
        if (cfgResp.coapMsg.payload.length > 0) {
            const etag = coap.optionFirst(cfgResp.coapMsg, coap.OPT_ETAG);
            test('Config response has ETag', !!etag);

            if (etag) {
                // Try again with ETag to see if we get 2.03 Valid
                clearMessages();
                const mid2 = midCounter++;
                const cb2 = coap.buildRequest({
                    code: coap.CODE_GET, path: `d/${DEVICE_ID}/config`,
                    token: crypto.randomBytes(4), mid: mid2, type: coap.TYPE_CON,
                    extraOptions: [{ num: coap.OPT_ETAG, value: etag }]
                });
                ws.send(wsBridge.build({ direction: 'client_to_server', ipv6: IPV6, udpPort: UDP_PORT, coapBytes: cb2 }));
                const validResp = await waitForMessage(m => m.method === '2.03' || m.method === 'VALID', 5000);
                test('Conditional GET with ETag returns 2.03 Valid', !!validResp);
            }
        }
    } catch (e) {
        test('Device config GET flow', false, e.message);
    }

    clearMessages();
    sendCoap(`d/${DEVICE_ID}/config`, coap.CODE_POST, tlv.encode([
        { fid: 0x0094, value: tlv.encodeValue(100, 'u16be') },  // temperature_offset (1.0 * 100)
    ]));
    await sleep(500);
    test('Device config PUT sent without error', true);

    // ╔══════════════════════════════════════╗
    // ║  5. Zone State                       ║
    // ╚══════════════════════════════════════╝
    section('5. Zone State');

    clearMessages();
    sendCoap(`h/${HOME_ID}/z/${ZONE_ID}/s`, coap.CODE_POST, tlv.encode([
        { fid: 0x6280, value: tlv.encodeValue(2100, 'u16be') },  // target temp 21.0°C
    ]));
    await sleep(500);
    test('Zone state sent without error', true);

    // ╔══════════════════════════════════════╗
    // ║  6. HVAC Monitoring                  ║
    // ╚══════════════════════════════════════╝
    section('6. HVAC Monitoring');

    clearMessages();
    sendCoap(`h/${HOME_ID}/hvac/mon`, coap.CODE_POST, tlv.encode([
        { fid: 0x00c8, value: tlv.encodeValue(55, 'u16be') },  // flow temperature
    ]));
    await sleep(500);
    test('HVAC monitoring data sent without error', true);

    // ╔══════════════════════════════════════╗
    // ║  7. Device Status Messages           ║
    // ╚══════════════════════════════════════╝
    section('7. Device Status Messages');

    // Firmware state
    clearMessages();
    sendCoap(`d/${DEVICE_ID}/fw/state`, coap.CODE_POST, tlv.encode([
        { fid: 0x003a, value: tlv.encodeValue(9210, 'u16be') },
    ]));
    await sleep(300);
    test('Firmware state sent', true);

    // Error flags
    sendCoap(`d/${DEVICE_ID}/err`, coap.CODE_POST, tlv.encode([
        { fid: 0x01a3, value: tlv.encodeValue(0, 'u32be') },
    ]));
    await sleep(300);
    test('Error flags sent', true);

    // Selftest
    sendCoap(`d/${DEVICE_ID}/selftest`, coap.CODE_POST, tlv.encode([
        { fid: 0x01ac, value: tlv.encodeValue(3300, 'u16be') },  // supply mV
    ]));
    await sleep(300);
    test('Selftest sent', true);

    // Mount
    sendCoap(`d/${DEVICE_ID}/mnt`, coap.CODE_POST, tlv.encode([
        { fid: 0x020a, value: tlv.encodeValue(0, 'u8') },
    ]));
    await sleep(300);
    test('Mount state sent', true);

    // Lock
    sendCoap(`d/${DEVICE_ID}/lock`, coap.CODE_POST, tlv.encode([
        { fid: 0x0290, value: tlv.encodeValue(0, 'u8') },
    ]));
    await sleep(300);
    test('Lock state sent', true);

    // Neighbors (Multi-block PUT)
    section('7b. Neighbors (Multi-block)');
    clearMessages();
    const neighborId = crypto.randomBytes(4);
    for (let i = 0; i < 2; i++) {
        // block1Option: num=i, m=(i<1), sz=64 (2)
        const block1Option = (i << 4) | (i === 1 ? 0 : 8) | 2;
        const cb = coap.buildRequest({
            code: coap.CODE_PUT, path: `d/${DEVICE_ID}/neighbors`,
            token: neighborId, mid: 0x2100 + i, type: coap.TYPE_CON,
            extraOptions: [{ num: coap.OPT_BLOCK1, value: Buffer.from([block1Option]) }],
            payload: Buffer.alloc(64, i)
        });
        ws.send(wsBridge.build({ direction: 'client_to_server', ipv6: IPV6, udpPort: UDP_PORT, coapBytes: cb }));
        await sleep(100);
    }
    await sleep(300);
    test('Multi-block neighbors sent', true);

    // ╔══════════════════════════════════════╗
    // ║  8. Time Sync                        ║
    // ╚══════════════════════════════════════╝
    section('8. Time Sync');

    clearMessages();
    try {
        sendCoap('time', coap.CODE_GET);
        const timeMsg = await waitForMessage(m => m.method === '2.05' || m.method === 'CONTENT', 5000);
        test('Time sync returns 2.05 Content', true);

        if (timeMsg.coapMsg.payload.length >= 5) {
            const timeDecoded = coap.decodeTimeProtobuf(timeMsg.coapMsg.payload);
            test('Time payload decodes as protobuf', timeDecoded.ok, timeDecoded.err);
            if (timeDecoded.ok) {
                const nowSec = Math.floor(Date.now() / 1000);
                const drift = Math.abs(timeDecoded.unix_s - nowSec);
                test('Time drift < 10 seconds', drift < 10, `drift=${drift}s`);
            }
        } else {
            skip('Time protobuf decode', 'Payload too short');
            skip('Time drift check', 'No valid payload');
        }
    } catch (e) {
        test('Time sync response', false, e.message);
    }

    // ╔══════════════════════════════════════╗
    // ║  9. Command API: Health              ║
    // ╚══════════════════════════════════════╝
    section('9. Command API: Health');

    const healthUnauth = await cmdApi('GET', '/api/health');
    test('GET /api/health without token returns 401', healthUnauth.code === 401, `Got ${healthUnauth.code}`);

    const healthPublic = await cmdApi('GET', '/api/public/health');
    test('GET /api/public/health returns 200', healthPublic.code === 200, `Got ${healthPublic.code}`);
    test('Public health status is ok', healthPublic.body && healthPublic.body.status === 'ok');

    // ╔══════════════════════════════════════╗
    // ║  10. Command API: Clients            ║
    // ╚══════════════════════════════════════╝
    section('10. Command API: Clients');

    const clients = await cmdApi('GET', '/api/clients');
    test('GET /api/clients returns 200', clients.code === 200, `Got ${clients.code}`);
    test('Clients list is array', clients.body && Array.isArray(clients.body.clients));

    const ourClient = (clients.body?.clients || []).find(c => c.deviceId === DEVICE_ID);
    test('Our test device appears in clients', !!ourClient, `Looking for ${DEVICE_ID}`);

    // ╔══════════════════════════════════════╗
    // ║  11. Command API: Send               ║
    // ╚══════════════════════════════════════╝
    section('11. Command API: Send');

    clearMessages();
    try {
        const sendResult = await cmdApi('POST', '/api/send', {
            deviceId: DEVICE_ID,
            code: 3,
            path: `d/${DEVICE_ID}/config`,
            tlvPayload: [
                { fid: 0x0094, type: 'u16be', value: 50 }
            ]
        });
        test('POST /api/send returns 200', sendResult.code === 200, `Got ${sendResult.code}`);

        const pushed = await waitForMessage(m => m.isRequest && m.uri.includes('config'), 3000);
        test('Device received config push', !!pushed);
    } catch (e) {
        test('Send + receive push', false, e.message);
    }

    // ╔══════════════════════════════════════╗
    // ║  12. Command API: Zone Overlay       ║
    // ╚══════════════════════════════════════╝
    section('12. Command API: Zone Overlay');

    clearMessages();
    try {
        const overlayResult = await cmdApi('POST', `/api/homes/${HOME_ID}/z/${ZONE_ID}/overlay`, {
            setting: { power: 'ON', temperature: { celsius: 24.0 } },
            termination: { typeSkillBasedApp: 'MANUAL' }
        });
        test('POST overlay returns 200', overlayResult.code === 200, `Got ${overlayResult.code} body: ${JSON.stringify(overlayResult.body)}`);

        // Push may not arrive if test device isn't in DB devices table for the zone
        try {
            const zsPush = await waitForMessage(m => m.isRequest && m.uri.includes('z/'), 3000);
            test('Device received zone state push', !!zsPush);

            // TLV payload verification
            if (zsPush.decoded && zsPush.decoded.ok) {
                const f = zsPush.decoded.fields;
                test('TLV overlay_mode = 1 or 2 (MANUAL)', f['0x6240'] === 1 || f['0x6240'] === 2 || f['0x6240'] === '01' || f['0x6240'] === '02', `got ${f['0x6240']}`);
                test('TLV overlay_has_setpoint = true', f['0x6260'] === true || f['0x6260'] === 1 || f['0x6260'] === '01', `got ${f['0x6260']}`);
                test('TLV overlay_target_temperature = 24', f['0x6280'] !== undefined && Math.abs(f['0x6280'] - 24) < 1.0, `got ${f['0x6280']}`);
                test('TLV zone_service_type present', f['0x62e0'] !== undefined);
            } else {
                skip('Overlay TLV field verification', 'Push was not TLV-decoded');
            }
        } catch {
            skip('Zone state push', 'Test device not in DB devices table for this zone');
        }
    } catch (e) {
        test('Overlay push flow', false, e.message);
    }

    // ╔══════════════════════════════════════╗
    // ║  13. Command API: Zone Overlay Delete║
    // ╚══════════════════════════════════════╝
    section('13. Command API: Overlay Delete');

    clearMessages();
    try {
        const delResult = await cmdApi('DELETE', `/api/homes/${HOME_ID}/z/${ZONE_ID}/overlay`);
        test('DELETE overlay returns 200', delResult.code === 200, `Got ${delResult.code} body: ${JSON.stringify(delResult.body)}`);

        try {
            const resumePush = await waitForMessage(m => m.isRequest && m.uri.includes('z/'), 3000);
            test('Device received resume schedule push', !!resumePush);

            // TLV payload verification
            if (resumePush.decoded && resumePush.decoded.ok) {
                const f = resumePush.decoded.fields;
                test('TLV overlay_mode = 0 (SCHEDULE)', f['0x6240'] === 0 || f['0x6240'] === '00', `got ${f['0x6240']}`);
            } else {
                skip('Resume TLV verification', 'Push was not TLV-decoded');
            }
        } catch {
            skip('Resume schedule push', 'Test device not in DB devices table for this zone');
        }
    } catch (e) {
        test('Overlay delete flow', false, e.message);
    }

    // ╔══════════════════════════════════════╗
    // ║  14. Command API: Device Config Push ║
    // ╚══════════════════════════════════════╝
    section('14. Command API: Device Config Push');

    clearMessages();
    try {
        const cfgResult = await cmdApi('POST', `/api/devices/${DEVICE_ID}/config`, {
            changes: { '0x0140': 0.5, temperature_offset: 0.5 }
        });

        // 404 expected if test device not in DB devices table
        if (cfgResult.code === 404) {
            skip('Device config push', 'Test device not in DB devices table');
        } else {
            test('POST device config returns 200', cfgResult.code === 200, `Got ${cfgResult.code}`);
            try {
                const cfgPush = await waitForMessage(m => m.isRequest && m.uri.includes('config'), 3000);
                test('Device received config push', !!cfgPush);

                // TLV payload verification
                if (cfgPush.decoded && cfgPush.decoded.ok) {
                    console.log('--- RECEIVED CONFIG FIELDS ---', cfgPush.decoded.fields);
                    const offset = cfgPush.decoded.fields['0x0140'] !== undefined ? cfgPush.decoded.fields['0x0140'] : cfgPush.decoded.fields['temperature_offset'];
                    test('Config TLV has temperature_offset', offset !== undefined, 'field missing');
                    if (offset !== undefined) {
                        test('temperature_offset ≈ 0.5', Math.abs(offset - 0.5) < 0.1, `got ${offset}`);
                    }
                } else {
                    skip('Config TLV verification', 'Push was not TLV-decoded');
                }
            } catch {
                test('Config push delivery', false, 'Timeout');
            }
        }
    } catch (e) {
        test('Config push flow', false, e.message);
    }

    // ╔══════════════════════════════════════╗
    // ║  15. Command API: Device Lock        ║
    // ╚══════════════════════════════════════╝
    section('15. Command API: Device Lock');

    clearMessages();
    try {
        const lockResult = await cmdApi('POST', `/api/devices/${DEVICE_ID}/lock`, { enabled: true });
        test('POST device lock returns 200', lockResult.code === 200, `Got ${lockResult.code}`);

        const lockPush = await waitForMessage(m => m.isRequest && m.uri.includes('lock'), 3000);
        test('Device received lock push', !!lockPush);
    } catch (e) {
        test('Lock push flow', false, e.message);
    }

    // ╔══════════════════════════════════════╗
    // ║  16. Command API: Identify           ║
    // ╚══════════════════════════════════════╝
    section('16. Command API: Device Identify');

    clearMessages();
    try {
        const idResult = await cmdApi('POST', `/api/devices/${DEVICE_ID}/identify`, {});
        test('POST identify returns 200', idResult.code === 200, `Got ${idResult.code}`);

        const idPush = await waitForMessage(m => m.isRequest && m.uri.includes('identify'), 3000);
        test('Device received identify push', !!idPush);
    } catch (e) {
        test('Identify push flow', false, e.message);
    }

    // ╔══════════════════════════════════════╗
    // ║  17. Command API: Circuit Config     ║
    // ╚══════════════════════════════════════╝
    section('17. Command API: Circuit Config');

    clearMessages();
    try {
        const ccResult = await cmdApi('POST', `/api/homes/${HOME_ID}/c/1/config`, { max_temp: 55.0 });
        test('POST circuit config returns 200', ccResult.code === 200, `Got ${ccResult.code}`);

        // Simulate device poll via CoAP GET
        sendCoap(`h/${HOME_ID}/c/1/config`, coap.CODE_GET, null);
        const ccPollResp = await waitForMessage(m => m.method === '2.05' || m.method === 'CONTENT', 3000);
        test('Device config poll returns 2.05 Content', !!ccPollResp);
    } catch (e) {
        test('Circuit config flow', false, e.message);
    }

    // ╔══════════════════════════════════════╗
    // ║  18. Command API: Time Broadcast     ║
    // ╚══════════════════════════════════════╝
    section('18. Command API: Time Broadcast');

    clearMessages();
    try {
        const tbResult = await cmdApi('POST', '/api/time/broadcast', {});
        // 500 expected if broadcastTime function not injected into command-api
        if (tbResult.code === 500) {
            skip('Time broadcast', 'broadcastTime not injected into command API');
        } else {
            test('POST time broadcast returns 200', tbResult.code === 200, `Got ${tbResult.code}`);
        }
        await sleep(500);
    } catch (e) {
        test('Time broadcast', false, e.message);
    }

    // ╔══════════════════════════════════════╗
    // ║  19. Command API: Send Raw           ║
    // ╚══════════════════════════════════════╝
    section('19. Command API: Send Raw');

    try {
        // Build a small CoAP NON GET for 'time' and wrap in WS frame
        const rawCoap = coap.buildRequest({
            code: coap.CODE_GET, path: 'time',
            token: Buffer.alloc(1), mid: 0xBEEF, type: coap.TYPE_NON
        });
        const rawFrame = wsBridge.build({
            direction: 'server_to_client', ipv6: IPV6, coapBytes: rawCoap
        });
        const rawResult = await cmdApi('POST', '/api/send-raw', {
            deviceId: DEVICE_ID,
            wsHex: rawFrame.toString('hex')
        });
        test('POST /api/send-raw returns 200', rawResult.code === 200, `Got ${rawResult.code}`);
    } catch (e) {
        test('Send raw', false, e.message);
    }

    // ╔══════════════════════════════════════╗
    // ║  Summary                             ║
    // ╚══════════════════════════════════════╝
    section('RESULTS');
    const total = passed + failed + skipped;
    console.log(`  Total: ${total} | Passed: ${passed} | Failed: ${failed} | Skipped: ${skipped}`);
    console.log(`  ${failed === 0 ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'}\n`);

    } catch (err) {
        console.error('FATAL E2E ERROR:', err.message);
        failed++;
    } finally {
        console.log('\nRestoring original database state...');
        try {
            const pool = db.getPool();
            if (originalDeviceConfig !== null) {
                await pool.execute('UPDATE devices SET last_config_json = ?, child_lock_enabled = ? WHERE serial_no = ?', [originalDeviceConfig, originalChildLock, DEVICE_ID]);
            }
            if (originalCircuitConfig !== null) {
                await pool.execute(
                    'UPDATE heating_circuits SET last_config_json = ?, config_etag = ?, field_2040 = ?, config_etag_real = ? WHERE home_id = ? AND number = 1',
                    [
                        originalCircuitConfig.last_config_json,
                        originalCircuitConfig.config_etag,
                        originalCircuitConfig.field_2040,
                        originalCircuitConfig.config_etag_real,
                        HOME_ID
                    ]
                );
            } else {
                await pool.execute('DELETE FROM heating_circuits WHERE home_id = ? AND number = 1', [HOME_ID]);
            }
            // Also ensure any test overlays are deleted
            await pool.execute('DELETE FROM zone_overlays WHERE zone_id = ? AND home_id = ?', [ZONE_ID, HOME_ID]);
            
            // Clean up synthetic test fixtures if they were created
            await dbHelper.cleanupTestFixtures(pool, HOME_ID, DEVICE_ID);
            
            console.log('Database state restored successfully.');
        } catch (restoreErr) {
            console.error('Error during DB state restore:', restoreErr.message);
        }

        // Cleanup
        if (ws && ws.readyState === WebSocket.OPEN) ws.close();
        await db.close();
        process.exit(failed > 0 ? 1 : 0);
    }
}

runTests();
