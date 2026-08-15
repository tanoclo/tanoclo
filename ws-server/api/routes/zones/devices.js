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

        // Check if zone now has 0 devices left
        const [counts] = await pool.execute('SELECT COUNT(*) as c FROM devices WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
        if (counts[0].c === 0) {
            await db.purgeZone(homeId, zoneId);
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

module.exports = router;
