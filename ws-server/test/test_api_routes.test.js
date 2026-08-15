/**
 * @file test/test_api_routes.test.js
 * @brief Vitest testing suite validating server modules.
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

// Helper to make HTTP requests


test('legacy test suite runs successfully', async () => {
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
  
  async function runTests() {
      console.log('═══ Running API Routes Test Suite ═══\n');
  
      const pool = db.getPool();
  
      // Backup settings
      const keysToBackup = ['cleanup_device_measurements_days', 'cleanup_zone_measurements_days', 'cleanup_home_weather_days', 'log_level'];
      const originalSettings = {};
      for (const key of keysToBackup) {
          const [rows] = await pool.execute('SELECT `value` FROM server_settings WHERE `key` = ?', [key]);
          originalSettings[key] = rows.length > 0 ? rows[0].value : null;
      }
  
      const testHomeId = 999999;
      const testDeviceId = 'IB0000000001';
      let server;
      let passed = 0;
      let failed = 0;
  
      try {
          // Reset server settings table to default values before test suite runs
          await pool.execute("UPDATE server_settings SET value = '30' WHERE `key` = 'cleanup_device_measurements_days'");
          await pool.execute("UPDATE server_settings SET value = '390' WHERE `key` = 'cleanup_zone_measurements_days'");
          await pool.execute("UPDATE server_settings SET value = '390' WHERE `key` = 'cleanup_home_weather_days'");
  
          // 1. Query dynamic template source home/device to guarantee schema compatibility
          const [homeRows] = await pool.execute('SELECT id FROM homes LIMIT 1');
          const sourceHomeId = homeRows.length > 0 ? homeRows[0].id : null;
  
          const [deviceRows] = await pool.execute('SELECT serial_no FROM devices LIMIT 1');
          const sourceDeviceId = deviceRows.length > 0 ? deviceRows[0].serial_no : null;
  
          console.log(`[test-api] Selected source home template: ${sourceHomeId}, device template: ${sourceDeviceId}`);
  
          const testZoneId = 1;
          const testUser = 'admin_test_api';
          const testPass = 'admin123_test_api';
  
          await dbHelper.setupTestFixtures(pool, testDeviceId, testHomeId, testZoneId, testUser, testPass, sourceHomeId, sourceDeviceId);
  
          // 2. Initialize Command Routes with dummy client/socket parameters
          const mockClientsMap = new Map();
          setupCommandRoutes({
              clients: mockClientsMap,
              sendToDevice: async () => {},
              broadcastTime: () => {},
              log: () => {},
              messageCache: { getCache: async () => ({}) }
          });
  
          // 3. Spin up Express server on a random port
          server = http.createServer(app);
          const port = await new Promise((resolve) => {
              server.listen(0, '127.0.0.1', () => {
                  resolve(server.address().port);
              });
          });
          console.log(`Express test server listening on 127.0.0.1:${port}`);
  
          let accessToken = null;
  
          async function test(name, fn) {
              try {
                  await fn();
                  passed++;
                  console.log(`  ✓ ${name}`);
              } catch (e) {
                  failed++;
                  console.error(`  ✗ ${name} — FAILED:`, e.stack || e.message);
              }
          }
  
      // --- OAuth Token Endpoint ---
      await test('POST /oauth/token (Password Grant)', async () => {
          const payload = JSON.stringify({
              grant_type: 'password',
              username: testUser,
              password: testPass,
              client_id: 'tado-web-app'
          });
  
          const res = await makeRequest(port, {
              path: '/oauth/token',
              method: 'POST'
          }, payload);
  
          assert.strictEqual(res.statusCode, 200);
          assert.ok(res.body.access_token, 'Response missing access_token');
          assert.ok(res.body.refresh_token, 'Response missing refresh_token');
          accessToken = res.body.access_token;
      });
  
      // --- Home Details Endpoint ---
      await test('GET /api/v2/homes/999999', async () => {
          assert.ok(accessToken, 'Access token is required');
          const res = await makeRequest(port, {
              path: `/api/v2/homes/${testHomeId}`,
              method: 'GET',
              headers: {
                  'Authorization': `Bearer ${accessToken}`
              }
          });
  
          assert.strictEqual(res.statusCode, 200);
          assert.strictEqual(res.body.id, testHomeId);
      });
  
      // --- Presence Lock Endpoint ---
      await test('PUT /api/v2/homes/999999/presenceLock', async () => {
          assert.ok(accessToken, 'Access token is required');
          const payload = JSON.stringify({ homePresence: 'AWAY' });
  
          const res = await makeRequest(port, {
              path: `/api/v2/homes/${testHomeId}/presenceLock`,
              method: 'PUT',
              headers: {
                  'Authorization': `Bearer ${accessToken}`
              }
          }, payload);
  
          assert.strictEqual(res.statusCode, 200);
          assert.strictEqual(res.body.presenceLocked, true);
          assert.strictEqual(res.body.presence, 'AWAY');
  
          // Reset presence lock to HOME using DELETE
          const delRes = await makeRequest(port, {
              path: `/api/v2/homes/${testHomeId}/presenceLock`,
              method: 'DELETE',
              headers: {
                  'Authorization': `Bearer ${accessToken}`
              }
          });
          assert.strictEqual(delRes.statusCode, 204);
      });
  
      // --- Zones Endpoint ---
      await test('GET /api/v2/homes/999999/zones', async () => {
          assert.ok(accessToken, 'Access token is required');
          const res = await makeRequest(port, {
              path: `/api/v2/homes/${testHomeId}/zones`,
              method: 'GET',
              headers: {
                  'Authorization': `Bearer ${accessToken}`
              }
          });
  
          assert.strictEqual(res.statusCode, 200);
          assert.ok(Array.isArray(res.body), 'Response must be an array of zones');
          assert.strictEqual(res.body.length, 1);
          assert.strictEqual(res.body[0].id, testZoneId);
      });
  
      // --- Zone State Endpoint ---
      await test('GET /api/v2/homes/999999/zones/1/state', async () => {
          assert.ok(accessToken, 'Access token is required');
          const res = await makeRequest(port, {
              path: `/api/v2/homes/${testHomeId}/zones/${testZoneId}/state`,
              method: 'GET',
              headers: {
                  'Authorization': `Bearer ${accessToken}`
              }
          });
  
          assert.strictEqual(res.statusCode, 200);
          assert.ok(res.body.setting, 'Response must have setting field');
      });
  
      // --- GET Default Overlay Endpoint ---
      await test('GET /api/v2/homes/999999/zones/1/defaultOverlay', async () => {
          assert.ok(accessToken, 'Access token is required');
          const res = await makeRequest(port, {
              path: `/api/v2/homes/${testHomeId}/zones/${testZoneId}/defaultOverlay`,
              method: 'GET',
              headers: {
                  'Authorization': `Bearer ${accessToken}`
              }
          });
  
          assert.strictEqual(res.statusCode, 200);
          assert.ok(res.body.terminationCondition, 'Response must have terminationCondition');
      });
  
      // --- PUT Default Overlay Endpoint ---
      await test('PUT /api/v2/homes/999999/zones/1/defaultOverlay', async () => {
          assert.ok(accessToken, 'Access token is required');
          const payload = JSON.stringify({
              terminationCondition: {
                  type: 'TIMER',
                  durationInSeconds: 7200
              }
          });
  
          const res = await makeRequest(port, {
              path: `/api/v2/homes/${testHomeId}/zones/${testZoneId}/defaultOverlay`,
              method: 'PUT',
              headers: {
                  'Authorization': `Bearer ${accessToken}`
              }
          }, payload);
  
          assert.strictEqual(res.statusCode, 200);
          assert.strictEqual(res.body.terminationCondition.type, 'TIMER');
          assert.strictEqual(res.body.terminationCondition.durationInSeconds, 7200);
      });
  
      // --- Devices Endpoint ---
      await test('GET /api/v2/homes/999999/devices', async () => {
          assert.ok(accessToken, 'Access token is required');
          const res = await makeRequest(port, {
              path: `/api/v2/homes/${testHomeId}/devices`,
              method: 'GET',
              headers: {
                  'Authorization': `Bearer ${accessToken}`
              }
          });
  
          assert.strictEqual(res.statusCode, 200);
          assert.ok(Array.isArray(res.body), 'Response must be an array of devices');
          assert.strictEqual(res.body.length, 1);
          assert.strictEqual(res.body[0].serialNo, testDeviceId);
      });
  
      // --- Users Endpoint ---
      await test('GET /api/v2/homes/999999/users', async () => {
          assert.ok(accessToken, 'Access token is required');
          const res = await makeRequest(port, {
              path: `/api/v2/homes/${testHomeId}/users`,
              method: 'GET',
              headers: {
                  'Authorization': `Bearer ${accessToken}`
              }
          });
  
          assert.strictEqual(res.statusCode, 200);
          assert.ok(Array.isArray(res.body), 'Response must be an array of users');
          const found = res.body.find(u => u.username === testUser);
          assert.ok(found, 'Test user must be found in the users list');
      });
  
      // --- Server Settings Endpoint (Setup API) ---
      await test('GET /setup/settings (Setup API)', async () => {
          const setupToken = jwt.sign({ username: 'admin' }, config.jwtSecret, { expiresIn: '1h' });
          const res = await makeRequest(port, {
              path: '/setup/settings',
              method: 'GET',
              headers: {
                  'Cookie': `setup_token=${setupToken}`,
                  'Accept': 'application/json'
              }
          });
  
          assert.strictEqual(res.statusCode, 200);
          assert.ok(res.body.log_level);
          assert.strictEqual(res.body.cleanup_device_measurements_days, 30);
          assert.strictEqual(res.body.cleanup_zone_measurements_days, 390);
          assert.strictEqual(res.body.cleanup_home_weather_days, 390);
      });
  
      await test('POST /setup/settings (Setup API)', async () => {
          const setupToken = jwt.sign({ username: 'admin' }, config.jwtSecret, { expiresIn: '1h' });
          const postData = JSON.stringify({
              log_level: 'info',
              cleanup_device_measurements_days: 15,
              cleanup_zone_measurements_days: 180,
              cleanup_home_weather_days: 200
          });
          const res = await makeRequest(port, {
              path: '/setup/settings',
              method: 'POST',
              headers: {
                  'Cookie': `setup_token=${setupToken}`,
                  'Accept': 'application/json'
              }
          }, postData);
  
          assert.strictEqual(res.statusCode, 200);
          assert.strictEqual(res.body.success, true);
  
          // Verify config is updated
          assert.strictEqual(config.logLevel, 'info');
          assert.strictEqual(config.cleanupDeviceMeasurementsDays, 15);
          assert.strictEqual(config.cleanupZoneMeasurementsDays, 180);
          assert.strictEqual(config.cleanupHomeWeatherDays, 200);
      });
  
      console.log(`\n═══ API Routes Tests Completed: Passed ${passed}/${passed + failed} ═══`);
      } finally {
          // Restore original settings
          console.log('[test-api] Restoring original server settings...');
          for (const [key, val] of Object.entries(originalSettings)) {
              try {
                  if (val === null) {
                      await pool.execute('DELETE FROM server_settings WHERE `key` = ?', [key]);
                  } else {
                      await pool.execute(
                          'INSERT INTO server_settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
                          [key, val, val]
                      );
                  }
              } catch (restoreErr) {
                  console.error(`[test-api] Failed to restore setting ${key}:`, restoreErr.message);
              }
          }
  
          // Clean up fixtures and connections
          try {
              await dbHelper.cleanupTestFixtures(pool, testHomeId, testDeviceId);
          } catch (cleanupErr) {
              console.error('[test-api] Failed to clean up test fixtures:', cleanupErr.message);
          }
          
          if (server) {
              await new Promise(resolve => server.close(resolve));
          }
          await db.close();
      }
  
      if (failed > 0) throw new Error('Some tests failed');
  }
  
  runTests().catch(err => {
      console.error('Fatal API test error:', err);
      throw new Error('Test failed');
  });
  
});