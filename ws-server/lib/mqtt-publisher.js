/**
 * @file lib/mqtt-publisher.js
 * @brief MQTT state updates publisher dispatching device states.
 */

'use strict';

const battery = require('./battery');
const geoUtils = require('./geo-utils');

let mqttClient = null;
let db = null;
let config = null;
let log = null;

const BASE_TOPIC = 'tado/tanoclo';

// Batching queue
let batchQueue = [];
let batchTimeout = null;

function init(_mqttClient, _db, _config, _log) {
    mqttClient = _mqttClient;
    db = _db;
    config = _config;
    log = _log;
}

function _batchPublish(topic, payload, opts) {
    if (!mqttClient) return;
    batchQueue.push({ topic, payload, opts });
    if (!batchTimeout) {
        batchTimeout = process.nextTick(() => {
            batchTimeout = null;
            const entries = batchQueue;
            batchQueue = [];
            for (const entry of entries) {
                mqttClient.publish(entry.topic, entry.payload, entry.opts);
            }
        });
    }
}

function _pub(topic, value) {
    if (value === undefined) return;
    const pubVal = (value === null) ? '' : String(value);
    _batchPublish(topic, pubVal, { retain: true, qos: 0 });
}

function _pubDebug(topic, value) {
    if (value === undefined) return;
    if (config && config.logLevel === 'debug') {
        const debugTopic = topic.replace(BASE_TOPIC, 'tado/tanoclo_debug');
        const pubVal = (value === null) ? '' : String(value);
        _batchPublish(debugTopic, pubVal, { retain: true, qos: 0 });
    }
}

function _pubAvailability(topic, online) {
    const payload = online ? 'online' : 'offline';
    _batchPublish(topic, payload, { retain: true, qos: 0 });
}

/**
 * Decodes STM32 RCC CSR reset reason flags.
 */
function getFriendlyResetReason(code) {
    if (code === null || code === undefined) return null;
    const val = Number(code);
    if (isNaN(val) || val === 0) return 'None';
    const parts = [];
    if (val & 1) parts.push('PIN');
    if (val & 2) parts.push('POR/PDR');
    if (val & 4) parts.push('Software');
    if (val & 8) parts.push('IWDG');
    if (val & 16) parts.push('WWDG');
    if (val & 32) parts.push('Low-Power');
    return parts.length > 0 ? parts.join('+') : 'None';
}

/**
 * Decodes Room Unit / Valve Actuator hardware error flags.
 */
function getFriendlyErrorFlags(flags) {
    if (flags === null || flags === undefined) return 'None';
    const val = Number(flags);
    if (isNaN(val) || val === 0) return 'None';
    const parts = [];
    if (val & 0x2) parts.push('Orphaned/No Route');
    if (val & 0x4) parts.push('NVM Write Fault');
    if (val & 0x8) parts.push('NVM Verification Fault');
    if (val & 0x80) parts.push('Link Loss/Offline');
    if (val & 0x800) parts.push('Motor Blocked');
    if (val & 0x1000) parts.push('Valve Travel Too Short');
    if (val & 0x2000) parts.push('Calibration Fault');
    if (val & 0x4000) parts.push('Mount/Contact Fault');
    if (val & 0x100000) parts.push('Low Battery');
    if (val & 0x200000) parts.push('Hardware Reset');
    
    const remaining = val & ~(0x2 | 0x4 | 0x8 | 0x80 | 0x800 | 0x1000 | 0x2000 | 0x4000 | 0x100000 | 0x200000);
    if (remaining > 0) {
        parts.push(`RAW_0x${remaining.toString(16).toUpperCase()}`);
    }
    return parts.length > 0 ? parts.join(', ') : 'None';
}

/**
 * Calculates valve position percentage.
 */
function calculateValvePositionPct(current, limitLow, limitHigh) {
    if (current == null || limitLow == null || limitHigh == null) return null;
    const range = limitLow - limitHigh;
    if (range === 0) return 0;
    const pct = ((limitLow - current) / range) * 100;
    return Math.round(Math.max(0, Math.min(100, pct)));
}

async function publishMobileDeviceTelemetry(homeId, deviceId, atHome, lat = null, lon = null, accuracy = null, online = true) {
    const mdTopic = `${BASE_TOPIC}/h/${homeId}/md/${deviceId}`;

    if (online) {
        _pubAvailability(`${mdTopic}/availability`, true);
        _pub(`${mdTopic}/state`, atHome ? 'home' : 'not_home');
    } else {
        // Clear topics on unlinking
        _pubAvailability(`${mdTopic}/availability`, null);
        _pub(`${mdTopic}/state`, null);
        _pub(`${mdTopic}/attributes`, null);
    }
}

/**
 * Publish entire system state from database.
 * Triggered on startup and on broker reconnect.
 */
