/**
 * @file api/routes/zones/schedule.js
 * @brief Heating schedule configuration and timetables management routes.
 * 
 * Exposes endpoints to retrieve active timetables, modify time/temperature blocks,
 * swap schedule types (1-day, 3-day, 7-day profiles), and copy/reset timetable blocks.
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

const { copySchedule } = require('./state');

const router = express.Router();
const _log = getLogger('zones-api');

router.get('/:homeId/zones/:zoneId/schedule/timetables', (req, res) => {
    res.json([
        { id: 0, type: 'ONE_DAY' },
        { id: 1, type: 'THREE_DAY' },
        { id: 2, type: 'SEVEN_DAY' }
    ]);
});

// GET /api/v2/homes/{homeId}/zones/{zoneId}/schedule/activeTimetable
router.get('/:homeId/zones/:zoneId/schedule/activeTimetable', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const pool = db.getPool();
        const [tt] = await pool.execute(
            'SELECT type FROM zone_timetables WHERE zone_id = ? AND home_id = ? AND is_active = 1',
            [zoneId, homeId]
        );
        const type = tt.length > 0 ? tt[0].type : 'ONE_DAY';
        res.json({ id: getTimetableIdFromType(type), type });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/v2/homes/{homeId}/zones/{zoneId}/schedule/activeTimetable
router.put('/:homeId/zones/:zoneId/schedule/activeTimetable', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const id = req.body.id ?? 0;
        const type = getTimetableTypeFromId(id);

        const pool = db.getPool();
        await pool.execute('UPDATE zone_timetables SET is_active = 0 WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);

        const [updateRes] = await pool.execute(
            'UPDATE zone_timetables SET is_active = 1 WHERE zone_id = ? AND home_id = ? AND type = ?',
            [zoneId, homeId, type]
        );

        if (updateRes.affectedRows === 0) {
            const [check] = await pool.execute('SELECT id FROM zone_timetables WHERE zone_id = ? AND home_id = ? AND type = ?', [zoneId, homeId, type]);
            if (check.length === 0) {
                await pool.execute('INSERT INTO zone_timetables (zone_id, home_id, type, is_active) VALUES (?, ?, ?, 1)', [zoneId, homeId, type]);
            }
        }

        const [ttRows] = await pool.execute('SELECT id FROM zone_timetables WHERE zone_id = ? AND home_id = ? AND type = ?', [zoneId, homeId, type]);
        if (ttRows.length > 0) {
            const internalId = ttRows[0].id;
            const [blockCount] = await pool.execute('SELECT COUNT(*) as c FROM schedule_blocks WHERE timetable_id = ? AND home_id = ?', [internalId, homeId]);
            if (blockCount[0].c === 0) {
                const [zoneRows] = await pool.execute('SELECT type FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
                const zoneType = zoneRows.length > 0 ? zoneRows[0].type : 'HEATING';

                let settingType = 'HEATING';
                let settingPower = 'ON';
                let tempC = 20.0;
                let tempF = 68.0;

                if (zoneType === 'HOT_WATER') {
                    settingType = 'HOT_WATER';
                    tempC = 50.0;
                    tempF = 122.0;
                }

                let dayTypes = [];
                if (type === 'SEVEN_DAY') dayTypes = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
                else if (type === 'THREE_DAY') dayTypes = ['MONDAY_TO_FRIDAY', 'SATURDAY', 'SUNDAY'];
                else dayTypes = ['MONDAY_TO_SUNDAY'];

                for (const dt of dayTypes) {
                    await pool.execute(`
                        INSERT INTO schedule_blocks (
                            timetable_id, home_id, day_type, start_time, end_time, geolocation_override, 
                            setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit
                        ) VALUES (?, ?, ?, '00:00', '00:00', 0, ?, ?, ?, ?)
                    `, [internalId, homeId, dt, settingType, settingPower, tempC, tempF]);
                }
            }
        }

        await pool.execute('UPDATE zones SET last_schedule_change_at = NOW() WHERE id = ? AND home_id = ?', [zoneId, homeId]);

        res.json({ id, type });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/{homeId}/zones/{zoneId}/schedule/timetables/{timetableId}/blocks
router.get('/:homeId/zones/:zoneId/schedule/timetables/:timetableId/blocks', async (req, res) => {
    try {
        const { homeId, zoneId, timetableId } = req.params;
        const timetableType = getTimetableTypeFromId(parseInt(timetableId, 10));
        const pool = db.getPool();

        let [tts] = await pool.execute('SELECT id FROM zone_timetables WHERE zone_id = ? AND home_id = ? AND type = ?', [zoneId, homeId, timetableType]);
        let internalId;

        if (tts.length === 0) {
            const [insertRes] = await pool.execute('INSERT INTO zone_timetables (zone_id, home_id, type) VALUES (?, ?, ?)', [zoneId, homeId, timetableType]);
            internalId = insertRes.insertId;
        } else {
            internalId = tts[0].id;
        }

        const [rows] = await pool.execute(`
            SELECT id, day_type, start_time, end_time, geolocation_override, setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit 
            FROM schedule_blocks 
            WHERE timetable_id = ? AND home_id = ?
        `, [internalId, homeId]);

        let blocks = rows.map(row => ({
            dayType: row.day_type,
            start: row.start_time,
            end: row.end_time,
            geolocationOverride: Boolean(row.geolocation_override),
            setting: {
                type: row.setting_type || 'HEATING',
                power: row.setting_power || 'ON',
                temperature: (row.setting_temp_celsius !== null) ? {
                    celsius: parseFloat(row.setting_temp_celsius),
                    fahrenheit: (row.setting_temp_fahrenheit !== null) ? parseFloat(row.setting_temp_fahrenheit) : null
                } : null
            }
        }));

        if (blocks.length === 0) {
            let dayTypes = [];
            if (timetableType === 'SEVEN_DAY') dayTypes = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
            else if (timetableType === 'THREE_DAY') dayTypes = ['MONDAY_TO_FRIDAY', 'SATURDAY', 'SUNDAY'];
            else dayTypes = ['MONDAY_TO_SUNDAY'];

            const [zoneRows] = await pool.execute('SELECT type FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
            const zoneType = zoneRows.length > 0 ? zoneRows[0].type : 'HEATING';

            let settingType = 'HEATING';
            let settingPower = 'ON';
            let tempC = 20.0;
            let tempF = 68.0;

            if (zoneType === 'HOT_WATER') {
                settingType = 'HOT_WATER';
                tempC = 50.0;
                tempF = 122.0;
            }

            for (const dt of dayTypes) {
                await pool.execute(`
                    INSERT INTO schedule_blocks (
                        timetable_id, home_id, day_type, start_time, end_time, geolocation_override, 
                        setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit
                    ) VALUES (?, ?, ?, '00:00', '00:00', 0, ?, ?, ?, ?)
                `, [internalId, homeId, dt, settingType, settingPower, tempC, tempF]);
            }

            const [rowsAfterInsert] = await pool.execute(`
                SELECT id, day_type, start_time, end_time, geolocation_override, setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit 
                FROM schedule_blocks 
                WHERE timetable_id = ? AND home_id = ?
            `, [internalId, homeId]);

            blocks = rowsAfterInsert.map(row => ({
                dayType: row.day_type,
                start: row.start_time,
                end: row.end_time,
                geolocationOverride: Boolean(row.geolocation_override),
                setting: {
                    type: row.setting_type || 'HEATING',
                    power: row.setting_power || 'ON',
                    temperature: (row.setting_temp_celsius !== null) ? {
                        celsius: parseFloat(row.setting_temp_celsius),
                        fahrenheit: (row.setting_temp_fahrenheit !== null) ? parseFloat(row.setting_temp_fahrenheit) : null
                    } : null
                }
            }));
        }

        res.json(blocks);
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/{homeId}/zones/{zoneId}/schedule/timetables/{timetableId}
router.get('/:homeId/zones/:zoneId/schedule/timetables/:timetableId', (req, res) => {
    const id = parseInt(req.params.timetableId, 10);
    const type = getTimetableTypeFromId(id);
    res.json({ id, type });
});

// GET /api/v2/homes/{homeId}/zones/{zoneId}/schedule/timetables/{timetableId}/blocks/{dayType}
router.get('/:homeId/zones/:zoneId/schedule/timetables/:timetableId/blocks/:dayType', async (req, res) => {
    try {
        const { homeId, zoneId, timetableId, dayType } = req.params;
        const timetableType = getTimetableTypeFromId(parseInt(timetableId, 10));
        const pool = db.getPool();

        let [tts] = await pool.execute('SELECT id FROM zone_timetables WHERE zone_id = ? AND home_id = ? AND type = ?', [zoneId, homeId, timetableType]);
        let internalId;

        if (tts.length === 0) {
            const [insertRes] = await pool.execute('INSERT INTO zone_timetables (zone_id, home_id, type) VALUES (?, ?, ?)', [zoneId, homeId, timetableType]);
            internalId = insertRes.insertId;
        } else {
            internalId = tts[0].id;
        }

        const [rows] = await pool.execute(`
            SELECT id, day_type, start_time, end_time, geolocation_override, setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit 
            FROM schedule_blocks 
            WHERE timetable_id = ? AND home_id = ? AND day_type = ?
        `, [internalId, homeId, dayType]);

        let blocks = rows.map(row => ({
            dayType: row.day_type,
            start: row.start_time,
            end: row.end_time,
            geolocationOverride: Boolean(row.geolocation_override),
            setting: {
                type: row.setting_type || 'HEATING',
                power: row.setting_power || 'ON',
                temperature: (row.setting_temp_celsius !== null) ? {
                    celsius: parseFloat(row.setting_temp_celsius),
                    fahrenheit: (row.setting_temp_fahrenheit !== null) ? parseFloat(row.setting_temp_fahrenheit) : null
                } : null
            }
        }));

        if (blocks.length === 0) {
            const [zoneRows] = await pool.execute('SELECT type FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
            const zoneType = zoneRows.length > 0 ? zoneRows[0].type : 'HEATING';

            const [allBlocks] = await pool.execute('SELECT COUNT(*) as c FROM schedule_blocks WHERE timetable_id = ? AND home_id = ?', [internalId, homeId]);
            if (allBlocks[0].c === 0) {
                let dayTypes = [];
                if (timetableType === 'SEVEN_DAY') dayTypes = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
                else if (timetableType === 'THREE_DAY') dayTypes = ['MONDAY_TO_FRIDAY', 'SATURDAY', 'SUNDAY'];
                else dayTypes = ['MONDAY_TO_SUNDAY'];

                let settingType = 'HEATING';
                let settingPower = 'ON';
                let tempC = 20.0;
                let tempF = 68.0;

                if (zoneType === 'HOT_WATER') {
                    settingType = 'HOT_WATER';
                    tempC = 50.0;
                    tempF = 122.0;
                }

                for (const dt of dayTypes) {
                    await pool.execute(`
                        INSERT INTO schedule_blocks (
                            timetable_id, home_id, day_type, start_time, end_time, geolocation_override, 
                            setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit
                        ) VALUES (?, ?, ?, '00:00', '00:00', 0, ?, ?, ?, ?)
                    `, [internalId, homeId, dt, settingType, settingPower, tempC, tempF]);
                }

                const [rowsAfterInsert] = await pool.execute(`
                    SELECT id, day_type, start_time, end_time, geolocation_override, setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit 
                    FROM schedule_blocks 
                    WHERE timetable_id = ? AND home_id = ? AND day_type = ?
                `, [internalId, homeId, dayType]);

                blocks = rowsAfterInsert.map(row => ({
                    dayType: row.day_type,
                    start: row.start_time,
                    end: row.end_time,
                    geolocationOverride: Boolean(row.geolocation_override),
                    setting: {
                        type: row.setting_type || 'HEATING',
                        power: row.setting_power || 'ON',
                        temperature: (row.setting_temp_celsius !== null) ? {
                            celsius: parseFloat(row.setting_temp_celsius),
                            fahrenheit: (row.setting_temp_fahrenheit !== null) ? parseFloat(row.setting_temp_fahrenheit) : null
                        } : null
                    }
                }));
            } else {
                blocks = [{
                    dayType: dayType,
                    start: '00:00',
                    end: '00:00',
                    geolocationOverride: false,
                    setting: {
                        type: zoneType === 'HOT_WATER' ? 'HOT_WATER' : 'HEATING',
                        power: 'ON',
                        temperature: zoneType === 'HOT_WATER' ? { celsius: 50.0, fahrenheit: 122.0 } : { celsius: 20.0, fahrenheit: 68.0 }
                    }
                }];
            }
        }

        res.json(blocks);
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/v2/homes/{homeId}/zones/{zoneId}/schedule/timetables/{timetableId}/blocks/{dayType}
router.put('/:homeId/zones/:zoneId/schedule/timetables/:timetableId/blocks/:dayType', async (req, res) => {
    try {
        const { homeId, zoneId, timetableId, dayType } = req.params;
        const timetableType = getTimetableTypeFromId(parseInt(timetableId, 10));
        const blocks = req.body; // Array of blocks
        const pool = db.getPool();

        let [tts] = await pool.execute('SELECT id FROM zone_timetables WHERE zone_id = ? AND home_id = ? AND type = ?', [zoneId, homeId, timetableType]);
        let internalId;

        if (tts.length === 0) {
            const [insertRes] = await pool.execute('INSERT INTO zone_timetables (zone_id, home_id, type) VALUES (?, ?, ?)', [zoneId, homeId, timetableType]);
            internalId = insertRes.insertId;
        } else {
            internalId = tts[0].id;
        }

        await pool.execute('DELETE FROM schedule_blocks WHERE timetable_id = ? AND home_id = ? AND day_type = ?', [internalId, homeId, dayType]);

        for (const block of blocks) {
            const blockDayType = block.dayType || dayType;
            const settingType = block.setting?.type || 'HEATING';
            const settingPower = block.setting?.power || 'ON';
            const settingTempC = block.setting?.temperature?.celsius ?? null;
            const settingTempF = block.setting?.temperature?.fahrenheit ?? null;

            await pool.execute(`
                INSERT INTO schedule_blocks (
                    timetable_id, home_id, day_type, start_time, end_time, geolocation_override, 
                    setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                internalId, homeId, blockDayType, block.start, block.end,
                block.geolocationOverride ? 1 : 0, settingType, settingPower, settingTempC, settingTempF
            ]);
        }

        await pool.execute('UPDATE zones SET last_schedule_change_at = NOW() WHERE id = ? AND home_id = ?', [zoneId, homeId]);

        res.json(blocks);
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/{homeId}/zones/{zoneId}/openWindowDetection

router.post('/:homeId/zones/:zoneId/schedule/copy', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const targetZoneIds = req.body.targetZoneIds || [];
        await copySchedule(homeId, zoneId, targetZoneIds);
        res.json({ status: 'COPIED' });
    } catch (err) {
        if (err.message === 'No target zones provided') {
            return res.status(400).json({ error: err.message });
        }
        _log('error', `Schedule copy error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// POST /api/v2/homes/{homeId}/zones/{zoneId}/schedule/timetables/:timetableId/blocks/copy
router.post('/:homeId/zones/:zoneId/schedule/timetables/:timetableId/blocks/copy', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const targetZoneIds = req.body.targetZoneIds || [];
        await copySchedule(homeId, zoneId, targetZoneIds);
        res.json({ status: 'COPIED' });
    } catch (err) {
        if (err.message === 'No target zones provided') {
            return res.status(400).json({ error: err.message });
        }
        _log('error', `Blocks copy error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/{homeId}/zones/{zoneId}/awayConfiguration
// GET /api/v2/homes/{homeId}/zones/{zoneId}/schedule/awayConfiguration
router.get(['/:homeId/zones/:zoneId/awayConfiguration', '/:homeId/zones/:zoneId/schedule/awayConfiguration'], async (req, res) => {
    try {
        const pool = db.getPool();
        const { homeId, zoneId } = req.params;

        const [zones] = await pool.execute('SELECT type FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
        const zoneType = zones.length > 0 ? zones[0].type : 'HEATING';

        const [configs] = await pool.execute('SELECT * FROM away_configurations WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);

        if (configs.length > 0) {
            let row = configs[0];
            const type = row.type || 'HEATING';
            const preheatingLevel = row.preheating_level || 'MEDIUM';
            const minAwayTempC = row.min_away_temp_celsius !== null ? parseFloat(row.min_away_temp_celsius) : null;
            const minAwayTempF = row.min_away_temp_fahrenheit !== null ? parseFloat(row.min_away_temp_fahrenheit) : null;
            const settingType = row.setting_type;
            const settingPower = row.setting_power;
            const settingTempC = row.setting_temp_celsius !== null ? parseFloat(row.setting_temp_celsius) : null;
            const settingTempF = row.setting_temp_fahrenheit !== null ? parseFloat(row.setting_temp_fahrenheit) : null;

            const responseObj = {
                type
            };

            if (zoneType !== 'HOT_WATER') {
                responseObj.autoAdjust = Boolean(row.auto_adjust);
            }

            if (type === 'HEATING') {
                responseObj.preheatingLevel = preheatingLevel;
                responseObj.minimumAwayTemperature = (minAwayTempC !== null) ? {
                    celsius: minAwayTempC,
                    fahrenheit: minAwayTempF
                } : null;
            } else if (type === 'FIXED_SETTING') {
                responseObj.setting = {
                    type: settingType || (zoneType === 'HOT_WATER' ? 'HOT_WATER' : 'HEATING'),
                    power: settingPower || 'ON',
                    temperature: (settingTempC !== null) ? {
                        celsius: settingTempC,
                        fahrenheit: settingTempF
                    } : null
                };
            } else {
                responseObj.setting = null;
            }

            return res.json(responseObj);
        }

        let defaultCfg = {};
        if (zoneType === 'HOT_WATER') {
            defaultCfg = { type: 'FIXED_SETTING', setting: { type: 'HOT_WATER', power: 'OFF', temperature: null } };
            await pool.execute(`
                INSERT INTO away_configurations (
                    zone_id, home_id, auto_adjust, type, setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit
                ) VALUES (?, ?, 0, 'FIXED_SETTING', 'HOT_WATER', 'OFF', null, null)
            `, [zoneId, homeId]);
        } else {
            defaultCfg = { type: 'HEATING', autoAdjust: true, preheatingLevel: 'MEDIUM', minimumAwayTemperature: { celsius: 15.0, fahrenheit: 59.0 } };
            await pool.execute(`
                INSERT INTO away_configurations (
                    zone_id, home_id, auto_adjust, type, preheating_level, min_away_temp_celsius, min_away_temp_fahrenheit
                ) VALUES (?, ?, 1, 'HEATING', 'MEDIUM', 15.0, 59.0)
            `, [zoneId, homeId]);
        }

        res.json(defaultCfg);
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/v2/homes/{homeId}/zones/{zoneId}/awayConfiguration
// PUT /api/v2/homes/{homeId}/zones/{zoneId}/schedule/awayConfiguration
router.put(['/:homeId/zones/:zoneId/awayConfiguration', '/:homeId/zones/:zoneId/schedule/awayConfiguration'], async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const data = req.body;
        const autoAdjust = data.autoAdjust ?? true;

        const pool = db.getPool();

        if (data.setting?.power === 'ON' && !data.setting.temperature) {
            const [zones] = await pool.execute('SELECT min_temp, type FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
            if (zones.length > 0) {
                let minTemp = zones[0].min_temp;
                const zType = zones[0].type;
                if (minTemp === null || minTemp === undefined) minTemp = zType === 'HOT_WATER' ? 30.0 : 5.0;
                else minTemp = parseFloat(minTemp);

                data.setting.temperature = {
                    celsius: minTemp,
                    fahrenheit: parseFloat((minTemp * 1.8 + 32).toFixed(1))
                };
            }
        }

        const type = data.type || 'HEATING';
        const preheatingLevel = data.preheatingLevel || null;
        const minAwayTempC = data.minimumAwayTemperature?.celsius ?? null;
        const minAwayTempF = data.minimumAwayTemperature?.fahrenheit ?? null;
        const settingType = data.setting?.type || null;
        const settingPower = data.setting?.power || null;
        const settingTempC = data.setting?.temperature?.celsius ?? null;
        const settingTempF = data.setting?.temperature?.fahrenheit ?? null;

        const [existing] = await pool.execute('SELECT zone_id FROM away_configurations WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
        if (existing.length > 0) {
            await pool.execute(`
                UPDATE away_configurations SET 
                    auto_adjust = ?, 
                    type = ?, 
                    preheating_level = ?, 
                    min_away_temp_celsius = ?, 
                    min_away_temp_fahrenheit = ?, 
                    setting_type = ?, 
                    setting_power = ?, 
                    setting_temp_celsius = ?, 
                    setting_temp_fahrenheit = ?
                WHERE zone_id = ? AND home_id = ?
            `, [
                autoAdjust ? 1 : 0, type, preheatingLevel, minAwayTempC, minAwayTempF,
                settingType, settingPower, settingTempC, settingTempF, zoneId, homeId
            ]);
        } else {
            await pool.execute(`
                INSERT INTO away_configurations (
                    zone_id, home_id, auto_adjust, type, preheating_level, 
                    min_away_temp_celsius, min_away_temp_fahrenheit, 
                    setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                zoneId, homeId, autoAdjust ? 1 : 0, type, preheatingLevel,
                minAwayTempC, minAwayTempF, settingType, settingPower, settingTempC, settingTempF
            ]);
        }

        const commandApi = require('../../../lib/command-api');
        const bestDevice = commandApi.findBestDeviceIdForPing(homeId);
        if (bestDevice) {
            await commandApi.pushConfigRefresh(bestDevice).catch(err => {
                _log('warn', `Failed to push config refresh after away config update: ${err.message}`);
            });
        }

        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/{homeId}/zones/{zoneId}/measuringDevice

router.put('/:homeId/zones/:zoneId/offline-schedule', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const { isReadOnly, devBypass } = await checkZoneConfigReadonly(homeId);
        if (isReadOnly && !devBypass) {
            return res.status(403).json({ error: 'zone_config_readonly', message: 'Zone configuration is read-only' });
        }
        const enabled = req.body.enabled !== false;

        const result = await commandApi.pushOfflineScheduleEnable(homeId, zoneId, enabled);

        const mqttHaDiscovery = require('../../../lib/mqtt-ha-discovery');
        mqttHaDiscovery.publishAllDiscovery().catch(() => { });

        res.json({ success: true, ...result });
    } catch (err) {
        _log('error', `Offline schedule enable error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.post('/:homeId/zones/:zoneId/offline-schedule/sync', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const { isReadOnly, devBypass } = await checkZoneConfigReadonly(homeId);
        if (isReadOnly && !devBypass) {
            return res.status(403).json({ error: 'zone_config_readonly', message: 'Zone configuration is read-only' });
        }

        const result = await commandApi.pushOfflineScheduleSync(homeId, zoneId);

        res.json({ success: true, ...result });
    } catch (err) {
        _log('error', `Offline schedule sync error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

module.exports = router;