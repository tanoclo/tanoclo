/**
 * @file lib/cron.js
 * @brief Periodic cron scheduler for cleanups and snapshots.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./db');
const weather = require('./weather');
const config = require('./config');
const { getLocalParts, parseLocalTimeInTimezone } = require('./utils');
const { getLogger } = require('./logger');
const log = getLogger('cron');

let _broadcastTimeFn = null;
let _broadcastRfKeyFn = null;
let _pushZoneOverlayDeleteFn = null;
let _pushScheduleTransitionFn = null;
let _mqttPublisher = null;
let _mqttHaDiscovery = null;

const _retryQueue = [];
const _intervals = [];

async function processRetryQueue() {
    if (db.isOffline()) return;
    if (_retryQueue.length === 0) return;

    log('debug', `Processing retry queue with ${_retryQueue.length} pending commands`);
    const tasks = [..._retryQueue];
    _retryQueue.length = 0;

    for (const task of tasks) {
        try {
            if (task.type === 'pushZoneOverlayDelete' && _pushZoneOverlayDeleteFn) {
                await _pushZoneOverlayDeleteFn(task.homeId, task.zoneId);
            } else if (task.type === 'pushScheduleTransition' && _pushScheduleTransitionFn) {
                await _pushScheduleTransitionFn(task.homeId, task.zoneId);
            }
        } catch (err) {
            log('error', `Retry task failed: ${err.message}`);
            const retries = (task.retries || 0) + 1;
            if (retries < 10) {
                _retryQueue.push({ ...task, retries });
            } else {
                log('warn', `Retry task abandoned after ${retries} retries: ${JSON.stringify(task)}`);
            }
        }
    }
}

/**
 * Initialize and start the cron service
 * @param {Object} opts
 * @param {Function} opts.broadcastTime - Function to broadcast time to all bridges
 * @param {Function} opts.pushZoneOverlayDelete - Function to resume schedule for a zone
 */
function start({ broadcastTime, broadcastRfKey, pushZoneOverlayDelete, pushScheduleTransition, mqttPublisher, mqttHaDiscovery }) {
    _broadcastTimeFn = broadcastTime;
    _broadcastRfKeyFn = broadcastRfKey;
    _pushZoneOverlayDeleteFn = pushZoneOverlayDelete;
    _pushScheduleTransitionFn = pushScheduleTransition;
    _mqttPublisher = mqttPublisher;
    _mqttHaDiscovery = mqttHaDiscovery;

    log('info', 'Cron service started');

    // 1. Device Disconnect Check (Every 1 minute)
    _intervals.push(setInterval(checkInactiveDevices, 60 * 1000));

    // 2. Zone Maintenance (Every 1 minute)
    // Handles overlay expiry and schedule transitions
    _intervals.push(setInterval(checkZones, 60 * 1000));

    // 3. Time Sync (Every 4 hours)
    _intervals.push(setInterval(syncTime, 4 * 60 * 60 * 1000));

    // 4. RF Key Broadcast (Daily)
    scheduleDailyRfKeySync();

    // 5. Database Cleanup (Every 24 hours)
    _intervals.push(setInterval(runCleanup, 24 * 60 * 60 * 1000));

    // 6. Weather Update (Every 1 hour)
    _intervals.push(setInterval(async () => {
        await weather.updateAllHomesWeather();
        if (_mqttPublisher) {
            try {
                const pool = db.getPool();
                const [homes] = await pool.execute('SELECT id FROM homes');
                for (const home of homes) {
                    await _mqttPublisher.publishHomeTelemetry(home.id).catch(() => { });
                }
            } catch (err) {
                log('error', `Failed to publish home telemetry after weather update: ${err.message}`);
            }
        }
    }, 60 * 60 * 1000));

    // 7. Retry Queue Processor (Every 30 seconds)
    _intervals.push(setInterval(processRetryQueue, 30 * 1000));

    // 8. HA Discovery re-publish (Every 24 hours backup)
    _intervals.push(setInterval(() => {
        if (_mqttHaDiscovery) {
            log('debug', 'Periodic HA Discovery republishing...');
            _mqttHaDiscovery.publishAllDiscovery().catch(() => { });
        }
    }, 24 * 60 * 60 * 1000));

    // 9. Auto-presence evaluation (Every 1 minute)
    _intervals.push(setInterval(evaluateAllHomesPresence, 60 * 1000));

    // Prevent cron intervals from keeping the process alive during crash paths
    for (const id of _intervals) id.unref();

    // Initial run
    checkInactiveDevices();
    checkZones();
    evaluateAllHomesPresence().catch(() => { });

    (async () => {
        await weather.updateAllHomesWeather();
        if (_mqttPublisher) {
            try {
                const pool = db.getPool();
                const [homes] = await pool.execute('SELECT id FROM homes');
                for (const home of homes) {
                    await _mqttPublisher.publishHomeTelemetry(home.id).catch(() => { });
                }
            } catch (e) {
                log('error', `Initial weather telemetry publish failed: ${e.message}`);
            }
        }
    })();

    cleanupLogs().catch(() => { });
}

