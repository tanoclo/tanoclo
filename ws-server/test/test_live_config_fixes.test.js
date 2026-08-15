/**
 * @file test/test_live_config_fixes.test.js
 * @brief Vitest testing suite validating server modules.
 */

'use strict';
require('./test_config');

const db = require('../lib/db');
const tlv = require('../lib/tlv');
const fs = require('fs');
const path = require('path');

const testCmdApi = require('../lib/command-api');



test('legacy test suite runs successfully', async () => {
  async function runTests() {
      try {
          console.log('--- Testing Live Config & Serialization Fixes ---');
  
          // 1. Initialize TLV labels
          const p = db.getPool();
          const [rows] = await p.execute('SELECT hex_id, name, type, unit, scale FROM tlv_labels');
          const labels = {};
          for (const row of rows) {
              labels[row.hex_id] = { name: row.name, type: row.type, unit: row.unit, scale: row.scale };
          }
          tlv.init(labels);
  
          const updateFieldInMap = testCmdApi.updateFieldInMap;
  
          // 2. Test updateFieldInMap behavior
          console.log('\n2. Testing updateFieldInMap for circuit_dhw_max_flow_temperature...');
          let configObj = {
              '0x2040': 5500,
              'circuit_dhw_max_flow_temperature': 5500
          };
  
          // Update it with unscaled value 55
          updateFieldInMap(configObj, 'circuit_dhw_max_flow_temperature', 55.0);
  
          console.log('configObj after update:', configObj);
          
          // Assertions:
          if (configObj['0x2040'] !== undefined) {
              throw new Error('FAIL: Hex key "0x2040" should have been deleted!');
          }
          if (configObj.circuit_dhw_max_flow_temperature !== 55.0) {
              throw new Error(`FAIL: Expected 55.0, got ${configObj.circuit_dhw_max_flow_temperature}`);
          }
          console.log('SUCCESS: updateFieldInMap correctly deleted hex alias and stored unscaled value.');
  
          // 3. Test serialization of the resulting object
          console.log('\n3. Testing TLV serialization for circuit config...');
          const payload = tlv.encodeFromFields(configObj);
          console.log('Raw Payload Hex:', payload.toString('hex'));
  
          const decoded = tlv.decode(payload);
          console.log('Decoded Fields:', decoded.fields);
  
          if (decoded.fields['0x2040'] !== 55.0) {
              throw new Error(`FAIL: Mismatch after decode. Expected 55.0, got ${decoded.fields['0x2040']}`);
          }
          console.log('SUCCESS: TLV round-trip correct. No double-scaling, no duplicate FIDs!');
  
          // 4. Test updateFieldInMap with real label
          let testFid = null;
          let testFriendly = null;
          for (const [hexId, label] of Object.entries(tlv.getLabels())) {
              if (label.name) {
                  testFid = parseInt(hexId, 16);
                  testFriendly = label.name;
                  break;
              }
          }
  
          console.log(`\n4. Testing updateFieldInMap with real label: FID ${testFid.toString(16)} -> ${testFriendly}...`);
          if (testFid !== null) {
              let testConfig = {};
              const hexName = '0x' + testFid.toString(16).toLowerCase().padStart(4, '0');
              testConfig[hexName] = 100;
              testConfig[testFriendly] = 100;
  
              // Update it using the friendly name
              updateFieldInMap(testConfig, testFriendly, 200);
              console.log('testConfig after update:', testConfig);
  
              if (testConfig[hexName] !== undefined) {
                  throw new Error(`FAIL: Hex key ${hexName} should have been deleted!`);
              }
              if (testConfig[testFriendly] !== 200) {
                  throw new Error(`FAIL: Friendly name ${testFriendly} should be 200, got ${testConfig[testFriendly]}`);
              }
              console.log('SUCCESS: updateFieldInMap correctly resolved and deduplicated.');
          } else {
              console.log('SKIPPED: No labels found with names in DB');
          }
  
          // 5. Test applyDeviceConfigOverrides
          console.log('\n5. Testing applyDeviceConfigOverrides...');
          const applyDeviceConfigOverrides = testCmdApi.applyDeviceConfigOverrides;
          
          // Find a device that is assigned to a zone
          const [devRows] = await p.execute('SELECT serial_no, zone_id FROM devices WHERE zone_id IS NOT NULL LIMIT 1');
          if (devRows.length > 0) {
              const dev = devRows[0];
              const [zoneRows] = await p.execute('SELECT dazzle_enabled, offline_schedule_enabled FROM zones WHERE id = ?', [dev.zone_id]);
              if (zoneRows.length > 0) {
                  const zone = zoneRows[0];
                  const testFields = {};
                  await applyDeviceConfigOverrides(dev.serial_no, testFields);
                  console.log('applyDeviceConfigOverrides result:', testFields);
                  
                  const expectedDazzle = zone.dazzle_enabled ? 0x0200 : 0x0000;
                  const expectedOffline = zone.offline_schedule_enabled ? 1 : 0;
                  
                  const actualDazzle = testFields.device_ui_flags_0158 !== undefined ? testFields.device_ui_flags_0158 : testFields['0x0158'];
                  const actualOffline = testFields.device_config_flag_02b3 !== undefined ? testFields.device_config_flag_02b3 : testFields['0x02b3'];
                  
                  if (actualDazzle !== expectedDazzle) {
                      throw new Error(`FAIL: Expected dazzle value ${expectedDazzle}, got ${actualDazzle}`);
                  }
                  if (actualOffline !== expectedOffline) {
                      throw new Error(`FAIL: Expected offline schedule value ${expectedOffline}, got ${actualOffline}`);
                  }
                  console.log('SUCCESS: applyDeviceConfigOverrides correctly fetched and applied overrides.');
              } else {
                  console.log('SKIPPED: Zone not found for test device');
              }
          } else {
              console.log('SKIPPED: No device with zone_id found in DB');
          }
  
          console.log('\nAll Live Config Fixes Tests Passed!');
          // process.exit(0);
      } catch (err) {
          console.error('FAIL: Test Error:', err);
          throw new Error('Test failed');
      } finally {
          try {
              await db.close();
          } catch (dbErr) {
              console.error('Failed to close DB:', dbErr.message);
          }
      }
  }
  
  await runTests();
  
});