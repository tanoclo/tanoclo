/**
 * @file lib/presence-helper.js
 * @brief User presence evaluation rules and geofencing triggers.
 */

'use strict';

const db = require('./db');
const mqttPublisher = require('./mqtt-publisher');
const cmdApi = require('./command-api');
const { getLogger } = require('./logger');

const _log = getLogger('presence-helper');

async function updateHomePresenceState(homeId, newPresence) {
    const pool = db.getPool();
    const isAway = newPresence === 'AWAY';

    // 1. Update homes table
    await pool.execute('UPDATE homes SET presence = ? WHERE id = ?', [newPresence, homeId]);

    // 2. Update all zones in home
    const [zones] = await pool.execute('SELECT id, type FROM zones WHERE home_id = ?', [homeId]);
    const [awayConfigs] = await pool.execute('SELECT * FROM away_configurations WHERE home_id = ?', [homeId]);

    for (const zone of zones) {
        const tlvUpdates = { '0x6160': isAway ? 2 : 1 };
        if (isAway) {
            const awayConfig = awayConfigs.find(c => c.zone_id === zone.id);
            const isDhw = zone.type === 'HOT_WATER' || zone.type === 'DHW';
            let enabled = 0;
            let temp = null;
            if (awayConfig) {
                const type = awayConfig.type || (isDhw ? 'FIXED_SETTING' : 'HEATING');
                if (type === 'HEATING' && !isDhw) {
                    if (awayConfig.min_away_temp_celsius !== null && awayConfig.min_away_temp_celsius !== undefined && parseFloat(awayConfig.min_away_temp_celsius) > 5.0) {
                        enabled = 1;
                        temp = parseFloat(awayConfig.min_away_temp_celsius);
                    }
                } else if (type === 'FIXED_SETTING') {
                    enabled = awayConfig.setting_power === 'ON' ? 1 : 0;
                    if (awayConfig.setting_temp_celsius !== null && awayConfig.setting_temp_celsius !== undefined) {
                        temp = parseFloat(awayConfig.setting_temp_celsius);
                    }
                }
            } else if (!isDhw) {
                enabled = 1;
                temp = 15.0;
            }
            tlvUpdates['0x61e0'] = enabled;
            if (enabled && temp !== null) {
                tlvUpdates['0x6200'] = temp;
            }
        }
        await db.insertMergedZoneMeasurement(homeId, zone.id, tlvUpdates);
        const [rows] = await pool.execute('SELECT * FROM zone_measurements WHERE zone_id = ? ORDER BY id DESC LIMIT 1', [zone.id]);
        if (rows.length > 0) {
            await mqttPublisher.publishZoneStateTelemetry(homeId, zone.id, rows[0]);
        }
    }

    // 3. Trigger WS push
    try {
        await cmdApi.pushHomeAway(homeId, isAway);
    } catch (pushErr) {
        _log('warn', `WS push failed for home ${homeId}: ${pushErr.message}`);
    }

    // 4. Trigger MQTT update for home presence
    await mqttPublisher.publishHomeTelemetry(homeId).catch(() => { });
}

async function evaluateHomePresence(homeId) {
    try {
        const pool = db.getPool();
        const [homes] = await pool.execute('SELECT presence, presence_locked FROM homes WHERE id = ?', [homeId]);
        if (homes.length === 0) return;

        if (Boolean(homes[0].presence_locked)) {
            _log('debug', `Presence is locked for home ${homeId}, skipping auto-evaluation.`);
            return;
        }

        const [geoDevices] = await pool.execute(
            'SELECT at_home, last_seen FROM mobile_devices WHERE home_id = ? AND geo_tracking_enabled = 1',
            [homeId]
        );

        // Filter out stale devices (no check-in within last 24 hours)
        const activeDevices = geoDevices.filter(d => {
            if (!d.last_seen) return false;
            const lastSeenTime = new Date(d.last_seen).getTime();
            return !isNaN(lastSeenTime) && (Date.now() - lastSeenTime) < 24 * 60 * 60 * 1000;
        });

        if (activeDevices.length > 0) {
            const anyoneHome = activeDevices.some(d => Boolean(d.at_home));
            const newPresence = anyoneHome ? 'HOME' : 'AWAY';
            const currentPresence = homes[0].presence || 'HOME';

            if (newPresence !== currentPresence) {
                _log('info', `Auto-presence change: ${currentPresence} → ${newPresence} for home ${homeId}`);
                await updateHomePresenceState(homeId, newPresence);
            }
        }
    } catch (err) {
        _log('error', `Auto-presence evaluation failed for home ${homeId}: ${err.message}`);
    }
}

async function setManualPresenceLock(homeId, presence) {
    try {
        _log('info', `Setting manual presence lock to ${presence} for home ${homeId}`);
        const pool = db.getPool();
        await pool.execute('UPDATE homes SET presence_locked = 1 WHERE id = ?', [homeId]);
        await updateHomePresenceState(homeId, presence);
    } catch (err) {
        _log('error', `Failed to set manual presence lock for home ${homeId}: ${err.message}`);
    }
}

async function removePresenceLock(homeId) {
    try {
        _log('info', `Removing presence lock for home ${homeId}`);
        const pool = db.getPool();
        await pool.execute('UPDATE homes SET presence_locked = 0 WHERE id = ?', [homeId]);
        // Immediately auto-evaluate presence after unlocking
        await evaluateHomePresence(homeId);
    } catch (err) {
        _log('error', `Failed to remove presence lock for home ${homeId}: ${err.message}`);
    }
}

module.exports = {
    evaluateHomePresence,
    setManualPresenceLock,
    removePresenceLock,
    updateHomePresenceState
};