/**
 * Marks devices offline if they haven't sent data for > 20 minutes
 */
async function checkInactiveDevices() {
    if (db.isOffline()) return;
    try {
        const pool = db.getPool();
        const twentyMinsAgo = new Date(Date.now() - 20 * 60000).toISOString();

        // Find devices that are about to be marked offline
        const [inactiveDevices] = await pool.execute(`
            SELECT serial_no FROM devices
            WHERE connection_state = 1 
              AND last_contact < ?
        `, [twentyMinsAgo]);

        if (inactiveDevices.length > 0) {
            const [result] = await pool.execute(`
                UPDATE devices
                SET connection_state = 0
                WHERE connection_state = 1 
                  AND last_contact < ?
            `, [twentyMinsAgo]);

            log('info', `Marked ${result.affectedRows} devices offline due to inactivity (20m timeout)`);

            if (_mqttPublisher) {
                for (const dev of inactiveDevices) {
                    _mqttPublisher.publishDeviceAvailability(dev.serial_no, false).catch(() => { });
                }
            }
        }
    } catch (err) {
        log('error', `checkInactiveDevices error: ${err.message}`);
    }
}

/**
 * Performs maintenance for all zones:
 * - Overlay expiry
 * - Schedule transition detection
 */
async function checkZones() {
    if (db.isOffline()) return;
    try {
        const pool = db.getPool();
        const [zones] = await pool.execute('SELECT id, home_id, type, early_start_enabled, last_schedule_transition_at, last_early_start_at, open_window_active, open_window_expiry FROM zones');
        const [overlays] = await pool.execute('SELECT zone_id, home_id, termination_expiry, termination_type FROM zone_overlays');
        const overlaysMap = new Map(overlays.map(o => [`${o.home_id}:${o.zone_id}`, o]));

        // Process zones in parallel batches of 5 to reduce total query time
        const BATCH_SIZE = 5;
        for (let i = 0; i < zones.length; i += BATCH_SIZE) {
            const batch = zones.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(zone => maintenanceZone(zone.home_id, zone.id, zone, overlaysMap.get(`${zone.home_id}:${zone.id}`))));
        }

        // Check and sync pending offline schedules
        await checkAndSyncOfflineSchedules();
    } catch (err) {
        log('error', `checkZones error: ${err.message}`);
    }
}

/**
 * Sync offline schedules if a schedule change is pending
 */
async function checkAndSyncOfflineSchedules() {
    try {
        const pool = db.getPool();
        // Query zones that have offline schedule enabled and have pending schedule updates
        const [pendingZones] = await pool.execute(`
            SELECT id, home_id, name FROM zones
            WHERE offline_schedule_enabled = 1
              AND (offline_schedule_synced_at IS NULL OR last_schedule_change_at > offline_schedule_synced_at)
        `);

        if (pendingZones.length === 0) return;

        // Lazy require: command-api depends on db → cron (circular). Must be deferred.
        const commandApi = require('./command-api');

        for (const zone of pendingZones) {
            const tzName = await db.getHomeTimezone(zone.home_id, zone.id);
            const { hour } = getLocalParts(new Date(), tzName);

            if (hour >= 2 && hour < 5) {
                log('debug', `Syncing offline schedule for Home ${zone.home_id}, Zone ${zone.id} (${zone.name}) during the night (local hour: ${hour})`);
                try {
                    await commandApi.pushOfflineScheduleSync(zone.home_id, zone.id);
                } catch (syncErr) {
                    log('error', `Failed to sync offline schedule for Home ${zone.home_id}, Zone ${zone.id}: ${syncErr.message}`);
                }
            } else {
                log('debug', `Offline schedule update pending for Home ${zone.home_id}, Zone ${zone.id} (${zone.name}), waiting for night time (current local hour: ${hour})`);
            }
        }
    } catch (err) {
        log('error', `checkAndSyncOfflineSchedules error: ${err.message}`);
    }
}

