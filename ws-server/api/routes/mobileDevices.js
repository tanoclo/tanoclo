/**
 * @file api/routes/mobileDevices.js
 * @brief REST routes governing mobile client device integrations and geolocation reporting.
 * 
 * Implements endpoints to register mobile apps, map active device state properties,
 * receive geofencing coordinates triggers, and manage client settings.
 */

const express = require('express');
const db = require('../../lib/db');
const authMiddleware = require('../middleware/auth');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getLogger } = require('../../lib/logger');
const geoUtils = require('../../lib/geo-utils');
const { mapMobileDevice } = require('../../lib/mappers');

const router = express.Router();
const _log = getLogger('mobileDevices-api');

// mapMobileDevice is imported from lib/mappers.js

async function ensureGeofencingAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ errors: [{ code: 'access_denied', title: 'Missing token' }] });
    }

    const { homeId, deviceId } = req.params;
    const pool = db.getPool();

    if (authHeader.startsWith('Mobile ')) {
        const token = authHeader.substring(7);
        const decodedToken = Buffer.from(token, 'base64').toString();
        const [tokenDeviceId, geofencingToken] = decodedToken.split('|');

        if (tokenDeviceId === deviceId) {
            const [devices] = await pool.execute('SELECT geofencing_access_token FROM mobile_devices WHERE id = ? AND home_id = ?', [deviceId, homeId]);
            if (devices.length > 0 && devices[0].geofencing_access_token === token) {
                return next();
            }
        }
    } else if (authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        const [devices] = await pool.execute('SELECT geofencing_access_token FROM mobile_devices WHERE id = ? AND home_id = ?', [deviceId, homeId]);

        if (devices.length > 0 && devices[0].geofencing_access_token === token) {
            return next();
        }

        try {
            const config = require('../../lib/config');
            let tokenToVerify = token;
            const decodedHeader = jwt.decode(token, { complete: true });
            if (decodedHeader && decodedHeader.header.alg === 'RS256') {
                const parts = token.split('.');
                if (parts.length === 3) {
                    const hsHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
                        .toString('base64')
                        .replace(/=/g, '')
                        .replace(/\+/g, '-')
                        .replace(/\//g, '_');
                    tokenToVerify = `${hsHeader}.${parts[1]}.${parts[2]}`;
                }
            }
            jwt.verify(tokenToVerify, config.jwtSecret, { algorithms: ['HS256'] });
            return next();
        } catch (err) {
            _log('warn', `ensureGeofencingAuth JWT verification failed: ${err.message}`);
        }
    }

    return res.status(401).json({ errors: [{ code: 'access_denied', title: 'Invalid token' }] });
}

