/**
 * @file lib/mqtt-commands.js
 * @brief MQTT command topic subscriber handling incoming controls.
 */

'use strict';

const { getLocalParts, parseLocalTimeInTimezone } = require('./utils');

let mqttClient = null;
let db = null;
let commandApi = null;
let mqttPublisher = null;
let log = null;
let onStateChange = null;

const emulatedStates = new Map();
const pendingEsp32Retries = new Map();

function init(_mqttClient, _db, _commandApi, _mqttPublisher, _log, _onStateChange) {
    mqttClient = _mqttClient;
    db = _db;
    commandApi = _commandApi;
    mqttPublisher = _mqttPublisher;
    log = _log;
    onStateChange = _onStateChange;

    // Subscribe to home-scoped commands
    mqttClient.subscribe('tado/tanoclo/h/+/set/#', (topic, payload) => {
        handleCommand(topic, payload).catch(err => {
            if (log) log('error', `[mqtt-commands] Error handling command for topic ${topic}: ${err.message}`);
        });
    });

    mqttClient.subscribe('tado/tanoclo/h/+/+/+/set/#', (topic, payload) => {
        handleCommand(topic, payload).catch(err => {
            if (log) log('error', `[mqtt-commands] Error handling command for topic ${topic}: ${err.message}`);
        });
    });

    // Subscribe to emulated device telemetry and HA control topics
    mqttClient.subscribe('tado/tanoclo/emulated/+/set/#', (topic, payload) => {
        handleEmulatedCommand(topic, payload).catch(err => {
            if (log) log('error', `[mqtt-commands] Error handling emulated command for topic ${topic}: ${err.message}`);
        });
    });

    mqttClient.subscribe('tado/tanoclo/emulated/+/telemetry', (topic, payload) => {
        handleEmulatedCommand(topic, payload).catch(err => {
            if (log) log('error', `[mqtt-commands] Error handling emulated telemetry for topic ${topic}: ${err.message}`);
        });
    });

    // Preload persisted emulated device states from DB (prioritize latest real measurements)
    if (db && db.getPool) {
        db.getPool().execute(`
            SELECT d.serial_no, 
                   COALESCE(dm.field_012d, 21.5) AS field_012d, 
                   COALESCE(dm.field_0135, 50.0) AS field_0135,
                   COALESCE(dm.field_0162, 4500) AS field_0162
            FROM devices d
            LEFT JOIN (
                SELECT dm1.* FROM device_measurements dm1
                INNER JOIN (
                    SELECT device_serial, MAX(id) AS max_id 
                    FROM device_measurements 
                    WHERE field_012d IS NOT NULL OR field_0135 IS NOT NULL
                    GROUP BY device_serial
                ) dm2 ON dm1.id = dm2.max_id
            ) dm ON d.serial_no = dm.device_serial
        `).then(([devs]) => {
            for (const dev of devs) {
                if (dev.field_012d != null || dev.field_0135 != null) {
                    emulatedStates.set(dev.serial_no, {
                        temp_celsius: dev.field_012d != null ? parseFloat(dev.field_012d) : 21.5,
                        humidity_percent: dev.field_0135 != null ? parseFloat(dev.field_0135) : 50.0,
                        battery_mv: dev.field_0162 != null && dev.field_0162 > 0 ? parseInt(dev.field_0162, 10) : 4500
                    });
                }
            }
        }).catch(err => {
            if (log) log('warn', `[mqtt-commands] Failed to preload emulated device states: ${err.message}`);
        });
    }
}