async function publishFullState() {
    if (!db || !mqttClient) return;
    try {
        if (log) log('info', '[mqtt-publisher] Starting full state publish...');
        const pool = db.getPool();

        // 1. Fetch homes
        const [homes] = await pool.execute('SELECT * FROM homes');
        for (const home of homes) {
            await publishHomeTelemetry(home.id, home);
        }

        // 2. Fetch zones
        const [zones] = await pool.execute('SELECT * FROM zones');
        const [zoneMeasurements] = await pool.execute(`
            SELECT zm.* FROM zone_measurements zm
            INNER JOIN (
                SELECT zone_id, MAX(id) as max_id 
                FROM zone_measurements 
                GROUP BY zone_id
            ) sub ON zm.id = sub.max_id
        `);
        const [zoneOverlays] = await pool.execute('SELECT * FROM zone_overlays');
        const [circuits] = await pool.execute('SELECT * FROM heating_circuits');

        const measurementsMap = new Map(zoneMeasurements.map(m => [m.zone_id, m]));
        const overlaysMap = new Map(zoneOverlays.map(o => [o.zone_id, o]));

        // Fetch all devices to derive zone availability
        const [devices] = await pool.execute('SELECT * FROM devices');
        const devicesByZone = new Map();
        for (const dev of devices) {
            if (dev.zone_id) {
                if (!devicesByZone.has(dev.zone_id)) {
                    devicesByZone.set(dev.zone_id, []);
                }
                devicesByZone.get(dev.zone_id).push(dev);
            }
        }

        for (const zone of zones) {
            const lastMeas = measurementsMap.get(zone.id) || {};
            const overlay = overlaysMap.get(zone.id);
            
            // Publish static info
            _pub(`${BASE_TOPIC}/h/${zone.home_id}/z/${zone.id}/name`, zone.name);
            _pub(`${BASE_TOPIC}/h/${zone.home_id}/z/${zone.id}/type`, zone.type);
            _pub(`${BASE_TOPIC}/h/${zone.home_id}/z/${zone.id}/early_start`, zone.early_start_enabled === 1 ? 'ON' : 'OFF');

            if (zone.type !== 'HOT_WATER' && zone.type !== 'DHW') {
                _pub(`${BASE_TOPIC}/h/${zone.home_id}/z/${zone.id}/open_window`, zone.open_window_active === 1 ? 'ON' : 'OFF');
                _pub(`${BASE_TOPIC}/h/${zone.home_id}/z/${zone.id}/open_window_detection`, zone.open_window_enabled === 1 ? 'ON' : 'OFF');
                _pub(`${BASE_TOPIC}/h/${zone.home_id}/z/${zone.id}/open_window_source`, zone.tanoclo_owd_source || 'device');
            }

            // Publish zone measurements
            await publishZoneStateTelemetry(zone.home_id, zone.id, lastMeas, zone);
            await publishZoneTelemetry(zone.home_id, zone.id, lastMeas);

            // Publish overlay state
            if (overlay) {
                _pub(`${BASE_TOPIC}/h/${zone.home_id}/z/${zone.id}/overlay/type`, overlay.termination_type || 'MANUAL');
                _pub(`${BASE_TOPIC}/h/${zone.home_id}/z/${zone.id}/overlay/expiry`, overlay.termination_expiry || '');
            } else {
                _pub(`${BASE_TOPIC}/h/${zone.home_id}/z/${zone.id}/overlay/type`, 'SCHEDULE');
                _pub(`${BASE_TOPIC}/h/${zone.home_id}/z/${zone.id}/overlay/expiry`, '');
            }

            // Derive zone availability
            let isZoneOnline = false;
            if (zone.type === 'HOT_WATER') {
                // HOT_WATER availability is based on the circuit leader (driver_serial_no in heating_circuits)
                const homeCircuits = circuits.filter(c => c.home_id === zone.home_id);
                const leaderSerials = homeCircuits.map(c => c.driver_serial_no).filter(Boolean);
                isZoneOnline = devices.some(d => leaderSerials.includes(d.serial_no) && d.connection_state === 1);
            } else {
                const zoneDevices = devicesByZone.get(zone.id) || [];
                isZoneOnline = zoneDevices.length > 0 ? zoneDevices.some(d => d.connection_state === 1) : false;
            }
            _pubAvailability(`${BASE_TOPIC}/h/${zone.home_id}/z/${zone.id}/availability`, isZoneOnline);
        }

        // 3. Fetch devices
        const [deviceMeasurements] = await pool.execute(`
            SELECT dm.* FROM device_measurements dm
            INNER JOIN (
                SELECT device_serial, MAX(id) as max_id 
                FROM device_measurements 
                GROUP BY device_serial
            ) sub ON dm.id = sub.max_id
        `);
        const devMeasMap = new Map(deviceMeasurements.map(m => [m.device_serial, m]));

        for (const dev of devices) {
            const lastMeas = devMeasMap.get(dev.serial_no) || {};
            await publishDeviceTelemetry(dev.serial_no, dev.home_id, dev.zone_id, lastMeas, dev);
            _pubAvailability(`${BASE_TOPIC}/h/${dev.home_id}/d/${dev.serial_no}/availability`, dev.connection_state === 1);
        }

        // 4. Fetch heating circuits
        for (const c of circuits) {
            const fields = {
                '0x4000': c.field_4000,
                '0x4040': c.field_4040,
                '0x4080': c.field_4080,
                '0x2090': c.field_2090
            };
            await publishCircuitTelemetry(c.home_id, c.number, fields);
        }

        // 5. Fetch heating systems (boilers)
        const [heatingSystems] = await pool.execute('SELECT * FROM heating_systems');
        for (const hs of heatingSystems) {
            let lastConfig = {};
            try {
                lastConfig = JSON.parse(hs.last_config_json || '{}');
            } catch (e) {
                if (log) log('error', `[mqtt-publisher] Failed to parse last_config_json for home ${hs.home_id}: ${e.message}`);
            }
            const fields = {
                '0x044c': hs.field_044c,
                '0x044d': hs.field_044d,
                '0x0450': hs.field_0450,
                '0x0458': hs.field_0458,
                '0x0457': hs.field_0457,
                '0x0460': hs.field_0460,
                '0x045b': hs.field_045b,
                '0x0463': hs.field_0463,
                '0x0466': hs.field_0466,
                '0x046f': hs.field_046f,
                '0x0464': hs.field_0464,
                '0x0465': hs.field_0465,
                '0x0467': hs.field_0467,
                '0x0468': hs.field_0468,
                '0x0452': hs.field_0452,
                // Retrieve the non-column fields from last_config_json:
                '0x044e': lastConfig['0x044e'] !== undefined ? lastConfig['0x044e'] : lastConfig.ot_outside_temperature,
                '0x044f': lastConfig['0x044f'] !== undefined ? lastConfig['0x044f'] : lastConfig.ot_exhaust_temperature,
                '0x045a': lastConfig['0x045a'] !== undefined ? lastConfig['0x045a'] : lastConfig.ot_dhw_temperature
            };
            await publishHvacTelemetry(hs.home_id, fields);
        }

        // 6. Fetch mobile devices and publish state
        const [mobileDevices] = await pool.execute('SELECT * FROM mobile_devices');
        for (const md of mobileDevices) {
            await publishMobileDeviceTelemetry(md.home_id, md.id, Boolean(md.at_home), md.latitude, md.longitude, null, true);
        }

        if (log) log('info', '[mqtt-publisher] Full state publish complete.');
    } catch (err) {
        if (log) log('error', `[mqtt-publisher] Failed to publish full state: ${err.message}`);
    }
}