/**
 * Maintenance for a single zone
 */
async function maintenanceZone(homeId, zoneId, zoneData, initialOverlay) {
    try {
        const pool = db.getPool();
        let changed = false;
        const now = new Date();

        let hasOverlay = !!initialOverlay;

        // 1. Check Overlay Expiry
        if (hasOverlay && initialOverlay.termination_expiry) {
            const expiry = new Date(initialOverlay.termination_expiry);
            if (!isNaN(expiry.getTime()) && expiry <= now) {
                log('info', `Overlay for Home ${homeId}, Zone ${zoneId} expired (${initialOverlay.termination_expiry}). Reverting to schedule.`);
                await pool.execute('DELETE FROM zone_overlays WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
                changed = true;
                hasOverlay = false;
            }
        }

        // Check Open Window expiry
        if (zoneData.open_window_active === 1 && zoneData.open_window_expiry) {
            const owExpiry = new Date(zoneData.open_window_expiry);
            if (!isNaN(owExpiry.getTime()) && owExpiry <= now) {
                log('info', `Open Window for Home ${homeId}, Zone ${zoneId} expired (${zoneData.open_window_expiry}). Deactivating.`);
                await db.updateZoneOpenWindow(homeId, zoneId, false);
                // Push OWD cancel to devices
                // Lazy require: command-api depends on db → cron (circular). Must be deferred.
                const commandApi = require('./command-api');
                try {
                    await commandApi.pushOpenWindowCancel(homeId, zoneId);
                } catch (pushErr) {
                    log('warn', `OWD cancel push failed after expiry: ${pushErr.message}`);
                }
                // Refresh zoneData properties for subsequent steps
                zoneData.open_window_active = 0;
                zoneData.open_window_expiry = null;
            }
        }

        // Fetch home state for Away mode check
        const home = await db.getHome(homeId);
        const isAway = home && (home.presence === 'AWAY' || home.field_6160 === 0);
        const isProxied = home && home.is_proxied;

        // 2. Early Start Detection (30 min look-ahead)
        if (!isAway && !hasOverlay && zoneData.type === 'HEATING' && zoneData.early_start_enabled === 1) {
            const nextBlock = await db.getNextScheduleBlock(homeId, zoneId);
            if (nextBlock) {
                const tzName = await db.getHomeTimezone(homeId, zoneId);
                const now = new Date();
                const { dateStr } = getLocalParts(now, tzName);
                const nextStartLocal = parseLocalTimeInTimezone(`${dateStr} ${nextBlock.startTime}`, tzName);
                const nextDiffMin = Math.round((nextStartLocal.getTime() - now.getTime()) / 60000);

                if (nextDiffMin > 0 && nextDiffMin <= 30) {
                    const lastEarly = zoneData.last_early_start_at || null;

                    if (lastEarly !== nextBlock.startTime) {
                        const targetTemp = nextBlock.setting?.temperature?.celsius ?? null;
                        const powerState = nextBlock.setting?.power || 'ON';

                        log('info', `Early start detected for Home ${homeId}, Zone ${zoneId}. Starting transition to ${targetTemp !== null ? targetTemp + ' °C' : powerState} (Next block starts at ${nextBlock.startTime})`);

                        await db.insertMergedZoneMeasurement(homeId, zoneId, {
                            field_6200: targetTemp,
                            tado_mode: 'SCHEDULE'
                        });

                        await pool.execute('UPDATE zones SET last_early_start_at = ? WHERE id = ? AND home_id = ?', [nextBlock.startTime, zoneId, homeId]);
                        changed = true;
                    }
                }
            }
        }

        // 3. Schedule Transition Detection
        const lastTransition = zoneData.last_schedule_transition_at ? new Date(zoneData.last_schedule_transition_at) : null;
        const currentBlock = await db.getCurrentScheduleBlock(homeId, zoneId);

        if (currentBlock) {
            const blockStartLocal = currentBlock.startDateTimeLocal;

            // Detection: Has a new block started since our last persistent transition record?
            // This also handles catch-up on server restart.
            if (!lastTransition || lastTransition < blockStartLocal) {
                const targetTemp = currentBlock.setting?.temperature?.celsius || 15.0;
                log('info', `Schedule transition detected for Home ${homeId}, Zone ${zoneId}: ${targetTemp} °C (New block started at ${currentBlock.startTime})`);

                const [currRows] = await pool.execute(
                    'SELECT field_012d, field_0135, field_40a0 FROM zone_measurements WHERE zone_id = ? AND home_id = ? ORDER BY id DESC LIMIT 1',
                    [zoneId, homeId]
                );
                const currMeas = currRows.length > 0 ? currRows[0] : {};

                // Insert new measurement entry (cloning latest but with new field_6200)
                await db.insertMergedZoneMeasurement(homeId, zoneId, {
                    field_012d: currMeas.field_012d ?? null,
                    field_0135: currMeas.field_0135 ?? null,
                    field_40a0: currMeas.field_40a0 ?? 0,
                    link_state: currMeas.link_state ?? 'ONLINE',
                    tado_mode: currMeas.tado_mode ?? 'SCHEDULE',
                    field_6160: currMeas.field_6160 ?? 1,
                    field_61e0: currMeas.field_61e0 ?? 1,
                    field_6240: currMeas.field_6240 ?? null,
                    field_6280: currMeas.field_6280 ?? null,
                    field_6200: targetTemp,
                    field_6260: currMeas.field_6260 ?? 0,
                    field_6020: currMeas.field_6020 ?? 1,
                    field_6180: currMeas.field_6180 ?? 0,
                    field_62e0: currMeas.field_62e0 ?? 0,
                    field_6440: currMeas.field_6440 ?? 0,
                    open_window_detected: currMeas.open_window_detected ?? 0
                });

                // Update persistent transition tracker
                await pool.execute('UPDATE zones SET last_schedule_transition_at = ? WHERE id = ? AND home_id = ?', [new Date().toISOString(), zoneId, homeId]);

                // Force a push during nominal block start to ensure parity,
                // even if an Early Start already transitioned the temperature.
                if (!hasOverlay) {
                    changed = true;
                    log('debug', `Forcing redundant follow-up push for H:${homeId} Z:${zoneId} at nominal block start`);
                }
            }
        }

        // 3. Trigger WS Push if something changed
        if (changed) {
            try {
                if (db.isOffline()) throw new Error('Database is offline');
                if (hasOverlay && _pushZoneOverlayDeleteFn) {
                    // Overlay expired — use overlay delete (includes field_6440 0x6440)
                    await _pushZoneOverlayDeleteFn(homeId, zoneId);
                } else if (_pushScheduleTransitionFn) {
                    // Schedule transition — use transition push (no 0x6440)
                    await _pushScheduleTransitionFn(homeId, zoneId);
                } else if (_pushZoneOverlayDeleteFn) {
                    // Fallback if pushScheduleTransition not injected
                    await _pushZoneOverlayDeleteFn(homeId, zoneId);
                }
            } catch (err) {
                log('error', `Failed to push state for H:${homeId} Z:${zoneId}, queueing for retry: ${err.message}`);
                _retryQueue.push({ type: 'pushScheduleTransition', homeId, zoneId, retries: 0 });
            }
        }

    } catch (err) {
        log('error', `maintenanceZone ${zoneId} error: ${err.message}`);
    }
}

/**
 * Periodically broadcasts time to all bridges
 */
function syncTime() {
    if (typeof _broadcastTimeFn === 'function') {
        log('info', 'Firing scheduled Time Broadcast to bridges...');
        _broadcastTimeFn();
    }
}

/**
 * Schedules RF Key broadcast daily
 */
function scheduleDailyRfKeySync() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(3, 15, 0, 0);
    if (next <= now) {
        next.setUTCDate(next.getUTCDate() + 1);
    }
    const msUntilNext = next.getTime() - now.getTime();

    log('info', `Scheduled next RF Key Broadcast for ${next.toISOString()} (in ${Math.round(msUntilNext / 1000 / 60)} minutes)`);

    const timer = setTimeout(() => {
        syncRfKey();
        const intervalTimer = setInterval(syncRfKey, 24 * 60 * 60 * 1000);
        if (intervalTimer.unref) intervalTimer.unref();
        _intervals.push(intervalTimer);
    }, msUntilNext);

    if (timer.unref) timer.unref();
    _intervals.push(timer);
}

