/**
 * @file test/test_db_helper.js
 * @brief Vitest testing suite validating server modules.
 */

'use strict';

const bcrypt = require('bcryptjs');




  async function setupTestFixtures(pool, deviceId, homeId, zoneId, apiUser, apiPass, sourceHomeId, sourceDeviceId) {
      // Only run setup if using the synthetic test home ID 999999
      if (Number(homeId) !== 999999) {
          return;
      }
  
      console.log(`[test-db-helper] Setting up synthetic test fixtures for home ${homeId}...`);
  
      // Clean up first to be idempotent
      await cleanupTestFixtures(pool, homeId, deviceId);
  
      // 1. Copy Home
      if (sourceHomeId) {
          const [homeRows] = await pool.execute('SELECT * FROM homes WHERE id = ?', [sourceHomeId]);
          if (homeRows.length > 0) {
              const homeData = { 
                  ...homeRows[0], 
                  id: homeId, 
                  name: 'Test Home', 
                  presence: 'HOME', 
                  presence_locked: 0, 
                  is_proxied: 0, 
                  allow_commands_in_proxy: 1, 
                  installation_completed: 1 
              };
              const keys = Object.keys(homeData);
              const placeholders = keys.map(() => '?').join(', ');
              await pool.execute(`INSERT INTO homes (${keys.join(', ')}) VALUES (${placeholders})`, Object.values(homeData));
          }
      } else {
          // Fallback if no source home provided
          await pool.execute(`
              INSERT INTO homes (
                  id, name, temperature_unit, presence, presence_locked, is_proxied, 
                  log_uploads_enabled, proxy_logging, allow_commands_in_proxy, 
                  zone_config_readonly, ha_discovery_enabled, dev_bypass, installation_completed,
                  simple_smart_schedule_enabled
              ) VALUES (?, 'Test Home', 'CELSIUS', 'HOME', 0, 0, 0, 0, 1, 0, 0, 0, 1, 1)
          `, [homeId]);
      }
  
      // 2. Insert User (default admin / admin123)
      const passwordHash = await bcrypt.hash(apiPass || 'admin123', 10);
      await pool.execute(`
          INSERT INTO users (id, name, email, username, password, locale, home_id)
          VALUES ('test-admin-uuid', 'Test Admin', 'admin@example.com', ?, ?, 'en', ?)
      `, [apiUser || 'admin', passwordHash, homeId]);
  
      // 3. Copy Zone
      if (sourceHomeId) {
          const [zoneRows] = await pool.execute('SELECT * FROM zones WHERE home_id = ? ORDER BY (type = "HEATING") DESC LIMIT 1', [sourceHomeId]);
          if (zoneRows.length > 0) {
              const zoneData = { 
                  ...zoneRows[0], 
                  id: zoneId, 
                  home_id: homeId, 
                  name: 'Test Zone',
                  type: 'HEATING',
                  config_etag: Buffer.from('zoneconfigetag12', 'utf8')
              };
              const keys = Object.keys(zoneData);
              const placeholders = keys.map(() => '?').join(', ');
              await pool.execute(`INSERT INTO zones (${keys.join(', ')}) VALUES (${placeholders})`, Object.values(zoneData));
          }
      } else {
          // Fallback if no source zone
          await pool.execute(`
              INSERT INTO zones (
                  id, home_id, name, type, open_window_enabled, open_window_timeout, 
                  dazzle_enabled, early_start_enabled, min_temp, max_temp, step_temp, 
                  default_overlay_type
              ) VALUES (?, ?, 'Test Zone', 'HEATING', 0, 900, 0, 0, 5, 25, 0.5, 'MANUAL')
          `, [zoneId, homeId]);
      }
  
      // 4. Copy Device (forcing non-null ETags to support conditional GET verification)
      let deviceCopied = false;
      if (sourceDeviceId) {
          const [deviceRows] = await pool.execute('SELECT * FROM devices WHERE serial_no = ?', [sourceDeviceId]);
          if (deviceRows.length > 0) {
              const deviceData = { 
                  ...deviceRows[0], 
                  serial_no: deviceId, 
                  home_id: homeId, 
                  zone_id: zoneId, 
                  connection_state: 1,
                  config_etag: Buffer.from('configetag123456', 'utf8'),
                  config_etag_real: Buffer.from('configetag123456', 'utf8'),
                  lock_etag: Buffer.from('locketag12345678', 'utf8'),
                  lock_etag_real: Buffer.from('locketag12345678', 'utf8'),
                  sen_etag: Buffer.from('senetag123456789', 'utf8'),
                  act_etag: Buffer.from('actetag123456789', 'utf8')
              };
              const keys = Object.keys(deviceData);
              const placeholders = keys.map(() => '?').join(', ');
              await pool.execute(`INSERT INTO devices (${keys.join(', ')}) VALUES (${placeholders})`, Object.values(deviceData));
              deviceCopied = true;
          }
      }
      
      if (!deviceCopied) {
          // Fallback if no source device or if copy failed
          await pool.execute(`
              INSERT INTO devices (
                  serial_no, device_type, home_id, current_fw_version, connection_state, 
                  in_pairing_mode, connection_state_timestamp, config_etag, config_etag_real
              ) VALUES (?, 'IB01', ?, '92.1', 1, 0, '2026-07-01T00:00:00Z', 'configetag123456', 'configetag123456')
          `, [deviceId, homeId]);
      }
  
      // 5. Copy Heating Circuit
      if (sourceHomeId) {
          const [circuitRows] = await pool.execute('SELECT * FROM heating_circuits WHERE home_id = ? LIMIT 1', [sourceHomeId]);
          if (circuitRows.length > 0) {
              const circuitData = { 
                  ...circuitRows[0], 
                  home_id: homeId, 
                  number: 1,
                  driver_serial_no: deviceId,
                  config_etag: Buffer.from('circuitetag12345', 'utf8'),
                  config_etag_real: Buffer.from('circuitetag12345', 'utf8')
              };
              delete circuitData.id;
              const keys = Object.keys(circuitData);
              const placeholders = keys.map(() => '?').join(', ');
              await pool.execute(`INSERT INTO heating_circuits (${keys.join(', ')}) VALUES (${placeholders})`, Object.values(circuitData));
          }
      } else {
          await pool.execute(`
              INSERT INTO heating_circuits (home_id, number, driver_serial_no, config_etag, config_etag_real)
              VALUES (?, 1, ?, 'circuitetag12345', 'circuitetag12345')
          `, [homeId, deviceId]);
      }
  
      // 6. Whitelist device and home
      await pool.execute(`
          INSERT INTO websocket_whitelist (type, value)
          VALUES ('device', ?)
      `, [deviceId]);
      await pool.execute(`
          INSERT INTO websocket_whitelist (type, value)
          VALUES ('home', ?)
      `, [String(homeId)]);
  
      console.log('[test-db-helper] Synthetic test fixtures set up successfully!');
  }
  
  async function cleanupTestFixtures(pool, homeId, deviceId) {
      if (Number(homeId) !== 999999) {
          return;
      }
  
      console.log(`[test-db-helper] Cleaning up synthetic test fixtures for home ${homeId}...`);
      try {
          const tables = [
              'away_configurations',
              'devices',
              'device_measurements',
              'flow_temperature_settings',
              'heating_circuits',
              'heating_systems',
              'home_weather',
              'installations',
              'invitations',
              'mobile_devices',
              'schedule_blocks',
              'state_snapshots',
              'users',
              'zones',
              'zone_measurements',
              'zone_overlays',
              'zone_timetables'
          ];
  
          await pool.execute('SET FOREIGN_KEY_CHECKS = 0');
          
          for (const table of tables) {
              await pool.execute(`DELETE FROM ${table} WHERE home_id = ?`, [homeId]);
          }
          
          await pool.execute('DELETE FROM homes WHERE id = ?', [homeId]);
          
          if (deviceId) {
              await pool.execute("DELETE FROM websocket_whitelist WHERE value = ?", [deviceId]);
          }
          await pool.execute("DELETE FROM websocket_whitelist WHERE value = ?", [String(homeId)]);
          
          await pool.execute('SET FOREIGN_KEY_CHECKS = 1');
          
          console.log('[test-db-helper] Cleanup complete.');
      } catch (err) {
          try {
              await pool.execute('SET FOREIGN_KEY_CHECKS = 1');
          } catch (e) {}
          console.error('[test-db-helper] Error during cleanup:', err.message);
      }
  }
  
  module.exports = {
      setupTestFixtures,
      cleanupTestFixtures
  };
  
