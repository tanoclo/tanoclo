/**
 * @file test/test_overlay_persistence.test.js
 * @brief Vitest testing suite validating server modules.
 */

'use strict';
require('./test_config');

const path = require('path');
const dbHelper = require('./test_db_helper');

test('legacy test suite runs successfully', async () => {
  const db = require('../lib/db');
  const commandApi = require('../lib/command-api');
  const { app, setupCommandRoutes } = require('../api/server');
  const http = require('http');
  
  // Helper to make local http requests
  function makeRequest(method, port, path, body = null, token = null) {
      return new Promise((resolve, reject) => {
          const postData = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
          const options = {
              hostname: '127.0.0.1',
              port,
              path,
              method,
              headers: {
                  'Accept': 'application/json',
                  'Connection': 'close'
              }
          };
          if (token) {
              options.headers['Authorization'] = `Bearer ${token}`;
          }
          if (postData) {
              options.headers['Content-Type'] = 'application/json';
              options.headers['Content-Length'] = Buffer.byteLength(postData);
          }
  
          const req = http.request(options, (res) => {
              let data = '';
              res.on('data', chunk => data += chunk);
              res.on('end', () => {
                  try {
                      resolve({ statusCode: res.statusCode, body: data ? JSON.parse(data) : null });
                  } catch (e) {
                      resolve({ statusCode: res.statusCode, body: data });
                  }
              });
          });
  
          req.on('error', reject);
          if (postData) req.write(postData);
          req.end();
      });
  }
  
  async function testOverlayPersistence() {
      const pool = db.getPool();
      const testHomeId = 999999;
      const testZoneId = 2;
      const testUser = 'admin_test_api';
      const testPass = 'admin123_test_api';
      const testDeviceId = 'IB0000000001';
  
      console.log('--- Testing Overlay Persistence ---');
  
      try {
          // Seeding DB fixtures
          const [homeRows] = await pool.execute('SELECT id FROM homes LIMIT 1');
          const sourceHomeId = homeRows.length > 0 ? homeRows[0].id : null;
          const [deviceRows] = await pool.execute('SELECT serial_no FROM devices LIMIT 1');
          const sourceDeviceId = deviceRows.length > 0 ? deviceRows[0].serial_no : null;
          
          await dbHelper.setupTestFixtures(pool, testDeviceId, testHomeId, testZoneId, testUser, testPass, sourceHomeId, sourceDeviceId);
  
          // 1. Clear any existing overlays for test zone
           console.log('1. Clearing existing overlays for test zone...');
          await pool.execute('DELETE FROM zone_overlays WHERE zone_id = ?', [testZoneId]);
  
          // 2. Direct DB overlay update
          console.log('2. Testing updateZoneOverlay directly...');
          await db.updateZoneOverlay(testHomeId, testZoneId, 
              { type: 'HEATING', power: 'ON', temperature: { celsius: 23.5 } },
              { type: 'MANUAL' }
          );
          
          let [rows] = await pool.execute('SELECT * FROM zone_overlays WHERE zone_id = ?', [testZoneId]);
          if (rows.length === 0) {
              throw new Error('FAIL: Overlay not found in database after updateZoneOverlay call');
          }
          console.log('SUCCESS: Overlay persisted to DB via updateZoneOverlay!');
          console.log('Row in DB:', rows[0]);
  
          // 3. Direct DB overlay delete
          console.log('3. Testing deleteZoneOverlay directly...');
          await db.deleteZoneOverlay(testHomeId, testZoneId);
          [rows] = await pool.execute('SELECT * FROM zone_overlays WHERE zone_id = ?', [testZoneId]);
          if (rows.length > 0) {
              throw new Error('FAIL: Overlay still exists in database after deleteZoneOverlay call');
          }
          console.log('SUCCESS: Overlay removed from DB via deleteZoneOverlay!');
  
          // Setup Command Routes in Express
          setupCommandRoutes({
              clients: new Map(),
              sendToDevice: async () => {},
              broadcastTime: () => {},
              log: () => {},
              messageCache: {}
          });
  
          // 4. Run server on random port to test HTTP request fall-through
          console.log('4. Spinning up Express server on random port...');
          const server = http.createServer(app);
          
          await new Promise((resolve) => {
              server.listen(0, '127.0.0.1', resolve);
          });
          const port = server.address().port;
          console.log(`Express server listening on 127.0.0.1:${port}`);
  
          try {
              // Get access token first via Password Grant (public OAuth token endpoint)
              const tokenPayload = {
                  grant_type: 'password',
                  username: testUser,
                  password: testPass,
                  client_id: 'tado-web-app'
              };
              const tokenRes = await makeRequest('POST', port, '/oauth/token', tokenPayload);
              if (tokenRes.statusCode !== 200 || !tokenRes.body?.access_token) {
                  throw new Error(`Failed to get access token: ${tokenRes.statusCode} - ${JSON.stringify(tokenRes.body)}`);
              }
              const accessToken = tokenRes.body.access_token;
  
              console.log('5. Testing PUT /api/v2/homes/:homeId/zones/:zoneId/overlay (must fall through to zones.js)...');
              const putRes = await makeRequest('PUT', port, `/api/v2/homes/${testHomeId}/zones/${testZoneId}/overlay`, {
                  setting: { type: 'HEATING', power: 'ON', temperature: { celsius: 22.0 } },
                  termination: { type: 'MANUAL' }
              }, accessToken);
  
              console.log('PUT Status:', putRes.statusCode);
              console.log('PUT Response:', putRes.body);
  
              if (putRes.statusCode !== 200) {
                  throw new Error(`FAIL: PUT returned status ${putRes.statusCode}`);
              }
  
              // Verify written in DB
              [rows] = await pool.execute('SELECT * FROM zone_overlays WHERE zone_id = ?', [testZoneId]);
              if (rows.length === 0) {
                  throw new Error('FAIL: Overlay not written to database after PUT request');
              }
              console.log('SUCCESS: PUT overlay request successfully fell through to zones.js and persisted to DB!');
              console.log('Persisted Row:', rows[0]);
  
              console.log('6. Testing DELETE /api/v2/homes/:homeId/zones/:zoneId/overlay (must fall through to zones.js)...');
              const delRes = await makeRequest('DELETE', port, `/api/v2/homes/${testHomeId}/zones/${testZoneId}/overlay`, null, accessToken);
              console.log('DELETE Status:', delRes.statusCode);
  
              if (delRes.statusCode !== 204) {
                  throw new Error(`FAIL: DELETE returned status ${delRes.statusCode}`);
              }
  
              // Verify deleted in DB
              [rows] = await pool.execute('SELECT * FROM zone_overlays WHERE zone_id = ?', [testZoneId]);
              if (rows.length > 0) {
                  throw new Error('FAIL: Overlay still in database after DELETE request');
              }
              console.log('SUCCESS: DELETE overlay request successfully fell through to zones.js and deleted from the DB!');
  
          } finally {
              server.close();
          }
  
          console.log('\nAll Overlay Persistence Tests Passed!');
      } catch (err) {
          console.error('FAIL: Test Error:', err);
          throw err;
      } finally {
          try {
              await pool.execute('DELETE FROM zone_overlays WHERE zone_id = ?', [testZoneId]);
              console.log('Cleanup: deleted mock zone overlays from DB.');
          } catch (cleanupErr) {
              console.error('Cleanup failed:', cleanupErr.message);
          }
          try {
              await dbHelper.cleanupTestFixtures(pool, testHomeId, testDeviceId);
          } catch (cleanupErr) {
              console.error('Cleanup fixtures failed:', cleanupErr.message);
          }
          try {
              if (!process.env.VITEST) await db.getPool().end();
              console.log('DB Pool closed.');
          } catch (dbErr) {
              console.error('Failed to close DB pool:', dbErr.message);
          }
      }
  }
  
  await testOverlayPersistence();
  
});