/**
 * Periodically broadcasts RF Key refresh
 */
function syncRfKey() {
    if (typeof _broadcastRfKeyFn === 'function') {
        log('info', 'Firing scheduled RF Key Broadcast to devices...');
        _broadcastRfKeyFn();
    }
}

/**
 * Deletes debug.{date}.log files older than 7 days
 */
async function cleanupLogs() {
    try {
        const logDir = path.join(__dirname, '../log');
        try {
            await fs.promises.access(logDir);
        } catch {
            return;
        }

        const files = await fs.promises.readdir(logDir);
        const now = new Date();
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        let count = 0;
        for (const file of files) {
            // Match debug.YYYY-MM-DD.log or similar rotated logs. 
            // Exclude active debug.log and debug.local.log
            if (file.startsWith('debug.') && file.endsWith('.log') && file !== 'debug.log' && file !== 'debug.local.log') {
                const filePath = path.join(logDir, file);
                const stats = await fs.promises.stat(filePath);
                if (stats.mtime < sevenDaysAgo) {
                    await fs.promises.unlink(filePath).catch(() => { });
                    count++;
                }
            }
        }

        if (count > 0) {
            log('info', `Cleaned up ${count} old log files (>7 days)`);
        }
    } catch (err) {
        log('error', `cleanupLogs error: ${err.message}`);
    }
}

