/**
 * @file test/test_command_api.test.js
 * @brief Vitest testing suite validating server modules.
 */

'use strict';

require('./test_config');
const assert = require('assert');
const crypto = require('crypto');
const db = require('../lib/db');
const coap = require('../lib/coap');
const tlv = require('../lib/tlv');
const wsBridge = require('../lib/ws-bridge');
const commandApi = require('../lib/command-api');



test('legacy test suite runs successfully', async () => {
  async function runTests() {
      console.log('═══ Running command-api.js Test Suite ═══\n');
  
      // 1. Initialize TLV labels from DB first so tlv.decode works
      const pool = db.getPool();
      const [labelRows] = await pool.execute('SELECT hex_id, name, type, unit, scale FROM tlv_labels');
      const labels = {};
      for (const row of labelRows) {
          labels[row.hex_id] = { name: row.name, type: row.type, unit: row.unit, scale: row.scale };
      }
      tlv.init(labels);
      console.log(`Initialized ${labelRows.length} TLV labels.`);
  
      let passed = 0;
      let failed = 0;
  
      async function test(name, fn) {
          try {
              await fn();
              passed++;
              console.log(`  ✓ ${name}`);
          } catch (e) {
              failed++;
              console.error(`  ✗ ${name} — FAILED:`, e.stack || e.message);
          } finally {
              commandApi.clearPendingRetries();
          }
      }
  
      // ══════════════════════════════════════════════════════════════════════════
      // Unit Tests: LEB128 Encoding / Decoding
      // ══════════════════════════════════════════════════════════════════════════
      console.log('\n--- 1. LEB128 Utilities ---');
  
      await test('encodeLEB128: single byte values', () => {
          const b1 = commandApi.encodeLEB128(0);
          assert.deepStrictEqual(b1, Buffer.from([0x00]));
  
          const b2 = commandApi.encodeLEB128(127);
          assert.deepStrictEqual(b2, Buffer.from([0x7f]));
      });
  
      await test('encodeLEB128: multi-byte values', () => {
          const b1 = commandApi.encodeLEB128(128);
          assert.deepStrictEqual(b1, Buffer.from([0x80, 0x01]));
  
          const b2 = commandApi.encodeLEB128(300); // 300 = 0x12C -> 0xAC 0x02
          assert.deepStrictEqual(b2, Buffer.from([0xac, 0x02]));
      });
  
      await test('decodeLEB128: round-trip', () => {
          const b1 = commandApi.encodeLEB128(16384);
          const { value, bytesRead } = commandApi.decodeLEB128(b1, 0);
          assert.strictEqual(value, 16384);
          assert.strictEqual(bytesRead, b1.length);
      });
  
      // ══════════════════════════════════════════════════════════════════════════
      // Unit Tests: Schedule Mapping Helpers
      // ══════════════════════════════════════════════════════════════════════════
      console.log('\n--- 2. Schedule Formatting Utilities ---');
  
      await test('buildDayScheduleBlob: transition sequences', () => {
          const transitions = [
              { timeSeconds: 0, tempTenths: 200 },
              { timeSeconds: 21600, tempTenths: 180 }
          ];
          const blob = commandApi.buildDayScheduleBlob(transitions);
          // Format: [count=2] [time0=0] [temp0=200] [time1=21600] [temp1=180]
          const decodedCount = commandApi.decodeLEB128(blob, 0);
          assert.strictEqual(decodedCount.value, 2);
  
          let offset = decodedCount.bytesRead;
          const t0Time = commandApi.decodeLEB128(blob, offset);
          assert.strictEqual(t0Time.value, 0);
          offset += t0Time.bytesRead;
  
          const t0Temp = commandApi.decodeLEB128(blob, offset);
          assert.strictEqual(t0Temp.value, 200);
          offset += t0Temp.bytesRead;
  
          const t1Time = commandApi.decodeLEB128(blob, offset);
          assert.strictEqual(t1Time.value, 21600);
          offset += t1Time.bytesRead;
  
          const t1Temp = commandApi.decodeLEB128(blob, offset);
          assert.strictEqual(t1Temp.value, 180);
      });
  
      await test('blocksToTransitions: sorts and formats correctly', () => {
          const blocks = [
              { start_time: '08:00', setting_type: 'HEATING', setting_power: 'ON', setting_temp_celsius: 21.5 },
              { start_time: '00:00', setting_type: 'HEATING', setting_power: 'ON', setting_temp_celsius: 18.0 },
              { start_time: '22:00', setting_type: 'HEATING', setting_power: 'OFF', setting_temp_celsius: null }
          ];
          const trans = commandApi.blocksToTransitions(blocks);
          assert.strictEqual(trans.length, 3);
          // Verify sort order
          assert.strictEqual(trans[0].timeSeconds, 0);       // 00:00
          assert.strictEqual(trans[0].tempTenths, 180);
          assert.strictEqual(trans[1].timeSeconds, 28800);   // 08:00
          assert.strictEqual(trans[1].tempTenths, 215);
          assert.strictEqual(trans[2].timeSeconds, 79200);   // 22:00
          assert.strictEqual(trans[2].tempTenths, 0);         // OFF
      });
  
      await test('blocksToTransitions: empty fallback', () => {
          const trans = commandApi.blocksToTransitions([]);
          assert.strictEqual(trans.length, 1);
          assert.strictEqual(trans[0].timeSeconds, 0);
          assert.strictEqual(trans[0].tempTenths, 200); // 20.0°C default
      });
  
      // ══════════════════════════════════════════════════════════════════════════
      // Mock connection & command construction tests
      // ══════════════════════════════════════════════════════════════════════════
      console.log('\n--- 3. Command Packet & Payload Construction ---');
  
      // 1. Mock DB stubs
      const mockDb = {
          isOffline: () => false,
          getDevicesInZone: async (homeId, zoneId) => [
              { serial_no: 'IB0000000001', device_type: 'IB01', home_id: homeId, zone_id: zoneId, ipv6_address: 'fd00::1' },
              { serial_no: 'VA0000000001', device_type: 'VA01', home_id: homeId, zone_id: zoneId, ipv6_address: 'fd00::2' }
          ],
          getZoneState: async () => ({}),
          getDeviceByFullSerial: async (serial) => ({
              serial_no: serial,
              device_type: serial.startsWith('IB') ? 'IB01' : 'VA01',
              home_id: 999999,
              ipv6_address: serial.startsWith('IB') ? 'fd00::1' : 'fd00::2',
              zone_id: 1,
              last_config_json: JSON.stringify({
                  '0x0158': 0,
                  '0x60e0': 0,
                  '0x62c0': 0,
                  '0x02b3': 0
              }),
              config_etag: Buffer.from('1e38286d77c0c25c', 'hex')
          }),
          getDeviceBySerial: async (serial) => ({
              serial_no: serial,
              device_type: serial.startsWith('IB') ? 'IB01' : 'VA01',
              home_id: 999999,
              ipv6_address: serial.startsWith('IB') ? 'fd00::1' : 'fd00::2',
              zone_id: 1,
              last_config_json: JSON.stringify({
                  '0x0158': 0,
                  '0x60e0': 0,
                  '0x62c0': 0,
                  '0x02b3': 0
              }),
              config_etag: Buffer.from('1e38286d77c0c25c', 'hex')
          }),
          getZoneBindingsForDevice: async () => [],
          getZoneDefaultOverlay: async () => ({ type: 'MANUAL', durationInSeconds: null }),
          updateZoneConfig: async () => ({}),
          updateZoneOpenWindow: async () => ({}),
          updateLastConfigJsonFromLive: async () => ({}),
          calculateVADeviceETag: () => 0x1e38,
          generateEtag: db.generateEtag,
          unmapOrientation: db.unmapOrientation,
          getPool: () => ({
              execute: async (query, params) => {
                  if (query.includes('FROM homes')) {
                      return [[{ zone_config_readonly: 0, dev_bypass: 1 }]];
                  }
                  if (query.includes('FROM zones')) {
                      return [[{ id: 1, home_id: 999999, type: 'HEATING', zone_config_readonly: 0, dev_bypass: 1, measuring_device_serial: 'VA0000000001', dazzle_enabled: 1, offline_schedule_enabled: 1, open_window_enabled: 1, open_window_timeout: 900 }]];
                  }
                  if (query.includes('FROM heating_circuits')) {
                      return [[{ number: 1, driver_serial_no: 'IB0000000001' }]];
                  }
                  if (query.includes('FROM devices')) {
                      return [[{ serial_no: 'IB0000000001', device_type: 'IB01' }]];
                  }
                  if (query.includes('FROM zone_timetables')) {
                      return [[{ id: 45 }]];
                  }
                  if (query.includes('FROM schedule_blocks')) {
                      return [[
                          { start_time: '00:00', setting_power: 'ON', setting_temp_celsius: 18 },
                          { start_time: '07:30', setting_power: 'ON', setting_temp_celsius: 21 },
                          { start_time: '22:00', setting_power: 'OFF', setting_temp_celsius: null }
                      ]];
                  }
                  return [[]];
              }
          })
      };
  
      // 2. Mock Clients Connection Map
      const clientsMap = new Map();
      clientsMap.set('IB0000000001', {
          ws: { send: () => {} },
          ipv6: 'fd00::1',
          port: 5683,
          udpPort: 5683,
          homeId: 999999,
          session2048: Buffer.from('mocksession2048key12')
      });
  
      // Capture frames sent
      let lastSentFrame = null;
      const sendToDevice = async (deviceId, wsFrame) => {
          lastSentFrame = { deviceId, wsFrame };
      };
  
      // Initialize command API with stubs
      commandApi.initialize({
          clients: clientsMap,
          sendToDevice,
          broadcastTime: () => {},
          db: mockDb
      });
  
      const verifyCoapFrame = (expectedMethod, expectedPath, expectedQuery = null) => {
          assert.ok(lastSentFrame, 'No frame was sent!');
          const frame = wsBridge.parse(lastSentFrame.wsFrame);
          assert.ok(frame.ok, 'Failed to parse wsBridge frame');
          const coapMsg = coap.parse(frame.coapBytes);
          assert.ok(coapMsg.ok, 'Failed to parse CoAP message');
          assert.strictEqual(coap.codeStr(coapMsg.code), expectedMethod);
          assert.strictEqual(coap.uriPath(coapMsg), expectedPath);
          
          if (expectedQuery) {
              const queryOpt = coapMsg.options.find(o => o.num === coap.OPT_URI_QUERY);
              assert.ok(queryOpt, 'Missing Uri-Query option');
              assert.strictEqual(queryOpt.value.toString(), expectedQuery);
          }
  
          let decoded = null;
          if (coapMsg.payload && coapMsg.payload.length > 0) {
              decoded = tlv.decode(coapMsg.payload);
              assert.ok(decoded.ok, 'Failed to decode TLV payload');
          }
          return { coapMsg, decoded };
      };
  
      await test('pushZoneOverlay (Manual ON 22.5°C)', async () => {
          lastSentFrame = null;
          await commandApi.pushZoneOverlay(999999, 1, { power: 'ON', temperature: { celsius: 22.5 } }, { type: 'MANUAL' });
          const { decoded } = verifyCoapFrame('PUT', 'z/s', 'id=1');
          assert.strictEqual(decoded.fields['0x6240'], 2); // MANUAL
          assert.strictEqual(decoded.fields['0x6280'], 22.5);
      });
  
      await test('pushZoneOverlay (Manual OFF)', async () => {
          lastSentFrame = null;
          await commandApi.pushZoneOverlay(999999, 1, { power: 'OFF' }, { type: 'MANUAL' });
          const { decoded } = verifyCoapFrame('PUT', 'z/s', 'id=1');
          assert.strictEqual(decoded.fields['0x6240'], 1); // Heating OFF overlay is 1
          assert.strictEqual(decoded.fields['0x6280'], undefined);
      });
  
      await test('pushZoneOverlayDelete (Resume Schedule)', async () => {
          lastSentFrame = null;
          await commandApi.pushZoneOverlayDelete(999999, 1);
          const { decoded } = verifyCoapFrame('PUT', 'z/s', 'id=1');
          assert.strictEqual(decoded.fields['0x6240'], 0); // 0 = SCHEDULE
      });
  
      await test('pushDeviceLock (Child Lock ON)', async () => {
          lastSentFrame = null;
          await commandApi.pushDeviceLock('IB0000000001', true);
          const { decoded } = verifyCoapFrame('PUT', 'd/lock');
          assert.strictEqual(decoded.fields['0x0290'], true);
      });
  
      await test('pushDeviceIdentify (Flash LED)', async () => {
          lastSentFrame = null;
          await commandApi.pushDeviceIdentify('IB0000000001');
          const { coapMsg } = verifyCoapFrame('PUT', 'd/identify');
          assert.ok(!coapMsg.payload || coapMsg.payload.length === 0);
      });

      await test('pushDeviceReboot (Device Reboot)', async () => {
          lastSentFrame = null;
          await commandApi.pushDeviceReboot('IB0000000001');
          const { coapMsg } = verifyCoapFrame('POST', 'd/reboot');
          assert.ok(!coapMsg.payload || coapMsg.payload.length === 0);
      });

      await test('pushHomeIbReboot (Home IB Restart)', async () => {
          lastSentFrame = null;
          const results = await commandApi.pushHomeIbReboot(999999);
          assert.ok(Array.isArray(results));
          assert.strictEqual(results.length, 1);
          assert.strictEqual(results[0].serial_no, 'IB0000000001');
          assert.strictEqual(results[0].success, true);
          const { coapMsg } = verifyCoapFrame('POST', 'd/reboot');
          assert.ok(!coapMsg.payload || coapMsg.payload.length === 0);
      });
  
      await test('pushZoneDazzleMode (Dazzle ON)', async () => {
          lastSentFrame = null;
          await commandApi.pushZoneDazzleMode(999999, 1, true);
          const { decoded } = verifyCoapFrame('PUT', 'd/config');
          assert.strictEqual(decoded.fields['0x0158'], 0x0200); // Dazzle enabled flag
      });
  
      await test('pushZoneOWD (OWD Enable with 900s timeout)', async () => {
          lastSentFrame = null;
          await commandApi.pushZoneOWD(999999, 1, true, 900);
          const { decoded } = verifyCoapFrame('PUT', 'd/config');
          assert.ok(decoded); // Verify refresh config refresh command was triggered
      });
  
      await test('pushOfflineScheduleEnable (Enable Fallback Schedule)', async () => {
          lastSentFrame = null;
          await commandApi.pushOfflineScheduleEnable(999999, 1, true);
          const { decoded } = verifyCoapFrame('PUT', 'd/config');
          assert.strictEqual(decoded.fields['0x02b3'], true); // true = enabled
      });
  
      await test('pushOfflineScheduleSync (Push transitions)', async () => {
          lastSentFrame = null;
          // Stub DB timetable fetch for sync
          const originalGetPool = mockDb.getPool;
          mockDb.getPool = () => ({
              execute: async (query, params) => {
                  if (query.includes('FROM zone_timetables')) {
                      return [[{ id: 45 }]];
                  }
                  if (query.includes('FROM schedule_blocks')) {
                      return [[
                          { start_time: '00:00', setting_power: 'ON', setting_temp_celsius: 18 },
                          { start_time: '07:30', setting_power: 'ON', setting_temp_celsius: 21 },
                          { start_time: '22:00', setting_power: 'OFF', setting_temp_celsius: null }
                      ]];
                  }
                  return [[]];
              }
          });
  
          try {
              await commandApi.pushOfflineScheduleSync(999999, 1);
              const { decoded } = verifyCoapFrame('PUT', 'd/config');
              
              // Check that schedule blobs exist for all days in the TLV payload (using hex FIDs)
              const fids = ['0x029a', '0x029b', '0x029c', '0x029d', '0x029e', '0x029f', '0x02a0'];
              fids.forEach(fid => {
                  const blob = decoded.fields[fid];
                  assert.ok(blob, `Missing transition blob for ${fid}`);
                  assert.strictEqual(typeof blob, 'string', `Blob for ${fid} must be a hex string`);
              });
          } finally {
              mockDb.getPool = originalGetPool;
          }
      });

      await test('handleRfKeyRefresh (GET /d/rfkey)', async () => {
          lastSentFrame = null;
          const req = {};
          let responseStatus = null;
          let responseJson = null;
          const res = {
              writeHead: (code) => { responseStatus = code; return res; },
              status: (code) => { responseStatus = code; return res; },
              json: (data) => { responseJson = data; return res; },
              setHeader: () => res,
              end: (data) => { if (data) try { responseJson = JSON.parse(data); } catch(e) {} return res; }
          };

          await commandApi.handleRfKeyRefresh(req, res, 'IB0000000001');
          assert.strictEqual(responseStatus, 200);
          assert.ok(lastSentFrame, 'No frame was sent');

          const frame = wsBridge.parse(lastSentFrame.wsFrame);
          assert.strictEqual(frame.direction, 'server_to_client');
          assert.strictEqual(frame.ipv6, 'fd00:0:0:0:0:0:0:1'); // Bridge IPv6

          const coapMsg = coap.parse(frame.coapBytes);
          assert.strictEqual(coap.codeStr(coapMsg.code), 'GET'); // GET
          assert.strictEqual(coap.uriPath(coapMsg), 'd/rfkey');
          assert.strictEqual(coapMsg.token.length, 8); // 8-byte random token

          // Check options: Option 7 = 0xffff, Option 12 = 42, No Option 2048
          const opt7 = coapMsg.options.find(o => o.num === 7);
          assert.ok(opt7);
          assert.strictEqual(opt7.value.toString('hex'), 'ffff');

          const opt12 = coapMsg.options.find(o => o.num === 12);
          assert.ok(opt12);
          assert.strictEqual(opt12.value.readUInt8(0), 42);

          const opt2048 = coapMsg.options.find(o => o.num === 2048);
          assert.strictEqual(opt2048, undefined, 'Option 2048 must NOT be present on GET /d/rfkey');
      });
  
      console.log(`\n═══ command-api.js Tests Completed: Passed ${passed}/${passed + failed} ═══`);
      if (!process.env.VITEST) await db.close();
      if (failed > 0) throw new Error('Some tests failed');
  }

  await runTests();
  
});