/**
 * @file api/routes/users.js
 * @brief REST routes managing user profiles, settings, and linked home accounts.
 * 
 * Implements endpoints to retrieve user profiles, update usernames/passwords,
 * link mobile clients, and fetch general user mappings.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../../lib/db');
const authMiddleware = require('../middleware/auth');
const jwt = require('jsonwebtoken');
const { getLogger } = require('../../lib/logger');
const geoUtils = require('../../lib/geo-utils');
const { mapMobileDevice } = require('../../lib/mappers');

const router = express.Router();
const _log = getLogger('users-api');

// Map User
function mapUser(user, homes, mobileDevices) {
    return {
        name: user.name,
        email: user.email,
        username: user.username,
        id: user.id,
        locale: user.locale,
        homes: homes.map(h => ({ id: isNaN(Number(h.id)) ? h.id : parseInt(h.id, 10), name: h.name })),
        mobileDevices: mobileDevices.map(d => {
            const home = homes.find(h => h.id === d.home_id);
            return mapMobileDevice(d, home);
        })
    };
}

// Helper to fetch user full data
async function getFullUserData(pool, userId) {
    const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
    if (users.length === 0) return null;
    const [homes] = await pool.execute(
        'SELECT h.* FROM homes h JOIN home_users hu ON h.id = hu.home_id WHERE hu.user_id = ?',
        [userId]
    );
    const [mobileDevices] = await pool.execute('SELECT * FROM mobile_devices WHERE user_id = ?', [userId]);
    return mapUser(users[0], homes, mobileDevices);
}

// PUT /api/v2/users/{userId}
router.put('/:userId', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { locale, name } = req.body;
        const pool = db.getPool();

        if (locale) {
            await pool.execute('UPDATE users SET locale = ? WHERE id = ?', [locale, userId]);

            await pool.execute('DELETE FROM oauth_access_tokens WHERE user_id = ?', [userId]);
            await pool.execute('DELETE FROM oauth_refresh_tokens WHERE user_id = ?', [userId]);

            const domainParts = req.hostname.split('.');
            const domain = domainParts.length >= 2 ? '.' + domainParts.slice(-2).join('.') : undefined;
            const cookieSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';

            res.clearCookie('tanoclo_session', { domain, httpOnly: true, secure: cookieSecure, sameSite: 'lax' });

            res.cookie('tado_locale', locale, {
                maxAge: 31536000000,
                domain,
                path: '/',
                secure: cookieSecure,
                sameSite: 'lax'
            });

            const userData = await getFullUserData(pool, userId);
            if (!userData) return res.status(404).json({ error: 'not_found' });
            return res.json(userData);
        }

        if (name) {
            await pool.execute('UPDATE users SET name = ? WHERE id = ?', [name, userId]);
        }

        const userData = await getFullUserData(pool, userId);
        if (!userData) return res.status(404).json({ error: 'not_found' });
        res.json(userData);
    } catch (err) {
        _log('error', `PUT user error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// Email format validation regex (RFC 5322 simplified)
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Password strength: minimum 8 chars, at least 1 number or special character
function validatePassword(password) {
    if (!password || password.length < 8) return 'Password must be at least 8 characters long';
    if (!/[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) return 'Password must contain at least one number or special character';
    return null;
}

// Shared handler for email change (used by PUT and POST routes)
async function changeEmailHandler(req, res) {
    try {
        const userId = req.user.id;
        const { email, currentPassword } = req.body;
        if (!email || !currentPassword) return res.status(400).json({ error: 'Missing email or currentPassword' });

        if (!EMAIL_REGEX.test(email)) return res.status(400).json({ error: 'Invalid email format' });

        const pool = db.getPool();
        const [users] = await pool.execute('SELECT password FROM users WHERE id = ?', [userId]);
        if (users.length === 0) return res.status(404).json({ error: 'User not found' });

        const valid = await bcrypt.compare(currentPassword, users[0].password);
        if (!valid) return res.status(400).json({ error: 'Invalid current password' });

        await pool.execute('UPDATE users SET email = ?, username = ? WHERE id = ?', [email, email, userId]);
        res.json({});
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
}

// PUT /api/v2/users/{userId}/email
router.put('/:userId/email', authMiddleware, changeEmailHandler);

// Shared handler for password change (used by PUT and POST routes)
async function changePasswordHandler(req, res) {
    try {
        const userId = req.user.id;
        const { password, currentPassword } = req.body;
        if (!password || !currentPassword) return res.status(400).json({ error: 'Missing password or currentPassword' });

        const passwordError = validatePassword(password);
        if (passwordError) return res.status(400).json({ error: passwordError });

        const pool = db.getPool();
        const [users] = await pool.execute('SELECT password FROM users WHERE id = ?', [userId]);
        if (users.length === 0) return res.status(404).json({ error: 'User not found' });

        const valid = await bcrypt.compare(currentPassword, users[0].password);
        if (!valid) return res.status(400).json({ error: 'Invalid current password' });

        const hashed = await bcrypt.hash(password, 10);
        await pool.execute('UPDATE users SET password = ? WHERE id = ?', [hashed, userId]);
        res.json({});
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
}

// PUT /api/v2/users/{userId}/password
router.put('/:userId/password', authMiddleware, changePasswordHandler);

// --- Mobile Device Helper ---
async function registerOrUpdateDevice(pool, username, data) {
    const [users] = await pool.execute('SELECT * FROM users WHERE username = ? OR email = ?', [username, username]);
    if (users.length === 0) throw new Error('user_not_found');
    const user = users[0];

    const [homeUsers] = await pool.execute('SELECT home_id FROM home_users WHERE user_id = ? LIMIT 1', [user.id]);
    if (homeUsers.length === 0) throw new Error('no_home_found');
    const homeId = homeUsers[0].home_id;

    const metadata = data.metadata || data || {};
    const deviceMeta = metadata.device || {};

    const platform = deviceMeta.platform || 'Android';
    const osVersion = deviceMeta.osVersion || 'Unknown';
    const model = deviceMeta.model || 'Unknown';
    const locale = deviceMeta.locale || 'en';
    const deviceName = model.split('_')[0].replace(/_/g, '');

    let deviceId = data.mobileDeviceId;
    let existing = [];

    if (deviceId) {
        [existing] = await pool.execute('SELECT * FROM mobile_devices WHERE id = ?', [deviceId]);
    } else {
        [existing] = await pool.execute('SELECT * FROM mobile_devices WHERE user_id = ? AND home_id = ? AND model = ?', [user.id, homeId, model]);
    }

    if (existing.length === 0) {
        // Clean up any old duplicate devices for the same user with same model or name
        try {
            const [oldDevices] = await pool.execute(
                'SELECT id FROM mobile_devices WHERE user_id = ? AND home_id = ? AND (model = ? OR name = ?)',
                [user.id, homeId, model, deviceName]
            );
            for (const oldDev of oldDevices) {
                _log('info', `[registerOrUpdateDevice] Removing duplicate device ${oldDev.id} for user ${user.id}`);
                await pool.execute('DELETE FROM mobile_devices WHERE id = ?', [oldDev.id]);

                try {
                    const mqttHaDiscovery = require('../../lib/mqtt-ha-discovery');
                    mqttHaDiscovery.unpublishMobileDevice(oldDev.id);
                } catch (discoveryErr) {
                    _log('warn', `[registerOrUpdateDevice] Failed to unpublish discovery for old device ${oldDev.id}: ${discoveryErr.message}`);
                }
                try {
                    const mqttPublisher = require('../../lib/mqtt-publisher');
                    mqttPublisher.publishMobileDeviceTelemetry(homeId, oldDev.id, false, null, null, null, false).catch(() => { });
                } catch (pubErr) {
                    // ignore
                }
            }
        } catch (cleanupErr) {
            _log('error', `[registerOrUpdateDevice] Failed to cleanup duplicate devices: ${cleanupErr.message}`);
        }

        if (!deviceId) {
            deviceId = Math.floor(Math.random() * (99999999 - 10000000 + 1)) + 10000000;
        }
        await pool.execute(
            `INSERT INTO mobile_devices (
                id, name, user_id, home_id, platform, os_version, model, locale, 
                geo_tracking_enabled, special_offers_enabled, on_demand_log_retrieval_enabled, smart_reminders_in_app_enabled, at_home, last_seen
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 1, 0, 1, ?)`,
            [deviceId, deviceName, user.id, homeId, platform, osVersion, model, locale, new Date().toISOString()]
        );
    } else {
        deviceId = existing[0].id;
        await pool.execute('UPDATE mobile_devices SET platform = ?, os_version = ?, locale = ?, last_seen = ? WHERE id = ?', [platform, osVersion, locale, new Date().toISOString(), deviceId]);
    }

    const crypto = require('crypto');
    const token = Buffer.from(`${deviceId}|${crypto.randomBytes(32).toString('hex')}`).toString('base64');
    await pool.execute('UPDATE mobile_devices SET geofencing_access_token = ? WHERE id = ?', [token, deviceId]);

    return {
        mobileDeviceIdValue: parseInt(deviceId, 10),
        geofencingAccessToken: token
    };
}

// DELETE /api/v2/homes/{homeId}/users/{username}
router.delete('/homes/:homeId/users/:username', authMiddleware, async (req, res) => {
    try {
        const { homeId, username } = req.params;
        const pool = db.getPool();

        const [users] = await pool.execute('SELECT id FROM users WHERE username = ?', [decodeURIComponent(username)]);
        if (users.length === 0) return res.status(204).end();

        const targetUserId = users[0].id;

        const requesterStatus = await db.getAdminStatus(homeId, req.user.id);
        if (!requesterStatus.isFound) {
            return res.status(404).json({ error: 'Home not found' });
        }

        const isRemovingSelf = (targetUserId === req.user.id);
        if (!isRemovingSelf) {
            if (!requesterStatus.isAdmin) {
                return res.status(403).json({ error: 'forbidden', error_description: 'Only admins can remove members' });
            }
            if (requesterStatus.isTaNoCloAdmin && targetUserId === requesterStatus.adminUserId) {
                return res.status(403).json({ error: 'forbidden', error_description: 'TaNoClo admins cannot remove the Tado admin' });
            }
        }

        // Fetch mobile devices to unpublish from HA MQTT
        const [devicesToUnpublish] = await pool.execute('SELECT id FROM mobile_devices WHERE user_id = ? AND home_id = ?', [targetUserId, homeId]);

        await pool.execute('DELETE FROM mobile_devices WHERE user_id = ? AND home_id = ?', [targetUserId, homeId]);
        await pool.execute('DELETE FROM home_users WHERE home_id = ? AND user_id = ?', [homeId, targetUserId]);

        // Cleanup MQTT trackers config and telemetry
        const mqttPublisher = require('../../lib/mqtt-publisher');
        const mqttHaDiscovery = require('../../lib/mqtt-ha-discovery');
        for (const md of devicesToUnpublish) {
            mqttHaDiscovery.unpublishMobileDevice(md.id);
            mqttPublisher.publishMobileDeviceTelemetry(homeId, md.id, false, null, null, null, false).catch(() => { });
        }

        const [counts] = await pool.execute('SELECT COUNT(*) as c FROM home_users WHERE user_id = ?', [targetUserId]);
        if (counts[0].c === 0) {
            await pool.execute('DELETE FROM users WHERE id = ?', [targetUserId]);
        }

        res.status(204).end();
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// POST /api/v2/users/{username}/mobileDevices
router.post('/:username/mobileDevices', authMiddleware, async (req, res) => {
    try {
        const username = decodeURIComponent(req.params.username);
        const result = await registerOrUpdateDevice(db.getPool(), username, req.body);
        res.json(result);
    } catch (err) {
        if (err.message === 'user_not_found') return res.status(404).json({ error: 'User not found' });
        if (err.message === 'no_home_found') return res.status(404).json({ error: 'No home found for user' });
        _log('error', `POST mobileDevices error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// POST /api/user/changeEmail — legacy v1 compat, delegates to shared handler
router.post('/api/user/changeEmail', authMiddleware, async (req, res) => {
    // Delegate to the same handler as PUT /:userId/email
    req.params.userId = req.user.id;
    return changeEmailHandler(req, res);
});

// POST /api/user/changePassword — legacy v1 compat, delegates to shared handler
router.post('/api/user/changePassword', authMiddleware, async (req, res) => {
    // Delegate to the same handler as PUT /:userId/password
    req.params.userId = req.user.id;
    return changePasswordHandler(req, res);
});

// GET /users/:username/iterable
router.get('/:username/iterable', async (req, res) => {
    try {
        const username = decodeURIComponent(req.params.username);
        const pool = db.getPool();

        const [users] = await pool.execute('SELECT * FROM users WHERE username = ? OR email = ?', [username, username]);
        if (users.length === 0) return res.status(404).json({ error: 'User not found' });
        const user = users[0];

        const now = Math.floor(Date.now() / 1000);
        const payload = {
            exp: now + 3600,
            iat: now,
            email: user.email
        };

        const config = require('../../lib/config');
        const token = jwt.sign(payload, config.jwtSecret);

        res.json({ token: token });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// PATCH /api/user
router.patch('/api/user', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { locale, name } = req.body;
        const pool = db.getPool();

        if (locale) {
            await pool.execute('UPDATE users SET locale = ? WHERE id = ?', [locale, userId]);

            await pool.execute('DELETE FROM oauth_access_tokens WHERE user_id = ?', [userId]);
            await pool.execute('DELETE FROM oauth_refresh_tokens WHERE user_id = ?', [userId]);

            const domainParts = req.hostname.split('.');
            const domain = domainParts.length >= 2 ? '.' + domainParts.slice(-2).join('.') : undefined;
            const cookieSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';

            res.clearCookie('tanoclo_session', { domain, httpOnly: true, secure: cookieSecure, sameSite: 'lax' });

            res.cookie('tado_locale', locale, {
                maxAge: 31536000000,
                domain,
                path: '/',
                secure: cookieSecure,
                sameSite: 'lax'
            });

            const userData = await getFullUserData(pool, userId);
            if (!userData) return res.status(404).json({ error: 'not_found' });
            return res.json(userData);
        }

        if (name) {
            await pool.execute('UPDATE users SET name = ? WHERE id = ?', [name, userId]);
        }

        const userData = await getFullUserData(pool, userId);
        if (!userData) return res.status(404).json({ error: 'not_found' });
        res.json(userData);
    } catch (err) {
        _log('error', `PATCH user error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// POST /api/v2/users/{username}/mobileDeviceClaim
router.post('/:username/mobileDeviceClaim', authMiddleware, async (req, res) => {
    try {
        const username = decodeURIComponent(req.params.username);
        const result = await registerOrUpdateDevice(db.getPool(), username, req.body);
        res.json(result);
    } catch (err) {
        if (err.message === 'user_not_found') return res.status(404).json({ error: 'User not found' });
        if (err.message === 'no_home_found') return res.status(404).json({ error: 'No home found for user' });
        _log.error(err);
        res.status(500).json({ error: 'internal_error' });
    }
});

module.exports = router;