/**
 * Runs database retention cleanup
 */
async function runCleanup() {
    if (db.isOffline()) return;
    try {
        const pool = db.getPool();
        log('info', 'Running database cleanup...');

        const now = new Date();
        const deviceDays = config.cleanupDeviceMeasurementsDays || 30;
        const zoneDays = config.cleanupZoneMeasurementsDays || 390;
        const weatherDays = config.cleanupHomeWeatherDays || 390;

        const deviceCutoff = new Date(now.getTime() - deviceDays * 24 * 60 * 60 * 1000).toISOString();
        const zoneCutoff = new Date(now.getTime() - zoneDays * 24 * 60 * 60 * 1000).toISOString();
        const weatherCutoff = new Date(now.getTime() - weatherDays * 24 * 60 * 60 * 1000).toISOString();
        const nowStr = now.toISOString();

        const [res1] = await pool.execute('DELETE FROM device_measurements WHERE timestamp < ?', [deviceCutoff]);
        if (res1.affectedRows > 0) log('info', `Cleaned up ${res1.affectedRows} old device measurements`);

        const [res2] = await pool.execute('DELETE FROM zone_measurements WHERE timestamp < ?', [zoneCutoff]);
        if (res2.affectedRows > 0) log('info', `Cleaned up ${res2.affectedRows} old zone measurements`);

        const [res4] = await pool.execute('DELETE FROM home_weather WHERE timestamp < ?', [weatherCutoff]);
        if (res4.affectedRows > 0) log('info', `Cleaned up ${res4.affectedRows} old home weather records`);

        const [res3] = await pool.execute('DELETE FROM oauth_auth_codes WHERE expires_at < ?', [nowStr]);
        if (res3.affectedRows > 0) log('info', `Cleaned up ${res3.affectedRows} expired OAuth auth codes`);

        log('info', 'Cleanup complete');

        // Also cleanup logs
        await cleanupLogs();
    } catch (err) {
        log('error', `runCleanup error: ${err.message}`);
    }
}

/**
 * Periodically evaluates presence for all homes to handle stale geofence devices
 */
async function evaluateAllHomesPresence() {
    if (db.isOffline()) return;
    try {
        const pool = db.getPool();
        const [homes] = await pool.execute('SELECT id FROM homes');
        // Lazy require: presence-helper depends on db → cron (circular). Must be deferred.
        const presenceHelper = require('./presence-helper');
        for (const home of homes) {
            await presenceHelper.evaluateHomePresence(home.id).catch(() => { });
        }
    } catch (err) {
        log('error', `evaluateAllHomesPresence error: ${err.message}`);
    }
}

function stop() {
    for (const id of _intervals) clearInterval(id);
    _intervals.length = 0;
    log('info', 'Cron service stopped');
}

module.exports = { start, stop };
