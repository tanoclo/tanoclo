/**
 * @file test/test_allow_commands_in_proxy.test.js
 * @brief Vitest testing suite validating server modules.
 */

'use strict';
require('./test_config');


const db = require('../lib/db');
const coap = require('../lib/coap');
const wsBridge = require('../lib/ws-bridge');
const tlv = require('../lib/tlv');
const config = require('../lib/config');

// Mocks to mirror server.js scope


test('legacy test suite runs successfully', async () => {
  const clients = new Map();
  const proxyConnections = new Set();
  const messageCache = {
      cacheMessage: () => { }
  };
  const logLogs = [];
  const log = (level, msg) => {
      logLogs.push({ level, msg });
      console.log(`[log][${level}] ${msg}`);
  };
  
  // The sendToDevice logic from server.js
  function sendToDevice(deviceId, wsMessage) {
      if (db.isOffline()) return;
  
      const clientInfo = clients.get(deviceId);
      if (!clientInfo || !clientInfo.ws) {
          throw new Error(`Device ${deviceId} not connected`);
      }
  
      // Cache recreated downlink messages even when proxied
      messageCache.cacheMessage(deviceId, wsMessage, 'recreated');
  
      if (proxyConnections.has(clientInfo.ws)) {
          db.getHome(clientInfo.homeId).then(async (home) => {
              const allowInProxy = home && home.allow_commands_in_proxy === 1;
              if (!allowInProxy) {
                  log('debug', `Skipping sendToDevice(${deviceId}) because connection is proxied. Commands should go to real API.`);
                  return;
              }
  
              // Connection is proxied but allow_commands_in_proxy is enabled.
              // Check if this is a config message.
              let isConfig = false;
              try {
                  const frame = wsBridge.parse(Buffer.from(wsMessage));
                  if (frame.ok) {
                      const coapMsg = coap.parse(frame.coapBytes);
                      if (coapMsg.ok) {
                          const uriPathStr = coap.uriPath(coapMsg);
                          if (uriPathStr && (
                              uriPathStr.includes('config') ||
                              uriPathStr === 'd/config' ||
                              uriPathStr.endsWith('/config')
                          )) {
                              isConfig = true;
                          }
                      }
                  }
              } catch (err) {
                  log('error', `Failed to parse CoAP message in sendToDevice check: ${err.message}`);
              }
  
              if (isConfig && config.zoneConfigReadonly) {
                  log('debug', `Blocking config write to device ${deviceId} in proxy mode because config is read-only.`);
                  return;
              }
  
              // Not blocked, send command
              log('debug', `Allowing command in proxy mode to ${deviceId} (isConfig=${isConfig})`);
              try {
                  if (!clientInfo.ws.isClosed) {
                      clientInfo.ws.send(wsMessage, true);
                  } else {
                      log('debug', `sendToDevice(${deviceId}) skipped: socket is closed`);
                  }
              } catch (err) {
                  log('error', `sendToDevice(${deviceId}) failed in proxy bypass: ${err.message}`);
              }
          }).catch(err => {
              log('error', `Error checking allow_commands_in_proxy for home ${clientInfo.homeId}: ${err.message}`);
          });
          return;
      }
      try {
          if (!clientInfo.ws.isClosed) {
              clientInfo.ws.send(wsMessage, true);
          } else {
              log('debug', `sendToDevice(${deviceId}) skipped: socket is closed`);
          }
      } catch (err) {
          log('error', `sendToDevice(${deviceId}) failed: ${err.message}`);
      }
  }
  
  async function runTests() {
      const pool = db.getPool();
      const testHomeId = 999999;
      const testDeviceSerial = 'IB1234567890';
  
      console.log('--- Testing Allow Commands in Proxy Mode ---');
  
          let testFailed = false;
          try {
              // Ensure mock home exists
              await pool.execute(`
                  INSERT IGNORE INTO homes (
                      id, name, temperature_unit, installation_completed,
                      simple_smart_schedule_enabled, away_radius_in_meters,
                      installation_method, incident_detection_enabled,
                      latitude, longitude, presence, presence_locked,
                      address_line1, address_line2, address_zip_code, address_city, address_state, address_country,
                      contact_name, contact_email, contact_phone,
                      email_low_battery_reminder, allow_commands_in_proxy
                  ) VALUES (
                      ?, 'Test Home', 'CELSIUS', 1, 0, 1000,
                      'SELF', 0, 50.0, 4.0, 'HOME', 0,
                      'Line 1', 'Line 2', '12345', 'City', 'State', 'Country',
                      'Name', 'email@test.com', '12345678',
                      1, 0
                  )
              `, [testHomeId]);
  
              // 1. Initialize TLV labels
              const [rows] = await pool.execute('SELECT hex_id, name, type, unit, scale FROM tlv_labels');
              const labels = {};
              for (const row of rows) {
                  labels[row.hex_id] = { name: row.name, type: row.type, unit: row.unit, scale: row.scale };
              }
              tlv.init(labels);
  
              // 2. Setup mock client connection
              let mockSent = false;
              let mockSentMsg = null;
              const mockWs = {
                  isClosed: false,
                  send: (msg) => {
                      mockSent = true;
                      mockSentMsg = msg;
                  }
              };
  
              clients.set(testDeviceSerial, {
                  ws: mockWs,
                  homeId: testHomeId
              });
  
              // 3. Enable proxy mode for the socket
              proxyConnections.add(mockWs);
  
              // Create mock CoAP messages
              const overlayPayload = tlv.encode([
                  { fid: 0x6240, value: tlv.encodeValue(2, 'u8') } // Overlay manual HEATING
              ]);
              const overlayWsMessage = wsBridge.build({
                  direction: 'server_to_client',
                  ipv6: '::1',
                  coapBytes: coap.buildRequest({
                      code: coap.CODE_PUT,
                      path: 'z/s',
                      token: Buffer.alloc(2),
                      mid: 100,
                      type: coap.TYPE_CON,
                      payload: overlayPayload
                  })
              });
  
              const configWsMessage = wsBridge.build({
                  direction: 'server_to_client',
                  ipv6: '::1',
                  coapBytes: coap.buildRequest({
                      code: coap.CODE_PUT,
                      path: 'd/config',
                      token: Buffer.alloc(2),
                      mid: 101,
                      type: coap.TYPE_CON,
                      payload: Buffer.alloc(4)
                  })
              });
  
              // --- TEST CASE 1: allow_commands_in_proxy is disabled (default) ---
              console.log('\nCase 1: allow_commands_in_proxy is disabled');
              await pool.execute('UPDATE homes SET allow_commands_in_proxy = 0 WHERE id = ?', [testHomeId]);
  
              mockSent = false;
              sendToDevice(testDeviceSerial, overlayWsMessage);
  
              // Wait briefly for async DB check to finish
              await new Promise(r => setTimeout(r, 200));
              if (mockSent) {
                  throw new Error('FAIL: Command was sent to device when allow_commands_in_proxy is disabled!');
              }
              console.log('SUCCESS: Command was correctly blocked.');
  
              // --- TEST CASE 2: allow_commands_in_proxy is enabled, sending non-config (overlay) ---
              console.log('\nCase 2: allow_commands_in_proxy is enabled, sending non-config (overlay)');
              await pool.execute('UPDATE homes SET allow_commands_in_proxy = 1 WHERE id = ?', [testHomeId]);
  
              mockSent = false;
              sendToDevice(testDeviceSerial, overlayWsMessage);
  
              await new Promise(r => setTimeout(r, 200));
              if (!mockSent) {
                  throw new Error('FAIL: Overlay command was blocked even though allow_commands_in_proxy is enabled!');
              }
              console.log('SUCCESS: Overlay command was allowed.');
  
              // --- TEST CASE 3: allow_commands_in_proxy is enabled, sending config with read-only config enabled ---
              console.log('\nCase 3: allow_commands_in_proxy is enabled, sending config with read-only config enabled');
              config.zoneConfigReadonly = true; // Ensure read-only config is enabled
  
              mockSent = false;
              sendToDevice(testDeviceSerial, configWsMessage);
  
              await new Promise(r => setTimeout(r, 200));
              if (mockSent) {
                  throw new Error('FAIL: Config command was allowed in proxy mode when config is read-only!');
              }
              console.log('SUCCESS: Config command was blocked while config is read-only.');
  
              // --- TEST CASE 4: allow_commands_in_proxy is enabled, sending config with read-only config disabled ---
              console.log('\nCase 4: allow_commands_in_proxy is enabled, sending config with read-only config disabled');
              config.zoneConfigReadonly = false;
  
              mockSent = false;
              sendToDevice(testDeviceSerial, configWsMessage);
  
              await new Promise(r => setTimeout(r, 200));
              if (!mockSent) {
                  throw new Error('FAIL: Config command was blocked even though read-only config is false!');
              }
              console.log('SUCCESS: Config command was allowed when read-only config is disabled.');
  
              console.log('\nAll Allow Commands in Proxy Tests Passed!');
          } catch (err) {
              console.error('FAIL: Test Error:', err);
              testFailed = true;
          } finally {
              try {
                  await pool.execute('DELETE FROM homes WHERE id = ?', [testHomeId]);
                  console.log('Cleanup: deleted mock home from DB.');
              } catch (cleanupErr) {
                  console.error('Cleanup failed:', cleanupErr.message);
              }
              try {
                  await db.close();
              } catch (dbErr) {
                  console.error('Failed to close DB:', dbErr.message);
              }
              if (testFailed) throw new Error('Some tests failed');
          }
  }
  
  await runTests();
  
});