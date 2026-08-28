/**
 * @file api/routes/devices.js
 * @brief REST routes managing physical hardware devices (Bridges, Wall Thermostats, Valves).
 * 
 * Implements endpoints to retrieve device registration lists, perform device pairing
 * associations, update child lock states, configure temperature offsets, and handle
 * device deletions.
 */

const express = require('express');
const db = require('../../lib/db');
const authMiddleware = require('../middleware/auth');
const homeAccessMiddleware = require('../middleware/home-access');
const commandApi = require('../../lib/command-api');
const { getLogger } = require('../../lib/logger');
const { mapDevice } = require('../../lib/mappers');

const router = express.Router();
const _log = getLogger('devices-api');

router.use(authMiddleware);
router.use(homeAccessMiddleware);

async function checkConfigReadonly(homeId) {
    const pool = db.getPool();
    const [homes] = await pool.execute('SELECT zone_config_readonly, dev_bypass FROM homes WHERE id = ?', [homeId]);
    if (homes.length === 0) return { isReadOnly: false, devBypass: false };
    const config = require('../../lib/config');
    const isReadOnly = homes[0].zone_config_readonly === null ? config.zoneConfigReadonly : Boolean(homes[0].zone_config_readonly);
    const devBypass = Boolean(homes[0].dev_bypass);
    return { isReadOnly, devBypass };
}
const checkZoneConfigReadonly = checkConfigReadonly;

async function verifyDeviceHome(req, deviceId) {
    const pool = db.getPool();
    const [rows] = await pool.execute('SELECT home_id FROM devices WHERE serial_no = ?', [deviceId]);
    if (rows.length === 0) {
        const err = new Error('Device not found');
        err.statusCode = 404;
        throw err;
    }
    const homeId = rows[0].home_id;
    if (req.params.homeId) {
        const pathHomeId = parseInt(req.params.homeId, 10);
        if (pathHomeId !== homeId) {
            const err = new Error('Device not found');
            err.statusCode = 404;
            throw err;
        }
    }
    if (req.user && req.user.homes && !req.user.homes.includes(homeId)) {
        const err = new Error('Forbidden');
        err.statusCode = 403;
        throw err;
    }
    return homeId;
}

// GET /api/v2/homes/{homeId}/devices OR /api/v2/devices
async function getDeviceList(req, res) {
    try {
        let homeId = req.params.homeId;
        if (!homeId) {
            if (req.user && req.user.homeId) {
                homeId = req.user.homeId;
            } else if (req.user && req.user.homes && req.user.homes.length > 0) {
                const pool = db.getPool();
                const placeholders = req.user.homes.map(() => '?').join(',');
                const [devices] = await pool.execute(`SELECT * FROM devices WHERE home_id IN (${placeholders})`, req.user.homes);
                return res.json(devices.map(mapDevice));
            } else {
                return res.json([]);
            }
        }

        const parsedHomeId = parseInt(homeId, 10);
        if (req.user && req.user.homes && !req.user.homes.includes(parsedHomeId)) {
            return res.status(403).json({ error: 'forbidden' });
        }
        const devices = await db.getDevicesForHome(parsedHomeId);
        res.json(devices.map(mapDevice));
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
}

async function getDevice(req, res) {
    try {
        const { deviceId } = req.params;
        const homeId = await verifyDeviceHome(req, deviceId);
        const dev = await db.getDeviceByFullSerial(deviceId);
        if (!dev || dev.home_id !== homeId) return res.status(404).json({ error: 'Device not found' });
        res.json(mapDevice(dev));
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message.toLowerCase() });
        res.status(500).json({ error: 'internal_error' });
    }
}

async function getTemperatureOffset(req, res) {
    try {
        const { deviceId } = req.params;
        const homeId = await verifyDeviceHome(req, deviceId);
        const pool = db.getPool();
        const [devices] = await pool.execute('SELECT field_0140 FROM devices WHERE serial_no = ? AND home_id = ?', [deviceId, homeId]);
        if (devices.length === 0) return res.status(404).json({ error: 'Device not found' });

        const val = parseFloat(devices[0].field_0140 || 0);
        const fahr = val * 1.8;
        res.setHeader('Content-Type', 'application/json');
        res.send(`{"celsius":${val.toFixed(1)},"fahrenheit":${fahr.toFixed(1)}}`);
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message.toLowerCase() });
        res.status(500).json({ error: 'internal_error' });
    }
}

async function setTemperatureOffset(req, res) {
    try {
        const { deviceId } = req.params;
        const homeId = await verifyDeviceHome(req, deviceId);
        const { isReadOnly, devBypass } = await checkConfigReadonly(homeId);
        if (isReadOnly && !devBypass) {
            return res.status(403).json({ error: 'config_readonly', message: 'Configuration is read-only' });
        }
        const celsius = parseFloat(req.body.celsius ?? 0.0);
        const pool = db.getPool();

        await pool.execute('UPDATE devices SET field_0140 = ? WHERE serial_no = ? AND home_id = ?', [celsius, deviceId, homeId]);

        await commandApi.pushConfigRefresh(deviceId).catch(err => {
            _log('warn', `Failed to push config refresh for ${deviceId}: ${err.message}`);
        });

        const fahr = celsius * 1.8;
        res.setHeader('Content-Type', 'application/json');
        res.send(`{"celsius":${celsius.toFixed(1)},"fahrenheit":${fahr.toFixed(1)}}`);
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message.toLowerCase() });
        res.status(500).json({ error: 'internal_error' });
    }
}

