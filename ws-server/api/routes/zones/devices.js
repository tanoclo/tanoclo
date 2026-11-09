/**
 * @file api/routes/zones/devices.js
 * @brief Endpoints managing associations between zones and physical devices.
 * 
 * Exposes routes to assign/re-assign physical smart devices (valves, wall thermostats)
 * to specific heating/hot-water zones, and handle device unlinking.
 */

const express = require('express');
const db = require('../../../lib/db');
const { getLogger } = require('../../../lib/logger');
const commandApi = require('../../../lib/command-api');
const { mapDevice } = require('../../../lib/mappers');
const { parseUtcDate, getLocalParts, parseLocalTimeInTimezone, getDayBoundsInTimezone } = require('../../../lib/utils');
const {
    checkZoneConfigReadonly,
    formatDate,
    normalizeSetting,
    getHomeTimezone,
    getTimetableIdFromType,
    getTimetableTypeFromId,
    formatHomeLocalTime,
    formatTimezoneOffset,
    parseHomeLocalTime,
    getZoneDetails
} = require('./helpers');

const { assignDeviceToZone } = require('./base');

const router = express.Router();
const _log = getLogger('zones-api');

router.post('/:homeId/zones/:zoneId/devices', async (req, res) => {
    const { homeId, zoneId } = req.params;
    const { serialNo } = req.body;
    if (!serialNo) return res.status(400).json({ error: 'Missing serialNo' });
    return assignDeviceToZone(req, res, homeId, zoneId, serialNo);
});

// PUT /api/v2/homes/{homeId}/zones/{zoneId}/devices/{deviceId}
router.put('/:homeId/zones/:zoneId/devices/:deviceId', async (req, res) => {
    const { homeId, zoneId, deviceId } = req.params;
    return assignDeviceToZone(req, res, homeId, zoneId, deviceId);
});

