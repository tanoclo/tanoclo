/**
 * @file api/routes/zones/state.js
 * @brief REST routes managing active zone states and temperature overlays.
 * 
 * Supports retrieving active zone temperatures, applying manual override overlays
 * (setting timer durations, indefinite modes, or schedule falls), and terminating overrides.
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
    getInMemoryCurrentScheduleBlock,
    getInMemoryNextScheduleBlock,
    mapZoneOverlay,
    resolveAwaySetting,
    mapZoneState
} = require('./helpers');
const { getOrSeedMeasurement, getStateInternal } = require('./owd');

const router = express.Router();
const _log = getLogger('zones-api');

router.get('/:homeId/zoneStates', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const pool = db.getPool();

        // 1. Fetch home timezone and presence
        const [homes] = await pool.execute('SELECT date_time_zone, presence FROM homes WHERE id = ?', [homeId]);
        if (homes.length === 0) return res.status(404).json({ error: 'Home not found' });
        const tzName = homes[0].date_time_zone || 'Europe/Berlin';
        const homePresence = homes[0].presence || 'HOME';

        // 2. Fetch all zones
        const [zones] = await pool.execute('SELECT id, name, type, display_order, open_window_active, open_window_timeout, open_window_expiry, measuring_device_serial FROM zones WHERE home_id = ? ORDER BY display_order ASC', [homeId]);
        if (zones.length === 0) return res.json({ zoneStates: {} });

        // Fetch devices connection state to determine zone link state
        const [devices] = await pool.execute('SELECT serial_no, connection_state FROM devices WHERE home_id = ?', [homeId]);
        const deviceConnMap = new Map(devices.map(d => [d.serial_no, d.connection_state]));

        // Fetch away configurations for home
        const [awayConfigs] = await pool.execute('SELECT * FROM away_configurations WHERE home_id = ?', [homeId]);
        const awayConfigMap = new Map(awayConfigs.map(c => [c.zone_id.toString(), c]));

        // 3. Batch query latest measurements for all zones
        const [measurements] = await pool.execute(`
            SELECT zm.*
            FROM zone_measurements zm
            INNER JOIN (
                SELECT MAX(id) as max_id
                FROM zone_measurements
                WHERE home_id = ?
                GROUP BY zone_id
            ) latest ON zm.id = latest.max_id
        `, [homeId]);

        const measurementMap = new Map(measurements.map(m => [m.zone_id.toString(), m]));

        // 4. Batch query overlays
        const [overlays] = await pool.execute('SELECT * FROM zone_overlays WHERE home_id = ?', [homeId]);
        const overlayMap = new Map(overlays.map(o => [o.zone_id.toString(), o]));

        // 5. Batch query active timetables
        const [timetables] = await pool.execute('SELECT * FROM zone_timetables WHERE home_id = ? AND is_active = 1', [homeId]);
        const activeTTMap = new Map(timetables.map(t => [t.zone_id.toString(), t]));

        // 6. Batch query schedule blocks for active timetables
        let blocks = [];
        if (timetables.length > 0) {
            const ttIds = timetables.map(t => t.id);
            const placeholders = ttIds.map(() => '?').join(',');
            const [blockRows] = await pool.execute(`
                SELECT * FROM schedule_blocks 
                WHERE timetable_id IN (${placeholders}) AND home_id = ?
            `, [...ttIds, homeId]);
            blocks = blockRows;
        }

        const blocksByTimetable = new Map();
        for (const block of blocks) {
            const ttIdStr = block.timetable_id.toString();
            if (!blocksByTimetable.has(ttIdStr)) {
                blocksByTimetable.set(ttIdStr, []);
            }
            blocksByTimetable.get(ttIdStr).push(block);
        }

        const zoneStates = {};

        for (const z of zones) {
            const zoneIdStr = z.id.toString();

            // Get or seed measurement (fallback only if not in database yet)
            const measurement = measurementMap.get(zoneIdStr) || await getOrSeedMeasurement(homeId, z.id, pool);
            const activeTT = activeTTMap.get(zoneIdStr) || null;
            const blocksForTT = activeTT ? (blocksByTimetable.get(activeTT.id.toString()) || []) : [];

            // Resolve schedule block in memory
            const currentSchedBlock = getInMemoryCurrentScheduleBlock(activeTT, blocksForTT, tzName);
            const currentSetting = currentSchedBlock ? currentSchedBlock.setting : null;
            const nextChange = getInMemoryNextScheduleBlock(activeTT, blocksForTT, currentSetting, tzName);

            // Overlay checks
            let overlayRow = overlayMap.get(zoneIdStr) || null;
            if (overlayRow) {
                if (overlayRow.termination_type === 'TIMER' || overlayRow.termination_type === 'NEXT_TIME_BLOCK') {
                    if (new Date() > new Date(overlayRow.termination_expiry)) overlayRow = null;
                }
            }

            let isOffline = false;
            if (z.measuring_device_serial) {
                const connState = deviceConnMap.get(z.measuring_device_serial);
                if (connState === 0) {
                    isOffline = true;
                }
            }

            // Map the state
            const state = mapZoneState(measurement, overlayRow, nextChange, z, isOffline, homePresence);

            if (!overlayRow) {
                if (homePresence === 'AWAY') {
                    const awayConfig = awayConfigMap.get(zoneIdStr);
                    state.setting = normalizeSetting(resolveAwaySetting(z, awayConfig));
                } else if (currentSetting) {
                    state.setting = normalizeSetting(currentSetting);
                }
            }

            zoneStates[z.id] = state;
        }

        const order = zones.map(z => z.id);
        const sortedStates = {};
        order.forEach(id => {
            if (zoneStates[id]) {
                sortedStates[id] = zoneStates[id];
            }
        });

        res.json({ zoneStates: sortedStates });
    } catch (err) {
        _log('error', `Zone States Error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/{homeId}/zones/{zoneId}/state
router.get('/:homeId/zones/:zoneId/state', async (req, res) => {
    try {
        const pool = db.getPool();
        const state = await getStateInternal(req.params.homeId, req.params.zoneId, pool);
        res.json(state);
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/{homeId}/zones/{zoneId}/overlay
router.get('/:homeId/zones/:zoneId/overlay', async (req, res) => {
    try {
        const pool = db.getPool();
        const [overlays] = await pool.execute('SELECT * FROM zone_overlays WHERE zone_id = ? AND home_id = ?', [req.params.zoneId, req.params.homeId]);
        if (overlays.length === 0) return res.status(404).json({ error: 'No overlay' });

        let overlay = overlays[0];
        if (['TIMER', 'NEXT_TIME_BLOCK'].includes(overlay.termination_type)) {
            if (overlay.termination_expiry) {
                const tzName = await getHomeTimezone(req.params.homeId, req.params.zoneId);
                const expiryTs = parseHomeLocalTime(overlay.termination_expiry, tzName);
                if (Date.now() > expiryTs) {
                    return res.status(404).json({ error: 'No overlay' });
                }
            }
        }
        res.json(mapZoneOverlay(overlay));
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// DELETE /api/v2/homes/{homeId}/zones/{zoneId}/overlay
router.delete('/:homeId/zones/:zoneId/overlay', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const pool = db.getPool();

        await removeOverlay(homeId, zoneId, pool);

        res.status(204).end();
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/v2/homes/{homeId}/zones/{zoneId}/overlay
router.put('/:homeId/zones/:zoneId/overlay', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const { setting, termination } = req.body;

        if (!setting) return res.status(400).json({ error: 'Missing setting' });

        const pool = db.getPool();
        await applyOverlay(homeId, zoneId, setting, termination, pool);

        const [overlays] = await pool.execute('SELECT * FROM zone_overlays WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
        res.json(mapZoneOverlay(overlays[0]));
    } catch (err) {
        _log('error', `PUT zone overlay error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// DELETE /api/v2/homes/{homeId}/zoneStates
router.delete('/:homeId/zoneStates', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const pool = db.getPool();

        const [zones] = await pool.execute('SELECT id FROM zones WHERE home_id = ?', [homeId]);
        for (const zone of zones) {
            await removeOverlay(homeId, zone.id, pool);
        }

        res.status(204).end();
    } catch (err) {
        _log('error', `DELETE zoneStates error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

async function copySchedule(homeId, zoneId, targetZoneIds) {
    if (targetZoneIds.length === 0) throw new Error('No target zones provided');

    const pool = db.getPool();
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const [sourceTTs] = await connection.execute('SELECT * FROM zone_timetables WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
        const sourceBlocksData = {};

        for (const st of sourceTTs) {
            const [blocks] = await connection.execute('SELECT * FROM schedule_blocks WHERE timetable_id = ? AND home_id = ?', [st.id, homeId]);
            sourceBlocksData[st.type] = { blocks, is_active: st.is_active };
        }

        for (const targetId of targetZoneIds) {
            for (const [type, info] of Object.entries(sourceBlocksData)) {
                const [targetTTs] = await connection.execute('SELECT id FROM zone_timetables WHERE zone_id = ? AND home_id = ? AND type = ?', [targetId, homeId, type]);
                let targetTTId;

                if (targetTTs.length === 0) {
                    const [insRes] = await connection.execute('INSERT INTO zone_timetables (zone_id, home_id, type, is_active) VALUES (?, ?, ?, ?)', [targetId, homeId, type, info.is_active]);
                    targetTTId = insRes.insertId;
                } else {
                    targetTTId = targetTTs[0].id;
                    await connection.execute('UPDATE zone_timetables SET is_active = ? WHERE id = ? AND home_id = ?', [info.is_active, targetTTId, homeId]);
                }

                await connection.execute('DELETE FROM schedule_blocks WHERE timetable_id = ? AND home_id = ?', [targetTTId, homeId]);

                for (const block of info.blocks) {
                    await connection.execute(`
                        INSERT INTO schedule_blocks (
                            timetable_id, home_id, day_type, start_time, end_time, geolocation_override, 
                            setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [
                        targetTTId, homeId, block.day_type, block.start_time, block.end_time, block.geolocation_override,
                        block.setting_type, block.setting_power, block.setting_temp_celsius, block.setting_temp_fahrenheit
                    ]);
                }
            }
            await connection.execute('UPDATE zones SET last_schedule_change_at = NOW() WHERE id = ? AND home_id = ?', [targetId, homeId]);
        }

        await connection.commit();
    } catch (err) {
        await connection.rollback();
        throw err;
    } finally {
        connection.release();
    }
}

// POST /api/v2/homes/{homeId}/zones/{zoneId}/schedule/copy

router.post('/:homeId/zones/:zoneId/state/openWindow/activate', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        await db.updateZoneOpenWindow(homeId, zoneId, true);

        const pool = db.getPool();
        const [rows] = await pool.execute('SELECT open_window_expiry, open_window_timeout FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
        const expiry = rows.length > 0 && rows[0].open_window_expiry ? new Date(rows[0].open_window_expiry).toISOString() : new Date(Date.now() + 900 * 1000).toISOString();
        const remaining = expiry ? Math.max(0, Math.round((new Date(expiry).getTime() - Date.now()) / 1000)) : 900;

        const commandApi = require('../../../lib/command-api');
        try {
            await commandApi.pushOpenWindowActivate(homeId, zoneId);
        } catch (pushErr) {
            _log('warn', `OWD activate push failed: ${pushErr.message}`);
        }

        res.json({
            detectedTime: new Date().toISOString(),
            expiry: expiry,
            remainingTimeInSeconds: remaining
        });
    } catch (err) {
        _log('error', `Error activating open window: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// DELETE /api/v2/homes/{homeId}/zones/{zoneId}/state/openWindow
router.delete('/:homeId/zones/:zoneId/state/openWindow', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        await db.updateZoneOpenWindow(homeId, zoneId, false);

        const commandApi = require('../../../lib/command-api');
        try {
            await commandApi.pushOpenWindowCancel(homeId, zoneId);
        } catch (pushErr) {
            _log('warn', `OWD cancel push failed: ${pushErr.message}`);
        }

        res.status(204).end();
    } catch (err) {
        _log('error', `Error deactivating open window: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// POST /api/v2/homes/{homeId}/overlay
router.post('/:homeId/overlay', async (req, res) => {
    try {
        const { homeId } = req.params;
        const { setting, termination, overlays } = req.body;
        const pool = db.getPool();

        _log('info', `[zones-api] Bulk overlay start: home=${homeId} body=${JSON.stringify(req.body)}`);

        if (overlays && Array.isArray(overlays)) {
            _log('info', `[zones-api] Processing ${overlays.length} specific overlays`);
            for (const item of overlays) {
                const zoneId = item.room;
                const ovrSetting = item.overlay?.setting;
                const ovrTerm = item.overlay?.termination;
                if (zoneId && ovrSetting) {
                    await applyOverlay(homeId, zoneId, ovrSetting, ovrTerm, pool);
                }
            }
        } else if (setting) {
            const [zones] = await pool.execute('SELECT id FROM zones WHERE home_id = ?', [homeId]);
            _log('info', `[zones-api] Processing home-wide boost for ${zones.length} zones`);
            for (const zone of zones) {
                await applyOverlay(homeId, zone.id, setting, termination, pool);
            }
        } else {
            _log('warn', `[zones-api] Bulk overlay missing setting or overlays`);
            return res.status(400).json({ error: 'Missing setting or overlays' });
        }

        res.status(200).json({ status: 'done' });
    } catch (err) {
        _log('error', `[zones-api] Bulk overlay error: ${err.message}\n${err.stack}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// DELETE /api/v2/homes/{homeId}/overlay
router.delete('/:homeId/overlay', async (req, res) => {
    try {
        const { homeId } = req.params;
        const { rooms } = req.query;
        const pool = db.getPool();

        if (rooms) {
            const roomIds = String(rooms).split(',').map(id => parseInt(id, 10)).filter(id => !isNaN(id));
            for (const zoneId of roomIds) {
                await removeOverlay(homeId, zoneId, pool);
            }
        } else {
            const [zones] = await pool.execute('SELECT id FROM zones WHERE home_id = ?', [homeId]);
            for (const zone of zones) {
                await removeOverlay(homeId, zone.id, pool);
            }
        }

        res.status(204).end();
    } catch (err) {
        _log('error', `[zones-api] Bulk overlay delete error: ${err.message}\n${err.stack}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

async function applyOverlay(homeId, zoneId, setting, termination, pool) {
    const settingType = setting.type || 'HEATING';
    const settingPower = setting.power || 'ON';
    const settingTempC = setting.temperature?.celsius ?? null;
    const settingTempF = setting.temperature?.fahrenheit ?? null;

    let resolvedTermination = termination;
    if (!resolvedTermination) {
        const defaults = await db.getZoneDefaultOverlay(homeId, zoneId);
        if (defaults) {
            resolvedTermination = {
                type: defaults.type,
                typeSkillBasedApp: defaults.type,
                durationInSeconds: defaults.durationInSeconds
            };
        }
    }

    const termType = resolvedTermination?.typeSkillBasedApp || resolvedTermination?.type || 'MANUAL';
    let termDuration = null;
    let termExpiry = null;

    const tzName = await getHomeTimezone(homeId, zoneId);

    if (termType === 'TIMER') {
        termDuration = resolvedTermination?.durationInSeconds || 3600;
        const expiryDate = new Date(Date.now() + termDuration * 1000);
        termExpiry = expiryDate.toISOString(); // Always store UTC ISO string
    } else if (termType === 'NEXT_TIME_BLOCK') {
        const nextBlock = await db.getNextScheduleBlock(homeId, zoneId);
        if (nextBlock && nextBlock.startTime) {
            const tzName = await getHomeTimezone(homeId, zoneId);
            const nowObj = new Date();
            const nowLocal = getLocalParts(nowObj, tzName);
            let nextStartLocal = parseLocalTimeInTimezone(`${nowLocal.dateStr} ${nextBlock.startTime}`, tzName);

            if (nextStartLocal.getTime() < nowObj.getTime()) {
                const parts = nowLocal.dateStr.split('-');
                const d = new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10)));
                d.setUTCDate(d.getUTCDate() + 1);
                const nextDateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
                nextStartLocal = parseLocalTimeInTimezone(`${nextDateStr} ${nextBlock.startTime}`, tzName);
            }

            termExpiry = nextStartLocal.toISOString();
            termDuration = Math.max(0, Math.round((nextStartLocal.getTime() - nowObj.getTime()) / 1000));
        }
    }

    try {
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

        await commandApi.pushZoneOverlay(homeId, zoneId, setting, resolvedTermination).catch(err => {
            _log('warn', `Failed to push overlay to devices for Zone ${zoneId}: ${err.message}`);
        });

        try {
            const sse = require('../sse');
            sse.broadcastToHome(homeId, 'zone-state', { zoneId });
        } catch (sseErr) {
            _log('warn', `Failed to broadcast zone-state SSE for Zone ${zoneId}: ${sseErr.message}`);
        }
    } catch (err) {
        _log('error', `[zones-api] applyOverlay failed for Zone ${zoneId}: ${err.message}`);
        throw err;
    }
}

async function removeOverlay(homeId, zoneId, pool) {
    await pool.execute('DELETE FROM zone_overlays WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);

    await commandApi.pushZoneOverlayDelete(homeId, zoneId).catch(err => {
        _log('warn', `Failed to push overlay deletion to devices for Zone ${zoneId}: ${err.message}`);
    });

    try {
        const sse = require('../sse');
        sse.broadcastToHome(homeId, 'zone-state', { zoneId });
    } catch (sseErr) {
        _log('warn', `Failed to broadcast zone-state SSE for Zone ${zoneId}: ${sseErr.message}`);
    }
}

module.exports = router;
module.exports.copySchedule = copySchedule;