// POST /api/v2/homes/{homeId}/mobileDevices/{deviceId}/geofenceWebhook
// Native background geofence transition webhook from @capgo/background-geolocation.
// Registered BEFORE authMiddleware because the native layer cannot send custom auth headers.
// Authentication is via the geofencing_access_token passed in the body payload.
// Native POST body shape: { identifier, transition, enter, latitude, longitude, radius, payload }
router.post('/:homeId/mobileDevices/:deviceId/geofenceWebhook', async (req, res) => {
    try {
        const { homeId, deviceId } = req.params;
        const data = req.body;
        const pool = db.getPool();

        // Extract token from payload instead of URL path
        const webhookToken = data.payload?.geofencingAccessToken;
        if (!webhookToken) {
            _log('warn', `[geofenceWebhook] Missing token in payload for device ${deviceId}`);
            return res.status(401).json({ errors: [{ code: 'access_denied', title: 'Missing token in payload' }] });
        }

        // Authenticate via webhook token (matches geofencing_access_token)
        const [devices] = await pool.execute(
            'SELECT geofencing_access_token FROM mobile_devices WHERE id = ? AND home_id = ?',
            [deviceId, homeId]
        );
        if (devices.length === 0 || devices[0].geofencing_access_token !== webhookToken) {
            _log('warn', `[geofenceWebhook] Invalid webhook token for device ${deviceId}`);
            return res.status(401).json({ errors: [{ code: 'access_denied', title: 'Invalid webhook token' }] });
        }

        // Transform native cap-go transition payload into our standard geolocation format
        _log('info', `[geofenceWebhook] Received transition: ${data.transition} (enter: ${data.enter}) for ${data.identifier} (home=${homeId}, device=${deviceId})`);

        // Delegate transition and enter properties to handleGeolocationUpdate without coordinates
        req.body = {
            transition: data.transition,
            enter: data.enter
        };
        return handleGeolocationUpdate(req, res);
    } catch (err) {
        _log('error', `[geofenceWebhook] Error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.use(authMiddleware);

// GET /api/v2/homes/{homeId}/mobileDevices
router.get('/:homeId/mobileDevices', async (req, res) => {
    try {
        const pool = db.getPool();
        const [homes] = await pool.execute('SELECT * FROM homes WHERE id = ?', [req.params.homeId]);
        const home = homes[0] || null;
        const [devices] = await pool.execute('SELECT * FROM mobile_devices WHERE home_id = ?', [req.params.homeId]);
        res.json(devices.map(d => mapMobileDevice(d, home)));
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// POST /api/v2/homes/{homeId}/mobileDevices
router.post('/:homeId/mobileDevices', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const userId = req.user.id;
        const data = req.body;

        const name = (data.name || 'Mobile Device').substring(0, 255);
        const geoEnabled = data.settings?.geoTrackingEnabled ? 1 : 0;
        const platform = (data.metadata?.device?.platform || 'Android').substring(0, 50);
        const osVersion = (data.metadata?.device?.osVersion || 'Unknown').substring(0, 50);
        const model = (data.metadata?.device?.model || 'Unknown').substring(0, 255);
        const locale = (data.metadata?.device?.locale || 'en').substring(0, 10);

        const pool = db.getPool();

        // Check if device with the same name, user_id and home_id already exists
        const [existing] = await pool.execute(
            'SELECT id FROM mobile_devices WHERE name = ? AND user_id = ? AND home_id = ?',
            [name, userId, homeId]
        );

        let deviceId;
        if (existing.length > 0) {
            deviceId = existing[0].id;
            await pool.execute(
                `UPDATE mobile_devices SET 
                    platform = ?, os_version = ?, model = ?, locale = ?, 
                    geo_tracking_enabled = ?, last_seen = ? 
                 WHERE id = ?`,
                [platform, osVersion, model, locale, geoEnabled, new Date().toISOString(), deviceId]
            );
        } else {
            // Cleanup duplicate devices with same model or name for this user in this home
            try {
                const [oldDevices] = await pool.execute(
                    'SELECT id FROM mobile_devices WHERE user_id = ? AND home_id = ? AND (model = ? OR name = ?)',
                    [userId, homeId, model, name]
                );
                for (const oldDev of oldDevices) {
                    _log('info', `[POST mobileDevices] Removing duplicate device ${oldDev.id} for user ${userId}`);
                    await pool.execute('DELETE FROM mobile_devices WHERE id = ?', [oldDev.id]);
                    
                    try {
                        const mqttHaDiscovery = require('../../lib/mqtt-ha-discovery');
                        await mqttHaDiscovery.unpublishMobileDevice(oldDev.id);
                    } catch (discoveryErr) {
                        _log('warn', `[POST mobileDevices] Failed to unpublish discovery for old device ${oldDev.id}: ${discoveryErr.message}`);
                    }
                    try {
                        const mqttPublisher = require('../../lib/mqtt-publisher');
                        mqttPublisher.publishMobileDeviceTelemetry(homeId, oldDev.id, false, null, null, null, false).catch(() => {});
                    } catch (pubErr) {
                        // ignore
                    }
                }
            } catch (cleanupErr) {
                _log('error', `[POST mobileDevices] Failed to cleanup duplicate devices: ${cleanupErr.message}`);
            }

            deviceId = Math.floor(Math.random() * (99999999 - 10000000 + 1)) + 10000000;
            await pool.execute(
                `INSERT INTO mobile_devices (
                    id, name, user_id, home_id, platform, os_version, model, locale, 
                    geo_tracking_enabled, special_offers_enabled, on_demand_log_retrieval_enabled, smart_reminders_in_app_enabled, at_home, last_seen
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 1, 1, ?)`,
                [deviceId, name, userId, homeId, platform, osVersion, model, locale, geoEnabled, new Date().toISOString()]
            );
        }

        const token = Buffer.from(`${deviceId}|${crypto.randomBytes(32).toString('hex')}`).toString('base64');
        await pool.execute('UPDATE mobile_devices SET geofencing_access_token = ? WHERE id = ?', [token, deviceId]);

        const [created] = await pool.execute('SELECT * FROM mobile_devices WHERE id = ?', [deviceId]);
        res.json(mapMobileDevice(created[0]));
    } catch (err) {
        _log('error', `Create mobileDevice error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/{homeId}/mobileDevices/{deviceId}
router.get('/:homeId/mobileDevices/:deviceId', async (req, res) => {
    try {
        const pool = db.getPool();
        const [homes] = await pool.execute('SELECT * FROM homes WHERE id = ?', [req.params.homeId]);
        const home = homes[0] || null;
        const [devices] = await pool.execute('SELECT * FROM mobile_devices WHERE id = ? AND home_id = ?', [req.params.deviceId, req.params.homeId]);
        if (devices.length === 0) return res.status(404).json({ error: 'Not Found' });
        res.json(mapMobileDevice(devices[0], home));
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// DELETE /api/v2/homes/{homeId}/mobileDevices/{deviceId}
router.delete('/:homeId/mobileDevices/:deviceId', async (req, res) => {
    try {
        const { homeId, deviceId } = req.params;
        const pool = db.getPool();

        // 1. Fetch the device to see who it belongs to
        const [devices] = await pool.execute('SELECT user_id FROM mobile_devices WHERE id = ? AND home_id = ?', [deviceId, homeId]);
        if (devices.length === 0) {
            return res.status(204).end();
        }
        const deviceOwnerId = devices[0].user_id;

        // 2. Fetch admin status of the requester
        const requesterStatus = await db.getAdminStatus(homeId, req.user.id);
        if (!requesterStatus.isFound) {
            return res.status(404).json({ error: 'Home not found' });
        }

        // 3. Authorization check
        const isOwnDevice = (deviceOwnerId === req.user.id);
        if (!isOwnDevice) {
            if (!requesterStatus.isAdmin) {
                return res.status(403).json({ error: 'forbidden', error_description: 'Only admins can remove other users\' devices' });
            }
            if (requesterStatus.isTaNoCloAdmin && deviceOwnerId === requesterStatus.adminUserId) {
                return res.status(403).json({ error: 'forbidden', error_description: 'TaNoClo admins cannot remove the Tado admin\'s devices' });
            }
        }

        await pool.execute('DELETE FROM mobile_devices WHERE id = ? AND home_id = ?', [deviceId, homeId]);

        // Cleanup MQTT tracker discovery config
        const mqttHaDiscovery = require('../../lib/mqtt-ha-discovery');
        mqttHaDiscovery.unpublishMobileDevice(deviceId);

        // Cleanup MQTT tracker
        const mqttPublisher = require('../../lib/mqtt-publisher');
        mqttPublisher.publishMobileDeviceTelemetry(homeId, deviceId, false, null, null, null, false).catch(() => { });

        res.status(204).end();
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/{homeId}/mobileDevices/{deviceId}/settings
router.get('/:homeId/mobileDevices/:deviceId/settings', async (req, res) => {
    try {
        const pool = db.getPool();
        const [devices] = await pool.execute('SELECT * FROM mobile_devices WHERE id = ? AND home_id = ?', [req.params.deviceId, req.params.homeId]);
        if (devices.length === 0) return res.status(404).json({ error: 'Not Found' });

        const settings = mapMobileDevice(devices[0]).settings;
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/v2/homes/{homeId}/mobileDevices/{deviceId}/settings
router.put('/:homeId/mobileDevices/:deviceId/settings', async (req, res) => {
    try {
        const { homeId, deviceId } = req.params;
        const data = req.body;
        const pool = db.getPool();

        const updates = [];
        const params = [];

        if (data.geoTrackingEnabled !== undefined) { updates.push('geo_tracking_enabled = ?'); params.push(data.geoTrackingEnabled ? 1 : 0); }
        if (data.specialOffersEnabled !== undefined) { updates.push('special_offers_enabled = ?'); params.push(data.specialOffersEnabled ? 1 : 0); }
        if (data.onDemandLogRetrievalEnabled !== undefined) { updates.push('on_demand_log_retrieval_enabled = ?'); params.push(data.onDemandLogRetrievalEnabled ? 1 : 0); }
        if (data.smartRemindersInAppEnabled !== undefined) { updates.push('smart_reminders_in_app_enabled = ?'); params.push(data.smartRemindersInAppEnabled ? 1 : 0); }

        if (data.pushNotifications !== undefined) {
            const push = data.pushNotifications;
            if (push.lowBatteryReminder !== undefined) { updates.push('push_low_battery_reminder = ?'); params.push(push.lowBatteryReminder ? 1 : 0); }
            if (push.awayModeReminder !== undefined) { updates.push('push_away_mode_reminder = ?'); params.push(push.awayModeReminder ? 1 : 0); }
            if (push.homeModeReminder !== undefined) { updates.push('push_home_mode_reminder = ?'); params.push(push.homeModeReminder ? 1 : 0); }
            if (push.openWindowReminder !== undefined) { updates.push('push_open_window_reminder = ?'); params.push(push.openWindowReminder ? 1 : 0); }
            if (push.energySavingsReportReminder !== undefined) { updates.push('push_energy_savings_report_reminder = ?'); params.push(push.energySavingsReportReminder ? 1 : 0); }
            if (push.incidentDetection !== undefined) { updates.push('push_incident_detection = ?'); params.push(push.incidentDetection ? 1 : 0); }
            if (push.energyIqReminder !== undefined) { updates.push('push_energy_iq_reminder = ?'); params.push(push.energyIqReminder ? 1 : 0); }
            if (push.tariffHighPriceAlert !== undefined) { updates.push('push_tariff_high_price_alert = ?'); params.push(push.tariffHighPriceAlert ? 1 : 0); }
            if (push.tariffLowPriceAlert !== undefined) { updates.push('push_tariff_low_price_alert = ?'); params.push(push.tariffLowPriceAlert ? 1 : 0); }
            if (push.smartReminders !== undefined) { updates.push('push_smart_reminders = ?'); params.push(push.smartReminders ? 1 : 0); }
        }

        if (updates.length > 0) {
            params.push(deviceId, homeId);
            await pool.execute(`UPDATE mobile_devices SET ${updates.join(', ')} WHERE id = ? AND home_id = ?`, params);
        }

        const [devices] = await pool.execute('SELECT * FROM mobile_devices WHERE id = ? AND home_id = ?', [deviceId, homeId]);
        if (devices.length === 0) {
            return res.status(404).json({ error: 'Mobile device not found' });
        }
        res.json(mapMobileDevice(devices[0]).settings);
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/v2/homes/{homeId}/mobileDevices/{deviceId}/metadata
router.put('/:homeId/mobileDevices/:deviceId/metadata', async (req, res) => {
    try {
        const { homeId, deviceId } = req.params;
        const { device } = req.body;
        const pool = db.getPool();

        if (device) {
            const updates = [];
            const params = [];
            if (device.platform) { updates.push('platform = ?'); params.push(device.platform); }
            if (device.osVersion) { updates.push('os_version = ?'); params.push(device.osVersion); }
            if (device.model) { updates.push('model = ?'); params.push(device.model); }
            if (device.locale) { updates.push('locale = ?'); params.push(device.locale); }

            if (updates.length > 0) {
                params.push(deviceId, homeId);
                await pool.execute(`UPDATE mobile_devices SET ${updates.join(', ')} WHERE id = ? AND home_id = ?`, params);
            }
        }
        res.status(204).end();
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

function parseTransition(data) {
    if (data.enter !== undefined) {
        const val = data.enter;
        if (val === true || val === 'true' || val === 1 || val === '1' || String(val).toLowerCase() === 'enter') {
            return true;
        }
        if (val === false || val === 'false' || val === 0 || val === '0' || String(val).toLowerCase() === 'exit') {
            return false;
        }
    }
    if (data.transition !== undefined) {
        const val = String(data.transition).toLowerCase();
        if (val === 'enter' || val === 'entrance') {
            return true;
        }
        if (val === 'exit' || val === 'leave') {
            return false;
        }
    }
    return null;
}

router.post('/:homeId/mobileDevices/:deviceId/geolocation', ensureGeofencingAuth, handleGeolocationUpdate);

async function handleGeolocationUpdate(req, res) {
    try {
        const { homeId, deviceId } = req.params;
        const data = req.body;
        const pool = db.getPool();

        const parsedTransition = parseTransition(data);
        if (parsedTransition !== null) {
            const atHome = parsedTransition;
            _log('info', `[geolocation] Decoded transition via helper atHome=${atHome} (enter=${data.enter}, transition=${data.transition}) for device ${deviceId}`);
            
            await pool.execute(
                'UPDATE mobile_devices SET at_home = ?, last_seen = ?, latitude = NULL, longitude = NULL WHERE id = ? AND home_id = ?',
                [atHome ? 1 : 0, new Date().toISOString(), deviceId, homeId]
            );

            // Trigger MQTT device tracker update
            const mqttPublisher = require('../../lib/mqtt-publisher');
            mqttPublisher.publishMobileDeviceTelemetry(homeId, deviceId, atHome, null, null, null, true).catch(() => { });

            // Auto-evaluate home/away presence
            const presenceHelper = require('../../lib/presence-helper');
            await presenceHelper.evaluateHomePresence(homeId);
        } else {
            _log('info', `[geolocation] Geolocation update received for device ${deviceId} but no transition parsed. Treating as check-in.`);
            
            // 1. Update last_seen
            await pool.execute(
                'UPDATE mobile_devices SET last_seen = ? WHERE id = ? AND home_id = ?',
                [new Date().toISOString(), deviceId, homeId]
            );

            // 2. Fetch current at_home to publish telemetry and evaluate presence
            const [rows] = await pool.execute(
                'SELECT at_home FROM mobile_devices WHERE id = ? AND home_id = ?',
                [deviceId, homeId]
            );
            if (rows.length > 0) {
                const atHome = Boolean(rows[0].at_home);
                const mqttPublisher = require('../../lib/mqtt-publisher');
                mqttPublisher.publishMobileDeviceTelemetry(homeId, deviceId, atHome, null, null, null, true).catch(() => { });
            }

            // 3. Auto-evaluate home/away presence
            const presenceHelper = require('../../lib/presence-helper');
            await presenceHelper.evaluateHomePresence(homeId);
        }
        res.status(204).end();
    } catch (err) {
        _log('error', `geolocation update error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
}

// PUT /api/v2/homes/{homeId}/mobileDevices/{deviceId}/geolocationFix
router.put('/:homeId/mobileDevices/:deviceId/geolocationFix', ensureGeofencingAuth, handleGeolocationUpdate);

// POST /api/v2/homes/{homeId}/mobileDevices/{deviceId}/token (Push Notifications)
router.post('/:homeId/mobileDevices/:deviceId/token', ensureGeofencingAuth, async (req, res) => {
    // Tado app sometimes sends push tokens here or just pings it. 
    // We don't have push infrastructure, so we just acknowledge it.
    res.status(204).end();
});

// GET /api/v2/homes/{homeId}/mobileDevices/{deviceId}/geolocationConfig
router.get('/:homeId/mobileDevices/:deviceId/geolocationConfig', ensureGeofencingAuth, async (req, res) => {
    try {
        const { homeId } = req.params;
        const pool = db.getPool();

        const [homes] = await pool.execute('SELECT latitude, longitude, away_radius_in_meters FROM homes WHERE id = ?', [homeId]);
        const home = homes[0] || {};

        const lat = parseFloat(home.latitude || 0);
        const lon = parseFloat(home.longitude || 0);
        const radius = parseInt(home.away_radius_in_meters || 397, 10);

        const regions = [];
        const base = 183;
        for (let i = 0; i < 20; i++) {
            regions.push(Math.round(base * Math.pow(1.3, i)));
        }

        const wifiRegion = Math.round(radius * 3.52);

        res.json({
            home: { geolocation: { latitude: lat, longitude: lon }, region: radius, wifiRegion },
            regions,
            desiredAccuracy: 200, maxAccuracy: 2500, distanceFilter: 200, maxAge: 60,
            providerUpdateInterval: 300, minIntervalBetweenSentUpdates: 60, minIntervalBetweenBackgroundUpdates: 1800,
            wakeupInterval: 14400
        });
    } catch (err) {
        _log('error', `geolocationConfig error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

module.exports = {
    router,
    ensureGeofencingAuth
};