/**
 * Publish Zone Measurement Telemetry
 */
async function publishZoneTelemetry(homeId, zoneId, fields) {
    if (!fields) return;

    // Suppress telemetry for HOT_WATER zones
    if (db) {
        const zoneType = await db.getZoneType(homeId, zoneId).catch(() => null);
        if (zoneType === 'HOT_WATER') {
            return;
        }
    }

    const temp = fields.field_012d !== undefined ? fields.field_012d : fields['0x012d'];
    const hum = fields.field_0135 !== undefined ? fields.field_0135 : fields['0x0135'];
    const power = fields.field_40a0 !== undefined ? fields.field_40a0 : fields['0x40a0'];

    _pub(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/temperature`, temp);
    _pub(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/humidity`, hum);
    _pub(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/heating_power`, power);

    // Raw/debug topics
    _pubDebug(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/field_012d`, temp);
    _pubDebug(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/field_0135`, hum);
    _pubDebug(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/field_40a0`, power);

    // If heating power is reported, it might affect climate hvac_action
    if (power !== undefined) {
        const mode = fields.field_6240 !== undefined ? fields.field_6240 : fields['0x6240'];
        const enabled = fields.field_61e0 !== undefined ? fields.field_61e0 : fields['0x61e0'];
        
        let action = 'idle';
        if (enabled === 0) {
            action = 'off';
        } else if (Number(power) > 0) {
            action = 'heating';
        }
        _pub(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/hvac_action`, action);
    }
}

/**
 * Publish Zone State/Control Telemetry
 */
async function publishZoneStateTelemetry(homeId, zoneId, fields, zoneRow = null) {
    if (!fields) return;

    let isHotWater = false;
    if (zoneRow) {
        isHotWater = (zoneRow.type === 'HOT_WATER');
    } else if (db) {
        const zoneType = await db.getZoneType(homeId, zoneId).catch(() => null);
        isHotWater = (zoneType === 'HOT_WATER');
    }

    const target = fields.field_6200 !== undefined ? fields.field_6200 : fields['0x6200'];
    const overlayVal = fields.field_6240 !== undefined ? fields.field_6240 : fields['0x6240'];
    const overlayTemp = fields.field_6280 !== undefined ? fields.field_6280 : fields['0x6280'];
    const tadoMode = fields.tado_mode;
    const presenceVal = fields.field_6160 !== undefined ? fields.field_6160 : fields['0x6160'];
    const enabled = fields.field_61e0 !== undefined ? fields.field_61e0 : fields['0x61e0'];
    const openWindow = fields.open_window_detected !== undefined ? fields.open_window_detected : fields.open_window_active;

    _pub(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/target_temperature`, target);
    _pub(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/tado_mode`, tadoMode);
    
    if (presenceVal !== undefined) {
        _pub(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/home_away`, Number(presenceVal) === 1 ? 'HOME' : 'AWAY');
        let presetMode = Number(presenceVal) === 1 ? 'home' : 'away';
        if (db) {
            const home = await db.getHome(homeId).catch(() => null);
            if (home && !home.presence_locked) {
                presetMode = 'auto';
            }
        }
        _pub(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/preset_mode`, presetMode);
    }

    if (enabled !== undefined) {
        _pub(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/zone_enabled`, Number(enabled) === 0 ? 'OFF' : 'ON');
    }

    // Suppress open_window for HOT_WATER zones
    if (!isHotWater && openWindow !== undefined) {
        _pub(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/open_window`, Number(openWindow) === 1 ? 'ON' : 'OFF');
    }

    if (overlayVal !== undefined) {
        const overlayActive = Number(overlayVal) > 0;
        _pub(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/overlay_active`, overlayActive ? 'ON' : 'OFF');
        
        // Clear overlay temperature if inactive
        _pub(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/overlay_temperature`, overlayActive ? overlayTemp : '');

        let overlayMode = 'SCHEDULE';
        if (Number(overlayVal) === 1) overlayMode = 'TIMER';
        else if (Number(overlayVal) === 2) overlayMode = 'NEXT_BLOCK';
        else if (Number(overlayVal) === 3) overlayMode = 'MANUAL';
        _pub(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/overlay_mode`, overlayMode);

        // Publish preset_mode (overlay termination type for climate entity)
        _pub(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/preset_mode`, overlayMode);

        // Derive hvac_mode: auto (schedule), heat (overlay with power ON), off (overlay with power OFF or zone disabled)
        let hvacMode = 'auto';
        if (enabled === 0) {
            hvacMode = 'off';
        } else if (overlayActive) {
            // Check if overlay has power OFF (need DB lookup)
            let overlayPowerOff = false;
            if (db) {
                try {
                    const [ovrs] = await db.getPool().execute('SELECT setting_power FROM zone_overlays WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]).catch(() => [[]]);
                    if (ovrs && ovrs.length > 0 && ovrs[0].setting_power === 'OFF') {
                        overlayPowerOff = true;
                    }
                } catch (e) {}
            }
            hvacMode = overlayPowerOff ? 'off' : 'heat';
        }
        _pub(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/hvac_mode`, hvacMode);
    }

    // Publish overlay time remaining (in minutes)
    let remainingMinutes = 0;
    if (db) {
        try {
            const [ovrs] = await db.getPool().execute('SELECT termination_type, termination_expiry FROM zone_overlays WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]).catch(() => [[]]);
            if (ovrs && ovrs.length > 0 && ovrs[0].termination_expiry) {
                const expiryMs = new Date(ovrs[0].termination_expiry).getTime();
                if (!isNaN(expiryMs)) {
                    remainingMinutes = Math.max(0, Math.ceil((expiryMs - Date.now()) / 60000));
                }
            }
        } catch (e) {}
    }
    _pub(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/overlay_time_remaining`, remainingMinutes);

    if (zoneRow) {
        _pub(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/early_start`, zoneRow.early_start_enabled === 1 ? 'ON' : 'OFF');
    }

    if (zoneRow && zoneRow.default_overlay_duration !== undefined && zoneRow.default_overlay_duration !== null) {
        _pub(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/default_overlay_duration`, Math.round(zoneRow.default_overlay_duration / 60));
    } else if (db) {
        const [zRows] = await db.getPool().execute('SELECT default_overlay_duration FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]).catch(() => [[]]);
        if (zRows && zRows[0] && zRows[0].default_overlay_duration) {
            _pub(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/default_overlay_duration`, Math.round(zRows[0].default_overlay_duration / 60));
        }
    }

    // Publish offline schedule status for HEATING zones
    if (!isHotWater) {
        let offlineScheduleEnabled = 'OFF';
        if (zoneRow && (zoneRow.offline_schedule_enabled === 1 || zoneRow.offline_schedule_enabled === true)) {
            offlineScheduleEnabled = 'ON';
        } else if (db && !zoneRow) {
            const [rows] = await db.getPool().execute('SELECT offline_schedule_enabled FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]).catch(() => [[]]);
            if (rows && rows[0] && (rows[0].offline_schedule_enabled === 1 || rows[0].offline_schedule_enabled === true)) {
                offlineScheduleEnabled = 'ON';
            }
        }
        _pub(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/offline_schedule_enabled`, offlineScheduleEnabled);
    }

    // Raw/debug topics
    _pubDebug(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/field_6200`, target);
    _pubDebug(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/field_6240`, overlayVal);
    _pubDebug(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/field_6280`, overlayTemp);
    _pubDebug(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/field_6160`, presenceVal);
    _pubDebug(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/field_61e0`, enabled);
}

/**
 * Publish Device Telemetry
 */
async function publishDeviceTelemetry(shortSerial, homeId, zoneId, sensorFields, deviceRow = null) {
    let dev = deviceRow;
    if (!dev && db) {
        try {
            dev = await db.getDeviceBySerial(shortSerial);
        } catch (e) {
            if (log) log('error', `[mqtt-publisher] Failed to get device row for ${shortSerial}: ${e.message}`);
        }
    }

    if (dev) {
        shortSerial = dev.serial_no;
    }

    if (!homeId && dev) {
        homeId = dev.home_id;
    }

    if (sensorFields && homeId) {
        const temp = sensorFields.field_012d !== undefined ? sensorFields.field_012d : sensorFields['0x012d'];
        const auxTemp = sensorFields.field_012e !== undefined ? sensorFields.field_012e : sensorFields['0x012e'];
        const hum = sensorFields.field_0135 !== undefined ? sensorFields.field_0135 : sensorFields['0x0135'];
        const volt = sensorFields.field_0162 !== undefined ? sensorFields.field_0162 : sensorFields['0x0162'];
        const light = sensorFields.field_0136 !== undefined ? sensorFields.field_0136 : sensorFields['0x0136'];
        const otVolt = sensorFields.field_0161 !== undefined ? sensorFields.field_0161 : sensorFields['0x0161'];
        const resetReason = sensorFields.field_0160 !== undefined ? sensorFields.field_0160 : sensorFields['0x0160'];

        _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/temperature`, temp);
        _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/aux_temperature`, auxTemp);
        _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/humidity`, hum);
        
        // Only VA, RU, and SU have battery (not IB, BP, BR, WR)
        const isIBOrReceiver = dev && dev.device_type && (dev.device_type.startsWith('IB') || dev.device_type.startsWith('BP') || dev.device_type.startsWith('BR') || dev.device_type.startsWith('WR'));
        const isEmulated = Boolean(dev && (dev.is_emulated || dev.emulated_mode));
        if (!isIBOrReceiver && !isEmulated) {
            _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/battery_voltage`, volt);
            _pubDebug(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/field_0162`, volt);
            
            if (volt !== undefined && volt !== null) {
                const voltInV = (Number(volt) / 1000).toFixed(3);
                _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/battery_mv`, voltInV);
            }
            
            if (volt !== undefined && dev) {
                const calcPct = battery.getBatteryPercent(Number(volt), dev.serial_no, dev.battery_type);
                if (calcPct !== null) {
                    _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/battery_percent`, calcPct);
                }
            }
        }
        
        _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/light_level`, light);

        if (otVolt !== undefined && otVolt !== null) {
            const otVoltV = (Number(otVolt) / 1000).toFixed(3);
            _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/opentherm_voltage`, otVoltV);
        }

        if (resetReason !== undefined && resetReason !== null) {
            _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/reset_reason_raw`, resetReason);
            _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/reset_reason`, getFriendlyResetReason(resetReason));
        }

        // Raw/debug
        _pubDebug(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/field_012d`, temp);
        _pubDebug(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/field_012e`, auxTemp);
        _pubDebug(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/field_0135`, hum);
        _pubDebug(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/field_0136`, light);
    }

    if (dev && homeId) {
        const isVA = dev.device_type && dev.device_type.startsWith('VA');
        const isIB = dev.device_type && (dev.device_type.startsWith('IB') || dev.device_type.startsWith('BP') || dev.device_type.startsWith('BR') || dev.device_type.startsWith('WR'));
        const errFlags = dev.field_01a3;

        _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/connection_state`, dev.connection_state === 1 ? 'ON' : 'OFF');
        _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/is_emulated`, (dev.is_emulated || dev.emulated_mode) ? 'ON' : 'OFF');
        _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/firmware_version`, dev.current_fw_version);
        _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/device_type`, dev.device_type);

        if (errFlags !== undefined && errFlags !== null) {
            _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/error_flags_raw`, errFlags);
            _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/error_flags`, getFriendlyErrorFlags(errFlags));
        }

        // Only VA has child lock
        if (isVA) {
            _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/child_lock`, dev.child_lock_enabled === 1 ? 'ON' : 'OFF');
        }

        // Battery fields from devices table (VA and RU only)
        if (!isIB) {
            if (dev.battery_percent !== null) {
                _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/battery_percent`, dev.battery_percent);
            }
            if (dev.battery_state) {
                _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/battery_state`, dev.battery_state);
            }
        }

        // Stepper / actuator fields for VAs
        if (isVA) {
            _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/valve_position`, dev.field_0265);
            _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/actuator_active`, dev.field_028c === 1 ? 'ON' : 'OFF');
            _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/mounting_state`, dev.field_016a);

            // Display Orientation (VA02 only)
            if (dev.device_type === 'VA02') {
                _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/orientation`, dev.field_0149 || 'VERTICAL');
            }

            // Actuator Limits
            _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/actuator_limit_low`, dev.field_0273);
            _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/actuator_limit_high`, dev.field_027c);
            _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/actuator_drive_constant`, dev.field_0280);

            if (dev.field_0283 !== undefined && dev.field_0283 !== null && Number(dev.field_0283) !== 32767) {
                _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/actuator_deviation`, Number(dev.field_0283));
            }

            // Compute valve pct
            const pct = calculateValvePositionPct(dev.field_0265, dev.field_0273, dev.field_027c);
            if (pct !== null) {
                _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/valve_position_pct`, pct);
            }
        }
    }
}

/**
 * Publish Circuit Telemetry
 */
async function publishCircuitTelemetry(homeId, circuitNumber, fields) {
    if (!fields) return;

    const target = fields.field_4000 !== undefined ? fields.field_4000 : fields['0x4000'];
    const reference = fields.field_4040 !== undefined ? fields.field_4040 : fields['0x4040'];
    const demand = fields.field_4080 !== undefined ? fields.field_4080 : fields['0x4080'];

    _pub(`${BASE_TOPIC}/h/${homeId}/c/${circuitNumber}/target_temperature`, target);
    _pub(`${BASE_TOPIC}/h/${homeId}/c/${circuitNumber}/reference_temperature`, reference);
    _pub(`${BASE_TOPIC}/h/${homeId}/c/${circuitNumber}/demand_percent`, demand);
    _pubAvailability(`${BASE_TOPIC}/h/${homeId}/c/${circuitNumber}/availability`, true); // Circuit is online if bridge is connected
}

/**
 * Publish Boiler Telemetry (HVAC)
 */
async function publishHvacTelemetry(homeId, fields) {
    if (!fields) return;

    let flow = fields.field_044c !== undefined ? fields.field_044c : fields['0x044c'];
    let ret = fields.field_044d !== undefined ? fields.field_044d : fields['0x044d'];
    let setpoint = fields.field_0450 !== undefined ? fields.field_0450 : fields['0x0450'];
    const modulation = fields.field_0452 !== undefined ? fields.field_0452 : fields['0x0452'];
    const active = fields.field_0457 !== undefined ? fields.field_0457 : fields['0x0457'];
    let press = fields.field_0460 !== undefined ? fields.field_0460 : fields['0x0460'];
    let dhwTarget = fields.field_045b !== undefined ? fields.field_045b : fields['0x045b'];
    // New FIDs from RU02 walkthrough findings
    let outsideTemp = fields.field_044f !== undefined ? fields.field_044f : fields['0x044f'];
    let exhaustTemp = fields.field_044e !== undefined ? fields.field_044e : fields['0x044e'];
    let dhwMeasured = fields.field_045a !== undefined ? fields.field_045a : fields['0x045a'];
    let dhwSetpoint = fields.field_046f !== undefined ? fields.field_046f : fields['0x046f'];
    let chPumpStarts = fields.field_0464 !== undefined ? fields.field_0464 : fields['0x0464'];
    let dhwPumpStarts = fields.field_0465 !== undefined ? fields.field_0465 : fields['0x0465'];
    let chBurnerHours = fields.field_0467 !== undefined ? fields.field_0467 : fields['0x0467'];
    let dhwBurnerHours = fields.field_0468 !== undefined ? fields.field_0468 : fields['0x0468'];
    const faultFlags = fields.field_0458 !== undefined ? fields.field_0458 : fields['0x0458'];

    // Sanitize 16-bit and 32-bit sentinel values
    const sanitizeHvacValue = (v) => {
        if (v === undefined) return undefined;
        if (v === null) return null;
        const val = Number(v);
        if (val === 65535 || val === 4294967295 || val > 70000000) {
            return null;
        }
        return val;
    };

    let starts = fields.field_0463 !== undefined ? fields.field_0463 : fields['0x0463'];
    let hours = fields.field_0466 !== undefined ? fields.field_0466 : fields['0x0466'];

    starts = sanitizeHvacValue(starts);
    hours = sanitizeHvacValue(hours);
    chPumpStarts = sanitizeHvacValue(chPumpStarts);
    dhwPumpStarts = sanitizeHvacValue(dhwPumpStarts);
    chBurnerHours = sanitizeHvacValue(chBurnerHours);
    dhwBurnerHours = sanitizeHvacValue(dhwBurnerHours);

    // Fix water pressure bitmask bug: mask high 16-bits and handle sentinel
    if (press !== undefined && press !== null) {
        const rawPress = Number(press);
        if (rawPress === 65535 || rawPress === 4294967295 || rawPress === 4294901760) {
            press = null;
        } else {
            press = (rawPress & 0xFFFF) / 1000;
        }
    }

    _pub(`${BASE_TOPIC}/h/${homeId}/boiler/flow_temperature`, flow);
    _pub(`${BASE_TOPIC}/h/${homeId}/boiler/return_temperature`, ret);
    _pub(`${BASE_TOPIC}/h/${homeId}/boiler/control_setpoint`, setpoint);
    _pub(`${BASE_TOPIC}/h/${homeId}/boiler/modulation`, modulation);
    _pub(`${BASE_TOPIC}/h/${homeId}/boiler/boiler_active`, Number(active) === 1 ? 'ON' : 'OFF');
    _pub(`${BASE_TOPIC}/h/${homeId}/boiler/water_pressure_bar`, press);
    _pub(`${BASE_TOPIC}/h/${homeId}/boiler/dhw_target_temperature`, dhwTarget);
    _pub(`${BASE_TOPIC}/h/${homeId}/boiler/burner_starts`, starts);
    _pub(`${BASE_TOPIC}/h/${homeId}/boiler/burner_hours`, hours);

    // Publish new parameters
    _pub(`${BASE_TOPIC}/h/${homeId}/boiler/outside_temperature`, outsideTemp);
    _pub(`${BASE_TOPIC}/h/${homeId}/boiler/exhaust_temperature`, exhaustTemp);
    _pub(`${BASE_TOPIC}/h/${homeId}/boiler/dhw_measured_temperature`, dhwMeasured);
    _pub(`${BASE_TOPIC}/h/${homeId}/boiler/dhw_setpoint`, dhwSetpoint);
    _pub(`${BASE_TOPIC}/h/${homeId}/boiler/ch_pump_starts`, chPumpStarts);
    _pub(`${BASE_TOPIC}/h/${homeId}/boiler/dhw_pump_starts`, dhwPumpStarts);
    _pub(`${BASE_TOPIC}/h/${homeId}/boiler/ch_burner_hours`, chBurnerHours);
    _pub(`${BASE_TOPIC}/h/${homeId}/boiler/dhw_burner_hours`, dhwBurnerHours);
    _pub(`${BASE_TOPIC}/h/${homeId}/boiler/fault_flags`, faultFlags);

    _pubAvailability(`${BASE_TOPIC}/h/${homeId}/boiler/availability`, true);
}

/**
 * Publish Home Presence and Weather Telemetry
 */
async function publishHomeTelemetry(homeId, homeData = null) {
    let home = homeData;
    if (!home && db) {
        try {
            home = await db.getHome(homeId);
        } catch (e) {
            if (log) log('error', `[mqtt-publisher] Failed to get home row: ${e.message}`);
        }
    }

    if (home) {
        const presence = home.presence || 'HOME';
        const isLocked = Boolean(home.presence_locked);
        const lockSetting = !isLocked ? 'AUTO' : (presence === 'AWAY' ? 'AWAY' : 'HOME');
        const presetMode = !isLocked ? 'auto' : (presence === 'AWAY' ? 'away' : 'home');

        _pub(`${BASE_TOPIC}/h/${homeId}/presence`, presence);
        _pub(`${BASE_TOPIC}/h/${homeId}/presence_lock_setting`, lockSetting);
        _pub(`${BASE_TOPIC}/h/${homeId}/name`, home.name);
        _pubAvailability(`${BASE_TOPIC}/h/${homeId}/availability`, true);

        if (db) {
            try {
                const pool = db.getPool();
                const [zones] = await pool.execute('SELECT id FROM zones WHERE home_id = ?', [homeId]);
                for (const zone of zones) {
                    _pub(`${BASE_TOPIC}/h/${homeId}/z/${zone.id}/preset_mode`, presetMode);
                }
            } catch (e) {}
        }

        // Publish Home Assistant switch settings
        _pub(`${BASE_TOPIC}/h/${homeId}/is_proxied`, (home.is_proxied === 1 || home.is_proxied === true) ? 'ON' : 'OFF');
        _pub(`${BASE_TOPIC}/h/${homeId}/proxy_logging`, (home.proxy_logging === 1 || home.proxy_logging === true) ? 'ON' : 'OFF');
        _pub(`${BASE_TOPIC}/h/${homeId}/log_uploads_enabled`, (home.log_uploads_enabled === 1 || home.log_uploads_enabled === true) ? 'ON' : 'OFF');
        _pub(`${BASE_TOPIC}/h/${homeId}/allow_commands_in_proxy`, (home.allow_commands_in_proxy === 1 || home.allow_commands_in_proxy === true) ? 'ON' : 'OFF');
        _pub(`${BASE_TOPIC}/h/${homeId}/zone_config_readonly`, (home.zone_config_readonly === 1 || home.zone_config_readonly === true) ? 'ON' : 'OFF');
    }

    // Weather telemetry
    if (db) {
        try {
            const pool = db.getPool();
            const [rows] = await pool.execute(
                'SELECT * FROM home_weather WHERE home_id = ? ORDER BY id DESC LIMIT 1',
                [homeId]
            );
            if (rows.length > 0) {
                const w = rows[0];
                _pub(`${BASE_TOPIC}/h/${homeId}/outside_temperature`, w.outside_temp_celsius);
                _pub(`${BASE_TOPIC}/h/${homeId}/solar_intensity`, w.solar_intensity_percentage);
                _pub(`${BASE_TOPIC}/h/${homeId}/weather_state`, w.weather_state);
            }
        } catch (e) {
            if (log) log('error', `[mqtt-publisher] Failed to get weather for home ${homeId}: ${e.message}`);
        }
    }
}

/**
 * Publish Device Availability
 */
async function publishDeviceAvailability(shortSerial, online) {
    if (!db) return;
    try {
        const dev = await db.getDeviceBySerial(shortSerial);
        if (!dev) return;

        const homeId = dev.home_id;
        shortSerial = dev.serial_no;
        _pubAvailability(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/availability`, online);

        // 1. If device is in a zone, update that zone's availability
        if (dev.zone_id) {
            const zoneId = dev.zone_id;
            const zoneDevices = await db.getDevicesInZone(homeId, zoneId);
            const isZoneOnline = zoneDevices.some(d => {
                return (d.serial_no === shortSerial) ? online : (d.connection_state === 1);
            });
            _pubAvailability(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/availability`, isZoneOnline);
        }

        // 2. Also check if this device affects HOT_WATER zones in the home (based on circuit leader)
        const pool = db.getPool();
        const [hwZones] = await pool.execute('SELECT id FROM zones WHERE home_id = ? AND type = "HOT_WATER"', [homeId]);
        if (hwZones.length > 0) {
            const [circuits] = await pool.execute('SELECT driver_serial_no FROM heating_circuits WHERE home_id = ?', [homeId]);
            const leaderSerials = circuits.map(c => c.driver_serial_no).filter(Boolean);

            if (leaderSerials.includes(dev.serial_no)) {
                const [allLeaders] = await pool.query('SELECT serial_no, connection_state FROM devices WHERE serial_no IN (?)', [leaderSerials]);
                const isLeaderOnline = allLeaders.some(d => {
                    return (d.serial_no === dev.serial_no) ? online : (d.connection_state === 1);
                });
                for (const hwZone of hwZones) {
                    _pubAvailability(`${BASE_TOPIC}/h/${homeId}/z/${hwZone.id}/availability`, isLeaderOnline);
                }
            }
        }
    } catch (e) {
        if (log) log('error', `[mqtt-publisher] Failed to update availability for ${shortSerial}: ${e.message}`);
    }
}

/**
 * Publish Child Lock State
 */
async function publishChildLock(shortSerial, enabled) {
    let homeId = null;
    let isVA = false;
    if (db) {
        const dev = await db.getDeviceBySerial(shortSerial).catch(() => null);
        if (dev) {
            homeId = dev.home_id;
            isVA = dev.device_type && dev.device_type.startsWith('VA');
            shortSerial = dev.serial_no;
        }
    }
    if (homeId && isVA) {
        _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/child_lock`, enabled ? 'ON' : 'OFF');
    }
}