async function identifyDevice(req, res) {
    try {
        const { deviceId } = req.params;
        const homeId = await verifyDeviceHome(req, deviceId);
        const pool = db.getPool();
        const [existing] = await pool.execute('SELECT * FROM devices WHERE serial_no = ? AND home_id = ?', [deviceId, homeId]);
        if (existing.length === 0) return res.status(404).json({ error: 'Device not found' });

        try {
            await commandApi.pushDeviceIdentify(deviceId);
            _log('info', `[Device API] identify call pushed to ${deviceId}`);
        } catch (e) {
            _log('error', `Failed to push identify: ${e.message}`);
        }

        res.json({});
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message.toLowerCase() });
        res.status(500).json({ error: 'internal_error' });
    }
}

async function getChildLock(req, res) {
    try {
        const { deviceId } = req.params;
        const homeId = await verifyDeviceHome(req, deviceId);
        const pool = db.getPool();
        const [devices] = await pool.execute('SELECT child_lock_enabled FROM devices WHERE serial_no = ? AND home_id = ?', [deviceId, homeId]);
        if (devices.length === 0) return res.status(404).json({ error: 'Device not found' });

        res.json({ childLockEnabled: Boolean(devices[0].child_lock_enabled) });
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message.toLowerCase() });
        res.status(500).json({ error: 'internal_error' });
    }
}

async function setChildLock(req, res) {
    try {
        const { deviceId } = req.params;
        const homeId = await verifyDeviceHome(req, deviceId);
        const enabled = req.body.childLockEnabled ?? false;
        const pool = db.getPool();

        const [existing] = await pool.execute('SELECT * FROM devices WHERE serial_no = ? AND home_id = ?', [deviceId, homeId]);
        if (existing.length === 0) return res.status(404).json({ error: 'Device not found' });

        await pool.execute('UPDATE devices SET child_lock_enabled = ? WHERE serial_no = ? AND home_id = ?', [enabled ? 1 : 0, deviceId, homeId]);

        await commandApi.pushDeviceLock(deviceId, enabled).catch(err => {
            _log('warn', `Failed to push child lock for ${deviceId}: ${err.message}`);
        });

        res.json({ childLockEnabled: Boolean(enabled) });
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message.toLowerCase() });
        res.status(500).json({ error: 'internal_error' });
    }
}

async function setOrientation(req, res) {
    try {
        const { deviceId } = req.params;
        const homeId = await verifyDeviceHome(req, deviceId);
        const { isReadOnly, devBypass } = await checkConfigReadonly(homeId);
        if (isReadOnly && !devBypass) {
            return res.status(403).json({ error: 'config_readonly', message: 'Configuration is read-only' });
        }
        const rawOrient = req.body.orientation || 'VERTICAL';
        const orientation = db.mapOrientation(rawOrient);
        const pool = db.getPool();

        const [existing] = await pool.execute('SELECT * FROM devices WHERE serial_no = ? AND home_id = ?', [deviceId, homeId]);
        if (existing.length === 0) return res.status(404).json({ error: 'Device not found' });

        await pool.execute('UPDATE devices SET field_0149 = ? WHERE serial_no = ? AND home_id = ?', [orientation, deviceId, homeId]);

        await commandApi.pushConfigRefresh(deviceId).catch(err => {
            _log('warn', `Failed to push config refresh for ${deviceId}: ${err.message}`);
        });

        const mqttPublisher = require('../../lib/mqtt-publisher');
        await mqttPublisher.publishOrientation(deviceId, orientation).catch(err => {
            _log('warn', `Failed to publish orientation to MQTT for ${deviceId}: ${err.message}`);
        });

        res.json({ orientation });
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message.toLowerCase() });
        res.status(500).json({ error: 'internal_error' });
    }
}

async function setPairing(req, res) {
    try {
        const { deviceId } = req.params;
        const homeId = await verifyDeviceHome(req, deviceId);
        const pool = db.getPool();
        const [existing] = await pool.execute('SELECT * FROM devices WHERE serial_no = ? AND home_id = ?', [deviceId, homeId]);
        if (existing.length === 0) return res.status(404).json({ error: 'Device not found' });

        await pool.execute('UPDATE devices SET in_pairing_mode = 1 WHERE serial_no = ? AND home_id = ?', [deviceId, homeId]);

        await commandApi.pushDevicePair(deviceId, true).catch(err => {
            _log('warn', `Failed to push pairing mode for ${deviceId}: ${err.message}`);
        });

        const { blockBridge, getBridgeBlockStatus } = require('../../lib/device-manager');
        const skipBlock = req.query.skip_block === 'true' || req.body?.skip_block === true;
        let blockStatus = { active: false, remainingSeconds: 0 };

        if (!skipBlock) {
            _log('info', `[PAIRING] Isolating Bridge ${deviceId} offline for 120s to enable plaintext key push (TLV 0x12) for real devices.`);
            blockBridge(deviceId, 120000, async (expiredSerial) => {
                _log('info', `[PAIRING_TIMEOUT] Auto-disabling pairing mode after 120s for Bridge ${expiredSerial}`);
                try {
                    const p = db.getPool();
                    await p.execute('UPDATE devices SET in_pairing_mode = 0 WHERE serial_no = ?', [expiredSerial]);
                    await commandApi.pushDevicePair(expiredSerial, false).catch(() => {});
                } catch (err) {
                    _log('error', `Failed to auto-disable pairing for ${expiredSerial}: ${err.message}`);
                }
            });
            blockStatus = getBridgeBlockStatus(deviceId);
        }

        res.json({ in_pairing_mode: true, pairing_block: blockStatus });
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message.toLowerCase() });
        res.status(500).json({ error: 'internal_error' });
    }
}

