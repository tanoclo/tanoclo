/**
 * @file test/test_config_sync.test.js
 * @brief Vitest testing suite validating server modules.
 */

'use strict';
require('./test_config');


const db = require('../lib/db');
const tlv = require('../lib/tlv');



test('legacy test suite runs successfully', async () => {
  async function testConfigSync() {
      const testSerial = 'IB1234567890';
      try {
          console.log('--- Testing Config Sync & Template Building ---');
  
          // Initialize TLV labels from database
          const labels = await db.getTlvLabels();
          tlv.init(labels.fields);
  
          // Ensure home 999999 exists in DB
          await db.getPool().execute(`
              INSERT INTO homes (
                  id, name, temperature_unit, installation_completed, simple_smart_schedule_enabled,
                  away_radius_in_meters, installation_method, incident_detection_enabled, latitude, longitude,
                  presence, presence_locked, is_proxied, allow_commands_in_proxy, ha_discovery_enabled
              ) VALUES (
                  999999, 'Test Home', 'CELSIUS', 1, 1, 400.00, 'MANUAL', 0, 50.8503, 4.3517, 'HOME', 0, 0, 1, 1
              ) ON DUPLICATE KEY UPDATE name = VALUES(name)
          `);

          // Ensure mock device exists cleanly in DB
          await db.getPool().execute('DELETE FROM devices WHERE serial_no = ?', [testSerial]);
          await db.getPool().execute(`
              INSERT INTO devices (
                  serial_no, device_type, home_id,
                  current_fw_version, connection_state, in_pairing_mode,
                  cap_inside_temp_measurement, cap_identify, cap_radio_encryption_key_access,
                  connection_state_timestamp, field_0140
              ) VALUES (
                  ?, 'VA', 999999,
                  '1.0', 1, 0,
                  1, 1, 0,
                  '2026-06-20T00:00:00Z', 0.0
              )
          `, [testSerial]);
  
          console.log('\n1. Testing Inverse Sync (Device)...');
          const newOffset = -0.5;
          await db.updateDeviceConfig(testSerial, { '0x0140': newOffset });
          const dev = await db.getDeviceByFullSerial(testSerial);
          if (!dev) throw new Error('Device not found');
          expect(Number(dev.field_0140)).toBe(newOffset);
  
          console.log('\n2. Testing Template Building (Device)...');
          const payload = await db.buildDeviceConfigTLV(testSerial, dev);
          const decoded = tlv.decode(payload);
  
          expect(decoded.fields['0x0140']).toBe(newOffset);
  
          console.log('\nVerification Complete!');
      } finally {
          try {
              const pool = db.getPool();
              await pool.execute('DELETE FROM devices WHERE serial_no = ?', [testSerial]);
          } catch (cleanupErr) {}
          try {
              if (!process.env.VITEST) await db.close();
          } catch (dbErr) {}
      }
  }
  
  await testConfigSync();
});