/**
 * Publish Orientation State
 */
async function publishOrientation(shortSerial, orientation) {
    let homeId = null;
    let isVA02 = false;
    if (db) {
        const dev = await db.getDeviceBySerial(shortSerial).catch(() => null);
        if (dev) {
            homeId = dev.home_id;
            isVA02 = dev.device_type === 'VA02';
            shortSerial = dev.serial_no;
        }
    }
    if (homeId && isVA02) {
        _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/orientation`, orientation || 'VERTICAL');
    }
}

/**
 * Publish Open Window State
 */
async function publishOpenWindow(zoneId, active) {
    if (db) {
        const [rows] = await db.getPool().execute('SELECT home_id FROM zones WHERE id = ?', [zoneId]).catch(() => [[]]);
        const homeId = rows[0]?.home_id;
        if (!homeId) return;

        const zoneType = await db.getZoneType(homeId, zoneId).catch(() => null);
        if (zoneType === 'HOT_WATER') return; // Suppress open window for HOT_WATER

        _pub(`${BASE_TOPIC}/h/${homeId}/z/${zoneId}/open_window`, active ? 'ON' : 'OFF');
    }
}

/**
 * Publish Mounting State
 */
async function publishMountingState(shortSerial, state) {
    let homeId = null;
    if (db) {
        const dev = await db.getDeviceBySerial(shortSerial).catch(() => null);
        if (dev) {
            homeId = dev.home_id;
            shortSerial = dev.serial_no;
        }
    }
    if (homeId) {
        _pub(`${BASE_TOPIC}/h/${homeId}/d/${shortSerial}/mounting_state`, state);
    }
}

module.exports = {
    init,
    publishFullState,
    publishZoneTelemetry,
    publishZoneStateTelemetry,
    publishDeviceTelemetry,
    publishCircuitTelemetry,
    publishHvacTelemetry,
    publishHomeTelemetry,
    publishDeviceAvailability,
    publishChildLock,
    publishOrientation,
    publishOpenWindow,
    publishMountingState,
    publishMobileDeviceTelemetry,
    getFriendlyResetReason,
    getFriendlyErrorFlags
};
