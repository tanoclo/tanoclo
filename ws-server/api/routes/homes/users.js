/**
 * @file api/routes/homes/users.js
 * @brief User invitations and home membership management.
 * 
 * Supports sending/revoking home invitations, retrieving member lists, and updating
 * administrative designations (such as is_tanoclo_admin).
 */

const express = require('express');
const db = require('../../../lib/db');
const config = require('../../../lib/config');
const { getLogger } = require('../../../lib/logger');
const { mapDevice } = require('../../../lib/mappers');
const geoUtils = require('../../../lib/geo-utils');
const fs = require('fs');
const path = require('path');
const { buildHomeDetails, checkZoneConfigReadonly } = require('./helpers');

const router = express.Router();
const _log = getLogger('homes-api');

// --- lines 694 to 739 ---
router.get('/:homeId/invitations', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const pool = db.getPool();

        const [invitations] = await pool.execute(`
            SELECT i.token, i.email, i.created_at, i.inviter_user_id,
                   u.name AS inviter_name, u.email AS inviter_email, u.username AS inviter_username, u.locale AS inviter_locale
            FROM invitations i
            LEFT JOIN users u ON i.inviter_user_id = u.id
            WHERE i.home_id = ?
        `, [homeId]);
        const [homes] = await pool.execute('SELECT * FROM homes WHERE id = ?', [homeId]);

        if (homes.length === 0) return res.status(404).json({ error: 'Home not found' });
        const homeDetails = await buildHomeDetails(homes[0]);

        const response = [];
        for (const invite of invitations) {
            response.push({
                token: invite.token,
                email: invite.email,
                firstSent: invite.created_at ? new Date(invite.created_at).toISOString() : new Date().toISOString(),
                lastSent: invite.created_at ? new Date(invite.created_at).toISOString() : new Date().toISOString(),
                inviter: {
                    name: invite.inviter_name || 'Unknown',
                    email: invite.inviter_email || '',
                    username: invite.inviter_username || '',
                    enabled: true,
                    id: invite.inviter_user_id,
                    homeId: parseInt(homeId, 10),
                    locale: invite.inviter_locale || 'en',
                    type: "WEB_USER"
                },
                home: homeDetails
            });
        }

        res.json(response);
    } catch (err) {
        _log('error', `getInvitations error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// POST /api/v2/homes/{homeId}/invitations


// --- lines 740 to 785 ---
router.post('/:homeId/invitations', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required' });

        const pool = db.getPool();
        const inviterUserId = req.user.id;

        let [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
        let targetUserId;
        if (users.length === 0) {
            targetUserId = require('crypto').randomUUID();
            const bcrypt = require('bcryptjs');
            const hashed = await bcrypt.hash('tanoclo2026', 10);
            const [homes] = await pool.execute('SELECT language FROM homes WHERE id = ?', [homeId]);
            const lang = homes[0]?.language || 'en';
            await pool.execute('INSERT INTO users (id, name, email, username, password, locale) VALUES (?, ?, ?, ?, ?, ?)', [targetUserId, email, email, email, hashed, lang]);
        } else {
            targetUserId = users[0].id;
        }

        await pool.execute('UPDATE users SET home_id = ? WHERE id = ?', [homeId, targetUserId]);

        const token = require('crypto').randomBytes(16).toString('hex');
        await pool.execute('INSERT INTO invitations (token, home_id, email, inviter_user_id, created_at) VALUES (?, ?, ?, ?, ?)', [token, homeId, email, inviterUserId, new Date().toISOString()]);

        const [homeRows] = await pool.execute('SELECT * FROM homes WHERE id = ?', [homeId]);
        const homeDetails = await buildHomeDetails(homeRows[0]);
        const [inviters] = await pool.execute('SELECT * FROM users WHERE id = ?', [inviterUserId]);
        const inviter = inviters[0];

        res.status(201).json({
            token, email, firstSent: new Date().toISOString(), lastSent: new Date().toISOString(),
            inviter: {
                name: inviter.name, email: inviter.email, username: inviter.username, enabled: true, id: inviter.id,
                homeId: parseInt(homeId, 10), locale: inviter.locale || 'en', type: "WEB_USER"
            },
            home: homeDetails
        });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// DELETE /api/v2/homes/{homeId}/invitations/{token}


// --- lines 786 to 805 ---
router.delete('/:homeId/invitations/:token', async (req, res) => {
    try {
        const { homeId, token } = req.params;
        const pool = db.getPool();
        const [invites] = await pool.execute('SELECT email FROM invitations WHERE home_id = ? AND token = ?', [homeId, token]);
        if (invites.length === 0) return res.status(404).json({ error: 'Invitation not found' });

        const email = invites[0].email;
        const [users] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
        if (users.length > 0) {
            await pool.execute('DELETE FROM users WHERE id = ?', [users[0].id]);
        }
        await pool.execute('DELETE FROM invitations WHERE home_id = ? AND token = ?', [homeId, token]);
        res.status(204).end();
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// POST /api/v2/homes/{homeId}/invitations/{token}/resend


// --- lines 806 to 818 ---
router.post('/:homeId/invitations/:token/resend', async (req, res) => {
    try {
        const { homeId, token } = req.params;
        const pool = db.getPool();
        const [updateRes] = await pool.execute('UPDATE invitations SET created_at = ? WHERE home_id = ? AND token = ?', [new Date().toISOString(), homeId, token]);
        if (updateRes.affectedRows === 0) return res.status(404).json({ error: 'Invitation not found' });
        res.status(204).end();
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/v2/homes/{homeId}/zoneOrder


// --- lines 848 to 860 ---
router.get('/:homeId/emailNotificationSettings', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const pool = db.getPool();
        const [homes] = await pool.execute('SELECT email_low_battery_reminder FROM homes WHERE id = ?', [homeId]);
        const settings = { lowBatteryReminder: homes[0] ? Boolean(homes[0].email_low_battery_reminder) : true };
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// PATCH /api/v2/homes/{homeId}/emailNotificationSettings


// --- lines 861 to 875 ---
router.patch('/:homeId/emailNotificationSettings', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const { lowBatteryReminder } = req.body;
        if (lowBatteryReminder === undefined) return res.status(400).json({ error: 'Missing lowBatteryReminder' });

        const pool = db.getPool();
        await pool.execute('UPDATE homes SET email_low_battery_reminder = ? WHERE id = ?', [lowBatteryReminder ? 1 : 0, homeId]);
        res.json({ lowBatteryReminder: Boolean(lowBatteryReminder) });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/{homeId}/state


// --- lines 982 to 1107 ---
router.get('/:homeId/users', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const pool = db.getPool();
        const [homes] = await pool.execute('SELECT * FROM homes WHERE id = ?', [homeId]);
        const home = homes[0] || null;

        // Determine admin user ID
        let adminUserId = home ? home.admin_user_id : null;
        const [users] = await pool.execute(
            `SELECT u.* FROM users u
             WHERE u.home_id = ?`,
            [homeId]
        );

        if (!adminUserId && users.length > 0) {
            adminUserId = users[0].id;
        }

        const [mobileDevices] = await pool.execute('SELECT * FROM mobile_devices WHERE home_id = ?', [homeId]);

        const requesterUserObj = users.find(u => u.id === req.user.id);
        const requesterIsTaNoCloAdmin = requesterUserObj ? (requesterUserObj.is_tanoclo_admin === 1) : false;
        const requestorIsAdmin = (req.user.id === adminUserId || requesterIsTaNoCloAdmin);

        const mappedUsers = [];
        for (const u of users) {
            const isCurrentUser = (u.id === req.user.id);
            const isTadoAdmin = (u.id === adminUserId);
            const isTaNoCloAdmin = (u.is_tanoclo_admin === 1);
            const isAdmin = isTadoAdmin || isTaNoCloAdmin;
            const showFullDetails = isCurrentUser || requestorIsAdmin;

            const userHome = {
                id: parseInt(homeId, 10),
                name: home ? home.name : '',
                isAdmin: isAdmin,
                isTadoAdmin: isTadoAdmin,
                isTaNoCloAdmin: isTaNoCloAdmin
            };

            const userObj = {
                name: u.name,
                id: u.id,
                homes: [userHome]
            };

            if (showFullDetails) {
                userObj.email = u.email;
                userObj.username = u.username;
                userObj.locale = u.locale || 'en';

                const userDevices = mobileDevices.filter(md => md.user_id == u.id).map(md => {
                    let bearing = { degrees: 0.0, radians: 0.0 };
                    let relativeDistance = 0.0;

                    if (home && md.latitude !== null && md.longitude !== null && home.latitude && home.longitude) {
                        const homeLat = parseFloat(home.latitude);
                        const homeLon = parseFloat(home.longitude);
                        const devLat = parseFloat(md.latitude);
                        const devLon = parseFloat(md.longitude);

                        const dist = geoUtils.haversineDistance(homeLat, homeLon, devLat, devLon);
                        const radius = parseFloat(home.away_radius_in_meters || 200);
                        relativeDistance = dist - radius;

                        const brngRad = geoUtils.calculateBearing(homeLat, homeLon, devLat, devLon);
                        bearing = {
                            degrees: geoUtils.radiansToDegrees(brngRad),
                            radians: brngRad
                        };
                    }

                    const settings = {
                        geoTrackingEnabled: Boolean(md.geo_tracking_enabled),
                        specialOffersEnabled: Boolean(md.special_offers_enabled),
                        onDemandLogRetrievalEnabled: Boolean(md.on_demand_log_retrieval_enabled),
                        smartRemindersInAppEnabled: Boolean(md.smart_reminders_in_app_enabled),
                    };

                    if (md.push_notifications_json) {
                        try {
                            settings.pushNotifications = JSON.parse(md.push_notifications_json);
                        } catch (e) {}
                    }

                    const deviceObj = {
                        name: md.name,
                        id: parseInt(md.id, 10),
                        settings: settings,
                        deviceMetadata: {
                            platform: md.platform || 'Unknown',
                            osVersion: md.os_version || 'Unknown',
                            model: md.model || 'Unknown',
                            locale: md.locale || 'en'
                        }
                    };

                    if (settings.geoTrackingEnabled) {
                        deviceObj.location = {
                            stale: md.last_seen ? (Date.now() - new Date(md.last_seen).getTime() > 24 * 60 * 60 * 1000) : true,
                            atHome: Boolean(md.at_home),
                            bearingFromHome: bearing,
                            relativeDistanceFromHomeFence: relativeDistance,
                            lastSeen: md.last_seen || null
                        };
                    } else {
                        deviceObj.location = null;
                    }

                    return deviceObj;
                });

                userObj.mobileDevices = userDevices;
            }

            mappedUsers.push(userObj);
        }

        res.json(mappedUsers);
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/homes/{homeId}/skills


module.exports = router;