async function deletePairing(req, res) {
    try {
        const { deviceId } = req.params;
        const homeId = await verifyDeviceHome(req, deviceId);
        const pool = db.getPool();
        const [existing] = await pool.execute('SELECT * FROM devices WHERE serial_no = ? AND home_id = ?', [deviceId, homeId]);
        if (existing.length === 0) return res.status(404).json({ error: 'Device not found' });

        const { unblockBridge } = require('../../lib/device-manager');
        unblockBridge(deviceId);

        await pool.execute('UPDATE devices SET in_pairing_mode = 0 WHERE serial_no = ? AND home_id = ?', [deviceId, homeId]);

        await commandApi.pushDevicePair(deviceId, false).catch(err => {
            _log('warn', `Failed to push pairing stop for ${deviceId}: ${err.message}`);
        });

        res.status(204).end();
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message.toLowerCase() });
        res.status(500).json({ error: 'internal_error' });
    }
}

async function createDevice(req, res) {
    try {
        const { homeId } = req.params;
        const { serialNo, deviceType } = req.body;
        let { zoneId } = req.body;

        if (!serialNo) {
            return res.status(400).json({ error: 'serialNo is required' });
        }

        const upperSerialNo = serialNo.toUpperCase();
        const match = /^(VA|RU|IB|BU|WR|SU|BP|BR)(\d{10})$/.exec(upperSerialNo);
        if (!match || Number(match[2]) > 4294967295) {
            return res.status(400).json({ error: 'invalid_serial', message: 'Invalid serial number format. Numeric part must be a 10-digit number <= 4294967295.' });
        }

        const prefix = match[1];
        let derivedType = deviceType;
        if (!derivedType) {
            if (prefix === 'VA') derivedType = 'VA02';
            else if (['RU', 'WR', 'SU', 'BP', 'BR'].includes(prefix)) derivedType = 'RU02';
            else if (prefix === 'IB') derivedType = 'IB01';
            else if (prefix === 'BU') derivedType = 'BU01';
        }

        const parsedHomeId = parseInt(homeId, 10);
        if (req.user && req.user.homes && !req.user.homes.includes(parsedHomeId)) {
            return res.status(403).json({ error: 'forbidden', message: 'Forbidden' });
        }

        const { isReadOnly, devBypass } = await checkZoneConfigReadonly(parsedHomeId);
        if (isReadOnly && !devBypass) {
            return res.status(403).json({ error: 'zone_config_readonly', message: 'Zone configuration is read-only' });
        }

        const pool = db.getPool();

        const [existing] = await pool.execute('SELECT COUNT(*) as c FROM devices WHERE serial_no = ?', [upperSerialNo]);
        if (existing[0].c > 0) {
            return res.status(409).json({ error: 'Device already exists' });
        }

        const isBridge = derivedType.startsWith('IB') || derivedType.startsWith('GW') || derivedType === 'BRIDGE';
        const isHeatingDev = !isBridge;

        if (isHeatingDev) {
            const [heatingDevRows] = await pool.execute(
                "SELECT COUNT(*) as c FROM devices WHERE home_id = ? AND device_type NOT LIKE 'IB%' AND device_type NOT LIKE 'GW%' AND device_type != 'BRIDGE'",
                [parsedHomeId]
            );
            if (heatingDevRows[0].c >= 25) {
                return res.status(400).json({ error: 'max_heating_devices_reached', message: 'Maximum limit of 25 heating devices reached for this home' });
            }
        }

        if (zoneId) {
            if (isHeatingDev) {
                const [roomDevRows] = await pool.execute(
                    "SELECT COUNT(*) as c FROM devices WHERE home_id = ? AND zone_id = ? AND device_type NOT LIKE 'IB%' AND device_type NOT LIKE 'GW%' AND device_type != 'BRIDGE'",
                    [parsedHomeId, zoneId]
                );
                if (roomDevRows[0].c >= 7) {
                    return res.status(400).json({ error: 'max_room_devices_reached', message: 'Maximum limit of 7 heating devices per room reached' });
                }
            }
        } else {
            zoneId = null;
        }

        await pool.execute(
            `INSERT INTO devices (
                serial_no, home_id, zone_id, current_fw_version, 
                connection_state, battery_state, device_type, in_pairing_mode, 
                cap_inside_temp_measurement, cap_identify, cap_radio_encryption_key_access, 
                field_0140, connection_state_timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                upperSerialNo, parsedHomeId, zoneId, '54.2', 
                1, 'NORMAL', derivedType, 0,
                derivedType.startsWith('IB') ? 0 : 1, 
                derivedType.startsWith('IB') ? 0 : 1, 
                1, 
                0.0, new Date().toISOString()
            ]
        );

        const [bridgeRows] = await pool.execute("SELECT serial_no FROM devices WHERE home_id = ? AND device_type LIKE 'IB%' LIMIT 1", [parsedHomeId]);
        const bridgeSerial = bridgeRows.length > 0 ? bridgeRows[0].serial_no : null;

        if (!devBypass && bridgeSerial && upperSerialNo !== bridgeSerial) {
            const commandApi = require('../../lib/command-api');
            await commandApi.pushDevicePair(bridgeSerial, true).catch(err => {
                _log('warn', `Failed to push pair enable to bridge ${bridgeSerial}: ${err.message}`);
            });
        }

        res.status(201).json({ serialNo: upperSerialNo });
    } catch (err) {
        _log('error', `Failed to create device: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
}

async function deleteDevice(req, res) {
    try {
        const { deviceId } = req.params;
        const homeId = await verifyDeviceHome(req, deviceId);
        const pool = db.getPool();

        const dev = await db.getDeviceByFullSerial(deviceId);
        if (!dev || dev.home_id !== homeId) return res.status(204).end();
        const { zone_id, device_type, is_emulated, emulated_mode } = dev;
        const isEmulated = Boolean(is_emulated || emulated_mode);

        if (device_type && (device_type.startsWith('IB') || device_type.includes('GW') || device_type.includes('BRIDGE'))) {
            return res.status(403).json({ error: 'cannot_delete_bridge', message: 'Internet Bridge devices cannot be removed.' });
        }
        if (device_type && device_type.startsWith('RU') && !isEmulated) {
            return res.status(403).json({ error: 'cannot_delete_ru', message: 'Reconfiguring or removing a RU device should be done using the Tado app (in proxy mode)' });
        }

        const { isReadOnly, devBypass } = await checkZoneConfigReadonly(homeId);
        if (isReadOnly && !devBypass) {
            return res.status(403).json({ error: 'zone_config_readonly', message: 'Zone configuration is read-only' });
        }

        if (zone_id) {
            const [zone] = await pool.execute('SELECT measuring_device_serial FROM zones WHERE id = ? AND home_id = ?', [zone_id, homeId]);
            if (zone.length > 0 && zone[0].measuring_device_serial === deviceId) {
                const [otherDevs] = await pool.execute('SELECT serial_no FROM devices WHERE zone_id = ? AND home_id = ? AND serial_no != ?', [zone_id, homeId, deviceId]);
                const newMeasurer = otherDevs.length > 0 ? otherDevs[0].serial_no : null;
                await pool.execute('UPDATE zones SET measuring_device_serial = ? WHERE id = ? AND home_id = ?', [newMeasurer, zone_id, homeId]);
            }
        }

        const [bridgeRows] = await pool.execute("SELECT serial_no FROM devices WHERE home_id = ? AND device_type LIKE 'IB%' LIMIT 1", [homeId]);
        const bridgeSerial = bridgeRows.length > 0 ? bridgeRows[0].serial_no : null;

        if (!devBypass) {
            const commandApi = require('../../lib/command-api');
            await commandApi.pushDeviceUnassociation(homeId, deviceId).catch(err => {
                _log.warn(`Failed to push un-association config to device ${deviceId}: ${err.message}`);
            });

            if (bridgeSerial) {
                await commandApi.pushDevicePair(bridgeSerial, false).catch(err => {
                    _log.warn(`Failed to push unpair to bridge ${bridgeSerial}: ${err.message}`);
                });
            }
        }

        if (isEmulated || deviceId.startsWith('RU') || deviceId.startsWith('VA')) {
            try {
                const emulatedList = await db.getAllEmulatedDevices();
                const emDev = emulatedList.find(d => d.serial_no === deviceId);
                const { sendEsp32Command } = require('../setup/emulated');
                if (typeof sendEsp32Command === 'function') {
                    if (emDev && emDev.esp32_node_id) {
                        const node = await db.getEsp32NodeById(emDev.esp32_node_id);
                        if (node && node.ip_address) {
                            await sendEsp32Command(node.ip_address, node.api_port, node.api_key, {
                                cmd: 'remove',
                                serial: deviceId
                            }).catch(e => _log.warn(`[Emulated] ESP32 remove RPC warning: ${e.message}`));
                        }
                    } else {
                        const nodes = await db.getAllEsp32Nodes();
                        for (const node of nodes) {
                            if (node && node.ip_address) {
                                await sendEsp32Command(node.ip_address, node.api_port, node.api_key, {
                                    cmd: 'remove',
                                    serial: deviceId
                                }).catch(e => _log.warn(`[Emulated] ESP32 remove RPC warning: ${e.message}`));
                            }
                        }
                    }
                }
            } catch (espErr) {
                _log.warn(`[Emulated] Warning notifying ESP32 on deletion: ${espErr.message}`);
            }

            await pool.execute('DELETE FROM emulated_devices WHERE serial_no = ?', [deviceId]);
        }
        await pool.execute('DELETE FROM devices WHERE serial_no = ? AND home_id = ?', [deviceId, homeId]);

        try {
            const mqttHaDiscovery = require('../../lib/mqtt-ha-discovery');
            if (mqttHaDiscovery && typeof mqttHaDiscovery.unpublishDevice === 'function') {
                mqttHaDiscovery.unpublishDevice(deviceId);
            }
        } catch (mqttErr) {
            _log.warn(`[devices] Warning unpublishing from HA on device delete: ${mqttErr.message}`);
        }

        if (zone_id) {
            const [counts] = await pool.execute('SELECT COUNT(*) as c FROM devices WHERE zone_id = ? AND home_id = ?', [zone_id, homeId]);
            if (counts[0].c === 0) {
                await db.purgeZone(homeId, zone_id);
            }
        }

        res.status(204).end();
    } catch (err) {
        _log.error(`Failed to delete device: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
}

async function setActuatorLimits(req, res) {
    try {
        const { deviceId } = req.params;
        const { lowSteps, highSteps, driveConstant } = req.body;
        const homeId = await verifyDeviceHome(req, deviceId);
        const pool = db.getPool();

        const [existing] = await pool.execute('SELECT * FROM devices WHERE serial_no = ? AND home_id = ?', [deviceId, homeId]);
        if (existing.length === 0) return res.status(404).json({ error: 'Device not found' });

        await commandApi.pushActuatorLimits(deviceId, { lowSteps, highSteps, driveConstant }).catch(err => {
            if (err.statusCode === 400) throw err;
            _log('warn', `Failed to push actuator limits for ${deviceId}: ${err.message}`);
        });

        const updates = [];
        const params = [];
        if (lowSteps !== undefined && lowSteps !== null) { updates.push('field_0273 = ?'); params.push(Number(lowSteps)); }
        if (highSteps !== undefined && highSteps !== null) { updates.push('field_027c = ?'); params.push(Number(highSteps)); }
        if (driveConstant !== undefined && driveConstant !== null) { updates.push('field_0280 = ?'); params.push(Number(driveConstant)); }
        
        if (updates.length > 0) {
            params.push(deviceId);
            params.push(homeId);
            await pool.execute(`UPDATE devices SET ${updates.join(', ')} WHERE serial_no = ? AND home_id = ?`, params);
        }

        const mqttHaDiscovery = require('../../lib/mqtt-ha-discovery');
        mqttHaDiscovery.publishAllDiscovery().catch(() => {});

        res.json({ success: true });
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message.toLowerCase() });
        _log('error', `Actuator limits update error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
}

async function setDisplaySettings(req, res) {
    try {
        const { deviceId } = req.params;
        const { displayBrightness, displayContrast, displayActiveTimeout, brightness, wakeSensitivity, temperatureUnit } = req.body;
        const homeId = await verifyDeviceHome(req, deviceId);
        const pool = db.getPool();

        const [existing] = await pool.execute('SELECT * FROM devices WHERE serial_no = ? AND home_id = ?', [deviceId, homeId]);
        if (existing.length === 0) return res.status(404).json({ error: 'Device not found' });

        if (brightness !== undefined || wakeSensitivity !== undefined || temperatureUnit !== undefined) {
            await commandApi.pushDisplaySettings(deviceId, { brightness, wakeSensitivity, temperatureUnit }).catch(err => {
                _log('warn', `Failed to push display settings for ${deviceId}: ${err.message}`);
            });
            return res.json({ success: true });
        }

        const updates = [];
        const params = [];
        const configFields = {};

        if (displayBrightness !== undefined && displayBrightness !== null) {
            updates.push('field_019e = ?');
            params.push(Number(displayBrightness));
            configFields['0x019e'] = Number(displayBrightness);
        }
        if (displayContrast !== undefined && displayContrast !== null) {
            updates.push('field_019d = ?');
            params.push(Number(displayContrast));
            configFields['0x019d'] = Number(displayContrast);
        }
        if (displayActiveTimeout !== undefined && displayActiveTimeout !== null) {
            updates.push('field_02b2 = ?');
            params.push(Number(displayActiveTimeout));
            configFields['0x02b2'] = Number(displayActiveTimeout);
        }

        if (updates.length > 0) {
            params.push(deviceId);
            params.push(homeId);
            await pool.execute(`UPDATE devices SET ${updates.join(', ')} WHERE serial_no = ? AND home_id = ?`, params);
            
            // Merge into config
            await db.updateDeviceConfig(deviceId, configFields);
        }

        await commandApi.pushConfigRefresh(deviceId).catch(err => {
            _log('warn', `Failed to push config refresh for ${deviceId}: ${err.message}`);
        });

        res.json({ success: true });
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message.toLowerCase() });
        _log('error', `Display settings update error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
}

async function setFriendlyName(req, res) {
    try {
        const { deviceId } = req.params;
        const friendlyName = req.body.friendlyName || null;
        const homeId = await verifyDeviceHome(req, deviceId);
        const pool = db.getPool();

        await pool.execute('UPDATE devices SET friendly_name = ? WHERE serial_no = ? AND home_id = ?', [friendlyName, deviceId, homeId]);

        const mqttHaDiscovery = require('../../lib/mqtt-ha-discovery');
        mqttHaDiscovery.publishAllDiscovery().catch(() => {});

        res.json({ friendlyName });
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message.toLowerCase() });
        _log('error', `Friendly name update error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
}

async function unassociateNeighbor(req, res) {
    try {
        const { deviceId } = req.params;
        const homeId = await verifyDeviceHome(req, deviceId);
        const { neighborIpv6 } = req.body || {};
        if (!neighborIpv6) return res.status(400).json({ error: 'neighborIpv6_required' });

        await commandApi.pushUnassociateNeighborByIp(homeId, neighborIpv6);
        res.json({ ok: true, message: `Unassociate requested for neighbor ${neighborIpv6}` });
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message.toLowerCase() });
        _log('error', `Unassociate neighbor error: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

async function triggerMount(req, res) {
    try {
        const { deviceId } = req.params;
        const homeId = await verifyDeviceHome(req, deviceId);
        const action = (req.body && req.body.action) || 'start';
        await commandApi.pushMountCalibration(deviceId, action);
        res.json({ ok: true, message: `Mount calibration ${action} sent to ${deviceId}` });
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message.toLowerCase() });
        _log('error', `Trigger mount calibration error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
}

async function triggerSelftest(req, res) {
    try {
        const { deviceId } = req.params;
        const homeId = await verifyDeviceHome(req, deviceId);
        await commandApi.pushSelftestTrigger(deviceId);
        res.json({ ok: true, message: `Selftest request sent to ${deviceId}` });
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message.toLowerCase() });
        _log('error', `Trigger selftest error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
}

async function triggerDeviceDebug(req, res) {
    try {
        const { deviceId } = req.params;
        const homeId = await verifyDeviceHome(req, deviceId);
        const body = req.body || {};
        const subpath = body.subpath || req.query.subpath || 'st';
        const params = {
            method: body.method || req.query.method,
            adr: body.adr || req.query.adr,
            fid: body.fid !== undefined ? body.fid : req.query.fid,
            len: body.len || req.query.len,
            value: body.value !== undefined ? body.value : req.query.value
        };
        const mid = await commandApi.pushDeviceDebug(deviceId, subpath, params);

        return res.json({
            ok: true,
            mid,
            pending: true,
            message: `Debug request (MID ${mid}) sent to ${deviceId}`
        });
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message.toLowerCase() });
        _log('error', `Trigger device debug error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
}

async function rebootDevice(req, res) {
    try {
        const { deviceId } = req.params;
        const homeId = await verifyDeviceHome(req, deviceId);
        await commandApi.pushDeviceReboot(deviceId);
        res.json({ ok: true, message: `Reboot command sent to ${deviceId}` });
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message.toLowerCase() });
        _log('error', `Reboot device error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
}

async function refreshRfKey(req, res) {
    try {
        const { deviceId } = req.params;
        const homeId = await verifyDeviceHome(req, deviceId);
        await commandApi.handleRfKeyRefresh(req, res, deviceId);
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message.toLowerCase() });
        _log('error', `Refresh RF key error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
}

async function refreshConfig(req, res) {
    try {
        const { deviceId } = req.params;
        const homeId = await verifyDeviceHome(req, deviceId);
        await commandApi.pushConfigRefresh(deviceId);
        res.json({ ok: true, message: `Config refresh sent to ${deviceId}` });
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message.toLowerCase() });
        _log('error', `Refresh config error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
}

async function startMemoryDump(req, res) {
    try {
        const { deviceId } = req.params;
        const homeId = await verifyDeviceHome(req, deviceId);
        const { startAdr, totalBytes, chunkSize, restart } = req.body || {};
        const memoryDumper = require('../../lib/memory-dumper');
        const status = memoryDumper.startDump(deviceId, homeId, startAdr, totalBytes, chunkSize, !!restart);
        res.json({ ok: true, status });
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message.toLowerCase() });
        _log.error(`Start memory dump error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
}

async function getMemoryDumpStatus(req, res) {
    try {
        const { deviceId } = req.params;
        await verifyDeviceHome(req, deviceId);
        const memoryDumper = require('../../lib/memory-dumper');
        const status = memoryDumper.getStatus(deviceId);
        res.json({ ok: true, status });
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message.toLowerCase() });
        _log.error(`Get memory dump status error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
}

async function cancelMemoryDump(req, res) {
    try {
        const { deviceId } = req.params;
        await verifyDeviceHome(req, deviceId);
        const memoryDumper = require('../../lib/memory-dumper');
        const result = memoryDumper.cancelDump(deviceId);
        res.json({ ok: true, result });
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message.toLowerCase() });
        _log.error(`Cancel memory dump error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
}

async function downloadMemoryDump(req, res) {
    try {
        const { deviceId } = req.params;
        await verifyDeviceHome(req, deviceId);
        const memoryDumper = require('../../lib/memory-dumper');
        const fileInfo = memoryDumper.getDumpFilePath(deviceId);
        if (!fileInfo) {
            return res.status(404).json({ error: 'no_dump_file_found' });
        }
        res.download(fileInfo.filePath, fileInfo.fileName);
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message.toLowerCase() });
        _log.error(`Download memory dump error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
}

async function setDeviceRole(req, res) {
    try {
        const { deviceId } = req.params;
        const homeId = await verifyDeviceHome(req, deviceId);
        const pool = db.getPool();

        const { isReadOnly, devBypass } = await checkZoneConfigReadonly(homeId);
        if (isReadOnly && !devBypass) {
            return res.status(403).json({ error: 'zone_config_readonly', message: 'Zone configuration is read-only' });
        }

        const dev = await db.getDeviceByFullSerial(deviceId);
        if (!dev || dev.home_id !== homeId) {
            return res.status(404).json({ error: 'Device not found' });
        }

        if (!dev.device_type || !dev.device_type.startsWith('RU')) {
            return res.status(400).json({ error: 'invalid_device_type', message: 'Role switching is only supported on RU devices' });
        }

        if (dev.is_emulated || dev.emulated_mode) {
            return res.status(400).json({ error: 'emulated_ru_role_immutable', message: 'Emulated RU devices can only be wireless sensors' });
        }

        let { role, field_015d } = req.body || {};
        let targetRole = field_015d !== undefined ? parseInt(field_015d, 10) : (typeof role === 'string' ? (role.toUpperCase() === 'WIRELESS_SENSOR' ? 200 : 71) : parseInt(role, 10));

        if (targetRole !== 71 && targetRole !== 200) {
            return res.status(400).json({ error: 'invalid_role', message: 'Role must be 71 (Wired Thermostat) or 200 (Wireless Sensor)' });
        }

        if (targetRole === 200) {
            // Changing to Wireless Sensor:
            // 1. Find circuits driven by THIS specific device before deleting
            const [driverCircuits] = await pool.execute('SELECT number FROM heating_circuits WHERE home_id = ? AND driver_serial_no = ?', [homeId, deviceId]);
            const driverCircuitNums = driverCircuits.map(c => c.number);

            if (driverCircuitNums.length > 0) {
                await pool.execute('DELETE FROM heating_circuits WHERE home_id = ? AND driver_serial_no = ?', [homeId, deviceId]);

                // 2. Only delete DHW zones bound to the circuits driven by THIS device
                const [dhwZones] = await pool.execute(
                    `SELECT id FROM zones WHERE home_id = ? AND type = 'HOT_WATER' AND heating_circuit IN (${driverCircuitNums.map(() => '?').join(',')})`,
                    [homeId, ...driverCircuitNums]
                );
                const { purgeZone } = require('../../lib/db-zones/state');
                for (const dhw of dhwZones) {
                    await purgeZone(homeId, dhw.id).catch(err => {
                        _log.warn(`Failed to purge bound DHW zone ${dhw.id}: ${err.message}`);
                    });
                }
            }

            // 3. Remove RU from all zones
            const previousZoneId = dev.zone_id;
            if (previousZoneId) {
                const [zone] = await pool.execute('SELECT measuring_device_serial FROM zones WHERE id = ? AND home_id = ?', [previousZoneId, homeId]);
                if (zone.length > 0 && zone[0].measuring_device_serial === deviceId) {
                    const [otherDevs] = await pool.execute('SELECT serial_no FROM devices WHERE zone_id = ? AND home_id = ? AND serial_no != ?', [previousZoneId, homeId, deviceId]);
                    const newMeasurer = otherDevs.length > 0 ? otherDevs[0].serial_no : null;
                    await pool.execute('UPDATE zones SET measuring_device_serial = ? WHERE id = ? AND home_id = ?', [newMeasurer, previousZoneId, homeId]);
                }
            }
            await pool.execute('UPDATE devices SET zone_id = NULL, field_015d = 200 WHERE serial_no = ? AND home_id = ?', [deviceId, homeId]);
            if (previousZoneId) {
                const [counts] = await pool.execute('SELECT COUNT(*) as c FROM devices WHERE zone_id = ? AND home_id = ?', [previousZoneId, homeId]);
                if (counts[0].c === 0) {
                    const { purgeZone } = require('../../lib/db-zones/state');
                    await purgeZone(homeId, previousZoneId).catch(err => {
                        _log.warn(`Failed to purge empty zone ${previousZoneId}: ${err.message}`);
                    });
                }
            }

            // 4. Push updated config to device and refresh home configuration
            const commandApi = require('../../lib/command-api');
            await commandApi.pushDeviceConfig(deviceId).catch(err => {
                _log.warn(`Failed to push updated config to device ${deviceId}: ${err.message}`);
            });
            if (previousZoneId) {
                await commandApi.pushZoneConfig(homeId, previousZoneId).catch(() => {});
            }
        } else {
            // Changing to Wired Thermostat:
            await pool.execute('UPDATE devices SET field_015d = 71 WHERE serial_no = ? AND home_id = ?', [deviceId, homeId]);

            // 1. Ensure a heating circuit exists with this device as driver
            const [existingCircuits] = await pool.execute('SELECT number FROM heating_circuits WHERE home_id = ? AND driver_serial_no = ?', [homeId, deviceId]);
            let circuitNumber;
            if (existingCircuits.length > 0) {
                circuitNumber = existingCircuits[0].number;
            } else {
                const [maxCircuitRows] = await pool.execute('SELECT MAX(number) as max_num FROM heating_circuits WHERE home_id = ?', [homeId]);
                circuitNumber = (maxCircuitRows[0].max_num !== null && maxCircuitRows[0].max_num !== undefined) ? maxCircuitRows[0].max_num + 1 : 1;
                await pool.execute(
                    'INSERT INTO heating_circuits (home_id, number, driver_serial_no) VALUES (?, ?, ?)',
                    [homeId, circuitNumber, deviceId]
                );
            }

            // 2. Optionally create Hot Water (DHW) zone if requested
            const { createDhwZone } = req.body || {};
            if (createDhwZone) {
                const [existingDhw] = await pool.execute("SELECT id FROM zones WHERE home_id = ? AND type = 'HOT_WATER'", [homeId]);
                if (existingDhw.length === 0) {
                    const [zoneRows] = await pool.execute('SELECT id FROM zones WHERE home_id = ?', [homeId]);
                    const existingIds = zoneRows.map(r => r.id);
                    let dhwZoneId = 0;
                    if (existingIds.includes(dhwZoneId)) {
                        dhwZoneId = 1;
                        while (existingIds.includes(dhwZoneId)) {
                            dhwZoneId++;
                        }
                    }

                    const [maxOrderRows] = await pool.execute('SELECT MAX(display_order) as max_order FROM zones WHERE home_id = ?', [homeId]);
                    const nextOrder = (maxOrderRows[0].max_order !== null) ? maxOrderRows[0].max_order + 1 : 0;
                    const now = new Date().toISOString();

                    await pool.execute(
                        `INSERT INTO zones (
                            id, home_id, name, type, date_created, open_window_enabled, open_window_timeout, 
                            dazzle_enabled, early_start_enabled, min_temp, max_temp, step_temp, 
                            default_overlay_type, default_overlay_duration, heating_circuit, display_order
                        ) VALUES (?, ?, 'Hot Water', 'HOT_WATER', ?, 1, 900, 1, 0, 30.0, 65.0, 1.0, 'MANUAL', null, ?, ?)`,
                        [dhwZoneId, homeId, now, circuitNumber, nextOrder]
                    );
                    await pool.execute('UPDATE homes SET zones_count = (SELECT COUNT(*) FROM zones WHERE home_id = ?) WHERE id = ?', [homeId, homeId]);
                }
            }

            const commandApi = require('../../lib/command-api');
            await commandApi.pushDeviceConfig(deviceId).catch(err => {
                _log.warn(`Failed to push updated config to device ${deviceId}: ${err.message}`);
            });
            const [ibDevs] = await pool.execute("SELECT serial_no FROM devices WHERE home_id = ? AND device_type LIKE 'IB%' LIMIT 1", [homeId]);
            if (ibDevs.length > 0) {
                await commandApi.pushConfigRefresh(ibDevs[0].serial_no).catch(() => {});
            }
        }

        const updatedDev = await db.getDeviceByFullSerial(deviceId);
        res.json(mapDevice(updatedDev));
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message.toLowerCase() });
        _log.error(`Set device role error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
}

router.get('/:homeId/devices', getDeviceList);
router.get('/:homeId/deviceList', getDeviceList);
router.post('/:homeId/devices', createDevice);
router.get('/:homeId/devices/:deviceId', getDevice);
router.delete('/:homeId/devices/:deviceId', deleteDevice);
router.get('/:homeId/devices/:deviceId/temperatureOffset', getTemperatureOffset);
router.put('/:homeId/devices/:deviceId/temperatureOffset', setTemperatureOffset);
router.put('/:homeId/devices/:deviceId/role', setDeviceRole);
router.put('/:homeId/tanoclo/devices/:deviceId/role', setDeviceRole);
router.post('/:homeId/devices/:deviceId/identify', identifyDevice);
router.put('/:homeId/devices/:deviceId/childLock', setChildLock);
router.post('/:homeId/devices/:deviceId/orientation', setOrientation);
router.post('/:homeId/devices/:deviceId/pairing', setPairing);
router.delete('/:homeId/devices/:deviceId/pairing', deletePairing);
router.put('/:homeId/devices/:deviceId/actuatorLimits', setActuatorLimits);
router.put('/:homeId/devices/:deviceId/displaySettings', setDisplaySettings);
router.put('/:homeId/tanoclo/devices/:deviceId/friendlyName', setFriendlyName);
router.post('/:homeId/devices/:deviceId/unassociate-neighbor', unassociateNeighbor);
router.post('/:homeId/devices/:deviceId/mount', triggerMount);
router.post('/:homeId/devices/:deviceId/selftest', triggerSelftest);
router.post('/:homeId/devices/:deviceId/debug', triggerDeviceDebug);
router.post('/:homeId/devices/:deviceId/debug/dump/start', startMemoryDump);
router.get('/:homeId/devices/:deviceId/debug/dump/status', getMemoryDumpStatus);
router.post('/:homeId/devices/:deviceId/debug/dump/cancel', cancelMemoryDump);
router.get('/:homeId/devices/:deviceId/debug/dump/download', downloadMemoryDump);
router.post('/:homeId/devices/:deviceId/reboot', rebootDevice);
router.post('/:homeId/devices/:deviceId/rfkey/refresh', refreshRfKey);
router.post('/:homeId/devices/:deviceId/config/refresh', refreshConfig);

router.get('/:deviceId', getDevice);
router.delete('/:deviceId', deleteDevice);
router.get('/:deviceId/temperatureOffset', getTemperatureOffset);
router.put('/:deviceId/temperatureOffset', setTemperatureOffset);
router.put('/:deviceId/role', setDeviceRole);
router.put('/tanoclo/devices/:deviceId/role', setDeviceRole);
router.post('/:deviceId/identify', identifyDevice);
router.get('/:deviceId/childLock', getChildLock);
router.put('/:deviceId/childLock', setChildLock);
router.post('/:deviceId/orientation', setOrientation);
router.post('/:deviceId/pairing', setPairing);
router.delete('/:deviceId/pairing', deletePairing);
router.put('/:deviceId/actuatorLimits', setActuatorLimits);
router.put('/:deviceId/displaySettings', setDisplaySettings);
router.put('/tanoclo/devices/:deviceId/friendlyName', setFriendlyName);
router.post('/:deviceId/unassociate-neighbor', unassociateNeighbor);
router.post('/:deviceId/mount', triggerMount);
router.post('/:deviceId/selftest', triggerSelftest);
router.post('/:deviceId/debug', triggerDeviceDebug);
router.post('/:deviceId/reboot', rebootDevice);
router.post('/:deviceId/rfkey/refresh', refreshRfKey);
router.post('/:deviceId/config/refresh', refreshConfig);

module.exports = router;
