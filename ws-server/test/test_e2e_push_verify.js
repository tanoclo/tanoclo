/**
 * @file test/test_e2e_push_verify.js
 * @brief Vitest testing suite validating server modules.
 */

'use strict';

/**
 * End-to-End Push Verification Test Suite
 *
 * Tests API → Command API → WS Push with full TLV payload verification.
 * Each test calls a Command API endpoint and verifies the exact TLV fields
 * in the binary WS message received by a simulated Internet Bridge device.
 *
 * Reference TLV payloads extracted from real Tado server debug logs (PROXY DOWN).
 *
 * Run: node ws-server/test/test_e2e_push_verify.js
 *
 * Requires:
 *   - WS server running (WSS port)
 *   - Command API running (HTTP port 3111)
 *   - Seeded database with valid home/zone/device data
 *
 * Environment Variables:
 *   WS_URL      - WebSocket server URL (default: wss://127.0.0.1:988/hw/v2)
 *   CMD_API     - Command API URL (default: http://127.0.0.1:3111)
 *   HOME_ID     - Home ID (default: 999999)
 *   ZONE_ID     - Zone ID (default: 1)
 *   DEVICE_ID   - Simulated device serial (default: IB0000TEST01)
 */

const testConfig = require('./test_config');
const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');
const wsBridge = require('../lib/ws-bridge');
const coap = require('../lib/coap');
const tlv = require('../lib/tlv');
const db = require('../lib/db');
const dbHelper = require('./test_db_helper');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const WS_URL = testConfig.WS_URL;

const CMD_API = testConfig.CMD_API;
const HOME_ID = testConfig.TEST_HOME_ID || testConfig.HOME_ID;
const ZONE_ID = testConfig.TEST_ZONE_ID || testConfig.ZONE_ID;
const DEVICE_ID = testConfig.TEST_DEVICE_ID || testConfig.DEVICE_ID;
const REST_API = testConfig.API_URL;
const IPV6 = '::1';
const UDP_PORT = 54321;

// ---- State ----

let ws = null;
let accessToken = null;
let passed = 0;
let failed = 0;
let skipped = 0;
let midCounter = 0x300;
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
        const frame = wsBridge.parse(Buffer.from(data));
        if (!frame.ok) return;
        const coapMsg = coap.parse(frame.coapBytes);
        if (!coapMsg.ok) return;
        let decoded = null;
        if (coapMsg.payload && coapMsg.payload.length >= 3) decoded = tlv.decode(coapMsg.payload);
        const entry = {
            method: coap.codeStr(coapMsg.code),
            uri: coap.uriPath(coapMsg),
            isRequest: coap.isRequest(coapMsg.code),
            mid: coapMsg.mid,
            type: coapMsg.type,
            token: coapMsg.token,
            decoded: decoded && decoded.ok ? decoded : null,
            coapMsg,
            raw: data,
            receivedAt: Date.now()
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
    const existing = rxMessages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const idx = rxListeners.findIndex(l => l.resolve === resolve);
            if (idx >= 0) rxListeners.splice(idx, 1);
            reject(new Error('Timeout waiting for WS message'));
        }, timeoutMs);
        rxListeners.push({
            test: predicate,
            resolve: entry => { clearTimeout(timer); resolve(entry); }
        });
    });
}

