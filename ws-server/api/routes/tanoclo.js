/**
 * @file api/routes/tanoclo.js
 * @brief Custom server endpoints exposing raw database records, telemetry trends, and statistics.
 * 
 * Implements endpoints to retrieve raw boiler records, fetch zone measurement intervals,
 * and provide diagnostic metrics for advanced dashboard charts.
 */

const express = require('express');
const db = require('../../lib/db');
const authMiddleware = require('../middleware/auth');
const { getLogger } = require('../../lib/logger');
const { getLocalParts, parseLocalTimeInTimezone, getDayBoundsInTimezone } = require('../../lib/utils');
const battery = require('../../lib/battery');
const { getFriendlyErrorFlags } = require('../../lib/mqtt-publisher');

const router = express.Router();
const _log = getLogger('tanoclo-api');

function parseUtcDate(ts) {
    if (!ts) return new Date();
    if (typeof ts === 'string') {
        if (!ts.includes('T') && !ts.includes('Z') && !ts.includes('+')) {
            return new Date(ts.replace(' ', 'T') + 'Z');
        }
    }
    return new Date(ts);
}

function getInterpolatedValue(arr, ts, valKey, defaultVal, lastIdxObj) {
    if (!arr || arr.length === 0) return defaultVal;

    let i = lastIdxObj.idx;
    while (i < arr.length && parseUtcDate(arr[i].timestamp).getTime() < ts) {
        i++;
    }

    if (i >= arr.length) {
        const lp = arr[arr.length - 1];
        lastIdxObj.idx = arr.length - 1;
        return (lp[valKey] !== null && lp[valKey] !== undefined) ? parseFloat(lp[valKey]) : defaultVal;
    }

    if (i === 0) {
        const fp = arr[0];
        return (fp[valKey] !== null && fp[valKey] !== undefined) ? parseFloat(fp[valKey]) : defaultVal;
    }

    const p1 = arr[i - 1];
    const p2 = arr[i];

    const t1 = parseUtcDate(p1.timestamp).getTime();
    const t2 = parseUtcDate(p2.timestamp).getTime();

    const v1_raw = p1[valKey];
    const v2_raw = p2[valKey];

    const v1 = (v1_raw !== null && v1_raw !== undefined) ? parseFloat(v1_raw) : defaultVal;
    const v2 = (v2_raw !== null && v2_raw !== undefined) ? parseFloat(v2_raw) : defaultVal;

    if (t1 === t2) return v2;

    const fraction = (ts - t1) / (t2 - t1);
    lastIdxObj.idx = i - 1;
    return v1 + (v2 - v1) * fraction;
}

// Protect all routes under this namespace
router.use(authMiddleware);

async function checkZoneConfigReadonly(homeId) {
    const pool = db.getPool();
    const [homes] = await pool.execute('SELECT zone_config_readonly, dev_bypass FROM homes WHERE id = ?', [homeId]);
    if (homes.length === 0) return { isReadOnly: false, devBypass: false };
    const config = require('../../lib/config');
    const isReadOnly = homes[0].zone_config_readonly === null ? config.zoneConfigReadonly : Boolean(homes[0].zone_config_readonly);
    const devBypass = Boolean(homes[0].dev_bypass);
    return { isReadOnly, devBypass };
}