// DELETE /api/v2/homes/{homeId}/zones/{zoneId}/devices/{deviceId}
router.delete('/:homeId/zones/:zoneId/devices/:deviceId', async (req, res) => {
    try {
        const { homeId, zoneId, deviceId } = req.params;

        const { isReadOnly, devBypass } = await checkZoneConfigReadonly(homeId);
        if (isReadOnly && !devBypass) {
            return res.status(403).json({ error: 'zone_config_readonly', message: 'Zone configuration is read-only' });
        }

        const pool = db.getPool();

        // Check if it was the measuring device for this zone
        const [zone] = await pool.execute('SELECT measuring_device_serial FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
        if (zone.length > 0 && zone[0].measuring_device_serial === deviceId) {
            const [otherDevs] = await pool.execute('SELECT serial_no FROM devices WHERE zone_id = ? AND home_id = ? AND serial_no != ?', [zoneId, homeId, deviceId]);
            const newMeasurer = otherDevs.length > 0 ? otherDevs[0].serial_no : null;
            await pool.execute('UPDATE zones SET measuring_device_serial = ? WHERE id = ? AND home_id = ?', [newMeasurer, zoneId, homeId]);
        }

        await pool.execute('UPDATE devices SET zone_id = NULL WHERE home_id = ? AND zone_id = ? AND serial_no = ?', [homeId, zoneId, deviceId]);
        await pool.execute('UPDATE emulated_devices SET zone_id = NULL WHERE serial_no = ?', [deviceId]).catch(() => { });

        // Check if zone now has 0 devices left
        const [counts] = await pool.execute('SELECT COUNT(*) as c FROM devices WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
        if (counts[0].c === 0) {
            await db.purgeZone(homeId, zoneId);
        } else {
            const dbUtils = require('../../../lib/db-utils');
            await dbUtils.syncZoneConfig(homeId, zoneId).catch(err => {
                _log('warn', `Failed to sync zone config after removing device: ${err.message}`);
            });
        }

        if (!devBypass) {
            const commandApi = require('../../../lib/command-api');
            const bestDevice = commandApi.findBestDeviceIdForPing(homeId);
            if (bestDevice) {
                await commandApi.pushConfigRefresh(bestDevice).catch(err => {
                    _log('warn', `Failed to push config refresh after removing device from zone: ${err.message}`);
                });
            }
        }

        res.status(204).end();
    } catch (err) {
        _log('error', `Error in DELETE device from zone: ${err.message}\n${err.stack}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/v2/homes/{homeId}/zones/{zoneId}/control/heatingCircuit
router.put('/:homeId/zones/:zoneId/control/heatingCircuit', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const circuitNumber = req.body.circuitNumber !== undefined ? req.body.circuitNumber : null;

        const pool = db.getPool();
        const [zones] = await pool.execute('SELECT heating_circuit, type FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
        if (zones.length > 0) {
            const currentCircuit = zones[0].heating_circuit;
            const currentVal = (currentCircuit !== null && currentCircuit !== undefined && currentCircuit !== '')
                ? parseInt(currentCircuit, 10)
                : null;

            let newVal = circuitNumber;
            if (newVal === 'none' || newVal === '') newVal = null;
            if (newVal !== null && newVal !== undefined) {
                newVal = parseInt(newVal, 10);
                if (isNaN(newVal)) newVal = null;
            } else {
                newVal = null;
            }

            if (currentVal === newVal) {
                _log('info', `Heating circuit for zone ${zoneId} is already set to ${newVal}, skipping update and config push.`);
                return res.redirect(303, `/api/v2/homes/${homeId}/zones/${zoneId}/control`);
            }

            if (newVal !== null) {
                const [zcRows] = await pool.execute(
                    "SELECT COUNT(*) as c FROM zones WHERE home_id = ? AND type = 'HEATING' AND heating_circuit IS NOT NULL AND id != ?",
                    [homeId, zoneId]
                );
                if (zcRows[0].c >= 10) {
                    return res.status(400).json({
                        error: 'max_zone_controller_rooms_reached',
                        message: 'Maximum limit of 10 rooms communicating with the Zone Controller reached'
                    });
                }
            }

            await pool.execute('UPDATE zones SET heating_circuit = ? WHERE id = ? AND home_id = ?', [newVal, zoneId, homeId]);
            const dbUtils = require('../../../lib/db-utils');
            await dbUtils.syncZoneConfig(homeId, zoneId).catch(err => {
                _log('warn', `Failed to sync zone config after heating circuit update: ${err.message}`);
            });
        } else {
            return res.status(404).json({ error: 'zone_not_found', message: 'Zone not found' });
        }

        const commandApi = require('../../../lib/command-api');

        // Fetch RU/Boilers in the home to push config changes (zone bindings list changed)
        const [ruDevs] = await pool.execute(
            "SELECT serial_no FROM devices WHERE home_id = ? AND (device_type LIKE 'RU%' OR device_type LIKE 'BU%')",
            [homeId]
        );
        for (const ru of ruDevs) {
            await commandApi.pushConfigRefresh(ru.serial_no).catch(err => {
                _log('warn', `Failed to push config refresh to RU ${ru.serial_no} after heating circuit update: ${err.message}`);
            });
        }

        // Fetch devices in the affected zone to push config changes (ETags/bindings changed)
        const [zoneDevs] = await pool.execute(
            "SELECT serial_no FROM devices WHERE zone_id = ? AND home_id = ?",
            [zoneId, homeId]
        );
        for (const dev of zoneDevs) {
            await commandApi.pushConfigRefresh(dev.serial_no).catch(err => {
                _log('warn', `Failed to push config refresh to device ${dev.serial_no} after heating circuit update: ${err.message}`);
            });
        }

        res.redirect(303, `/api/v2/homes/${homeId}/zones/${zoneId}/control`);
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// POST /api/v2/homes/:homeId/zones/:zoneId/virtual-sensor
router.post('/:homeId/zones/:zoneId/virtual-sensor', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const pool = db.getPool();

        const [zones] = await pool.execute('SELECT * FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
        if (zones.length === 0) {
            return res.status(404).json({ error: 'zone_not_found', message: 'Zone not found' });
        }

        const [bridgeRows] = await pool.execute(
            "SELECT serial_no, ipv6_address FROM devices WHERE home_id = ? AND (device_type LIKE 'IB%' OR device_type = 'GATEWAY' OR serial_no LIKE 'IB%') AND ipv6_address IS NOT NULL LIMIT 1",
            [homeId]
        );
        const ibIpv6 = bridgeRows.length > 0 ? bridgeRows[0].ipv6_address : null;

        const serialNo = req.body.serialNo || `IB_VS_${homeId}_${zoneId}`;
        const friendlyName = req.body.name || `Virtual Sensor Z${zoneId}`;

        await pool.execute(`
            INSERT INTO devices (
                serial_no, device_type, home_id, zone_id, current_fw_version,
                connection_state, battery_state, in_pairing_mode, connection_state_timestamp,
                ipv6_address, is_virtual_leader, friendly_name
            ) VALUES (?, 'SU02', ?, ?, '100.1', 1, 'NORMAL', 0, NOW(), ?, 1, ?)
            ON DUPLICATE KEY UPDATE 
                zone_id = VALUES(zone_id),
                ipv6_address = VALUES(ipv6_address),
                is_virtual_leader = 1,
                connection_state = 1,
                friendly_name = VALUES(friendly_name)
        `, [serialNo, homeId, zoneId, ibIpv6, friendlyName]);

        await pool.execute('UPDATE zones SET measuring_device_serial = ? WHERE id = ? AND home_id = ?', [serialNo, zoneId, homeId]);

        const dbUtils = require('../../../lib/db-utils');
        await dbUtils.syncZoneConfig(homeId, zoneId).catch(err => {
            _log('warn', `Failed to sync zone config after adding virtual sensor: ${err.message}`);
        });

        const commandApi = require('../../../lib/command-api');
        const [zoneDevs] = await pool.execute(
            'SELECT serial_no FROM devices WHERE zone_id = ? AND home_id = ? AND serial_no != ?',
            [zoneId, homeId, serialNo]
        );
        for (const dev of zoneDevs) {
            commandApi.pushConfigRefresh(dev.serial_no).catch(err => {
                _log('warn', `Failed to push config refresh to ${dev.serial_no}: ${err.message}`);
            });
        }

        const [created] = await pool.execute('SELECT * FROM devices WHERE serial_no = ? AND home_id = ?', [serialNo, homeId]);
        res.status(201).json(mapDevice(created[0]));
    } catch (err) {
        _log('error', `Error creating virtual sensor: ${err.message}\n${err.stack}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// DELETE /api/v2/homes/:homeId/zones/:zoneId/virtual-sensor
router.delete('/:homeId/zones/:zoneId/virtual-sensor', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const pool = db.getPool();

        const [zones] = await pool.execute('SELECT measuring_device_serial FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
        if (zones.length === 0) {
            return res.status(404).json({ error: 'zone_not_found', message: 'Zone not found' });
        }

        const currentLeader = zones[0].measuring_device_serial;
        const [vDevs] = await pool.execute(
            'SELECT serial_no FROM devices WHERE serial_no = ? AND is_virtual_leader = 1 AND home_id = ?',
            [currentLeader, homeId]
        );

        const [otherDevs] = await pool.execute(
            'SELECT serial_no FROM devices WHERE zone_id = ? AND home_id = ? AND (is_virtual_leader = 0 OR is_virtual_leader IS NULL)',
            [zoneId, homeId]
        );
        const fallbackMeasurer = otherDevs.length > 0 ? otherDevs[0].serial_no : null;

        await pool.execute('UPDATE zones SET measuring_device_serial = ? WHERE id = ? AND home_id = ?', [fallbackMeasurer, zoneId, homeId]);

        if (vDevs.length > 0) {
            await pool.execute('DELETE FROM devices WHERE serial_no = ? AND home_id = ?', [currentLeader, homeId]);
        }

        const dbUtils = require('../../../lib/db-utils');
        await dbUtils.syncZoneConfig(homeId, zoneId).catch(err => {
            _log('warn', `Failed to sync zone config after removing virtual sensor: ${err.message}`);
        });

        const commandApi = require('../../../lib/command-api');
        for (const dev of otherDevs) {
            commandApi.pushConfigRefresh(dev.serial_no).catch(err => {
                _log('warn', `Failed to push config refresh to ${dev.serial_no}: ${err.message}`);
            });
        }

        res.json({ success: true, newMeasuringDevice: fallbackMeasurer });
    } catch (err) {
        _log('error', `Error deleting virtual sensor: ${err.message}\n${err.stack}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/:homeId/zones/:zoneId/virtual-sensor
router.get('/:homeId/zones/:zoneId/virtual-sensor', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const pool = db.getPool();

        const [zones] = await pool.execute('SELECT measuring_device_serial FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
        if (zones.length === 0) {
            return res.status(404).json({ error: 'zone_not_found', message: 'Zone not found' });
        }

        const measuringSerial = zones[0].measuring_device_serial;
        const [devs] = await pool.execute(
            'SELECT * FROM devices WHERE serial_no = ? AND home_id = ?',
            [measuringSerial, homeId]
        );
        const dev = devs.length > 0 ? devs[0] : null;
        const isVirtual = Boolean(dev && (dev.is_virtual_leader || (dev.serial_no && dev.serial_no.startsWith('IB_VS_'))));

        const zoneCoordinator = require('../../../lib/zone-coordinator');
        const state = zoneCoordinator.getZoneState(homeId, zoneId);
        const observers = zoneCoordinator.getObservers(homeId, zoneId).map(o => ({
            deviceSerial: o.deviceSerial,
            ipv6: o.ipv6,
            udpPort: o.udpPort,
            lastSeq: o.lastSeq,
            registeredAt: o.registeredAt
        }));

        res.json({
            isVirtualLeader: isVirtual,
            measuringDeviceSerial: measuringSerial,
            device: dev ? mapDevice(dev) : null,
            state: state || null,
            observers: observers || [],
            mqttTopics: {
                cmdTemperature: `tado/tanoclo/h/${homeId}/d/${measuringSerial || `IB_VS_${homeId}_${zoneId}`}/cmd/temperature`,
                cmdHumidity: `tado/tanoclo/h/${homeId}/d/${measuringSerial || `IB_VS_${homeId}_${zoneId}`}/cmd/humidity`,
                telemetry: `tado/tanoclo/h/${homeId}/d/${measuringSerial || `IB_VS_${homeId}_${zoneId}`}/telemetry`,
                virtualTelemetry: `tado/tanoclo/virtual/${measuringSerial || `IB_VS_${homeId}_${zoneId}`}/telemetry`
            }
        });
    } catch (err) {
        _log('error', `Error fetching virtual sensor status: ${err.message}\n${err.stack}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

module.exports = router;