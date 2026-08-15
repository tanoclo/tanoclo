/**
 * @file test/test_message_parity.test.js
 * @brief Vitest testing suite validating server modules.
 */

'use strict';
require('./test_config');


const db = require('../lib/db');
const coap = require('../lib/coap');
const tlv = require('../lib/tlv');
const crypto = require('crypto');



test('legacy test suite runs successfully', async () => {
  async function testParity() {
      console.log('--- Testing Message Parity & Block2 ---');
      
      const testSerial = 'VA9999999999';
      
      // Ensure mock device exists in DB
      await db.getPool().execute(`
          INSERT IGNORE INTO devices (
              serial_no, device_type, home_id,
              current_fw_version, connection_state, in_pairing_mode,
              cap_inside_temp_measurement, cap_identify, cap_radio_encryption_key_access,
              connection_state_timestamp, last_config_json
          ) VALUES (
              ?, 'VA', 999999,
              '1.0', 1, 0,
              1, 1, 0,
              '2026-06-20T00:00:00Z', '{"temperature_offset": 0.0}'
          )
      `, [testSerial]);
      
      // Initialize TLV labels from database
      const labels = await db.getTlvLabels();
      tlv.init(labels.fields);
  
      // Reset lock to false to ensure ETag changes when set to true
      await db.updateDeviceLock(testSerial, false);
  
      // 1. Test Persistent ETags
      console.log('Step 1: Testing Persistent ETags...');
      const etags1 = await db.getDeviceEtags(testSerial);
      console.log('Current ETags:', etags1);
      
      await db.updateDeviceLock(testSerial, true);
      const etags2 = await db.getDeviceEtags(testSerial);
      console.log('Updated ETags (Lock):', etags2);
      
      if (!etags1 || !etags2 || !etags2.lock || (etags1.lock && Buffer.compare(etags1.lock, etags2.lock) === 0)) {
          console.error('FAIL: ETag did not change after update!');
      } else {
          console.log('SUCCESS: ETag changed after update.');
      }
  
      // 2. Test Block2 Slicing & Freezing (Simulation)
      // Note: To test the actual WebSocket server logic, we'd need a running instance.
      // Here we'll just verify the DB retrieval and TLV building.
      console.log('\nStep 2: Testing TLV Construction...');
      const configPayload = await db.buildDeviceConfigTLV(testSerial);
      console.log(`Config Payload Length: ${configPayload.length} bytes`);
      
      const decoded = tlv.decode(configPayload);
      console.log('Decoded Config Keys:', Object.keys(decoded.fields));
  
      console.log('\nStep 3: Verifying Resource Types...');
      const etags = await db.getDeviceEtags(testSerial);
      if (etags.sen) console.log('Sensor ETag exists (8 bytes):', etags.sen.length === 8);
      if (etags.act) console.log('Actuator ETag exists (8 bytes):', etags.act.length === 8);
  }
  
  async function runTestAndCleanup() {
      const testSerial = 'VA9999999999';
      try {
          await testParity(testSerial);
      } catch (err) {
          console.error(err);
          process.exitCode = 1;
      } finally {
          try {
              await db.getPool().execute('DELETE FROM devices WHERE serial_no = ?', [testSerial]);
              console.log('Cleanup: deleted mock device from DB.');
          } catch (cleanupErr) {
              console.error('Cleanup failed:', cleanupErr.message);
          }
          try {
              await db.close();
          } catch (dbErr) {
              console.error('Failed to close DB:', dbErr.message);
          }
          if (process.exitCode) throw new Error('Some tests failed');
      }
  }
  
  await runTestAndCleanup();
  
});