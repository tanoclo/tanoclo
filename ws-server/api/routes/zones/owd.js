/**
 * @file api/routes/zones/owd.js
 * @brief Open Window Detection (OWD) settings endpoints for home zones.
 * 
 * Supports reading/updating OWD enable toggles, configuring OWD timeout variables,
 * and triggering manual window open/closed status updates.
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
    getZoneDetails,
    blockMatchesDay,
    getInMemoryCurrentScheduleBlock,
    getInMemoryNextScheduleBlock,
    mapZoneOverlay,
    resolveAwaySetting,
    mapZoneState
} = require('./helpers');

const router = express.Router();
const _log = getLogger('zones-api');

router.get('/:homeId/zones/:zoneId/openWindowDetection', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const pool = db.getPool();
        const [zones] = await pool.execute('SELECT open_window_enabled, open_window_timeout, field_6080, field_6340 FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);

        if (zones.length === 0) return res.status(404).json({ error: 'Zone not found' });

        res.json({
            supported: true,
            enabled: Boolean(zones[0].open_window_enabled),
            timeoutInSeconds: zones[0].open_window_timeout || 900,
            temperatureDeviationLimit: zones[0].field_6080 !== null && zones[0].field_6080 !== undefined ? parseFloat(zones[0].field_6080) : 0.50,
            owdNvmState: zones[0].field_6340 !== null && zones[0].field_6340 !== undefined ? parseInt(zones[0].field_6340, 10) : 1
        });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/v2/homes/{homeId}/zones/{zoneId}/openWindowDetection
router.put('/:homeId/zones/:zoneId/openWindowDetection', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const { isReadOnly, devBypass } = await checkZoneConfigReadonly(homeId);
        if (isReadOnly && !devBypass) {
            return res.status(403).json({ error: 'zone_config_readonly', message: 'Zone configuration is read-only' });
        }
        const { enabled, timeoutInSeconds, temperatureDeviationLimit, owdNvmState } = req.body;
        const pool = db.getPool();

        const [zones] = await pool.execute('SELECT open_window_enabled, open_window_timeout, field_6080, field_6340 FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
        if (zones.length === 0) return res.status(404).json({ error: 'Zone not found' });

        const currentEnabled = Boolean(zones[0].open_window_enabled);
        const currentTimeout = zones[0].open_window_timeout || 900;
        const currentDeviation = zones[0].field_6080 !== null ? parseFloat(zones[0].field_6080) : 0.50;
        const currentNvmState = zones[0].field_6340 !== null ? parseInt(zones[0].field_6340, 10) : 1;

        const newEnabled = enabled !== undefined ? enabled : currentEnabled;
        let newTimeout = timeoutInSeconds !== undefined ? parseInt(timeoutInSeconds, 10) : currentTimeout;
        // H4 fix: Bound timeout to reasonable range (60s - 3600s)
        if (isNaN(newTimeout) || newTimeout < 60) newTimeout = 60;
        if (newTimeout > 3600) newTimeout = 3600;

        const newDeviation = temperatureDeviationLimit !== undefined && temperatureDeviationLimit !== null ? parseFloat(temperatureDeviationLimit) : currentDeviation;
        const newNvmState = owdNvmState !== undefined && owdNvmState !== null ? parseInt(owdNvmState, 10) : currentNvmState;

        await db.updateZoneOpenWindowSettings(homeId, zoneId, newEnabled, newTimeout, newDeviation, newNvmState);

        // Push config refresh to zone devices so firmware learns about OWD change
        const [devices] = await pool.execute('SELECT serial_no FROM devices WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
        for (const dev of devices) {
            await commandApi.pushConfigRefresh(dev.serial_no).catch(e =>
                _log('warn', `OWD refresh failed for ${dev.serial_no}: ${e.message}`)
            );
        }

        res.json({
            enabled: newEnabled,
            timeoutInSeconds: newTimeout,
            temperatureDeviationLimit: newDeviation,
            owdNvmState: newNvmState
        });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});


// GET /api/v2/homes/{homeId}/zones/{zoneId}/earlyStart
router.get('/:homeId/zones/:zoneId/earlyStart', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const pool = db.getPool();
        const [zones] = await pool.execute('SELECT early_start_enabled FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);

        if (zones.length === 0) return res.status(404).json({ error: 'Zone not found' });
        res.json({ supported: true, enabled: Boolean(zones[0].early_start_enabled) });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/v2/homes/{homeId}/zones/{zoneId}/earlyStart
router.put('/:homeId/zones/:zoneId/earlyStart', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const enabled = req.body.enabled;
        if (enabled === undefined) return res.status(400).json({ error: 'Missing enabled' });

        const pool = db.getPool();
        await pool.execute('UPDATE zones SET early_start_enabled = ? WHERE id = ? AND home_id = ?', [enabled ? 1 : 0, zoneId, homeId]);

        res.json({ enabled: Boolean(enabled) });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/{homeId}/zones/{zoneId}/tanoclo/owd
router.get('/:homeId/zones/:zoneId/tanoclo/owd', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const pool = db.getPool();
        const [rows] = await pool.execute(
            'SELECT tanoclo_owd_enabled, tanoclo_owd_source FROM zones WHERE id = ? AND home_id = ?',
            [zoneId, homeId]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Zone not found' });
        res.json({ tanocloOwdEnabled: !!rows[0].tanoclo_owd_enabled, tanocloOwdSource: rows[0].tanoclo_owd_source });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/v2/homes/{homeId}/zones/{zoneId}/tanoclo/owd
router.put('/:homeId/zones/:zoneId/tanoclo/owd', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const { enabled, source } = req.body;
        const pool = db.getPool();
        await pool.execute(
            'UPDATE zones SET tanoclo_owd_enabled = ?, tanoclo_owd_source = ? WHERE id = ? AND home_id = ?',
            [enabled ? 1 : 0, source || 'device', zoneId, homeId]
        );

        // Push configuration refresh to zone devices to update their state if needed
        const commandApi = require('../../../lib/command-api');
        const [devs] = await pool.execute('SELECT serial_no FROM devices WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
        for (const d of devs) {
            await commandApi.pushConfigRefresh(d.serial_no).catch(err => { _log('warn', `pushConfigRefresh for OWD failed on device ${d.serial_no}: ${err.message}`); });
        }

        const mqttPublisher = require('../../../lib/mqtt-publisher');
        if (mqttPublisher) {
            mqttPublisher.publishOpenWindow(zoneId, enabled).catch(() => { });
        }

        res.json({ tanocloOwdEnabled: !!enabled, tanocloOwdSource: source || 'device' });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

async function getOrSeedMeasurement(homeId, zoneId, pool) {
    const [rows] = await pool.execute('SELECT * FROM zone_measurements WHERE zone_id = ? AND home_id = ? ORDER BY timestamp DESC LIMIT 1', [zoneId, homeId]);
    if (rows.length > 0) return rows[0];

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const defaultMeasure = {
        home_id: homeId, zone_id: zoneId, timestamp: new Date(now),
        field_012d: null, field_0135: null, field_40a0: null,
        link_state: 'ONLINE', tado_mode: 'HOME'
    };

    await pool.execute(
        `INSERT INTO zone_measurements (home_id, zone_id, timestamp, field_012d, field_0135, field_40a0, link_state, tado_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [homeId, zoneId, now, null, null, null, 'ONLINE', 'HOME']
    );
    return defaultMeasure;
}

// Delegate to canonical implementation in db.js (which handles day wraparound, TEST_PARITY_TIME, etc.)
async function getCurrentScheduleBlock(homeId, zoneId, pool) {
    const block = await db.getCurrentScheduleBlock(homeId, zoneId);
    return block ? block.setting : null;
}

async function getNextScheduleBlock(homeId, zoneId, pool) {
    const tzName = await getHomeTimezone(homeId, zoneId);
    const currentSetting = await getCurrentScheduleBlock(homeId, zoneId, pool);
    const currentSettingJson = JSON.stringify(currentSetting);

    const [activeTTs] = await pool.execute('SELECT id, type FROM zone_timetables WHERE zone_id = ? AND home_id = ? AND is_active = 1', [zoneId, homeId]);
    if (activeTTs.length === 0) return null;

    const ttId = activeTTs[0].id;
    const typeStr = activeTTs[0].type;
    const typeId = getTimetableIdFromType(typeStr);

    const now = new Date();
    let foundBlock = null;
    let daysToAdd = 0;

    for (let i = 0; i < 7; i++) {
        const checkDate = new Date(now.getTime() + i * 86400000);
        const fmtLong = new Intl.DateTimeFormat('en-US', { timeZone: tzName, weekday: 'long' });
        const dayName = fmtLong.format(checkDate).toUpperCase();

        let dayType = 'MONDAY_TO_SUNDAY';
        if (typeId === 1) {
            if (['SATURDAY', 'SUNDAY'].includes(dayName)) dayType = dayName;
            else dayType = 'MONDAY_TO_FRIDAY';
        } else if (typeId === 2) {
            dayType = dayName;
        }

        let sql = "SELECT start_time, setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit FROM schedule_blocks WHERE timetable_id = ? AND day_type = ? ";
        let params = [ttId, dayType];

        if (i === 0) {
            const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: tzName, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
            const nowTimeStr = fmtTime.format(now);
            sql += "AND start_time > ? ";
            params.push(nowTimeStr);
        }

        sql += "ORDER BY start_time ASC";
        const [blocks] = await pool.execute(sql, params);

        for (const block of blocks) {
            const blockSetting = {
                type: block.setting_type || 'HEATING',
                power: block.setting_power || 'ON',
                temperature: (block.setting_temp_celsius !== null) ? {
                    celsius: parseFloat(block.setting_temp_celsius),
                    fahrenheit: (block.setting_temp_fahrenheit !== null) ? parseFloat(block.setting_temp_fahrenheit) : null
                } : null
            };
            const isSameSetting = JSON.stringify(blockSetting) === currentSettingJson;

            if (!isSameSetting || block.start_time !== '00:00') {
                foundBlock = {
                    start_time: block.start_time,
                    setting: blockSetting
                };
                daysToAdd = i;
                break;
            }
        }
        if (foundBlock) break;
    }

    if (foundBlock) {
        const [h, m] = foundBlock.start_time.split(':');
        const targetDateInTz = new Date(now.getTime() + daysToAdd * 86400000);

        const fmtFull = new Intl.DateTimeFormat('en-US', {
            timeZone: tzName,
            year: 'numeric', month: 'numeric', day: 'numeric',
            hour12: false
        });
        const parts = fmtFull.formatToParts(targetDateInTz);
        const map = {};
        parts.forEach(p => map[p.type] = p.value);

        const offsetParts = new Intl.DateTimeFormat('en-US', {
            timeZone: tzName, timeZoneName: 'longOffset'
        }).formatToParts(targetDateInTz);
        const offsetStr = offsetParts.find(p => p.type === 'timeZoneName').value;

        const tzIsoStr = `${map.year}-${map.month.padStart(2, '0')}-${map.day.padStart(2, '0')}T${h.padStart(2, '0')}:${m.padStart(2, '0')}:00${formatTimezoneOffset(offsetStr)}`;
        const finalUtcDate = new Date(tzIsoStr);

        return {
            start: finalUtcDate.toISOString(),
            setting: foundBlock.setting
        };
    }

    return null;
}


async function getStateInternal(homeId, zoneId, pool) {
    const measurement = await getOrSeedMeasurement(homeId, zoneId, pool);
    const nextChange = await getNextScheduleBlock(homeId, zoneId, pool);

    const [homes] = await pool.execute('SELECT presence FROM homes WHERE id = ?', [homeId]);
    const homePresence = homes.length > 0 ? (homes[0].presence || 'HOME') : 'HOME';

    const [overlays] = await pool.execute('SELECT * FROM zone_overlays WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
    let overlayRow = overlays.length > 0 ? overlays[0] : null;

    if (overlayRow) {
        if (overlayRow.termination_type === 'TIMER' || overlayRow.termination_type === 'NEXT_TIME_BLOCK') {
            if (new Date() > new Date(overlayRow.termination_expiry)) overlayRow = null;
        }
    }

    const [zoneRows] = await pool.execute('SELECT * FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
    const zone = zoneRows.length > 0 ? zoneRows[0] : null;

    let isOffline = false;
    if (zone && zone.measuring_device_serial) {
        const [devRows] = await pool.execute('SELECT connection_state FROM devices WHERE serial_no = ? AND home_id = ?', [zone.measuring_device_serial, homeId]);
        if (devRows.length > 0 && devRows[0].connection_state === 0) {
            isOffline = true;
        }
    }

    let state = mapZoneState(measurement, overlayRow, nextChange, zone, isOffline, homePresence);

    if (!overlayRow) {
        if (homePresence === 'AWAY') {
            const [awayConfigs] = await pool.execute('SELECT * FROM away_configurations WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
            const awayConfig = awayConfigs.length > 0 ? awayConfigs[0] : null;
            state.setting = normalizeSetting(resolveAwaySetting(zone, awayConfig));
        } else {
            const scheduleSetting = await getCurrentScheduleBlock(homeId, zoneId, pool);
            if (scheduleSetting) state.setting = normalizeSetting(scheduleSetting);
        }
    }

    return state;
}

module.exports = router;
module.exports.getOrSeedMeasurement = getOrSeedMeasurement;
module.exports.getStateInternal = getStateInternal;
