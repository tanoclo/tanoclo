/**
 * @file test/test_limits.test.js
 * @brief Vitest tests for hardware and room limits.
 */

'use strict';

require('./test_config');
const assert = require('assert');
const http = require('http');
const jwt = require('jsonwebtoken');
const config = require('../lib/config');
const db = require('../lib/db');
const dbHelper = require('./test_db_helper');
const { app, setupCommandRoutes } = require('../api/server');

function makeRequest(port, options, postData = null) {
    return new Promise((resolve, reject) => {
        const reqOpts = {
            hostname: '127.0.0.1',
            port: port,
            path: options.path,
            method: options.method || 'GET',
            headers: options.headers || {}
        };

        if (postData) {
            reqOpts.headers['Content-Type'] = reqOpts.headers['Content-Type'] || 'application/json';
            reqOpts.headers['Content-Length'] = Buffer.byteLength(postData);
        }

        const req = http.request(reqOpts, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let json = null;
                try {
                    if (data) json = JSON.parse(data);
                } catch (e) {}
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: json !== null ? json : data
                });
            });
        });

        req.on('error', reject);
        if (postData) {
            req.write(postData);
        }
        req.end();
    });
}

test('device and room limit rules', async () => {
    let server;
    const testHomeId = 999999;
    const testDeviceId = 'VA9999999999';

    try {
        const pool = db.getPool();
        await dbHelper.cleanupTestFixtures(pool, testHomeId, testDeviceId);

        const [homeRows] = await pool.execute('SELECT id FROM homes WHERE id != 999999 LIMIT 1');
        const sourceHomeId = homeRows.length > 0 ? homeRows[0].id : null;
        const [deviceRows] = await pool.execute('SELECT serial_no FROM devices LIMIT 1');
        const sourceDeviceId = deviceRows.length > 0 ? deviceRows[0].serial_no : null;

        await dbHelper.setupTestFixtures(pool, testDeviceId, testHomeId, 1, 'admin_limits', 'admin123_limits', sourceHomeId, sourceDeviceId);
        setupCommandRoutes(app);

        await new Promise((resolve) => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        const port = server.address().port;

        // Get token via OAuth endpoint
        const tokenRes = await makeRequest(port, {
            path: '/oauth/token',
            method: 'POST'
        }, JSON.stringify({
            grant_type: 'password',
            username: 'admin_limits',
            password: 'admin123_limits',
            client_id: 'tado-web-app'
        }));
        assert.strictEqual(tokenRes.statusCode, 200, `Failed to get token: ${JSON.stringify(tokenRes.body)}`);
        const token = tokenRes.body.access_token;

        const authHeaders = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        };

        // Clean up any leftover devices/zones for this synthetic home and enable config edit
        await pool.execute('UPDATE homes SET zone_config_readonly = 0, dev_bypass = 1 WHERE id = ?', [testHomeId]);
        await pool.execute('DELETE FROM devices WHERE home_id = ?', [testHomeId]);
        await pool.execute('DELETE FROM zones WHERE home_id = ?', [testHomeId]);
        await pool.execute('DELETE FROM heating_circuits WHERE home_id = ?', [testHomeId]);

        // 1. Create a base room
        const createRoomRes = await makeRequest(port, {
            path: `/api/v2/homes/${testHomeId}/zones`,
            method: 'POST',
            headers: authHeaders
        }, JSON.stringify({ name: 'Living Room', type: 'HEATING' }));
        assert.ok([200, 201].includes(createRoomRes.statusCode), `Failed creating base room: ${JSON.stringify(createRoomRes.body)}`);

        // Fetch created zone id
        const [zRows] = await pool.execute('SELECT id FROM zones WHERE home_id = ? AND type = "HEATING" LIMIT 1', [testHomeId]);
        const baseZoneId = zRows[0].id;

        // 2. Test Max 7 heating devices per room
        console.log('Testing max 7 heating devices per room...');
        for (let i = 1; i <= 7; i++) {
            const serial = `VA390000000${i}`;
            const addDevRes = await makeRequest(port, {
                path: `/api/v2/homes/${testHomeId}/devices`,
                method: 'POST',
                headers: authHeaders
            }, JSON.stringify({ serialNo: serial, deviceType: 'VA02', zoneId: baseZoneId }));
            assert.strictEqual(addDevRes.statusCode, 201, `Failed to add device ${i}: ${JSON.stringify(addDevRes.body)}`);
        }

        // 8th device in the same room should be rejected with 400 max_room_devices_reached
        const dev8Res = await makeRequest(port, {
            path: `/api/v2/homes/${testHomeId}/devices`,
            method: 'POST',
            headers: authHeaders
        }, JSON.stringify({ serialNo: 'VA3900000008', deviceType: 'VA02', zoneId: baseZoneId }));
        assert.strictEqual(dev8Res.statusCode, 400);
        assert.strictEqual(dev8Res.body.error, 'max_room_devices_reached');

        // Test assignDeviceToZone route rejection for 8th device
        // Add 8th device to a new zone first (which auto-creates Zone 2)
        const dev8NewZone = await makeRequest(port, {
            path: `/api/v2/homes/${testHomeId}/devices`,
            method: 'POST',
            headers: authHeaders
        }, JSON.stringify({ serialNo: 'VA3900000008', deviceType: 'VA02' }));
        assert.strictEqual(dev8NewZone.statusCode, 201);

        // Try moving dev8 to baseZoneId (which already has 7 devices)
        const moveRes = await makeRequest(port, {
            path: `/api/v2/homes/${testHomeId}/zones/${baseZoneId}/devices`,
            method: 'POST',
            headers: authHeaders
        }, JSON.stringify({ serialNo: 'VA3900000008' }));
        assert.strictEqual(moveRes.statusCode, 400);
        assert.strictEqual(moveRes.body.error, 'max_room_devices_reached');

        // 3. Test Max 25 heating devices per home
        console.log('Testing max 25 heating devices per home...');
        // Currently we have 8 heating devices. Add 17 more into new zones (total 25)
        for (let i = 9; i <= 25; i++) {
            const serial = `VA39000000${i < 10 ? '0' + i : i}`;
            const res = await makeRequest(port, {
                path: `/api/v2/homes/${testHomeId}/devices`,
                method: 'POST',
                headers: authHeaders
            }, JSON.stringify({ serialNo: serial, deviceType: 'VA02' }));
            assert.strictEqual(res.statusCode, 201, `Failed to add device ${i}: ${JSON.stringify(res.body)}`);
        }

        // 26th heating device should be rejected with 400 max_heating_devices_reached
        const dev26Res = await makeRequest(port, {
            path: `/api/v2/homes/${testHomeId}/devices`,
            method: 'POST',
            headers: authHeaders
        }, JSON.stringify({ serialNo: 'VA3900000026', deviceType: 'VA02' }));
        assert.strictEqual(dev26Res.statusCode, 400);
        assert.strictEqual(dev26Res.body.error, 'max_heating_devices_reached');

        // Non-heating device (e.g. IB01 Internet Bridge) should NOT be blocked by 25 heating device limit
        const bridgeRes = await makeRequest(port, {
            path: `/api/v2/homes/${testHomeId}/devices`,
            method: 'POST',
            headers: authHeaders
        }, JSON.stringify({ serialNo: 'IB3900000099', deviceType: 'IB01' }));
        assert.strictEqual(bridgeRes.statusCode, 201);

        // 4. Test Max 25 heating rooms per home
        console.log('Testing max 25 heating rooms per home...');
        // Check current heating zone count
        const [currZones] = await pool.execute('SELECT COUNT(*) as c FROM zones WHERE home_id = ? AND type = "HEATING"', [testHomeId]);
        const currentHeatingRooms = currZones[0].c;

        // Add remaining rooms until we reach 25
        for (let i = currentHeatingRooms + 1; i <= 25; i++) {
            const res = await makeRequest(port, {
                path: `/api/v2/homes/${testHomeId}/zones`,
                method: 'POST',
                headers: authHeaders
            }, JSON.stringify({ name: `Room ${i}`, type: 'HEATING' }));
            assert.ok([200, 201].includes(res.statusCode), `Failed to create room ${i}: ${JSON.stringify(res.body)}`);
        }

        // 26th heating room should be rejected with 400 max_heating_rooms_reached
        const room26Res = await makeRequest(port, {
            path: `/api/v2/homes/${testHomeId}/zones`,
            method: 'POST',
            headers: authHeaders
        }, JSON.stringify({ name: 'Room 26', type: 'HEATING' }));
        assert.strictEqual(room26Res.statusCode, 400);
        assert.strictEqual(room26Res.body.error, 'max_heating_rooms_reached');

        // HOT_WATER zone should still be allowed
        const dhwRes = await makeRequest(port, {
            path: `/api/v2/homes/${testHomeId}/zones`,
            method: 'POST',
            headers: authHeaders
        }, JSON.stringify({ name: 'Hot Water', type: 'HOT_WATER' }));
        assert.ok([200, 201].includes(dhwRes.statusCode));

        // 5. Test Max 10 rooms communicating with Zone Controller
        console.log('Testing max 10 rooms communicating with Zone Controller...');
        // Reset all heating zones heating_circuit to null first
        await pool.execute('UPDATE zones SET heating_circuit = NULL WHERE home_id = ?', [testHomeId]);

        const [allHeatingZones] = await pool.execute('SELECT id FROM zones WHERE home_id = ? AND type = "HEATING" ORDER BY id ASC', [testHomeId]);

        // Assign heating circuit 1 to 10 zones
        for (let i = 0; i < 10; i++) {
            const zid = allHeatingZones[i].id;
            const res = await makeRequest(port, {
                path: `/api/v2/homes/${testHomeId}/zones/${zid}/control/heatingCircuit`,
                method: 'PUT',
                headers: authHeaders
            }, JSON.stringify({ circuitNumber: 1 }));
            assert.ok([200, 303].includes(res.statusCode), `Failed to assign circuit to zone ${zid}`);
        }

        // 11th room assignment should be rejected with 400 max_zone_controller_rooms_reached
        const z11Id = allHeatingZones[10].id;
        const z11Res = await makeRequest(port, {
            path: `/api/v2/homes/${testHomeId}/zones/${z11Id}/control/heatingCircuit`,
            method: 'PUT',
            headers: authHeaders
        }, JSON.stringify({ circuitNumber: 1 }));
        assert.strictEqual(z11Res.statusCode, 400);
        assert.strictEqual(z11Res.body.error, 'max_zone_controller_rooms_reached');

        console.log('ALL LIMIT TESTS PASSED!');
    } finally {
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
        const pool = db.getPool();
        await dbHelper.cleanupTestFixtures(pool, testHomeId, testDeviceId);
    }
});