// GET /:homeId/tanoclo/boiler/raw
router.get('/:homeId/tanoclo/boiler/raw', async (req, res) => {
    try {
        const pool = db.getPool();
        const homeId = req.params.homeId;
        const [rows] = await pool.execute('SELECT * FROM heating_systems WHERE home_id = ? LIMIT 1', [homeId]);

        if (rows.length === 0) {
            return res.status(404).json({ error: 'No heating system found for this home' });
        }

        const row = rows[0];
        if (row.last_config_json) {
            if (typeof row.last_config_json === 'object' && !Buffer.isBuffer(row.last_config_json)) {
                row.last_config_decoded = row.last_config_json;
                row.last_config_json = JSON.stringify(row.last_config_json);
            } else {
                try {
                    row.last_config_decoded = JSON.parse(row.last_config_json);
                } catch (e) {
                    row.last_config_decoded = null;
                }
            }
        }
        res.json(row);
    } catch (err) {
        _log('error', `Error fetching raw boiler data: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /:homeId/tanoclo/devices/battery
router.get('/:homeId/tanoclo/devices/battery', async (req, res) => {
    try {
        const pool = db.getPool();
        const homeId = req.params.homeId;
        const [rows] = await pool.execute(
            `SELECT d.serial_no as short_serial_no, d.serial_no, d.device_type, d.zone_id, d.current_fw_version, 
             d.connection_state, 
             (CASE WHEN ed.serial_no IS NOT NULL THEN 'NORMAL' ELSE d.battery_state END) as battery_state,
             (CASE WHEN ed.serial_no IS NOT NULL THEN 100 ELSE d.battery_percent END) as battery_percent,
             d.battery_type, d.last_contact, d.ipv6_address,
             d.friendly_name,
             (CASE WHEN ed.serial_no IS NOT NULL THEN 0 ELSE COALESCE(d.field_01a3, 0) END) as error_flags,
             (CASE WHEN ed.serial_no IS NOT NULL THEN 1 ELSE 0 END) AS is_emulated
             FROM devices d
             LEFT JOIN emulated_devices ed ON d.serial_no = ed.serial_no
             WHERE d.home_id = ?`,
            [homeId]
        );
        const mapped = rows.map(r => ({
            ...r,
            error_flags: r.error_flags !== null && r.error_flags !== undefined ? parseInt(r.error_flags, 10) : 0,
            friendly_error_flags: getFriendlyErrorFlags ? getFriendlyErrorFlags(r.error_flags) : 'None'
        }));
        res.json(mapped);
    } catch (err) {
        _log('error', `Error fetching device battery data: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /:homeId/tanoclo/devices/:id/raw
router.get('/:homeId/tanoclo/devices/:id/raw', async (req, res) => {
    try {
        const pool = db.getPool();
        const homeId = req.params.homeId;
        const deviceId = req.params.id;
        const [deviceRows] = await pool.execute(
            'SELECT * FROM devices WHERE home_id = ? AND serial_no = ?',
            [homeId, deviceId]
        );

        if (deviceRows.length === 0) {
            return res.status(404).json({ error: 'Device not found' });
        }

        const device = deviceRows[0];
        if (device.last_config_json) {
            if (typeof device.last_config_json === 'object' && !Buffer.isBuffer(device.last_config_json)) {
                device.last_config_decoded = device.last_config_json;
                device.last_config_json = JSON.stringify(device.last_config_json);
            } else {
                try {
                    device.last_config_decoded = JSON.parse(device.last_config_json);
                } catch (e) {
                    device.last_config_decoded = null;
                }
            }
        }

        const [measurementRows] = await pool.execute(
            'SELECT * FROM device_measurements WHERE home_id = ? AND device_serial = ? ORDER BY id DESC LIMIT 100',
            [homeId, device.serial_no]
        );

        res.json({ device, measurements: measurementRows });
    } catch (err) {
        _log('error', `Error fetching raw device data: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /:homeId/tanoclo/zones/:id/raw
router.get('/:homeId/tanoclo/zones/:id/raw', async (req, res) => {
    try {
        const pool = db.getPool();
        const homeId = req.params.homeId;
        const zoneId = req.params.id;
        const [zoneRows] = await pool.execute(
            'SELECT * FROM zones WHERE home_id = ? AND id = ?',
            [homeId, zoneId]
        );

        if (zoneRows.length === 0) {
            return res.status(404).json({ error: 'Zone not found' });
        }

        const zone = zoneRows[0];
        if (zone.last_config_json) {
            if (typeof zone.last_config_json === 'object' && !Buffer.isBuffer(zone.last_config_json)) {
                zone.last_config_decoded = zone.last_config_json;
                zone.last_config_json = JSON.stringify(zone.last_config_json);
            } else {
                try {
                    zone.last_config_decoded = JSON.parse(zone.last_config_json);
                } catch (e) {
                    zone.last_config_decoded = null;
                }
            }
        }

        const [measurementRows] = await pool.execute(
            'SELECT * FROM zone_measurements WHERE home_id = ? AND zone_id = ? ORDER BY id DESC LIMIT 100',
            [homeId, zoneId]
        );

        res.json({ zone, measurements: measurementRows });
    } catch (err) {
        _log('error', `Error fetching raw zone data: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /:homeId/tanoclo/circuits
router.get('/:homeId/tanoclo/circuits', async (req, res) => {
    try {
        const pool = db.getPool();
        const homeId = req.params.homeId;
        const [rows] = await pool.execute(
            'SELECT * FROM heating_circuits WHERE home_id = ?',
            [homeId]
        );
        res.json(rows);
    } catch (err) {
        _log('error', `Error fetching circuits: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /:homeId/tanoclo/circuits/:id/raw
router.get('/:homeId/tanoclo/circuits/:id/raw', async (req, res) => {
    try {
        const pool = db.getPool();
        const homeId = req.params.homeId;
        const circuitNumber = req.params.id;
        const [circuitRows] = await pool.execute(
            'SELECT * FROM heating_circuits WHERE home_id = ? AND number = ?',
            [homeId, circuitNumber]
        );

        if (circuitRows.length === 0) {
            return res.status(404).json({ error: 'Circuit not found' });
        }

        const circuit = circuitRows[0];
        if (circuit.last_config_json) {
            if (typeof circuit.last_config_json === 'object' && !Buffer.isBuffer(circuit.last_config_json)) {
                circuit.last_config_decoded = circuit.last_config_json;
                circuit.last_config_json = JSON.stringify(circuit.last_config_json);
            } else {
                try {
                    circuit.last_config_decoded = JSON.parse(circuit.last_config_json);
                } catch (e) {
                    circuit.last_config_decoded = null;
                }
            }
        }

        const [measurementRows] = await pool.execute(
            'SELECT * FROM circuit_measurements WHERE home_id = ? AND circuit_number = ? ORDER BY id DESC LIMIT 100',
            [homeId, circuitNumber]
        );

        res.json({ circuit, measurements: measurementRows });
    } catch (err) {
        _log('error', `Error fetching raw circuit data: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /:homeId/tanoclo/bridge
router.get('/:homeId/tanoclo/bridge', async (req, res) => {
    try {
        const pool = db.getPool();
        const homeId = req.params.homeId;
        const [rows] = await pool.execute(
            `SELECT * FROM devices WHERE home_id = ? AND 
             (device_type = "GW" OR device_type = "BRIDGE" OR serial_no LIKE "IB%") LIMIT 1`,
            [homeId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Internet Bridge not found for this home' });
        }

        const row = rows[0];
        if (row.last_config_json) {
            try {
                row.last_config_decoded = JSON.parse(row.last_config_json);
            } catch (e) {
                row.last_config_decoded = null;
            }
        }
        res.json(row);
    } catch (err) {
        _log('error', `Error fetching bridge data: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /:homeId/tanoclo/devices/:serial/battery
router.put('/:homeId/tanoclo/devices/:serial/battery', async (req, res) => {
    try {
        const pool = db.getPool();
        const homeId = req.params.homeId;
        const serial = req.params.serial;
        const { batteryType } = req.body;

        if (!batteryType) {
            return res.status(400).json({ error: 'Missing batteryType' });
        }

        await pool.execute(
            'UPDATE devices SET battery_type = ? WHERE home_id = ? AND serial_no = ?',
            [batteryType, homeId, serial]
        );

        let batteryPercent = null;
        let batteryState = null;
        const [meas] = await pool.execute(
            'SELECT field_0162 FROM device_measurements WHERE device_serial = ? AND field_0162 IS NOT NULL AND field_0162 > 0 ORDER BY id DESC LIMIT 1',
            [serial]
        );
        if (meas.length > 0 && meas[0].field_0162) {
            batteryPercent = battery.getBatteryPercent(meas[0].field_0162, serial, batteryType);
            if (batteryPercent != null) {
                batteryState = battery.classifyBatteryState(batteryPercent);
                battery.resetBatteryGuardState(serial);

                await pool.execute(
                    'UPDATE devices SET battery_percent = ?, battery_state = ? WHERE home_id = ? AND serial_no = ?',
                    [batteryPercent, batteryState, homeId, serial]
                );
            }
        }

        res.json({ success: true, batteryType, batteryPercent, batteryState });
    } catch (err) {
        _log('error', `Error updating battery type: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /:homeId/tanoclo/zones/:zoneId/dayReport
router.get('/:homeId/tanoclo/zones/:zoneId/dayReport', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const pool = db.getPool();

        // 1. Get Timezone
        const [zones] = await pool.execute('SELECT type, date_created FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
        if (zones.length === 0) return res.status(404).json({ error: 'Zone not found' });
        const zone = zones[0];
        const zoneType = zone.type || 'HEATING';

        const tzName = await db.getHomeTimezone(homeId, zoneId);
        const momentHomeStr = getLocalParts(new Date(), tzName).dateStr;
        const date = req.query.date || momentHomeStr;

        if (zone.date_created) {
            const createdDate = getLocalParts(new Date(zone.date_created), tzName).dateStr;
            if (date < createdDate) {
                return res.status(422).json({
                    errors: [{ code: 'beforeZoneCreation', title: `zone was created at ${zone.date_created}` }]
                });
            }
        }

        const bounds = getDayBoundsInTimezone(date, tzName);
        const startOfDay = bounds.startUtc;
        const endOfDay = bounds.endUtc;
        const hoursInDay = bounds.hoursInDay;

        const startBuffer = new Date(startOfDay.getTime() - 15 * 60 * 1000);
        const endBuffer = new Date(endOfDay.getTime() + 15 * 60 * 1000);

        const startUtc = startBuffer.toISOString();
        const endUtc = endBuffer.toISOString();

        const nowMs = Date.now();
        const actualEndMs = Math.min(new Date(endUtc).getTime(), nowMs);
        const actualEndUtc = new Date(actualEndMs).toISOString();

        const rows = await db.getZoneMeasurementsForTimeRange(homeId, zoneId, startUtc, endUtc);
        const weatherRows = await db.getHomeWeatherForTimeRange(homeId, startUtc, endUtc);

        const [dhwZones] = await pool.execute('SELECT id FROM zones WHERE home_id = ? AND type = "HOT_WATER"', [homeId]);
        const dhwZoneId = dhwZones.length > 0 ? dhwZones[0].id : 0;
        const dhwRows = await db.getZoneMeasurementsForTimeRange(homeId, dhwZoneId, startUtc, endUtc);

        const tempPoints = [];
        const humidityPoints = [];
        const solarPoints = [];
        let minTemp = null, maxTemp = null, minHum = null, maxHum = null, minSolar = null, maxSolar = null;

        const stripes = [];
        const settingsData = [];
        const callForHeatData = [];
        const hotWaterProduction = [];
        const presenceData = [];

        // Fetch Schedule for better interval alignment
        const [activeTTs] = await pool.execute('SELECT id, type FROM zone_timetables WHERE zone_id = ? AND is_active = 1', [zoneId]);
        let scheduleBlocks = [];
        if (activeTTs.length > 0) {
            const ttId = activeTTs[0].id;
            const ttType = activeTTs[0].type;
            const dayName = getLocalParts(startOfDay, tzName).dayName;

            let dayType = 'MONDAY_TO_SUNDAY';
            if (ttType === 'THREE_DAY') {
                if (['SATURDAY', 'SUNDAY'].includes(dayName)) dayType = dayName;
                else dayType = 'MONDAY_TO_FRIDAY';
            } else if (ttType === 'SEVEN_DAY') {
                dayType = dayName;
            }

            const [blocks] = await pool.execute('SELECT * FROM schedule_blocks WHERE timetable_id = ? AND home_id = ? AND day_type = ? ORDER BY start_time ASC', [ttId, homeId, dayType]);
            scheduleBlocks = blocks;
        }

        // 1. Resample DataPoints using exact Linear Interpolation
        const intervalMs = 15 * 60 * 1000;
        const startMs = startBuffer.valueOf();

        const idxTemp = { idx: 0 };
        const idxHum = { idx: 0 };
        const idxSolar = { idx: 0 };

        const hasTempSensors = rows.some(r => r.field_012d !== null && r.field_012d !== undefined);
        const hasHumSensors = rows.some(r => r.field_0135 !== null && r.field_0135 !== undefined);
        const isDhwZone = zoneType === 'HOT_WATER' || zoneType === 'DHW';

        for (let t = startMs; t <= actualEndMs; t += intervalMs) {
            const tsIso = new Date(t).toISOString();

            // Temp
            if (isDhwZone && !hasTempSensors) {
                tempPoints.push({
                    timestamp: tsIso,
                    value: null
                });
            } else {
                let temp = getInterpolatedValue(rows, t, 'field_012d', 20.0, idxTemp);
                temp = Math.round(temp * 100) / 100;
                if (minTemp === null || temp < minTemp) minTemp = temp;
                if (maxTemp === null || temp > maxTemp) maxTemp = temp;
                tempPoints.push({
                    timestamp: tsIso,
                    value: { celsius: temp, fahrenheit: parseFloat((temp * 1.8 + 32).toFixed(2)) }
                });
            }

            // Humidity
            if (isDhwZone && !hasHumSensors) {
                humidityPoints.push({ timestamp: tsIso, value: null });
            } else {
                let humRaw = getInterpolatedValue(rows, t, 'field_0135', 50.0, idxHum);
                let hum = Math.round((humRaw / 100.0) * 1000) / 1000;
                if (minHum === null || hum < minHum) minHum = hum;
                if (maxHum === null || hum > maxHum) maxHum = hum;
                humidityPoints.push({ timestamp: tsIso, value: hum });
            }

            // Solar
            let solarRaw = getInterpolatedValue(weatherRows, t, 'solar_intensity_percentage', 0.0, idxSolar);
            let solar = Math.round((solarRaw / 100.0) * 1000) / 1000;
            if (minSolar === null || solar < minSolar) minSolar = solar;
            if (maxSolar === null || solar > maxSolar) maxSolar = solar;
            solarPoints.push({ timestamp: tsIso, value: solar });
        }

        if (minTemp === null) { minTemp = null; maxTemp = null; }
        if (minHum === null) { minHum = null; maxHum = null; }
        if (minSolar === null) { minSolar = 0.0; maxSolar = 0.0; }

        let lastCallForHeatParams = null;
        const flushCallForHeat = (toTs) => {
            if (lastCallForHeatParams) {
                lastCallForHeatParams.to = toTs;
                callForHeatData.push(lastCallForHeatParams);
                lastCallForHeatParams = null;
            }
        };

        let lastHotWaterParams = null;
        const flushHotWater = (toTs) => {
            if (lastHotWaterParams) {
                lastHotWaterParams.to = toTs;
                hotWaterProduction.push(lastHotWaterParams);
                lastHotWaterParams = null;
            }
        };

        let lastPresenceParams = null;
        const flushPresence = (toTs) => {
            if (lastPresenceParams) {
                lastPresenceParams.to = toTs;
                presenceData.push(lastPresenceParams);
                lastPresenceParams = null;
            }
        };

        // Populate DHW mapping independently
        if (dhwRows.length > 0) {
            dhwRows.forEach((row) => {
                const ts = parseUtcDate(row.timestamp).toISOString();
                if (ts > actualEndUtc) return;

                const hp = row.field_40a0 ? parseFloat(row.field_40a0) : 0;
                const producing = (hp > 0);

                if (!lastHotWaterParams) {
                    lastHotWaterParams = { from: startUtc, to: null, value: producing };
                } else if (lastHotWaterParams.value !== producing) {
                    flushHotWater(ts);
                    lastHotWaterParams = { from: ts, to: null, value: producing };
                }
            });
            if (lastHotWaterParams) flushHotWater(actualEndUtc);
        } else {
            hotWaterProduction.push({ from: startUtc, to: actualEndUtc, value: false });
        }

        // Construct Presence intervals from tado_mode column
        if (rows.length > 0) {
            rows.forEach((row) => {
                const ts = parseUtcDate(row.timestamp).toISOString();
                if (ts > actualEndUtc) return;

                const isHome = row.tado_mode !== 'AWAY';
                if (!lastPresenceParams) {
                    lastPresenceParams = { from: startUtc, to: null, value: isHome };
                } else if (lastPresenceParams.value !== isHome) {
                    flushPresence(ts);
                    lastPresenceParams = { from: ts, to: null, value: isHome };
                }
            });
            if (lastPresenceParams) flushPresence(actualEndUtc);
        } else {
            presenceData.push({ from: startUtc, to: actualEndUtc, value: true });
        }

        const parseTimeStringAsUtc = (timeStr) => {
            return parseLocalTimeInTimezone(`${date} ${timeStr}`, tzName).toISOString();
        };

        // Layer Overlays from measurements
        const overlays = rows.filter(r => r.field_6240 !== null && r.field_6240 !== undefined && r.field_6240 !== 0);
        if (overlays.length > 0) {
            const allIntervals = [];

            scheduleBlocks.forEach((block, i) => {
                const s = (i === 0) ? startUtc : parseTimeStringAsUtc(block.start_time);
                const e = (block.end_time === '00:00') ? endUtc : parseTimeStringAsUtc(block.end_time);
                const tempC = block.setting_temp_celsius !== null ? parseFloat(block.setting_temp_celsius) : null;
                allIntervals.push({
                    from: s, to: e, stripeType: 'HOME', setting: {
                        type: zoneType, power: block.setting_power || 'ON', temperature: tempC !== null ? {
                            celsius: tempC,
                            fahrenheit: parseFloat((tempC * 1.8 + 32).toFixed(2))
                        } : null
                    }
                });
            });

            let currentOv = null;
            const ovSegments = [];
            rows.forEach(r => {
                const isOv = r.field_6240 !== null && r.field_6240 !== undefined && r.field_6240 !== 0;
                const ts = parseUtcDate(r.timestamp).toISOString();
                if (ts > actualEndUtc) return;

                if (isOv) {
                    const setting = {
                        type: zoneType,
                        power: r.field_6280 > 0 ? 'ON' : 'OFF',
                        temperature: zoneType === 'HEATING' ? {
                            celsius: parseFloat(r.field_6280),
                            fahrenheit: parseFloat((r.field_6280 * 1.8 + 32).toFixed(2))
                        } : null
                    };

                    if (!currentOv) {
                        currentOv = { from: ts, to: null, setting };
                    } else if (JSON.stringify(currentOv.setting) !== JSON.stringify(setting)) {
                        currentOv.to = ts;
                        ovSegments.push(currentOv);
                        currentOv = { from: ts, to: null, setting };
                    }
                } else if (currentOv) {
                    currentOv.to = ts;
                    ovSegments.push(currentOv);
                    currentOv = null;
                }
            });
            if (currentOv) { currentOv.to = actualEndUtc; ovSegments.push(currentOv); }

            stripes.length = 0;
            settingsData.length = 0;

            const bounds = new Set([startUtc, actualEndUtc]);
            allIntervals.forEach(i => { bounds.add(i.from); bounds.add(i.to); });
            ovSegments.forEach(s => { bounds.add(s.from); bounds.add(s.to); });
            const sortedBounds = Array.from(bounds).sort();
            const finalSegments = [];

            for (let i = 0; i < sortedBounds.length - 1; i++) {
                const s = sortedBounds[i];
                const e = sortedBounds[i + 1];
                if (s >= actualEndUtc) break;

                const ov = ovSegments.find(o => o.from <= s && (o.to === null || o.to > s));
                if (ov) {
                    finalSegments.push({ from: s, to: e, stripeType: 'OVERLAY_ACTIVE', setting: ov.setting });
                } else {
                    const block = allIntervals.find(b => b.from <= s && (b.to === null || b.to > s));
                    if (block) {
                        finalSegments.push({ from: s, to: e, stripeType: 'HOME', setting: block.setting });
                    }
                }
            }

            finalSegments.forEach(seg => {
                stripes.push({ from: seg.from, to: seg.to, value: { stripeType: seg.stripeType, setting: seg.setting } });
                settingsData.push({ from: seg.from, to: seg.to, value: seg.setting });
            });

        } else if (scheduleBlocks.length > 0) {
            scheduleBlocks.forEach((block, i) => {
                let start = (i === 0) ? startUtc : parseTimeStringAsUtc(block.start_time);
                let end = (block.end_time === '00:00') ? endUtc : parseTimeStringAsUtc(block.end_time);

                if (start < startUtc) start = startUtc;
                if (end > actualEndUtc) end = actualEndUtc;
                if (start >= actualEndUtc) return;

                const tempC = block.setting_temp_celsius !== null ? parseFloat(block.setting_temp_celsius) : null;
                const sVal = {
                    type: zoneType,
                    power: block.setting_power || 'ON',
                    temperature: tempC !== null ? {
                        celsius: tempC,
                        fahrenheit: parseFloat((tempC * 1.8 + 32).toFixed(2))
                    } : null
                };

                stripes.push({ from: start, to: end, value: { stripeType: 'HOME', setting: sVal } });
                settingsData.push({ from: start, to: end, value: sVal });
            });
        }

        if (rows.length > 0) {
            rows.forEach((row) => {
                const ts = parseUtcDate(row.timestamp).toISOString();
                if (ts > actualEndUtc) return;

                const hp = parseFloat(row.field_40a0 || 0);
                let cfh = 'NONE';
                if (hp > 66) cfh = 'HIGH'; else if (hp > 33) cfh = 'MEDIUM'; else if (hp > 0) cfh = 'LOW';

                if (!lastCallForHeatParams) {
                    lastCallForHeatParams = { from: startUtc, to: null, value: cfh };
                } else if (lastCallForHeatParams.value !== cfh) {
                    flushCallForHeat(ts);
                    lastCallForHeatParams = { from: ts, to: null, value: cfh };
                }
            });
            if (lastCallForHeatParams) flushCallForHeat(actualEndUtc);
        } else {
            callForHeatData.push({ from: startUtc, to: actualEndUtc, value: 'NONE' });
        }

        if (stripes.length === 0) {
            const defSetting = { type: zoneType, power: 'OFF', temperature: { celsius: 20, fahrenheit: 68 } };
            stripes.push({ from: startUtc, to: actualEndUtc, value: { stripeType: 'HOME', setting: defSetting } });
            settingsData.push({ from: startUtc, to: actualEndUtc, value: defSetting });
        }

        res.json({
            zoneType,
            interval: { from: startUtc, to: actualEndUtc },
            hoursInDay,
            measuredData: {
                measuringDeviceConnected: {
                    timeSeriesType: 'dataIntervals', valueType: 'boolean',
                    dataIntervals: [{ from: startUtc, to: actualEndUtc, value: true }]
                },
                insideTemperature: {
                    timeSeriesType: 'dataPoints', valueType: 'temperature',
                    min: { celsius: minTemp, fahrenheit: parseFloat((minTemp * 1.8 + 32).toFixed(2)) },
                    max: { celsius: maxTemp, fahrenheit: parseFloat((maxTemp * 1.8 + 32).toFixed(2)) },
                    dataPoints: tempPoints
                },
                humidity: {
                    timeSeriesType: 'dataPoints', valueType: 'percentage', percentageUnit: 'UNIT_INTERVAL',
                    min: minHum, max: maxHum, dataPoints: humidityPoints
                },
                solarIntensity: {
                    timeSeriesType: 'dataPoints', valueType: 'percentage', percentageUnit: 'UNIT_INTERVAL',
                    min: minSolar, max: maxSolar, dataPoints: solarPoints
                }
            },
            stripes: { timeSeriesType: 'dataIntervals', valueType: 'stripes', dataIntervals: stripes },
            settings: {
                timeSeriesType: 'dataIntervals',
                valueType: zoneType === 'HEATING' ? 'heatingSetting' : 'hotWaterSetting',
                dataIntervals: settingsData
            },
            callForHeat: { timeSeriesType: 'dataIntervals', valueType: 'callForHeat', dataIntervals: callForHeatData },
            hotWaterProduction: { timeSeriesType: 'dataIntervals', valueType: 'boolean', dataIntervals: hotWaterProduction },
            presence: { timeSeriesType: 'dataIntervals', valueType: 'boolean', dataIntervals: presenceData },
            weather: await formatWeatherDayReport(weatherRows, startUtc, actualEndUtc, tzName)
        });

    } catch (err) {
        _log('error', `DayReport Error: ${err.message}\n${err.stack}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

async function formatWeatherDayReport(rows, from, to, tzName) {
    const conditions = [];
    const slots = {};
    const sunny = [];
    const targetHoursLocal = ["04:00", "08:00", "12:00", "16:00", "20:00"];

    const getWeatherState = (state, timestamp) => {
        const parts = getLocalParts(new Date(timestamp), tzName);
        const localHour = parts.hour;
        const isNight = localHour < 6 || localHour >= 20;
        if (isNight && !state.startsWith('NIGHT_')) {
            if (state === 'CLEAR' || state === 'SUNNY') return 'NIGHT_CLEAR';
            if (state === 'CLOUDY' || state === 'CLOUDY_MOSTLY' || state === 'CLOUDY_PARTLY') return 'NIGHT_CLOUDY';
        }
        return state;
    };

    let lastCond = null;
    const flushCond = (toTs) => {
        if (lastCond) { lastCond.to = toTs; conditions.push(lastCond); lastCond = null; }
    };

    let lastSunny = null;
    const flushSunny = (toTs) => {
        if (lastSunny) { lastSunny.to = toTs; sunny.push(lastSunny); lastSunny = null; }
    };

    if (rows.length === 0) {
        conditions.push({ from, to, value: { state: 'CLOUDY', temperature: { celsius: 10.0, fahrenheit: 50.0 } } });
        sunny.push({ from, to, value: false });
        targetHoursLocal.forEach(h => {
            slots[h] = { state: 'CLOUDY', temperature: { celsius: 10.0, fahrenheit: 50.0 } };
        });
    } else {
        rows.forEach(row => {
            const ts = parseUtcDate(row.timestamp).toISOString();
            if (ts > to) return;

            const baseState = row.weather_state || 'CLOUDY';
            const state = getWeatherState(baseState, row.timestamp);
            const temp = parseFloat(row.outside_temp_celsius || 10);

            if (!lastCond) {
                lastCond = { from, to: null, value: { state, temperature: { celsius: temp, fahrenheit: parseFloat((temp * 1.8 + 32).toFixed(2)) } } };
            } else if (lastCond.value.state !== state || Math.abs(lastCond.value.temperature.celsius - temp) >= 1.0) {
                flushCond(ts);
                lastCond = { from: ts, to: null, value: { state, temperature: { celsius: temp, fahrenheit: parseFloat((temp * 1.8 + 32).toFixed(2)) } } };
            }

            const isSunny = ['CLEAR', 'SUNNY', 'MOSTLY_SUNNY', 'CLOUDY_PARTLY'].includes(baseState);
            if (!lastSunny) {
                lastSunny = { from, to: null, value: isSunny };
            } else if (lastSunny.value !== isSunny) {
                flushSunny(ts);
                lastSunny = { from: ts, to: null, value: isSunny };
            }

            const parts = getLocalParts(new Date(row.timestamp), tzName);
            const hourStr = String(parts.hour).padStart(2, '0') + ':00';

            if (targetHoursLocal.includes(hourStr) && !slots[hourStr]) {
                slots[hourStr] = {
                    state: state,
                    temperature: { celsius: temp, fahrenheit: parseFloat((temp * 1.8 + 32).toFixed(2)) }
                };
            }
        });
        if (lastCond) flushCond(to);
        if (lastSunny) flushSunny(to);
    }

    return {
        condition: { timeSeriesType: "dataIntervals", valueType: "weatherCondition", dataIntervals: conditions },
        sunny: { timeSeriesType: "dataIntervals", valueType: "boolean", dataIntervals: sunny },
        slots: slots
    };
}

// GET /:homeId/tanoclo/circuits/:circuitId/dayReport
router.get('/:homeId/tanoclo/circuits/:circuitId/dayReport', async (req, res) => {
    try {
        const { homeId, circuitId } = req.params;
        const circuitNumber = parseInt(circuitId, 10);
        const pool = db.getPool();

        const [circuits] = await pool.execute('SELECT * FROM heating_circuits WHERE home_id = ? AND number = ?', [homeId, circuitNumber]);
        if (circuits.length === 0) return res.status(404).json({ error: 'Circuit not found' });
        const circuit = circuits[0];

        const tzName = await db.getHomeTimezone(homeId);
        const momentHomeStr = getLocalParts(new Date(), tzName).dateStr;
        const date = req.query.date || momentHomeStr;

        const bounds = getDayBoundsInTimezone(date, tzName);
        const startOfDay = bounds.startUtc;
        const endOfDay = bounds.endUtc;
        const hoursInDay = bounds.hoursInDay;

        const startBuffer = new Date(startOfDay.getTime() - 15 * 60 * 1000);
        const endBuffer = new Date(endOfDay.getTime() + 15 * 60 * 1000);

        const startUtc = startBuffer.toISOString();
        const endUtc = endBuffer.toISOString();

        const nowMs = Date.now();
        const actualEndMs = Math.min(new Date(endUtc).getTime(), nowMs);
        const actualEndUtc = new Date(actualEndMs).toISOString();

        // 1. Fetch circuit measurements
        const [cRows] = await pool.execute(
            `SELECT * FROM circuit_measurements 
             WHERE home_id = ? AND circuit_number = ? AND timestamp >= ? AND timestamp <= ? 
             ORDER BY timestamp ASC`,
            [homeId, circuitNumber, startUtc, endUtc]
        );

        // 2. Fetch weather
        const weatherRows = await db.getHomeWeatherForTimeRange(homeId, startUtc, endUtc);

        // 3. Fetch mapped zones and their heat requests
        const [mappedZones] = await pool.execute(
            `SELECT id, name, type FROM zones 
             WHERE home_id = ? AND (heating_circuit = ? OR (heating_circuit IS NULL AND ? = 1))`,
            [homeId, circuitNumber, circuitNumber]
        );

        const zoneIds = mappedZones.map(z => z.id);
        let zoneMeasRows = [];
        if (zoneIds.length > 0) {
            const placeholders = zoneIds.map(() => '?').join(',');
            const [zRows] = await pool.execute(
                `SELECT zone_id, timestamp, field_40a0, field_012d, field_6280 
                 FROM zone_measurements 
                 WHERE home_id = ? AND zone_id IN (${placeholders}) AND timestamp >= ? AND timestamp <= ? 
                 ORDER BY timestamp ASC`,
                [homeId, ...zoneIds, startUtc, endUtc]
            );
            zoneMeasRows = zRows;
        }

        const zMeasByZone = {};
        zoneIds.forEach(id => zMeasByZone[id] = []);
        zoneMeasRows.forEach(r => {
            if (zMeasByZone[r.zone_id]) zMeasByZone[r.zone_id].push(r);
        });

        // 4. Resample circuit time-series
        const intervalMs = 15 * 60 * 1000;
        const startMs = startBuffer.valueOf();

        const flowTempPoints = [];
        const returnTempPoints = [];
        const setpointPoints = [];
        const targetTempPoints = [];
        const refTempPoints = [];
        const modulationPoints = [];
        const demandPoints = [];
        const waterPressurePoints = [];

        const idxFlow = { idx: 0 };
        const idxReturn = { idx: 0 };
        const idxSetpoint = { idx: 0 };
        const idxTarget = { idx: 0 };
        const idxRef = { idx: 0 };
        const idxMod = { idx: 0 };
        const idxDemand = { idx: 0 };
        const idxPress = { idx: 0 };

        const zoneIndices = {};
        const zoneHeatRequests = mappedZones.map(z => {
            zoneIndices[z.id] = { idx: 0 };
            return {
                zoneId: z.id,
                zoneName: z.name,
                zoneType: z.type,
                dataPoints: []
            };
        });

        let minFlow = null, maxFlow = null;
        let minReturn = null, maxReturn = null;
        let minMod = null, maxMod = null;
        let minDemand = null, maxDemand = null;

        for (let t = startMs; t <= actualEndMs; t += intervalMs) {
            const tsIso = new Date(t).toISOString();

            // Circuit & HVAC series
            const flow = Math.round(getInterpolatedValue(cRows, t, 'field_044c', 0, idxFlow) * 10) / 10;
            const ret = Math.round(getInterpolatedValue(cRows, t, 'field_044d', 0, idxReturn) * 10) / 10;
            const sp = Math.round(getInterpolatedValue(cRows, t, 'field_0450', 0, idxSetpoint) * 10) / 10;
            const target = Math.round(getInterpolatedValue(cRows, t, 'field_4000', 0, idxTarget) * 10) / 10;
            const ref = Math.round(getInterpolatedValue(cRows, t, 'field_4040', 0, idxRef) * 10) / 10;
            const mod = Math.round(getInterpolatedValue(cRows, t, 'field_0452', 0, idxMod));
            const dem = Math.round(getInterpolatedValue(cRows, t, 'field_4080', 0, idxDemand));
            const pressMbar = getInterpolatedValue(cRows, t, 'field_0460', 0, idxPress);
            const pressBar = Math.round(((pressMbar & 0xffff) / 1000.0) * 100) / 100;

            if (flow > 0) {
                if (minFlow === null || flow < minFlow) minFlow = flow;
                if (maxFlow === null || flow > maxFlow) maxFlow = flow;
            }
            if (ret > 0) {
                if (minReturn === null || ret < minReturn) minReturn = ret;
                if (maxReturn === null || ret > maxReturn) maxReturn = ret;
            }
            if (minMod === null || mod < minMod) minMod = mod;
            if (maxMod === null || mod > maxMod) maxMod = mod;
            if (minDemand === null || dem < minDemand) minDemand = dem;
            if (maxDemand === null || dem > maxDemand) maxDemand = dem;

            flowTempPoints.push({ timestamp: tsIso, value: flow > 0 ? flow : null });
            returnTempPoints.push({ timestamp: tsIso, value: ret > 0 ? ret : null });
            setpointPoints.push({ timestamp: tsIso, value: sp > 0 ? sp : null });
            targetTempPoints.push({ timestamp: tsIso, value: target > 0 ? target : null });
            refTempPoints.push({ timestamp: tsIso, value: ref > 0 ? ref : null });
            modulationPoints.push({ timestamp: tsIso, value: mod });
            demandPoints.push({ timestamp: tsIso, value: dem });
            waterPressurePoints.push({ timestamp: tsIso, value: pressBar > 0 ? pressBar : null });

            // Zones demand resample
            zoneHeatRequests.forEach(zEntry => {
                const zRows = zMeasByZone[zEntry.zoneId] || [];
                const zDem = Math.round(getInterpolatedValue(zRows, t, 'field_40a0', 0, zoneIndices[zEntry.zoneId]));
                zEntry.dataPoints.push({ timestamp: tsIso, value: zDem });
            });
        }

        // Flame state intervals
        const flameIntervals = [];
        let lastFlame = null;
        const flushFlame = (toTs) => {
            if (lastFlame) {
                lastFlame.to = toTs;
                flameIntervals.push(lastFlame);
                lastFlame = null;
            }
        };

        if (cRows.length > 0) {
            cRows.forEach(r => {
                const ts = parseUtcDate(r.timestamp).toISOString();
                if (ts > actualEndUtc) return;
                const active = Boolean(r.field_0457);
                if (!lastFlame) {
                    lastFlame = { from: startUtc, to: null, value: active };
                } else if (lastFlame.value !== active) {
                    flushFlame(ts);
                    lastFlame = { from: ts, to: null, value: active };
                }
            });
            if (lastFlame) flushFlame(actualEndUtc);
        } else {
            flameIntervals.push({ from: startUtc, to: actualEndUtc, value: false });
        }

        res.json({
            circuitNumber,
            driverSerial: circuit.driver_serial_no,
            interval: { from: startUtc, to: actualEndUtc },
            hoursInDay,
            measuredData: {
                flowTemperature: { min: minFlow, max: maxFlow, dataPoints: flowTempPoints },
                returnTemperature: { min: minReturn, max: maxReturn, dataPoints: returnTempPoints },
                controlSetpoint: { dataPoints: setpointPoints },
                targetTemperature: { dataPoints: targetTempPoints },
                referenceTemperature: { dataPoints: refTempPoints },
                modulation: { min: minMod, max: maxMod, dataPoints: modulationPoints },
                circuitDemand: { min: minDemand, max: maxDemand, dataPoints: demandPoints },
                waterPressure: { dataPoints: waterPressurePoints }
            },
            flameState: {
                timeSeriesType: 'dataIntervals',
                valueType: 'boolean',
                dataIntervals: flameIntervals
            },
            zoneHeatRequests,
            weather: await formatWeatherDayReport(weatherRows, startUtc, actualEndUtc, tzName)
        });
    } catch (err) {
        _log('error', `Circuit DayReport Error: ${err.message}\n${err.stack}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /:homeId/tanoclo/circuits/:circuitId/runningTimes
router.get('/:homeId/tanoclo/circuits/:circuitId/runningTimes', async (req, res) => {
    try {
        const { homeId, circuitId } = req.params;
        const circuitNumber = parseInt(circuitId, 10);
        const fromDateStr = req.query.from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const toDateStr = req.query.to || new Date().toISOString().slice(0, 10);
        const aggregate = req.query.aggregate || 'day';

        const pool = db.getPool();

        // 1. Fetch mapped zones
        const [mappedZones] = await pool.execute(
            `SELECT id, name FROM zones 
             WHERE home_id = ? AND (heating_circuit = ? OR (heating_circuit IS NULL AND ? = 1))`,
            [homeId, circuitNumber, circuitNumber]
        );
        const zoneIds = mappedZones.map(z => z.id);

        let fromDate = new Date(fromDateStr + "T00:00:00Z");
        let toDate = new Date(toDateStr + "T00:00:00Z");
        let endDate = new Date(toDate.getTime() + 24 * 60 * 60 * 1000);

        const buckets = [];
        let curr = new Date(fromDate);
        while (curr < endDate) {
            let bStart = new Date(curr);
            let bEnd;
            if (aggregate === 'month') {
                bEnd = new Date(Date.UTC(bStart.getUTCFullYear(), bStart.getUTCMonth() + 1, 1));
            } else {
                bEnd = new Date(bStart.getTime() + 24 * 60 * 60 * 1000);
            }
            if (bEnd > endDate) bEnd = endDate;

            buckets.push({
                startTime: bStart.toISOString().slice(0, 19).replace('T', ' '),
                endTime: bEnd.toISOString().slice(0, 19).replace('T', ' '),
                startTs: bStart.getTime() / 1000,
                endTs: bEnd.getTime() / 1000,
                key: bStart.toISOString().slice(0, 19).replace('T', ' ')
            });
            curr = bEnd;
        }

        // 2. Query circuit measurements for running duration
        const [cMeas] = await pool.execute(
            `SELECT timestamp, field_4080, field_0457, field_0452 
             FROM circuit_measurements 
             WHERE home_id = ? AND circuit_number = ? 
               AND timestamp >= ? AND timestamp < ? 
             ORDER BY timestamp ASC`,
            [homeId, circuitNumber, fromDateStr + ' 00:00:00', endDate.toISOString().slice(0, 19).replace('T', ' ')]
        );

        const circuitActiveByBucket = {};
        buckets.forEach(b => circuitActiveByBucket[b.key] = 0);

        for (let i = 0; i < cMeas.length - 1; i++) {
            const cur = cMeas[i];
            const nxt = cMeas[i + 1];
            const isActive = (parseFloat(cur.field_4080) > 0) || Boolean(cur.field_0457);
            if (isActive) {
                const t1 = Math.floor(parseUtcDate(cur.timestamp).getTime() / 1000);
                const t2 = Math.floor(parseUtcDate(nxt.timestamp).getTime() / 1000);
                let delta = t2 - t1;
                if (delta > 3600) delta = 3600;
                if (delta <= 0) continue;

                for (const b of buckets) {
                    if (t1 >= b.startTs && t1 < b.endTs) {
                        circuitActiveByBucket[b.key] += delta;
                        break;
                    }
                }
            }
        }

        // 3. Query zone measurements to calculate per-zone heat request contribution
        const zoneRunningByBucket = {};
        buckets.forEach(b => {
            zoneRunningByBucket[b.key] = {};
            zoneIds.forEach(id => zoneRunningByBucket[b.key][id] = 0);
        });

        if (zoneIds.length > 0) {
            const placeholders = zoneIds.map(() => '?').join(',');
            const [zMeas] = await pool.execute(
                `SELECT zone_id, timestamp, field_40a0 
                 FROM zone_measurements 
                 WHERE home_id = ? AND zone_id IN (${placeholders}) 
                   AND timestamp >= ? AND timestamp < ? 
                 ORDER BY zone_id, timestamp ASC`,
                [homeId, ...zoneIds, fromDateStr + ' 00:00:00', endDate.toISOString().slice(0, 19).replace('T', ' ')]
            );

            const zByZone = {};
            zoneIds.forEach(id => zByZone[id] = []);
            zMeas.forEach(m => {
                if (zByZone[m.zone_id]) zByZone[m.zone_id].push(m);
            });

            for (const [zIdStr, mArr] of Object.entries(zByZone)) {
                const zId = parseInt(zIdStr, 10);
                for (let i = 0; i < mArr.length - 1; i++) {
                    const cur = mArr[i];
                    const nxt = mArr[i + 1];
                    if (parseFloat(cur.field_40a0) > 0) {
                        const t1 = Math.floor(parseUtcDate(cur.timestamp).getTime() / 1000);
                        const t2 = Math.floor(parseUtcDate(nxt.timestamp).getTime() / 1000);
                        let delta = t2 - t1;
                        if (delta > 3600) delta = 3600;
                        if (delta <= 0) continue;

                        for (const b of buckets) {
                            if (t1 >= b.startTs && t1 < b.endTs) {
                                zoneRunningByBucket[b.key][zId] += delta;
                                break;
                            }
                        }
                    }
                }
            }
        }

        let totalCircuitRunning = 0;
        const runningTimesRes = [];

        for (const b of buckets) {
            const cDuration = circuitActiveByBucket[b.key] || 0;
            totalCircuitRunning += cDuration;

            let totalZoneHeatingDuration = 0;
            zoneIds.forEach(zId => {
                totalZoneHeatingDuration += (zoneRunningByBucket[b.key][zId] || 0);
            });

            const zonesRes = mappedZones.map(z => {
                const zDur = zoneRunningByBucket[b.key][z.id] || 0;
                const contribPct = totalZoneHeatingDuration > 0
                    ? Math.round((zDur / totalZoneHeatingDuration) * 1000) / 10
                    : (zoneIds.length > 0 && cDuration > 0 ? Math.round((100 / zoneIds.length) * 10) / 10 : 0);
                return {
                    id: z.id,
                    name: z.name,
                    runningTimeInSeconds: zDur,
                    contributionPercentage: contribPct
                };
            });

            runningTimesRes.push({
                startTime: b.startTime,
                endTime: b.endTime,
                runningTimeInSeconds: cDuration,
                zones: zonesRes
            });
        }

        const mean = Math.round(totalCircuitRunning / (buckets.length || 1));
        const summaryEndStr = buckets.length > 0 ? buckets[buckets.length - 1].endTime : endDate.toISOString().slice(0, 19).replace('T', ' ');

        res.json({
            circuitNumber,
            summary: {
                startTime: fromDateStr + ' 00:00:00',
                endTime: summaryEndStr,
                totalRunningTimeInSeconds: totalCircuitRunning,
                meanInSecondsPerDay: mean
            },
            runningTimes: runningTimesRes,
            lastUpdated: new Date().toISOString()
        });
    } catch (err) {
        _log('error', `Circuit RunningTimes Error: ${err.message}\n${err.stack}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /:homeId/tanoclo/timezone
router.get('/:homeId/tanoclo/timezone', async (req, res) => {
    try {
        const pool = db.getPool();
        const homeId = req.params.homeId;
        const [rows] = await pool.execute('SELECT date_time_zone FROM homes WHERE id = ?', [homeId]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Home not found' });
        }
        res.json({ dateTimeZone: rows[0].date_time_zone || 'Europe/Berlin' });
    } catch (err) {
        _log('error', `Error fetching timezone: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// 31. PUT /:homeId/tanoclo/timezone
router.put('/:homeId/tanoclo/timezone', async (req, res) => {
    try {
        const pool = db.getPool();
        const homeId = req.params.homeId;
        const { dateTimeZone } = req.body;
        if (!dateTimeZone) {
            return res.status(400).json({ error: 'Missing dateTimeZone' });
        }
        await pool.execute('UPDATE homes SET date_time_zone = ? WHERE id = ?', [dateTimeZone, homeId]);
        res.json({ dateTimeZone });
    } catch (err) {
        _log('error', `Error updating timezone: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /:homeId/tanoclo/users/:userId/admin
router.put('/:homeId/tanoclo/users/:userId/admin', async (req, res) => {
    try {
        const { homeId, userId } = req.params;
        const { isAdmin } = req.body;
        if (isAdmin === undefined) {
            return res.status(400).json({ error: 'Missing isAdmin' });
        }
        const pool = db.getPool();

        // 1. Fetch admin status of the requester
        const requesterStatus = await db.getAdminStatus(homeId, req.user.id);
        if (!requesterStatus.isFound) {
            return res.status(404).json({ error: 'Home not found' });
        }

        // 2. Requester must be Tado admin or TaNoClo admin
        if (!requesterStatus.isAdmin) {
            return res.status(403).json({ error: 'forbidden', error_description: 'Only home admins can change admin rights' });
        }

        // 3. Target user must be a member of the home
        const [targetMember] = await pool.execute('SELECT 1 FROM users WHERE home_id = ? AND id = ?', [homeId, userId]);
        if (targetMember.length === 0) {
            return res.status(404).json({ error: 'user_not_found', error_description: 'The target user is not a member of the home' });
        }

        // 4. Check if target is the Tado admin
        if (userId === requesterStatus.adminUserId) {
            return res.status(403).json({ error: 'forbidden', error_description: 'Cannot change admin rights of the Tado admin' });
        }

        // 5. Update the TaNoClo admin status in users table
        const tanocloAdminVal = isAdmin ? 1 : 0;
        await pool.execute('UPDATE users SET is_tanoclo_admin = ? WHERE id = ?', [tanocloAdminVal, userId]);

        res.status(204).end();
    } catch (err) {
        _log('error', `Error updating user admin status: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

module.exports = router;