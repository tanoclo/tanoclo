/**
 * @file api/routes/zones/base.js
 * @brief Base routes managing home zone summaries and details.
 * 
 * Supports retrieving lists of active heating/hot-water zones, configuring zone names,
 * mapping associated sensors, and deleting zone entries.
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

const router = express.Router();
const _log = getLogger('zones-api');

router.get('/:homeId/zones', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const pool = db.getPool();

        const [zonesData] = await pool.execute('SELECT * FROM zones WHERE home_id = ? ORDER BY display_order ASC', [homeId]);
        const sortedZones = zonesData;

        const allDevices = await db.getDevicesForHome(homeId);
        const [circuits] = await pool.execute('SELECT * FROM heating_circuits WHERE home_id = ?', [homeId]);

        const zoneDevices = new Map();
        allDevices.forEach(d => {
            if (d.zone_id) {
                if (!zoneDevices.has(d.zone_id.toString())) zoneDevices.set(d.zone_id.toString(), []);
                zoneDevices.get(d.zone_id.toString()).push(d);
            }
        });

        const zones = sortedZones.map(zone => {
            let devicesInZone = (zoneDevices.get(zone.id.toString()) || []).slice();

            // Find specific driver device for this zone / circuit
            const circuit = circuits.find(c => c.number === zone.heating_circuit) || circuits[0];
            const driverSerial = (zone.type === 'HOT_WATER' && zone.measuring_device_serial)
                ? zone.measuring_device_serial
                : (circuit ? circuit.driver_serial_no : null);
            const driverDevice = allDevices.find(d => d.serial_no === driverSerial)
                || allDevices.find(d => !d.is_emulated && d.field_015d !== 200 && ['RU01', 'RU02', 'BU01'].includes(d.device_type));

            if (zone.type === 'HOT_WATER' && driverDevice) {
                if (!devicesInZone.find(d => d.serial_no === driverDevice.serial_no)) {
                    devicesInZone.push(driverDevice);
                }
            }

            let leaderAssigned = false;
            const mappedDevices = devicesInZone.map(d => {
                const mapped = mapDevice(d);
                const duties = new Set(['ZONE_UI']);

                if (driverDevice && d.serial_no === driverDevice.serial_no && zone.type === 'HEATING') duties.add('CIRCUIT_DRIVER');
                if (d.device_type === 'VA02') duties.add('ZONE_DRIVER');
                if (driverDevice && d.serial_no === driverDevice.serial_no && zone.type === 'HOT_WATER') duties.add('ZONE_DRIVER');

                let isLeader = (zone.measuring_device_serial && d.serial_no === zone.measuring_device_serial);
                if (isLeader) {
                    duties.add('ZONE_LEADER');
                    leaderAssigned = true;
                }

                mapped.duties = Array.from(duties);
                return mapped;
            });

            if (!leaderAssigned && mappedDevices.length > 0) {
                mappedDevices[0].duties.push('ZONE_LEADER');
                mappedDevices[0].duties = Array.from(new Set(mappedDevices[0].duties));
                const firstSerial = mappedDevices[0].shortSerialNo || mappedDevices[0].serialNo;
                if (firstSerial && zone.type !== 'HOT_WATER') {
                    pool.execute('UPDATE zones SET measuring_device_serial = ? WHERE id = ? AND home_id = ?', [firstSerial, zone.id, homeId]).catch(() => {});
                }
            }

            return {
                id: parseInt(zone.id, 10),
                name: zone.name,
                type: zone.type,
                dateCreated: formatDate(zone.date_created),
                deviceTypes: mappedDevices.map(m => m.deviceType),
                devices: mappedDevices,
                reportAvailable: false,
                showScheduleSetup: false,
                supportsDazzle: zone.type !== 'HOT_WATER',
                dazzleEnabled: zone.type !== 'HOT_WATER' ? Boolean(zone.dazzle_enabled) : false,
                dazzleMode: zone.type !== 'HOT_WATER' ? { supported: true, enabled: Boolean(zone.dazzle_enabled) } : { supported: false },
                openWindowDetection: zone.type !== 'HOT_WATER' ? {
                    supported: true,
                    enabled: Boolean(zone.open_window_enabled),
                    timeoutInSeconds: zone.open_window_timeout || 900,
                    temperatureDeviationLimit: zone.field_6080 !== null && zone.field_6080 !== undefined ? parseFloat(zone.field_6080) : 0.50,
                    owdNvmState: zone.field_6340 !== null && zone.field_6340 !== undefined ? parseInt(zone.field_6340, 10) : 1
                } : { supported: false },
                frostMinTemperature: zone.field_60a0 !== null && zone.field_60a0 !== undefined ? parseFloat(zone.field_60a0) : 5.00,
                temperatureBaseline: zone.field_60c0 !== null && zone.field_60c0 !== undefined ? parseFloat(zone.field_60c0) : 19.00,
                tanocloOwdEnabled: Boolean(zone.tanoclo_owd_enabled),
                tanocloOwdSource: zone.tanoclo_owd_source || 'device',
                offlineScheduleEnabled: Boolean(zone.offline_schedule_enabled),
                offlineScheduleSyncedAt: zone.offline_schedule_synced_at ? formatDate(zone.offline_schedule_synced_at) : null,
                earlyStartEnabled: Boolean(zone.early_start_enabled),
                heatingCircuit: zone.heating_circuit !== null && zone.heating_circuit !== undefined && zone.heating_circuit !== '' ? parseInt(zone.heating_circuit, 10) : null
            };
        });

        res.json(zones);
    } catch (err) {
        _log('error', err.stack);
        res.status(500).json({ error: 'internal_error' });
    }
});

// POST /api/v2/homes/{homeId}/zones
router.post('/:homeId/zones', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const { name, type, devices } = req.body;

        const { isReadOnly, devBypass } = await checkZoneConfigReadonly(homeId);
        if (isReadOnly && !devBypass) {
            return res.status(403).json({ error: 'zone_config_readonly', message: 'Zone configuration is read-only' });
        }

        if (!name || !type) {
            return res.status(400).json({ error: 'Missing name or type' });
        }

        const pool = db.getPool();
        const now = new Date().toISOString();
        const isHotWater = (type === 'HOT_WATER');

        if (!isHotWater) {
            const [heatingZoneRows] = await pool.execute("SELECT COUNT(*) as c FROM zones WHERE home_id = ? AND type = 'HEATING'", [homeId]);
            if (heatingZoneRows[0].c >= 25) {
                return res.status(400).json({ error: 'max_heating_rooms_reached', message: 'Maximum limit of 25 heating rooms reached for this home' });
            }
        }

        let defaultHeatingCircuit = null;
        if (!isHotWater) {
            const [zcRooms] = await pool.execute("SELECT COUNT(*) as c FROM zones WHERE home_id = ? AND type = 'HEATING' AND heating_circuit IS NOT NULL", [homeId]);
            if (zcRooms[0].c < 10) {
                defaultHeatingCircuit = 1;
            }
        }

        // Get max display_order to append this zone at the end
        const [maxOrderRows] = await pool.execute('SELECT MAX(display_order) as max_order FROM zones WHERE home_id = ?', [homeId]);
        const nextOrder = (maxOrderRows[0].max_order !== null) ? maxOrderRows[0].max_order + 1 : 0;

        let newZoneId;
        if (isHotWater) {
            newZoneId = 0;
        } else {
            const [zoneRows] = await pool.execute('SELECT id FROM zones WHERE home_id = ? ORDER BY id ASC', [homeId]);
            const existingIds = zoneRows.map(r => r.id);
            newZoneId = 1;
            while (existingIds.includes(newZoneId)) {
                newZoneId++;
            }
        }

        await pool.execute(
            `INSERT INTO zones (
                id, home_id, name, type, date_created, open_window_enabled, open_window_timeout, 
                dazzle_enabled, early_start_enabled, min_temp, max_temp, step_temp, 
                default_overlay_type, default_overlay_duration, heating_circuit, display_order
            ) VALUES (?, ?, ?, ?, ?, 1, 900, 1, 0, ?, ?, ?, 'MANUAL', null, ?, ?)`,
            [
                newZoneId,
                homeId, name, type, now,
                isHotWater ? 30.0 : 5.0, // min temp
                isHotWater ? 65.0 : 25.0, // max temp
                isHotWater ? 1.0 : 0.5, // step temp
                defaultHeatingCircuit,
                nextOrder
            ]
        );

        // Update zones_count in homes
        await pool.execute('UPDATE homes SET zones_count = (SELECT COUNT(*) FROM zones WHERE home_id = ?) WHERE id = ?', [homeId, homeId]);

        // Process device assignment if provided
        let assignedDevices = [];
        let devSerial = null;
        if (devices && Array.isArray(devices) && devices.length > 0 && devices[0].serialNo) {
            devSerial = devices[0].serialNo;
        } else if (req.body.serialNo) {
            devSerial = req.body.serialNo;
        }

        if (devSerial) {
            const [oldDev] = await pool.execute('SELECT zone_id FROM devices WHERE serial_no = ? AND home_id = ?', [devSerial, homeId]);
            const oldZoneId = oldDev.length > 0 ? oldDev[0].zone_id : null;

            if (oldZoneId !== null) {
                const [oldZone] = await pool.execute('SELECT measuring_device_serial FROM zones WHERE id = ? AND home_id = ?', [oldZoneId, homeId]);
                if (oldZone.length > 0 && oldZone[0].measuring_device_serial === devSerial) {
                    const [otherDevs] = await pool.execute('SELECT serial_no FROM devices WHERE zone_id = ? AND home_id = ? AND serial_no != ?', [oldZoneId, homeId, devSerial]);
                    const newMeasurer = otherDevs.length > 0 ? otherDevs[0].serial_no : null;
                    await pool.execute('UPDATE zones SET measuring_device_serial = ? WHERE id = ? AND home_id = ?', [newMeasurer, oldZoneId, homeId]);
                }
            }

            await pool.execute('UPDATE devices SET zone_id = ? WHERE serial_no = ? AND home_id = ?', [newZoneId, devSerial, homeId]);
            await pool.execute('UPDATE zones SET measuring_device_serial = ? WHERE id = ? AND home_id = ?', [devSerial, newZoneId, homeId]);

            if (oldZoneId !== null) {
                const [counts] = await pool.execute('SELECT COUNT(*) as c FROM devices WHERE zone_id = ? AND home_id = ?', [oldZoneId, homeId]);
                if (counts[0].c === 0) {
                    await db.purgeZone(homeId, oldZoneId);
                }
            }

            if (!devBypass) {
                const commandApi = require('../../../lib/command-api');
                await commandApi.pushDeviceIdentify(devSerial).catch(err => { _log('warn', `pushDeviceIdentify attempt 1 failed: ${err.message}`); });
                await new Promise(r => setTimeout(r, 400));
                await commandApi.pushDeviceIdentify(devSerial).catch(err => { _log('warn', `pushDeviceIdentify attempt 2 failed: ${err.message}`); });
                await new Promise(r => setTimeout(r, 400));
                await commandApi.pushDeviceIdentify(devSerial).catch(err => { _log('warn', `pushDeviceIdentify attempt 3 failed: ${err.message}`); });
                await new Promise(r => setTimeout(r, 400));

                const [ibDevs] = await pool.execute("SELECT serial_no FROM devices WHERE home_id = ? AND device_type LIKE 'IB%' LIMIT 1", [homeId]);
                if (ibDevs.length > 0) {
                    await commandApi.pushConfigRefresh(ibDevs[0].serial_no).catch(err => { _log('warn', `pushConfigRefresh for IB failed: ${err.message}`); });
                }
                await commandApi.pushConfigRefresh(devSerial).catch(err => {
                    _log('warn', `Failed to push config refresh after creating zone with device: ${err.message}`);
                });
            }

            // Retrieve updated device
            const [updatedDevRows] = await pool.execute('SELECT * FROM devices WHERE serial_no = ? AND home_id = ?', [devSerial, homeId]);
            if (updatedDevRows.length > 0) {
                const mappedDev = mapDevice(updatedDevRows[0]);
                mappedDev.duties = ['ZONE_UI', 'ZONE_DRIVER', 'ZONE_LEADER'];
                assignedDevices.push(mappedDev);
            }
        }

        res.status(201).json({
            id: parseInt(newZoneId, 10),
            name,
            type,
            dateCreated: formatDate(now),
            deviceTypes: assignedDevices.map(d => d.deviceType),
            devices: assignedDevices,
            reportAvailable: false,
            showScheduleSetup: false,
            supportsDazzle: !isHotWater,
            dazzleEnabled: false,
            dazzleMode: !isHotWater ? { supported: true, enabled: false } : { supported: false },
            openWindowDetection: !isHotWater ? { supported: true, enabled: true, timeoutInSeconds: 900 } : { supported: false },
            offlineScheduleEnabled: false,
            offlineScheduleSyncedAt: null,
            earlyStartEnabled: false
        });
    } catch (err) {
        _log('error', `Error creating zone: ${err.message}\n${err.stack}`);
        res.status(500).json({ error: 'internal_error' });
    }
});


// GET /api/v2/homes/{homeId}/zones/{zoneId}/capabilities
router.get('/:homeId/zones/:zoneId/capabilities', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const pool = db.getPool();
        const [zones] = await pool.execute('SELECT * FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
        if (zones.length === 0) return res.status(404).json({ error: 'Zone not found' });

        const zone = zones[0];
        const caps = {
            type: zone.type,
            temperatures: {
                celsius: {
                    min: parseFloat(parseFloat(zone.min_temp || 5.0).toFixed(1)),
                    max: parseFloat(parseFloat(zone.max_temp || 25.0).toFixed(1)),
                    step: parseFloat(parseFloat(zone.step_temp || 0.1).toFixed(1))
                },
                fahrenheit: {
                    min: parseFloat(((zone.min_temp || 5.0) * 1.8 + 32).toFixed(1)),
                    max: parseFloat(((zone.max_temp || 25.0) * 1.8 + 32).toFixed(1)),
                    step: 0.1
                }
            }
        };

        if (zone.type === 'HOT_WATER') {
            caps.canSetTemperature = true;
        }

        res.json(caps);
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/{homeId}/zones/{zoneId}/schedule/timetables

router.get('/:homeId/zones/:zoneId/measuringDevice', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const pool = db.getPool();

        const [zones] = await pool.execute('SELECT measuring_device_serial FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
        if (zones.length === 0) return res.status(404).json({ error: 'Zone not found' });

        let device;
        if (zones[0].measuring_device_serial) {
            const [devs] = await pool.execute('SELECT * FROM devices WHERE serial_no = ? AND home_id = ?', [zones[0].measuring_device_serial, homeId]);
            if (devs.length > 0) device = devs[0];
        }

        if (!device) {
            const [devs] = await pool.execute('SELECT * FROM devices WHERE zone_id = ? AND home_id = ? LIMIT 1', [zoneId, homeId]);
            if (devs.length > 0) device = devs[0];
        }

        if (device) {
            res.json(mapDevice(device));
        } else {
            res.status(404).json({ errors: [{ code: 'measureDeviceNotFound', title: 'no measuring device found' }] });
        }
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/v2/homes/{homeId}/zones/{zoneId}/measuringDevice
router.put('/:homeId/zones/:zoneId/measuringDevice', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const { isReadOnly, devBypass } = await checkZoneConfigReadonly(homeId);
        if (isReadOnly && !devBypass) {
            return res.status(403).json({ error: 'zone_config_readonly', message: 'Zone configuration is read-only' });
        }
        const { serialNo } = req.body;
        if (!serialNo) return res.status(400).json({ error: 'Missing serialNo' });

        const pool = db.getPool();

        const [devs] = await pool.execute('SELECT * FROM devices WHERE serial_no = ? AND home_id = ?', [serialNo, homeId]);
        if (devs.length === 0) return res.status(404).json({ error: 'Device not found' });

        const device = devs[0];
        await pool.execute('UPDATE zones SET measuring_device_serial = ? WHERE id = ? AND home_id = ?', [serialNo, zoneId, homeId]);

        const [zoneDevices] = await pool.execute('SELECT serial_no FROM devices WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
        for (const dev of zoneDevices) {
            commandApi.pushConfigRefresh(dev.serial_no).catch(e => _log('warn', `Refresh failed for ${dev.serial_no}: ${e.message}`));
        }

        res.json(mapDevice(device));
    } catch (err) {
        _log('error', `Update measuring device error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/{homeId}/zones/{zoneId}/control
router.get('/:homeId/zones/:zoneId/control', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const pool = db.getPool();

        const [zones] = await pool.execute('SELECT * FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
        if (zones.length === 0) return res.status(404).json({ error: 'Zone not found' });
        const zone = zones[0];

        const allDevices = await db.getDevicesForHome(homeId);
        const zoneDevices = allDevices.filter(d => d.zone_id == zoneId);

        if (zone.type === 'HOT_WATER') {
            const boiler = allDevices.find(d => ['RU01', 'RU02', 'BU01'].includes(d.device_type));
            if (boiler && !zoneDevices.find(d => d.serial_no === boiler.serial_no)) {
                zoneDevices.push(boiler);
            }
        }

        let leader = null;
        const drivers = [];
        const uis = [];
        const measuringSerial = zone.measuring_device_serial;

        zoneDevices.forEach(d => {
            const mapped = mapDevice(d);
            if ((measuringSerial && d.serial_no === measuringSerial) || (!measuringSerial && !leader)) {
                leader = mapped;
            }
            if (d.device_type === 'VA02') {
                drivers.push(mapped);
            }
            uis.push(mapped);
        });

        if (!leader && zoneDevices.length > 0) leader = mapDevice(zoneDevices[0]);

        res.json({
            type: 'HEATING',
            heatingCircuit: zone.heating_circuit ? parseInt(zone.heating_circuit, 10) : null,
            earlyStartEnabled: Boolean(zone.early_start_enabled),
            duties: {
                type: zone.type,
                leader,
                drivers,
                uis
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/{homeId}/zones/{zoneId}/dazzle
router.get('/:homeId/zones/:zoneId/dazzle', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const pool = db.getPool();
        const [zones] = await pool.execute('SELECT dazzle_enabled FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
        if (zones.length === 0) return res.status(404).json({ error: 'Zone not found' });

        res.json({ supported: true, enabled: Boolean(zones[0].dazzle_enabled) });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/v2/homes/{homeId}/zones/{zoneId}/dazzle
router.put('/:homeId/zones/:zoneId/dazzle', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const { isReadOnly, devBypass } = await checkZoneConfigReadonly(homeId);
        if (isReadOnly && !devBypass) {
            return res.status(403).json({ error: 'zone_config_readonly', message: 'Zone configuration is read-only' });
        }
        const { enabled } = req.body;
        if (enabled === undefined) return res.status(400).json({ error: 'Missing enabled' });

        const pool = db.getPool();
        await pool.execute('UPDATE zones SET dazzle_enabled = ? WHERE id = ? AND home_id = ?', [enabled ? 1 : 0, zoneId, homeId]);

        const [devices] = await pool.execute('SELECT serial_no FROM devices WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
        for (const dev of devices) {
            await commandApi.pushConfigRefresh(dev.serial_no).catch(e => _log('warn', `Refresh failed for ${dev.serial_no}: ${e.message}`));
        }

        res.json({ enabled: Boolean(enabled) });
    } catch (err) {
        _log('error', `Dazzle update error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/v2/homes/{homeId}/zones/{zoneId}/details
router.put('/:homeId/zones/:zoneId/details', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const { name, frostMinTemperature, temperatureBaseline } = req.body;
        if (!name) return res.status(400).json({ error: 'Missing name' });

        const pool = db.getPool();
        await pool.execute('UPDATE zones SET name = ? WHERE id = ? AND home_id = ?', [name, zoneId, homeId]);

        const configFields = {};
        if (frostMinTemperature !== undefined && frostMinTemperature !== null) {
            configFields['0x60a0'] = parseFloat(frostMinTemperature);
        }
        if (temperatureBaseline !== undefined && temperatureBaseline !== null) {
            configFields['0x60c0'] = parseFloat(temperatureBaseline);
        }

        if (Object.keys(configFields).length > 0) {
            await db.updateZoneConfig(homeId, zoneId, configFields);
        }

        const [devices] = await pool.execute('SELECT serial_no FROM devices WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
        for (const dev of devices) {
            await commandApi.pushConfigRefresh(dev.serial_no).catch(e => _log('warn', `Refresh failed for ${dev.serial_no}: ${e.message}`));
        }

        const details = await getZoneDetails(homeId, zoneId, pool);
        if (!details) return res.status(404).json({ error: 'Zone not found' });
        res.json(details);
    } catch (err) {
        _log('error', `Update details error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/{homeId}/zones/{zoneId}/defaultOverlay
router.get('/:homeId/zones/:zoneId/defaultOverlay', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const pool = db.getPool();

        const [zones] = await pool.execute('SELECT default_overlay_type, default_overlay_duration FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
        if (zones.length === 0) return res.status(404).json({ error: 'Zone not found' });

        const z = zones[0];
        const response = {
            terminationCondition: {
                type: z.default_overlay_type || 'MANUAL'
            }
        };

        if (response.terminationCondition.type === 'TIMER' && z.default_overlay_duration) {
            response.terminationCondition.durationInSeconds = parseInt(z.default_overlay_duration, 10);
        }

        res.json(response);
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/v2/homes/{homeId}/zones/:zoneId/defaultOverlay
router.put('/:homeId/zones/:zoneId/defaultOverlay', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const terminationCondition = req.body.terminationCondition || req.body.termination;
        if (!terminationCondition || !terminationCondition.type) return res.status(400).json({ error: 'Missing type' });

        const pool = db.getPool();
        const duration = terminationCondition.type === 'TIMER' ? (terminationCondition.durationInSeconds || 3600) : null;

        await pool.execute(
            'UPDATE zones SET default_overlay_type = ?, default_overlay_duration = ? WHERE id = ? AND home_id = ?',
            [terminationCondition.type, duration, zoneId, homeId]
        );

        res.json({
            terminationCondition: {
                type: terminationCondition.type,
                ...(duration && { durationInSeconds: duration })
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/{homeId}/zones/{zoneId}/details
router.get('/:homeId/zones/:zoneId/details', async (req, res) => {
    try {
        const details = await getZoneDetails(req.params.homeId, req.params.zoneId, db.getPool());
        if (!details) return res.status(404).json({ error: 'Zone not found' });
        res.json(details);
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

async function assignDeviceToZone(req, res, homeId, zoneId, serialNo) {
    try {
        const { isReadOnly, devBypass } = await checkZoneConfigReadonly(homeId);
        if (isReadOnly && !devBypass) {
            return res.status(403).json({ error: 'zone_config_readonly', message: 'Zone configuration is read-only' });
        }

        const pool = db.getPool();
        const [oldDev] = await pool.execute('SELECT zone_id, device_type FROM devices WHERE serial_no = ? AND home_id = ?', [serialNo, homeId]);
        if (oldDev.length === 0) {
            return res.status(404).json({ error: 'device_not_found', message: 'Device not found' });
        }
        const currentDevType = oldDev[0].device_type || 'VA02';
        const isHeatingDev = !currentDevType.startsWith('IB') && !currentDevType.startsWith('GW') && currentDevType !== 'BRIDGE';
        const oldZoneId = oldDev[0].zone_id;

        if (isHeatingDev && String(oldZoneId) !== String(zoneId)) {
            const [roomDevRows] = await pool.execute(
                "SELECT COUNT(*) as c FROM devices WHERE home_id = ? AND zone_id = ? AND device_type NOT LIKE 'IB%' AND device_type NOT LIKE 'GW%' AND device_type != 'BRIDGE'",
                [homeId, zoneId]
            );
            if (roomDevRows[0].c >= 7) {
                return res.status(400).json({ error: 'max_room_devices_reached', message: 'Maximum limit of 7 heating devices per room reached' });
            }
        }

        // If oldZoneId exists, handle measuring device update before updating the device's zone
        if (oldZoneId !== null) {
            const [oldZone] = await pool.execute('SELECT measuring_device_serial FROM zones WHERE id = ? AND home_id = ?', [oldZoneId, homeId]);
            if (oldZone.length > 0 && oldZone[0].measuring_device_serial === serialNo) {
                const [otherDevs] = await pool.execute('SELECT serial_no FROM devices WHERE zone_id = ? AND home_id = ? AND serial_no != ?', [oldZoneId, homeId, serialNo]);
                const newMeasurer = otherDevs.length > 0 ? otherDevs[0].serial_no : null;
                await pool.execute('UPDATE zones SET measuring_device_serial = ? WHERE id = ? AND home_id = ?', [newMeasurer, oldZoneId, homeId]);
            }
        }

        await pool.execute('UPDATE devices SET zone_id = ? WHERE serial_no = ? AND home_id = ?', [zoneId, serialNo, homeId]);
        await pool.execute('UPDATE emulated_devices SET zone_id = ? WHERE serial_no = ? AND home_id = ?', [zoneId, serialNo, homeId]).catch(() => {});

        // If the new zone didn't have a measuring device, set this one
        const [newZone] = await pool.execute('SELECT measuring_device_serial FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
        if (newZone.length > 0 && !newZone[0].measuring_device_serial) {
            await pool.execute('UPDATE zones SET measuring_device_serial = ? WHERE id = ? AND home_id = ?', [serialNo, zoneId, homeId]);
        }

        // If oldZoneId now has 0 devices, purge it
        if (oldZoneId !== null) {
            const [counts] = await pool.execute('SELECT COUNT(*) as c FROM devices WHERE zone_id = ? AND home_id = ?', [oldZoneId, homeId]);
            if (counts[0].c === 0) {
                await db.purgeZone(homeId, oldZoneId);
            }
        }

        if (!devBypass) {
            const commandApi = require('../../../lib/command-api');

            // Tado sends 3x identify pulses (LED blink) when moving a device
            await commandApi.pushDeviceIdentify(serialNo).catch(err => { _log('warn', `pushDeviceIdentify attempt 1 failed: ${err.message}`); });
            await new Promise(r => setTimeout(r, 400));
            await commandApi.pushDeviceIdentify(serialNo).catch(err => { _log('warn', `pushDeviceIdentify attempt 2 failed: ${err.message}`); });
            await new Promise(r => setTimeout(r, 400));
            await commandApi.pushDeviceIdentify(serialNo).catch(err => { _log('warn', `pushDeviceIdentify attempt 3 failed: ${err.message}`); });

            // Tado always pushes a config refresh to the bridge and device AFTER the blink sequence
            await new Promise(r => setTimeout(r, 400));

            const [ibDevs] = await pool.execute("SELECT serial_no FROM devices WHERE home_id = ? AND device_type LIKE 'IB%' LIMIT 1", [homeId]);
            if (ibDevs.length > 0) {
                await commandApi.pushConfigRefresh(ibDevs[0].serial_no).catch(err => { _log('warn', `pushConfigRefresh for IB failed: ${err.message}`); });
            }

            await commandApi.pushConfigRefresh(serialNo).catch(err => {
                _log('warn', `Failed to push config refresh after adding device to zone: ${err.message}`);
            });
        }

        const [devs] = await pool.execute('SELECT * FROM devices WHERE serial_no = ? AND home_id = ?', [serialNo, homeId]);
        const d = devs[0];
        res.status(201).json({
            type: d.device_type,
            device: mapDevice(d),
            zone: { discriminator: parseInt(zoneId, 10), duties: ['ZONE_UI', 'ZONE_DRIVER', 'ZONE_LEADER'] }
        });
    } catch (err) {
        _log('error', `Error in assignDeviceToZone: ${err.message}\n${err.stack}`);
        res.status(500).json({ error: 'internal_error' });
    }
}

// POST /api/v2/homes/{homeId}/zones/{zoneId}/devices

router.get('/:homeId/roomsAndDevices/rooms/:zoneId/zoneControllers', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const pool = db.getPool();
        const [devices] = await pool.execute('SELECT * FROM devices WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
        res.json(devices.map(d => ({
            deviceId: d.serial_no,
            serialNumber: d.serial_no,
            deviceType: d.device_type || 'VA02',
            capabilities: d.capabilities_json ? JSON.parse(d.capabilities_json) : ["INSIDE_TEMPERATURE_MEASUREMENT", "IDENTIFY"]
        })));
    } catch (err) {
        _log('error', `zoneControllers error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

module.exports = router;
module.exports.assignDeviceToZone = assignDeviceToZone;