function waitForMessages(predicate, count, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const results = [];
        const timer = setTimeout(() => {
            resolve(results); // Return whatever we got
        }, timeoutMs);

        function check() {
            // Scan existing messages first
            for (const msg of rxMessages) {
                if (predicate(msg) && !results.includes(msg)) {
                    results.push(msg);
                    if (results.length >= count) {
                        clearTimeout(timer);
                        resolve(results);
                        return;
                    }
                }
            }
        }

        // Also register a listener for future messages
        const listener = {
            test: entry => {
                if (predicate(entry) && !results.includes(entry)) {
                    results.push(entry);
                    if (results.length >= count) {
                        clearTimeout(timer);
                        return true;
                    }
                }
                return false;
            },
            resolve: () => resolve(results)
        };
        rxListeners.push(listener);
        check();
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
    return new Promise((resolve) => {
        const url = new URL(CMD_API + path);
        const opts = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method,
            headers: { 'Accept': 'application/json' }
        };
        if (body) opts.headers['Content-Type'] = 'application/json';
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

/**
 * Make an HTTP(S) request to the REST API (for presenceLock etc.)
 * Includes JWT auth header.
 */
function restApi(method, path, body = null) {
    const https = require('https');
    return new Promise((resolve) => {
        const url = new URL(REST_API + path);
        const isHttps = url.protocol === 'https:';
        const lib = isHttps ? https : http;
        const opts = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method,
            headers: { 'Accept': 'application/json' },
            rejectAuthorized: false
        };
        if (body) opts.headers['Content-Type'] = 'application/json';
        if (accessToken) {
            opts.headers['Authorization'] = `Bearer ${accessToken}`;
        }
        const req = lib.request(opts, (res) => {
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

function getAccessToken() {
    const https = require('https');
    const querystring = require('querystring');
    return new Promise((resolve, reject) => {
        const authUrlStr = testConfig.AUTH_URL || REST_API;
        const url = new URL(authUrlStr + '/oauth/token');
        const isHttps = url.protocol === 'https:';
        const lib = isHttps ? https : http;
        const postData = querystring.stringify({
            grant_type: 'password',
            username: testConfig.API_USER,
            password: testConfig.API_PASS,
            client_id: 'tado-web-app',
            scope: 'home.user'
        });
        const opts = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname,
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            },
            rejectUnauthorized: false
        };
        const req = lib.request(opts, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.access_token) {
                        resolve(parsed.access_token);
                    } else {
                        reject(new Error(parsed.error_description || parsed.error || 'No token in response'));
                    }
                } catch (e) {
                    reject(new Error(`Failed to parse auth response: ${e.message}`));
                }
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

/**
 * Verify that a TLV-decoded message contains expected fields with correct values.
 * @param {string} testPrefix - Name prefix for assertions
 * @param {Object} decoded - Decoded TLV object { ok, fields }
 * @param {Object} expected - Map of field name → expected value
 */
function verifyTlvFields(testPrefix, decoded, expected) {
    if (!decoded || !decoded.ok) {
        test(`${testPrefix}: TLV decoded`, false, 'No decoded TLV');
        return;
    }
    const fields = decoded.fields;
    const items = decoded.items || [];
    for (const [key, expectedVal] of Object.entries(expected)) {
        const item = items.find(i => i.name === key);
        const actual = item ? item.value : fields[key];
        if (actual === undefined) {
            test(`${testPrefix}: has ${key}`, false, 'field missing');
        } else if (typeof expectedVal === 'number') {
            // Allow small float tolerance
            const match = Math.abs(actual - expectedVal) < 0.01;
            test(`${testPrefix}: ${key} = ${expectedVal}`, match, `got ${actual}`);
        } else if (typeof expectedVal === 'boolean') {
            test(`${testPrefix}: ${key} = ${expectedVal}`, actual === expectedVal || actual === (expectedVal ? 1 : 0), `got ${actual}`);
        } else {
            test(`${testPrefix}: ${key} = ${expectedVal}`, actual == expectedVal, `got ${actual}`);
        }
    }
}


// ---- Main Test Runner ----

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║  E2E Push Verification Test Suite                    ║');
    console.log('║  Verifies API → CoAP/TLV → WS binary payload        ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log(`  WS_URL:   ${WS_URL}`);
    console.log(`  CMD_API:  ${CMD_API}`);
    console.log(`  REST_API: ${REST_API}`);
    console.log(`  DEVICE:   ${DEVICE_ID}`);
    console.log(`  HOME_ID:  ${HOME_ID}`);
    console.log(`  ZONE_ID:  ${ZONE_ID}`);

    // Setup synthetic test fixtures if configured
    try {
        const pool = db.getPool();
        // Since test_e2e_push_verify doesn't use password-based API auth itself (it uses JWT directly), pass default credentials
        await dbHelper.setupTestFixtures(pool, DEVICE_ID, HOME_ID, ZONE_ID, 'admin', 'admin123', testConfig.HOME_ID, testConfig.DEVICE_ID);
    } catch (e) {
        console.error('Error during database setup:', e.message);
    }

    // Authenticate with REST API to get token
    try {
        accessToken = await getAccessToken();
    } catch (e) {
        console.error('Failed to authenticate with REST API:', e.message);
    }

    // Backup original DB state to revert changes after tests
    let originalPresence = null;
    let originalPresenceLocked = null;
    let originalDeviceConfig = null;
    let originalChildLock = null;
    let originalZoneConfig = null;
    let originalDefaultOverlayType = null;
    let originalDefaultOverlayDuration = null;

    try {
        const pool = db.getPool();
        const [homeRows] = await pool.execute('SELECT presence, presence_locked FROM homes WHERE id = ?', [HOME_ID]);
        if (homeRows.length > 0) {
            originalPresence = homeRows[0].presence;
            originalPresenceLocked = homeRows[0].presence_locked;
        }
        
        const [deviceRows] = await pool.execute('SELECT last_config_json, child_lock_enabled FROM devices WHERE serial_no = ?', [DEVICE_ID]);
        if (deviceRows.length > 0) {
            originalDeviceConfig = deviceRows[0].last_config_json;
            originalChildLock = deviceRows[0].child_lock_enabled;
        }

        const [zoneRows] = await pool.execute('SELECT last_config_json, default_overlay_type, default_overlay_duration FROM zones WHERE id = ? AND home_id = ?', [ZONE_ID, HOME_ID]);
        if (zoneRows.length > 0) {
            originalZoneConfig = zoneRows[0].last_config_json;
            originalDefaultOverlayType = zoneRows[0].default_overlay_type;
            originalDefaultOverlayDuration = zoneRows[0].default_overlay_duration;
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
        // ║  0. Connect & Authenticate           ║
        // ╚══════════════════════════════════════╝
        section('0. WebSocket Connection & Authentication');

        try {
            ws = new WebSocket(WS_URL, { rejectUnauthorized: false });
            await new Promise((resolve, reject) => {
                ws.on('open', resolve);
                ws.on('error', reject);
                setTimeout(() => reject(new Error('WS timeout')), 10000);
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
            test('Device authenticated (2.04 Changed or 2.05 Content)', true);
        } catch (e) {
            test('Device authenticated', false, e.message);
            throw new Error('Authentication failed. Aborting.');
        }

        await sleep(500);

    // ╔══════════════════════════════════════════════════════╗
    // ║  1. Set Overlay — Manual, specific temperature      ║
    // ╚══════════════════════════════════════════════════════╝
    section('1. Set Overlay: Manual 24.0°C');
    clearMessages();

    try {
        const result = await cmdApi('POST', `/api/homes/${HOME_ID}/z/${ZONE_ID}/overlay`, {
            setting: { power: 'ON', temperature: { celsius: 24.0 } },
            termination: { typeSkillBasedApp: 'MANUAL' }
        });
        test('POST overlay returns 200', result.code === 200, `Got ${result.code}`);

        const push = await waitForMessage(m => m.isRequest && m.uri.includes('z/'), 5000);
        test('Device received zone state push', !!push);
        test('Push method is PUT (0.03)', push.method === 'PUT' || push.method === '0.03');
        test('Push URI contains z/s', push.uri === 'z/s' || push.uri.includes('z/s'));

        // Verify TLV fields match real Tado server format
        // Reference: overlay_mode=1, overlay_has_setpoint=true, overlay_target_temperature=24
        verifyTlvFields('Overlay SET', push.decoded, {
            'overlay_mode': 2,
            'overlay_has_setpoint': true,
            'overlay_target_temp': 24,
            'zone_enabled': true,
            'zone_service_type': 1,
        });
    } catch (e) {
        test('Overlay set flow', false, e.message);
    }

    // ╔══════════════════════════════════════════════════════╗
    // ║  2. Set Overlay — Power OFF                         ║
    // ╚══════════════════════════════════════════════════════╝
    section('2. Set Overlay: Power OFF');
    clearMessages();

    try {
        const result = await cmdApi('POST', `/api/homes/${HOME_ID}/z/${ZONE_ID}/overlay`, {
            setting: { power: 'OFF' },
            termination: { typeSkillBasedApp: 'MANUAL' }
        });
        test('POST overlay OFF returns 200', result.code === 200, `Got ${result.code}`);

        const push = await waitForMessage(m => m.isRequest && m.uri.includes('z/'), 5000);
        test('Device received zone state push', !!push);

        // Power OFF → overlay_mode=1 but overlay_has_setpoint=0
        verifyTlvFields('Overlay OFF', push.decoded, {
            'overlay_mode': 1,
            'overlay_has_setpoint': false,
        });
    } catch (e) {
        test('Overlay OFF flow', false, e.message);
    }

    // ╔══════════════════════════════════════════════════════╗
    // ║  3. Set Overlay — NEXT_TIME_BLOCK termination       ║
    // ╚══════════════════════════════════════════════════════╝
    section('3. Set Overlay: NEXT_TIME_BLOCK 18.0°C');
    clearMessages();

    try {
        const result = await cmdApi('POST', `/api/homes/${HOME_ID}/z/${ZONE_ID}/overlay`, {
            setting: { power: 'ON', temperature: { celsius: 18.0 } },
            termination: { typeSkillBasedApp: 'NEXT_TIME_BLOCK' }
        });
        test('POST overlay NTB returns 200', result.code === 200, `Got ${result.code}`);

        const push = await waitForMessage(m => m.isRequest && m.uri.includes('z/'), 5000);
        test('Device received zone state push', !!push);

        // Reference: overlay_mode=3 for NEXT_TIME_BLOCK
        verifyTlvFields('Overlay NTB', push.decoded, {
            'overlay_mode': 3,
            'overlay_has_setpoint': true,
            'overlay_target_temp': 18,
        });
    } catch (e) {
        test('Overlay NTB flow', false, e.message);
    }

    // ╔══════════════════════════════════════════════════════╗
    // ║  4. Delete Overlay — Resume Schedule                ║
    // ╚══════════════════════════════════════════════════════╝
    section('4. Delete Overlay (Resume Schedule)');
    clearMessages();

    try {
        const result = await cmdApi('DELETE', `/api/homes/${HOME_ID}/z/${ZONE_ID}/overlay`);
        test('DELETE overlay returns 200', result.code === 200, `Got ${result.code}`);

        const push = await waitForMessage(m => m.isRequest && m.uri.includes('z/'), 5000);
        test('Device received resume push', !!push);

        // Reference: overlay_mode=0, no overlay_has_setpoint/overlay_target_temperature
        verifyTlvFields('Resume', push.decoded, {
            'overlay_mode': 0,
            'zone_enabled': true,
        });

        // Verify overlay fields are NOT present when resuming schedule
        if (push.decoded && push.decoded.ok) {
            const hasOverlayTemp = push.decoded.fields['overlay_target_temperature'] !== undefined;
            test('Resume: no overlay_target_temperature field', !hasOverlayTemp,
                hasOverlayTemp ? `unexpected value: ${push.decoded.fields['overlay_target_temperature']}` : '');
        }
    } catch (e) {
        test('Overlay delete flow', false, e.message);
    }

    // ╔══════════════════════════════════════════════════════╗
    // ║  5. Home/Away Toggle                                ║
    // ╚══════════════════════════════════════════════════════╝
    section('5. Home/Away Toggle');
    clearMessages();

    try {
        // Set AWAY via presenceLock (REST API)
        const awayResult = await restApi('PUT', `/api/v2/homes/${HOME_ID}/presenceLock`, {
            homePresence: 'AWAY'
        });
        test('PUT presenceLock AWAY returns 200', awayResult.code === 200, `Got ${awayResult.code}`);

        // Wait for zone state pushes — real Tado sends one per zone
        await sleep(1000);
        const awayPushes = rxMessages.filter(m => m.isRequest && (m.uri === 'z/s' || m.uri.includes('z/s')));
        test('Device received zone state push(es) for AWAY', awayPushes.length > 0, `Got ${awayPushes.length} pushes`);

        if (awayPushes.length > 0 && awayPushes[0].decoded && awayPushes[0].decoded.ok) {
            const f = awayPushes[0].decoded.fields;
            test('AWAY: home_away = 2', f['home_away'] === 2, `got ${f['home_away']}`);
            test('AWAY: zone_enabled = false', f['zone_enabled'] === false || f['zone_enabled'] === 0, `got ${f['zone_enabled']}`);
            test('AWAY: resume_schedule_event = 1', f['resume_schedule_event'] === 1, `got ${f['resume_schedule_event']}`);
        }

        // Set HOME via presenceLock (REST API)
        clearMessages();
        const homeResult = await restApi('PUT', `/api/v2/homes/${HOME_ID}/presenceLock`, {
            homePresence: 'HOME'
        });
        test('PUT presenceLock HOME returns 200', homeResult.code === 200, `Got ${homeResult.code}`);

        await sleep(1000);
        const homePushes = rxMessages.filter(m => m.isRequest && (m.uri === 'z/s' || m.uri.includes('z/s')));
        test('Device received zone state push(es) for HOME', homePushes.length > 0, `Got ${homePushes.length} pushes`);

        if (homePushes.length > 0 && homePushes[0].decoded && homePushes[0].decoded.ok) {
            const f = homePushes[0].decoded.fields;
            test('HOME: home_away = 1', f['home_away'] === 1, `got ${f['home_away']}`);
            test('HOME: zone_enabled = true', f['zone_enabled'] === true || f['zone_enabled'] === 1, `got ${f['zone_enabled']}`);
        }
    } catch (e) {
        test('Home/away flow', false, e.message);
    }

    // ╔══════════════════════════════════════════════════════╗
    // ║  6. Device Config Push                              ║
    // ╚══════════════════════════════════════════════════════╝
    section('6. Device Config Push (temperature_offset)');
    clearMessages();

    try {
        const result = await cmdApi('POST', `/api/devices/${DEVICE_ID}/config`, {
            changes: { '0x0140': 1.5, temperature_offset: 1.5 }
        });

        if (result.code === 404) {
            skip('Device config push', 'Test device not in DB devices table');
        } else {
            test('POST device config returns 200', result.code === 200, `Got ${result.code}`);

            const push = await waitForMessage(m => m.isRequest && m.uri.includes('config'), 3000);
            test('Device received config push', !!push);
            test('Config push path contains device ID or config', push.uri.includes('config'));

            if (push.decoded && push.decoded.ok) {
                const offset = push.decoded.fields['0x0140'] !== undefined ? push.decoded.fields['0x0140'] : push.decoded.fields['temperature_offset'];
                test('Config has temperature_offset field', offset !== undefined, 'field missing');
                if (offset !== undefined) {
                    // temperature_offset is scaled: value * 100 in TLV, so 1.5 → 150 raw, decoded back to 1.5
                    test('temperature_offset value ≈ 1.5', Math.abs(offset - 1.5) < 0.1, `got ${offset}`);
                }
            } else {
                skip('Config TLV decode', 'No decoded payload');
            }
        }
    } catch (e) {
        test('Device config push flow', false, e.message);
    }

    // ╔══════════════════════════════════════════════════════╗
    // ║  6. Zone Config Push                                ║
    // ╚══════════════════════════════════════════════════════╝
    section('7. Zone Config Push');
    clearMessages();

    try {
        const result = await cmdApi('POST', `/api/homes/${HOME_ID}/z/${ZONE_ID}/config`, {
            changes: { zone_fallback_setting_or_mode: 3 }
        });

        if (result.code === 404) {
            skip('Zone config push', 'No connected device for this home');
        } else {
            test('POST zone config returns 200', result.code === 200, `Got ${result.code}`);

            const push = await waitForMessage(m => m.isRequest && m.uri.includes(`z/${ZONE_ID}/config`), 3000);
            test('Device received zone config push', !!push);
            test('Push path matches zone config', push.uri.includes(`${ZONE_ID}/config`));

            if (push.decoded && push.decoded.ok) {
                test('Zone config has expected TLV fields', Object.keys(push.decoded.fields).length > 0);
            }
        }
    } catch (e) {
        test('Zone config push flow', false, e.message);
    }

    // ╔══════════════════════════════════════════════════════╗
    // ║  7. Device Lock Toggle                              ║
    // ╚══════════════════════════════════════════════════════╝
    section('8. Device Lock Toggle');
    clearMessages();

    try {
        // Enable lock
        const lockResult = await cmdApi('POST', `/api/devices/${DEVICE_ID}/lock`, { enabled: true });
        test('POST lock enable returns 200', lockResult.code === 200, `Got ${lockResult.code}`);

        const lockPush = await waitForMessage(m => m.isRequest && m.uri.includes('lock'), 3000);
        test('Device received lock push', !!lockPush);
        test('Lock push path contains lock', lockPush.uri.includes('lock'));

        if (lockPush.decoded && lockPush.decoded.ok) {
            const lockValue = lockPush.decoded.fields['child_lock'] ??
                lockPush.decoded.fields['0x0290'];
            test('Lock TLV field present', lockValue !== undefined, 'field missing');
            if (lockValue !== undefined) {
                test('Lock value = 1 (enabled)', lockValue === 1 || lockValue === true, `got ${lockValue}`);
            }
        }

        // Disable lock
        clearMessages();
        const unlockResult = await cmdApi('POST', `/api/devices/${DEVICE_ID}/lock`, { enabled: false });
        test('POST lock disable returns 200', unlockResult.code === 200, `Got ${unlockResult.code}`);

        const unlockPush = await waitForMessage(m => m.isRequest && m.uri.includes('lock'), 3000);
        if (unlockPush.decoded && unlockPush.decoded.ok) {
            const unlockValue = unlockPush.decoded.fields['child_lock'] ??
                unlockPush.decoded.fields['0x0290'];
            test('Unlock value = 0 (disabled)', unlockValue === 0 || unlockValue === false, `got ${unlockValue}`);
        }
    } catch (e) {
        test('Lock push flow', false, e.message);
    }

    // ╔══════════════════════════════════════════════════════╗
    // ║  8. Device Identify                                 ║
    // ╚══════════════════════════════════════════════════════╝
    section('9. Device Identify');
    clearMessages();

    try {
        const idResult = await cmdApi('POST', `/api/devices/${DEVICE_ID}/identify`, {});
        test('POST identify returns 200', idResult.code === 200, `Got ${idResult.code}`);

        const idPush = await waitForMessage(m => m.isRequest && m.uri.includes('identify'), 3000);
        test('Device received identify push', !!idPush);
        test('Identify push path = d/identify', idPush.uri === 'd/identify' || idPush.uri.includes('identify'));
    } catch (e) {
        test('Identify push flow', false, e.message);
    }

    // ╔══════════════════════════════════════════════════════╗
    // ║  9. Overlay Temperature Scaling Precision            ║
    // ╚══════════════════════════════════════════════════════╝
    section('10. Temperature Scaling Precision');
    clearMessages();

    try {
        // Set overlay with a fractional temperature to test scaling
        const result = await cmdApi('POST', `/api/homes/${HOME_ID}/z/${ZONE_ID}/overlay`, {
            setting: { power: 'ON', temperature: { celsius: 21.5 } },
            termination: { typeSkillBasedApp: 'MANUAL' }
        });
        test('POST overlay 21.5°C returns 200', result.code === 200, `Got ${result.code}`);

        const push = await waitForMessage(m => m.isRequest && m.uri.includes('z/'), 5000);
        test('Device received push', !!push);

        if (push.decoded && push.decoded.ok) {
            const item = push.decoded.items.find(i => i.name === 'overlay_target_temp');
            const temp = item ? item.value : push.decoded.fields['0x6280'];
            // Real Tado scales by 0.01: 21.5°C → 2150 in TLV, decoded back to 21.5
            test('Temperature precision: 21.5°C exact', temp !== undefined && Math.abs(temp - 21.5) < 0.01,
                `got ${temp}`);
        }

        // Cleanup: delete overlay
        await cmdApi('DELETE', `/api/homes/${HOME_ID}/z/${ZONE_ID}/overlay`);
        await sleep(300);
    } catch (e) {
        test('Temperature scaling flow', false, e.message);
    }

    // ╔══════════════════════════════════════════════════════╗
    // ║  11. Respect Default Overlay Setting                 ║
    // ╚══════════════════════════════════════════════════════╝
    section('11. Respect Default Overlay Setting');
    clearMessages();

    try {
        // 1. Set default overlay for the zone to NEXT_TIME_BLOCK
        const defaultRes = await restApi('PUT', `/api/v2/homes/${HOME_ID}/zones/${ZONE_ID}/defaultOverlay`, {
            terminationCondition: { type: 'NEXT_TIME_BLOCK' }
        });
        test('PUT defaultOverlay (NTB) returns 200', defaultRes.code === 200, `Got ${defaultRes.code}`);

        // 2. Set an overlay WITHOUT termination — should use the default (NTB)
        const overlayRes = await cmdApi('POST', `/api/homes/${HOME_ID}/z/${ZONE_ID}/overlay`, {
            setting: { power: 'ON', temperature: { celsius: 23.0 } }
            // No termination specified!
        });
        test('POST overlay (no termination) returns 200', overlayRes.code === 200, `Got ${overlayRes.code}`);

        // 3. Wait for push and verify it's mode 3 (NEXT_TIME_BLOCK)
        const push = await waitForMessage(m => m.isRequest && m.uri.includes('z/'), 5000);
        test('Device received push', !!push);

        if (push.decoded && push.decoded.ok) {
            const item = push.decoded.items.find(i => i.name === 'overlay_mode');
            const mode = item ? item.value : push.decoded.fields['0x6240'];
            test('Resolved default mode = 3 (NTB)', mode === 3, `got ${mode}`);
        }

        // 4. Reset default to MANUAL
        await restApi('PUT', `/api/v2/homes/${HOME_ID}/zones/${ZONE_ID}/defaultOverlay`, {
            terminationCondition: { type: 'MANUAL' }
        });

        // Cleanup: delete overlay
        await cmdApi('DELETE', `/api/homes/${HOME_ID}/z/${ZONE_ID}/overlay`);
        await sleep(300);
    } catch (e) {
        test('Default overlay test flow', false, e.message);
    }

    // ╔══════════════════════════════════════════════════════╗
    // ║  Summary                                            ║
    // ╚══════════════════════════════════════════════════════╝
    section('RESULTS');
    const total = passed + failed + skipped;
    console.log(`  Total: ${total} | Passed: ${passed} | Failed: ${failed} | Skipped: ${skipped}`);
    console.log(`  ${failed === 0 ? '✓ ALL TESTS PASSED (11 scenarios)' : '✗ SOME TESTS FAILED'}\n`);

    } catch (err) {
        console.error('FATAL E2E ERROR:', err.message);
        failed++;
    } finally {
        console.log('\nRestoring original database state...');
        try {
            const pool = db.getPool();
            if (originalPresence !== null) {
                await pool.execute('UPDATE homes SET presence = ?, presence_locked = ? WHERE id = ?', [originalPresence, originalPresenceLocked, HOME_ID]);
            }
            if (originalDeviceConfig !== null) {
                await pool.execute('UPDATE devices SET last_config_json = ?, child_lock_enabled = ? WHERE serial_no = ?', [originalDeviceConfig, originalChildLock, DEVICE_ID]);
            }
            if (originalZoneConfig !== null) {
                await pool.execute('UPDATE zones SET last_config_json = ?, default_overlay_type = ?, default_overlay_duration = ? WHERE id = ? AND home_id = ?', [originalZoneConfig, originalDefaultOverlayType, originalDefaultOverlayDuration, ZONE_ID, HOME_ID]);
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