async function handleCommand(topic, payload) {
    const segs = topic.split('/');
    if (segs.length < 5) return;

    if (log) log('info', `[mqtt-commands] Received command topic: ${topic}, payload: ${payload}`);

    const pool = db.getPool();

    // Case 1: Home-level command (e.g. tado/tanoclo/h/123/set/presence)
    if (segs[2] === 'h' && segs[4] === 'set') {
        const homeId = parseInt(segs[3], 10);
        if (isNaN(homeId)) return;
        const command = segs.slice(5).join('/');

        if (command === 'presence') {
            const presenceHelper = require('./presence-helper');
            const rawPayload = String(payload).trim().toLowerCase();
            if (rawPayload === 'auto') {
                await presenceHelper.removePresenceLock(homeId);
            } else if (rawPayload === 'away') {
                await presenceHelper.setManualPresenceLock(homeId, 'AWAY');
            } else if (rawPayload === 'home') {
                await presenceHelper.setManualPresenceLock(homeId, 'HOME');
            } else {
                const isAway = String(payload).toUpperCase() === 'AWAY';
                await presenceHelper.setManualPresenceLock(homeId, isAway ? 'AWAY' : 'HOME');
            }
        } else if (['is_proxied', 'proxy_logging', 'log_uploads_enabled', 'allow_commands_in_proxy', 'zone_config_readonly', 'ha_discovery_enabled'].includes(command)) {
            const ALLOWED_HOME_COLUMNS = new Set(['is_proxied', 'proxy_logging', 'log_uploads_enabled', 'allow_commands_in_proxy', 'zone_config_readonly', 'ha_discovery_enabled']);
            if (!ALLOWED_HOME_COLUMNS.has(command)) return; // Redundant safety guard
            const enabled = String(payload).toUpperCase() === 'ON' ? 1 : 0;
            // Use explicit column mapping to prevent SQL injection — never interpolate topic segments into SQL
            const HOME_COLUMN_MAP = {
                'is_proxied': 'UPDATE homes SET is_proxied = ? WHERE id = ?',
                'proxy_logging': 'UPDATE homes SET proxy_logging = ? WHERE id = ?',
                'log_uploads_enabled': 'UPDATE homes SET log_uploads_enabled = ? WHERE id = ?',
                'allow_commands_in_proxy': 'UPDATE homes SET allow_commands_in_proxy = ? WHERE id = ?',
                'zone_config_readonly': 'UPDATE homes SET zone_config_readonly = ? WHERE id = ?',
                'ha_discovery_enabled': 'UPDATE homes SET ha_discovery_enabled = ? WHERE id = ?'
            };
            await pool.execute(HOME_COLUMN_MAP[command], [enabled, homeId]);
            
            if (command === 'is_proxied') {
                const proxyManager = require('./proxy-manager');
                if (proxyManager && proxyManager.clearProxyConnectionsForHome) {
                    proxyManager.clearProxyConnectionsForHome(homeId);
                }
                if (commandApi) {
                    await commandApi.pushHomeIbReboot(homeId).catch(err => {
                        if (log) log('warn', `[mqtt-commands] Failed to trigger IB restart for home ${homeId}: ${err.message}`);
                    });
                }
            }

            if (command === 'ha_discovery_enabled') {
                const mqttHaDiscovery = require('./mqtt-ha-discovery');
                await mqttHaDiscovery.publishAllDiscovery().catch(() => {});
            }
            
            await mqttPublisher.publishHomeTelemetry(homeId);
        }
    }
    // Case 2: Zone or Device-level command (e.g. tado/tanoclo/h/123/z/1/set/target_temperature)
    else if (segs[2] === 'h' && segs[6] === 'set') {
        const homeId = parseInt(segs[3], 10);
        if (isNaN(homeId)) return;
        const type = segs[4]; // 'z' or 'd'
        const id = segs[5];   // zoneId or shortSerial
        const command = segs.slice(7).join('/');

        if (type === 'z') {
            const zoneId = parseInt(id, 10);
            if (isNaN(zoneId)) return;

            // Query zone context
            const [zones] = await pool.execute('SELECT home_id, type, name FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
            if (zones.length === 0) {
                if (log) log('warn', `[mqtt-commands] Zone ${zoneId} not found in home ${homeId}`);
                return;
            }
            const zone = zones[0];
            const zoneType = zone.type || 'HEATING';

            if (command === 'target_temperature') {
                const temp = parseFloat(payload);
                if (isNaN(temp)) return;

                // Check if an overlay is currently active
                const [ovrRows] = await pool.execute('SELECT setting_power, termination_type, termination_duration_seconds FROM zone_overlays WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);

                let termType = null;
                let termDuration = null;

                // If currently in auto (no overlay) OR off (setting_power === 'OFF'), switch to default overlay mode
                if (ovrRows.length === 0 || ovrRows[0].setting_power === 'OFF') {
                    const [zRows] = await pool.execute('SELECT default_overlay_type, default_overlay_duration FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
                    termType = zRows[0]?.default_overlay_type || 'MANUAL';
                    termDuration = zRows[0]?.default_overlay_duration || 3600;
                } else {
                    // Mode is already an overlay mode (timer, manual, next_schedule) -> stay unchanged!
                    termType = ovrRows[0].termination_type || 'MANUAL';
                    termDuration = ovrRows[0].termination_duration_seconds || 3600;
                }

                const setting = {
                    type: zoneType,
                    power: 'ON',
                    temperature: zoneType === 'HEATING' ? { celsius: temp } : null
                };
                const termination = {
                    type: termType,
                    durationInSeconds: termDuration
                };

                await applyOverlayMqtt(homeId, zoneId, zoneType, setting, termination);

                const overlayModeMap = { 'TIMER': 1, 'NEXT_TIME_BLOCK': 2, 'TADO_MODE': 2, 'MANUAL': 3 };
                const overlayModeInt = overlayModeMap[termType] || 3;

                await db.insertMergedZoneMeasurement(homeId, zoneId, {
                    '0x6240': overlayModeInt,
                    '0x6280': temp,
                    '0x6200': temp,
                    '0x6260': 1,
                    '0x61e0': 1
                });

                const [rows] = await pool.execute('SELECT * FROM zone_measurements WHERE zone_id = ? AND home_id = ? ORDER BY id DESC LIMIT 1', [zoneId, homeId]);
                if (rows.length > 0) {
                    await mqttPublisher.publishZoneStateTelemetry(homeId, zoneId, rows[0]);
                    await mqttPublisher.publishZoneTelemetry(homeId, zoneId, rows[0]);
                }

            } else if (command === 'mode') {
                const mode = String(payload).trim().toLowerCase(); // 'auto', 'off', 'timer', 'manual', 'next_schedule' / 'heat'

                if (mode === 'auto' || mode === 'schedule') {
                    // Auto clears overlay
                    await pool.execute('DELETE FROM zone_overlays WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);

                    const currentBlock = await db.getCurrentScheduleBlock(homeId, zoneId);
                    const targetTemp = currentBlock?.setting?.temperature?.celsius || 19.0;

                    await db.insertMergedZoneMeasurement(homeId, zoneId, {
                        '0x6240': 0, // SCHEDULE
                        '0x6280': null,
                        '0x6260': 0,
                        '0x6200': targetTemp,
                        '0x6440': 0, // clear overlay
                        '0x61e0': 1  // enabled
                    });

                    await commandApi.pushZoneOverlayDelete(homeId, zoneId).catch(err => {
                        if (log) log('warn', `[mqtt-commands] Delete overlay push failed: ${err.message}`);
                    });

                    if (typeof onStateChange === 'function') {
                        onStateChange(homeId, 'zone-state', { zoneId });
                    }

                    _pub(`tado/tanoclo/h/${homeId}/z/${zoneId}/target_temperature`, targetTemp);

                } else if (mode === 'off') {
                    // Off creates an overlay with power OFF
                    const [zRows] = await pool.execute('SELECT default_overlay_type, default_overlay_duration FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
                    const defaultType = zRows[0]?.default_overlay_type || 'MANUAL';
                    const defaultDuration = zRows[0]?.default_overlay_duration || 3600;

                    const setting = { type: zoneType, power: 'OFF' };
                    const termination = { type: defaultType, durationInSeconds: defaultDuration };

                    await applyOverlayMqtt(homeId, zoneId, zoneType, setting, termination);

                    const overlayModeMap = { 'TIMER': 1, 'NEXT_TIME_BLOCK': 2, 'TADO_MODE': 2, 'MANUAL': 3 };
                    const overlayModeInt = overlayModeMap[defaultType] || 3;

                    await db.insertMergedZoneMeasurement(homeId, zoneId, {
                        '0x61e0': 0,
                        '0x6240': overlayModeInt,
                        '0x6280': 5.0,
                        '0x6200': 5.0
                    });

                } else {
                    // Overlay modes: timer, manual, next_schedule / heat
                    const [zRows] = await pool.execute('SELECT default_overlay_type, default_overlay_duration FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
                    const defaultType = zRows[0]?.default_overlay_type || 'MANUAL';
                    const defaultDuration = zRows[0]?.default_overlay_duration || 3600;

                    let targetType = defaultType;
                    let targetDuration = defaultDuration;

                    if (mode === 'timer') {
                        targetType = 'TIMER';
                        targetDuration = defaultDuration;
                    } else if (mode === 'manual' || mode === 'heat') {
                        targetType = 'MANUAL';
                    } else if (mode === 'next_schedule' || mode === 'next_block' || mode === 'tado_mode') {
                        targetType = 'TADO_MODE';
                    }

                    // Get target temperature
                    const [ovr] = await pool.execute('SELECT setting_temp_celsius FROM zone_overlays WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
                    let targetTemp = 20.0;
                    if (ovr.length > 0 && ovr[0].setting_temp_celsius !== null && ovr[0].setting_temp_celsius !== undefined) {
                        targetTemp = parseFloat(ovr[0].setting_temp_celsius);
                    } else {
                        const currentBlock = await db.getCurrentScheduleBlock(homeId, zoneId);
                        targetTemp = currentBlock?.setting?.temperature?.celsius || 20.0;
                    }

                    const setting = { type: zoneType, power: 'ON', temperature: { celsius: targetTemp } };
                    const termination = { type: targetType, durationInSeconds: targetDuration };

                    await applyOverlayMqtt(homeId, zoneId, zoneType, setting, termination);

                    const overlayModeMap = { 'TIMER': 1, 'NEXT_TIME_BLOCK': 2, 'TADO_MODE': 2, 'MANUAL': 3 };
                    const overlayModeInt = overlayModeMap[targetType] || 3;

                    await db.insertMergedZoneMeasurement(homeId, zoneId, {
                        '0x61e0': 1,
                        '0x6240': overlayModeInt,
                        '0x6280': targetTemp,
                        '0x6200': targetTemp,
                        '0x6260': 1
                    });
                }

                const [rows] = await pool.execute('SELECT * FROM zone_measurements WHERE zone_id = ? AND home_id = ? ORDER BY id DESC LIMIT 1', [zoneId, homeId]);
                if (rows.length > 0) {
                    await mqttPublisher.publishZoneStateTelemetry(homeId, zoneId, rows[0]);
                    await mqttPublisher.publishZoneTelemetry(homeId, zoneId, rows[0]);
                }

            } else if (command === 'overlay') {
                try {
                    const data = JSON.parse(payload);
                    const temp = parseFloat(data.temperature);
                    const type = data.type || 'MANUAL';
                    const duration = parseInt(data.duration, 10) || null;

                    const setting = {
                        type: zoneType,
                        power: 'ON',
                        temperature: zoneType === 'HEATING' && !isNaN(temp) ? { celsius: temp } : null
                    };

                    const termination = {
                        type,
                        durationInSeconds: duration
                    };

                    await applyOverlayMqtt(homeId, zoneId, zoneType, setting, termination);

                    const overlayModeMap = { 'TIMER': 1, 'NEXT_TIME_BLOCK': 2, 'MANUAL': 3 };
                    const overlayModeInt = overlayModeMap[type] || 3;

                    await db.insertMergedZoneMeasurement(homeId, zoneId, {
                        '0x6240': overlayModeInt,
                        '0x6280': isNaN(temp) ? null : temp,
                        '0x6200': isNaN(temp) ? null : temp,
                        '0x6260': isNaN(temp) ? 0 : 1
                    });

                    const [rows] = await pool.execute('SELECT * FROM zone_measurements WHERE zone_id = ? AND home_id = ? ORDER BY id DESC LIMIT 1', [zoneId, homeId]);
                    if (rows.length > 0) {
                        await mqttPublisher.publishZoneStateTelemetry(homeId, zoneId, rows[0]);
                    }
                } catch (e) {
                    if (log) log('warn', `[mqtt-commands] Failed to parse overlay JSON payload: ${e.message}`);
                }

            } else if (command === 'overlay_clear') {
                await pool.execute('DELETE FROM zone_overlays WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);

                const currentBlock = await db.getCurrentScheduleBlock(homeId, zoneId);
                const targetTemp = currentBlock?.setting?.temperature?.celsius || 19.0;

                await db.insertMergedZoneMeasurement(homeId, zoneId, {
                    '0x6240': 0,
                    '0x6280': null,
                    '0x6260': 0,
                    '0x6200': targetTemp,
                    '0x6440': 0
                });

                await commandApi.pushZoneOverlayDelete(homeId, zoneId).catch(err => {
                    if (log) log('warn', `[mqtt-commands] Delete overlay push failed: ${err.message}`);
                  });
  
                  const [rows] = await pool.execute('SELECT * FROM zone_measurements WHERE zone_id = ? AND home_id = ? ORDER BY id DESC LIMIT 1', [zoneId, homeId]);
                  if (rows.length > 0) {
                      await mqttPublisher.publishZoneStateTelemetry(homeId, zoneId, rows[0]);
                  }

              } else if (command === 'overlay_mode' || command === 'preset_mode') {
                  const rawMode = String(payload).trim().toUpperCase();
                  if (rawMode === 'SCHEDULE' || rawMode === 'AUTO') {
                      await pool.execute('DELETE FROM zone_overlays WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);

                      const currentBlock = await db.getCurrentScheduleBlock(homeId, zoneId);
                      const targetTemp = currentBlock?.setting?.temperature?.celsius || 19.0;

                      await db.insertMergedZoneMeasurement(homeId, zoneId, {
                          '0x6240': 0,
                          '0x6280': null,
                          '0x6260': 0,
                          '0x6200': targetTemp,
                          '0x6440': 0,
                          '0x61e0': 1
                      });

                      await commandApi.pushZoneOverlayDelete(homeId, zoneId).catch(err => {
                          if (log) log('warn', `[mqtt-commands] Delete overlay push failed: ${err.message}`);
                      });

                      _pub(`tado/tanoclo/h/${homeId}/z/${zoneId}/target_temperature`, targetTemp);

                  } else {
                      const mappedType = (rawMode === 'NEXT_BLOCK' || rawMode === 'NEXT_TIME_BLOCK' || rawMode === 'TADO_MODE') ? 'TADO_MODE' : (rawMode === 'TIMER' ? 'TIMER' : 'MANUAL');

                      const [ovr] = await pool.execute('SELECT * FROM zone_overlays WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
                      const [zRows] = await pool.execute('SELECT default_overlay_duration FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
                      const duration = (ovr.length > 0 && ovr[0].termination_duration_seconds) ? ovr[0].termination_duration_seconds : (zRows[0]?.default_overlay_duration || 3600);

                      let currentTemp = 20.0;
                      if (ovr.length > 0 && ovr[0].setting_temp_celsius !== null && ovr[0].setting_temp_celsius !== undefined) {
                          currentTemp = parseFloat(ovr[0].setting_temp_celsius);
                      } else {
                          const currentBlock = await db.getCurrentScheduleBlock(homeId, zoneId);
                          currentTemp = currentBlock?.setting?.temperature?.celsius || 20.0;
                      }

                      const setting = {
                          type: (ovr.length > 0 && ovr[0].setting_type) ? ovr[0].setting_type : zoneType,
                          power: (ovr.length > 0 && ovr[0].setting_power) ? ovr[0].setting_power : 'ON',
                          temperature: { celsius: currentTemp }
                      };
                      const termination = {
                          type: mappedType,
                          durationInSeconds: duration
                      };

                      await applyOverlayMqtt(homeId, zoneId, zoneType, setting, termination);

                      const overlayModeMap = { 'TIMER': 1, 'TADO_MODE': 2, 'NEXT_BLOCK': 2, 'MANUAL': 3 };
                      const overlayModeInt = overlayModeMap[mappedType] || 3;

                      await db.insertMergedZoneMeasurement(homeId, zoneId, {
                          '0x6240': overlayModeInt,
                          '0x6280': currentTemp,
                          '0x6200': currentTemp,
                          '0x6260': 1,
                          '0x61e0': 1
                      });
                  }

                  const [rows] = await pool.execute('SELECT * FROM zone_measurements WHERE zone_id = ? AND home_id = ? ORDER BY id DESC LIMIT 1', [zoneId, homeId]);
                  if (rows.length > 0) {
                      await mqttPublisher.publishZoneStateTelemetry(homeId, zoneId, rows[0]);
                      await mqttPublisher.publishZoneTelemetry(homeId, zoneId, rows[0]);
                  }

              } else if (command === 'default_overlay_type') {
                  const rawType = String(payload).trim().toUpperCase();
                  const mappedType = (rawType === 'NEXT_BLOCK' || rawType === 'NEXT_TIME_BLOCK' || rawType === 'TADO_MODE') ? 'TADO_MODE' : (rawType === 'TIMER' ? 'TIMER' : 'MANUAL');
                  await pool.execute('UPDATE zones SET default_overlay_type = ? WHERE id = ? AND home_id = ?', [mappedType, zoneId, homeId]);

              } else if (command === 'default_overlay_duration') {
                  const durationMin = parseFloat(payload);
                  if (!isNaN(durationMin) && durationMin > 0) {
                      const durationSec = Math.round(durationMin * 60);

                      await pool.execute('UPDATE zones SET default_overlay_duration = ? WHERE id = ? AND home_id = ?', [durationSec, zoneId, homeId]);

                      const [ovr] = await pool.execute('SELECT * FROM zone_overlays WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
                      if (ovr.length > 0 && ovr[0].termination_type === 'TIMER') {
                          const currentOvr = ovr[0];
                          const setting = {
                              type: currentOvr.setting_type || zoneType,
                              power: currentOvr.setting_power || 'ON',
                              temperature: currentOvr.setting_temp_celsius ? { celsius: currentOvr.setting_temp_celsius } : null
                          };
                          const termination = {
                              type: 'TIMER',
                              durationInSeconds: durationSec
                          };
                          await applyOverlayMqtt(homeId, zoneId, zoneType, setting, termination);
                      }

                      _pub(`tado/tanoclo/h/${homeId}/z/${zoneId}/default_overlay_duration`, Math.round(durationMin));

                      const [rows] = await pool.execute('SELECT * FROM zone_measurements WHERE zone_id = ? AND home_id = ? ORDER BY id DESC LIMIT 1', [zoneId, homeId]);
                      if (rows.length > 0) {
                          await mqttPublisher.publishZoneStateTelemetry(homeId, zoneId, rows[0]);
                          await mqttPublisher.publishZoneTelemetry(homeId, zoneId, rows[0]);
                      }
                  }
  
              } else if (command === 'early_start') {
                  const enabled = String(payload).toUpperCase() === 'ON';
                  await pool.execute('UPDATE zones SET early_start_enabled = ? WHERE id = ? AND home_id = ?', [enabled ? 1 : 0, zoneId, homeId]);
  
                  // Query devices in zone to push config refresh (ETags change)
                  const [devs] = await pool.execute('SELECT serial_no FROM devices WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
                  for (const d of devs) {
                      await commandApi.pushConfigRefresh(d.serial_no).catch(() => {});
                  }
  
                  // Republish zone details
                  _pub(`tado/tanoclo/h/${homeId}/z/${zoneId}/early_start`, enabled ? 'ON' : 'OFF');
              } else if (command === 'offline_schedule_enabled') {
                  const enabled = String(payload).toUpperCase() === 'ON';
                  await commandApi.pushOfflineScheduleEnable(homeId, zoneId, enabled).catch(err => {
                      if (log) log('warn', `[mqtt-commands] Offline schedule enable push failed: ${err.message}`);
                  });
                  const [rows] = await pool.execute('SELECT * FROM zone_measurements WHERE zone_id = ? AND home_id = ? ORDER BY id DESC LIMIT 1', [zoneId, homeId]);
                  const [zoneRows] = await pool.execute('SELECT * FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
                  if (rows.length > 0) {
                      await mqttPublisher.publishZoneStateTelemetry(homeId, zoneId, rows[0], zoneRows[0]);
                  }
              } else if (command === 'offline_schedule_sync') {
                  await commandApi.pushOfflineScheduleSync(homeId, zoneId).catch(err => {
                      if (log) log('warn', `[mqtt-commands] Offline schedule sync push failed: ${err.message}`);
                  });
              } else if (command === 'open_window') {
                  const active = String(payload).toUpperCase() === 'ON';
                  if (active) {
                      const [zoneRows] = await pool.execute(
                          'SELECT open_window_timeout FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]
                      );
                      const timeout = zoneRows[0]?.open_window_timeout || 900;
                      const expiry = new Date(Date.now() + timeout * 1000);
                      await pool.execute(
                          'UPDATE zones SET open_window_active = 1, open_window_expiry = ? WHERE id = ? AND home_id = ?',
                          [expiry, zoneId, homeId]
                      );
                      await commandApi.pushOpenWindowActivate(homeId, zoneId).catch(err => {
                          if (log) log('warn', `[mqtt-commands] OWD activate push failed: ${err.message}`);
                      });
                  } else {
                      await db.updateZoneOpenWindow(homeId, zoneId, false);
                      await pool.execute('UPDATE zones SET open_window_expiry = NULL WHERE id = ? AND home_id = ?', [zoneId, homeId]);
                      await commandApi.pushOpenWindowCancel(homeId, zoneId).catch(err => {
                          if (log) log('warn', `[mqtt-commands] OWD cancel push failed: ${err.message}`);
                      });
                  }
                  if (mqttPublisher) {
                      await mqttPublisher.publishOpenWindow(zoneId, active).catch(() => {});
                  }
              } else if (command === 'open_window_detection') {
                  const enabled = String(payload).toUpperCase() === 'ON';
                  await pool.execute('UPDATE zones SET open_window_enabled = ? WHERE id = ? AND home_id = ?', [enabled ? 1 : 0, zoneId, homeId]);
                  const [devs] = await pool.execute('SELECT serial_no FROM devices WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
                  for (const d of devs) {
                      await commandApi.pushConfigRefresh(d.serial_no).catch(() => {});
                  }
                  _pub(`tado/tanoclo/h/${homeId}/z/${zoneId}/open_window_detection`, enabled ? 'ON' : 'OFF');
              } else if (command === 'open_window_source') {
                  const source = String(payload).toLowerCase();
                  if (['device', 'server', 'both', 'external'].includes(source)) {
                      await pool.execute('UPDATE zones SET tanoclo_owd_source = ? WHERE id = ? AND home_id = ?', [source, zoneId, homeId]);
                      _pub(`tado/tanoclo/h/${homeId}/z/${zoneId}/open_window_source`, source);
                  }
              }
  
          } else if (type === 'd') {
              const shortSerial = id;
              const [devs] = await pool.execute('SELECT serial_no, home_id, zone_id, device_type, cap_identify FROM devices WHERE serial_no = ?', [shortSerial]);
              if (devs.length === 0) {
                  if (log) log('warn', `[mqtt-commands] Device ${shortSerial} not found`);
                  return;
              }
              const dev = devs[0];
              const isVA = dev.device_type && dev.device_type.startsWith('VA');
   
              if (command === 'identify') {
                  if (dev.cap_identify !== 0) {
                      await commandApi.pushDeviceIdentify(dev.serial_no).catch(err => {
                          if (log) log('warn', `[mqtt-commands] Device identify push failed: ${err.message}`);
                      });
                  }
              } else if (command === 'orientation' && isVA) {
                  const rawOrient = String(payload).toUpperCase();
                  const orientation = db.mapOrientation(rawOrient);
                  await pool.execute('UPDATE devices SET field_0149 = ? WHERE serial_no = ?', [orientation, dev.serial_no]);
                  await commandApi.pushConfigRefresh(dev.serial_no).catch(err => {
                      if (log) log('warn', `[mqtt-commands] Orientation config refresh push failed: ${err.message}`);
                  });
                  await mqttPublisher.publishOrientation(shortSerial, orientation);
              } else if (command === 'child_lock' && isVA) {
                  const enabled = String(payload).toUpperCase() === 'ON';
                  await db.updateDeviceLock(dev.serial_no, enabled);
                  await commandApi.pushDeviceLock(dev.serial_no, enabled).catch(err => {
                      if (log) log('warn', `[mqtt-commands] Device lock push failed: ${err.message}`);
                  });
  
                  await mqttPublisher.publishChildLock(shortSerial, enabled);
              } else if (['actuator_limit_low', 'actuator_limit_high', 'actuator_drive_constant'].includes(command) && isVA) {
                  const val = parseInt(payload, 10);
                  if (isNaN(val)) return;

                  // Use explicit SQL per field to prevent any SQL injection via topic segments
                  const ACTUATOR_SQL_MAP = {
                      'actuator_limit_low': 'UPDATE devices SET field_0273 = ? WHERE serial_no = ?',
                      'actuator_limit_high': 'UPDATE devices SET field_027c = ? WHERE serial_no = ?',
                      'actuator_drive_constant': 'UPDATE devices SET field_0280 = ? WHERE serial_no = ?'
                  };
                  await pool.execute(ACTUATOR_SQL_MAP[command], [val, dev.serial_no]);

                  // Query updated device row to get all limits
                  const [updatedDevs] = await pool.execute('SELECT * FROM devices WHERE serial_no = ?', [dev.serial_no]);
                  const updatedDev = updatedDevs[0];

                  await mqttPublisher.publishDeviceTelemetry(shortSerial, dev.home_id, dev.zone_id, null, updatedDev);
              } else if (command === 'actuator_limits_apply' && isVA) {
                  // Fetch the actuator limits from the database and push to physical device
                  const [updatedDevs] = await pool.execute('SELECT * FROM devices WHERE serial_no = ?', [dev.serial_no]);
                  if (updatedDevs.length > 0) {
                      const updatedDev = updatedDevs[0];
                      const lowSteps = updatedDev.field_0273;
                      const highSteps = updatedDev.field_027c;
                      const driveConstant = updatedDev.field_0280;

                      await commandApi.pushActuatorLimits(dev.serial_no, { lowSteps, highSteps, driveConstant }).catch(err => {
                          if (log) log('warn', `[mqtt-commands] Actuator limits push failed: ${err.message}`);
                      });
                  }
              }
          }
      }
  }
  
  async function applyOverlayMqtt(homeId, zoneId, zoneType, setting, termination) {
      const pool = db.getPool();
      const settingType = setting.type || 'HEATING';
      const settingPower = setting.power || 'ON';
      const settingTempC = setting.temperature?.celsius ?? null;
      const settingTempF = (settingTempC !== null) ? parseFloat((settingTempC * 1.8 + 32).toFixed(2)) : null;

      const termType = termination?.type || 'MANUAL';
      let termDuration = null;
      let termExpiry = null;
  
      if (termType === 'TIMER') {
          termDuration = termination?.durationInSeconds || 3600;
          termExpiry = new Date(Date.now() + termDuration * 1000).toISOString();
      } else if (termType === 'NEXT_TIME_BLOCK') {
          const nextBlock = await db.getNextScheduleBlock(homeId, zoneId);
          if (nextBlock && nextBlock.startTime) {
              const tzName = await db.getHomeTimezone(homeId, zoneId);
              const now = new Date();
              const { dateStr } = getLocalParts(now, tzName);
              const nextStartLocal = parseLocalTimeInTimezone(`${dateStr} ${nextBlock.startTime}`, tzName);
              
              let finalStart = nextStartLocal;
              if (finalStart.getTime() <= now.getTime()) {
                  finalStart = new Date(finalStart.getTime() + 24 * 60 * 60 * 1000);
              }
              termExpiry = finalStart.toISOString();
              termDuration = Math.max(0, Math.round((finalStart.getTime() - now.getTime()) / 1000));
          }
      }
  
      await pool.execute(
          `INSERT INTO zone_overlays (zone_id, home_id, setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit, termination_type, termination_duration_seconds, termination_expiry)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE 
              setting_type = VALUES(setting_type), 
              setting_power = VALUES(setting_power), 
              setting_temp_celsius = VALUES(setting_temp_celsius), 
              setting_temp_fahrenheit = VALUES(setting_temp_fahrenheit), 
              termination_type = VALUES(termination_type),
              termination_duration_seconds = VALUES(termination_duration_seconds),
              termination_expiry = VALUES(termination_expiry)`,
          [zoneId, homeId, settingType, settingPower, settingTempC, settingTempF, termType, termDuration, termExpiry]
      );
  
      await commandApi.pushZoneOverlay(homeId, zoneId, setting, { type: termType, durationInSeconds: termDuration }).catch(err => {
          if (log) log('warn', `[mqtt-commands] Overlay push failed: ${err.message}`);
      });

      if (typeof onStateChange === 'function') {
          onStateChange(homeId, 'zone-state', { zoneId });
      }
  }

async function handleEmulatedCommand(topic, payloadStr) {
    const segs = topic.split('/');
    if (segs.length < 4 || segs[2] !== 'emulated') return;

    const serial = segs[3];
    const dbDevices = require('./db-devices');
    const emulatedList = await dbDevices.getAllEmulatedDevices();
    const dev = emulatedList.find(d => d.serial_no === serial);

    // STRICT GUARD: Only registered emulated devices can be controlled
    if (!dev) {
        if (log) log('warn', `[mqtt-commands] Rejected MQTT command for unknown/unregistered emulated serial: ${serial}`);
        return;
    }

    if (!emulatedStates.has(serial)) {
        emulatedStates.set(serial, {
            temp_celsius: 21.5,
            humidity_percent: 50.0,
            battery_mv: 4500
        });
    }
    const state = emulatedStates.get(serial);

    const payload = String(payloadStr).trim();
    let shouldPushToEsp32 = false;

    if (segs[4] === 'telemetry') {
        try {
            const data = JSON.parse(payload);
            if (data.temp_celsius !== undefined) state.temp_celsius = parseFloat(data.temp_celsius);
            if (data.humidity_percent !== undefined) state.humidity_percent = parseFloat(data.humidity_percent);
            if (data.battery_mv !== undefined) state.battery_mv = parseInt(data.battery_mv, 10);
            shouldPushToEsp32 = true;
        } catch (e) {
            if (log) log('warn', `[mqtt-commands] Invalid JSON payload for emulated device ${serial} telemetry`);
            return;
        }
    } else if (segs[4] === 'set') {
        const action = segs[5];
        if (action === 'temp') {
            const val = parseFloat(payload);
            if (!isNaN(val)) state.temp_celsius = val;
        } else if (action === 'humidity') {
            const val = parseFloat(payload);
            if (!isNaN(val)) state.humidity_percent = val;
        } else if (action === 'push') {
            shouldPushToEsp32 = true;
        }
    }

    // Publish updated state back to MQTT state topic immediately so HA sliders remain in sync
    _pub(`tado/tanoclo/emulated/${serial}/state`, JSON.stringify({
        serial,
        temp_celsius: state.temp_celsius,
        humidity_percent: state.humidity_percent,
        battery_mv: state.battery_mv,
        updated_at: new Date().toISOString()
    }));

    if (shouldPushToEsp32) {
        dispatchEsp32Telemetry(dev, serial, state, 0);
    }
}

function dispatchEsp32Telemetry(dev, serial, state, attempt = 0) {
    if (attempt === 0 && pendingEsp32Retries.has(serial)) {
        clearTimeout(pendingEsp32Retries.get(serial));
        pendingEsp32Retries.delete(serial);
    }

    try {
        const http = require('http');
        const crypto = require('crypto');
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const bodyData = JSON.stringify({
            cmd: 'send_telemetry',
            serial: serial,
            params: {
                temp_celsius: state.temp_celsius,
                humidity_percent: state.humidity_percent,
                battery_mv: state.battery_mv
            }
        });

        const postData = 'plain=' + encodeURIComponent(bodyData);
        const headers = {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
            'X-Timestamp': timestamp
        };

        if (dev.api_key) {
            headers['X-ESP-API-Key'] = dev.api_key;
            headers['X-Signature'] = crypto.createHmac('sha256', dev.api_key).update(`${timestamp}.${bodyData}`).digest('hex');
        }

        let handled = false;
        const scheduleRetry = (reason) => {
            if (handled) return;
            handled = true;
            if (attempt < 3) {
                const delayMs = Math.min(16000, 2000 * Math.pow(2, attempt));
                if (log) log('info', `[mqtt-commands] Telemetry push for ${serial} failed (${reason}). Scheduling retry #${attempt + 1} in ${delayMs / 1000}s`);
                const timer = setTimeout(() => {
                    pendingEsp32Retries.delete(serial);
                    const latestState = emulatedStates.get(serial) || state;
                    dispatchEsp32Telemetry(dev, serial, latestState, attempt + 1);
                }, delayMs);
                pendingEsp32Retries.set(serial, timer);
            } else {
                pendingEsp32Retries.delete(serial);
                if (log) log('warn', `[mqtt-commands] Failed to deliver telemetry to ESP32 for ${serial} after 4 attempts (${reason})`);
            }
        };

        const req = http.request({
            hostname: dev.esp32_ip,
            port: dev.esp32_port || 80,
            path: '/api/cmd',
            method: 'POST',
            headers,
            timeout: 5000
        }, (res) => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
                handled = true;
                pendingEsp32Retries.delete(serial);
                if (log) log('info', `[mqtt-commands] Triggered telemetry push for emulated ${serial} via ESP32 ${dev.esp32_ip} (HTTP ${res.statusCode})`);
            } else {
                scheduleRetry(`HTTP ${res.statusCode}`);
            }
        });

        req.on('timeout', () => {
            req.destroy();
            scheduleRetry('timeout');
        });

        req.on('error', (err) => {
            scheduleRetry(err.message);
        });

        req.write(postData);
        req.end();
    } catch (err) {
        if (log) log('error', `[mqtt-commands] Error dispatching emulated telemetry: ${err.message}`);
    }
}

function getEmulatedState(serial) {
    return emulatedStates.get(serial) || null;
}

function _pub(topic, value) {
    if (mqttClient) {
        mqttClient.publish(topic, String(value), { retain: true, qos: 0 });
    }
}

module.exports = {
    init,
    getEmulatedState
};
