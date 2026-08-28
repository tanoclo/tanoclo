/**
 * @file api/routes/homes/base.js
 * @brief Base routes managing home properties, presence states, and geofencing.
 * 
 * Exposes API endpoints to retrieve general home metadata lists, modify geolocation parameters
 * (latitude, longitude, geofencing boundary radius), change temperature Unit metrics (Celsius/Fahrenheit),
 * and toggle auto-assist/geofencing rules.
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

router.get('/:homeId', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const pool = db.getPool();
        const [homes] = await pool.execute('SELECT * FROM homes WHERE id = ?', [homeId]);

        if (homes.length === 0) return res.status(404).json({ error: 'Home not found' });

        const details = await buildHomeDetails(homes[0], req.user.id);
        res.json(details);
    } catch (err) {
        _log('error', `getHome error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/v2/homes/{homeId}/awayRadiusInMeters
router.put('/:homeId/awayRadiusInMeters', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const { awayRadiusInMeters } = req.body;
        if (awayRadiusInMeters === undefined) return res.status(400).json({ error: 'Missing awayRadiusInMeters' });

        const pool = db.getPool();
        await pool.execute('UPDATE homes SET away_radius_in_meters = ? WHERE id = ?', [parseFloat(awayRadiusInMeters), homeId]);

        res.json({ awayRadiusInMeters: parseFloat(awayRadiusInMeters) });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/v2/homes/{homeId}/geolocation
router.put('/:homeId/geolocation', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const { latitude, longitude } = req.body;
        if (latitude === undefined || longitude === undefined) return res.status(400).json({ error: 'Missing parameters' });

        const pool = db.getPool();
        await pool.execute('UPDATE homes SET latitude = ?, longitude = ? WHERE id = ?', [parseFloat(latitude), parseFloat(longitude), homeId]);

        res.json({ latitude: parseFloat(latitude), longitude: parseFloat(longitude) });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/{homeId}/details
router.get('/:homeId/details', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const pool = db.getPool();
        const [homes] = await pool.execute('SELECT * FROM homes WHERE id = ?', [homeId]);
        if (homes.length === 0) return res.status(404).json({ error: 'Home not found' });
        const home = homes[0];

        res.json({
            name: home.name,
            address: {
                addressLine1: home.address_line1 || '',
                addressLine2: home.address_line2 || '',
                zipCode: home.address_zip_code || '',
                city: home.address_city || '',
                state: home.address_state || '',
                country: home.address_country || ''
            },
            contactDetails: {
                name: home.contact_name || '',
                email: home.contact_email || '',
                phone: home.contact_phone || ''
            },
            cartoApiKey: config.cartoApiKey || ''
        });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/v2/homes/{homeId}/details
router.put('/:homeId/details', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const { address, contactDetails, name } = req.body;
        const pool = db.getPool();

        const updates = [];
        const params = [];
        if (address) {
            updates.push('address_line1 = ?', 'address_line2 = ?', 'address_zip_code = ?', 'address_city = ?', 'address_state = ?', 'address_country = ?');
            params.push(address.addressLine1 || '', address.addressLine2 || '', address.zipCode || '', address.city || '', address.state || '', address.country || '');
        }
        if (contactDetails) {
            updates.push('contact_name = ?', 'contact_email = ?', 'contact_phone = ?');
            params.push(contactDetails.name || '', contactDetails.email || '', contactDetails.phone || '');
        }
        if (name) { updates.push('name = ?'); params.push(name); }

        if (updates.length > 0) {
            params.push(homeId);
            await pool.execute(`UPDATE homes SET ${updates.join(', ')} WHERE id = ?`, params);
        }

        const [homes] = await pool.execute('SELECT * FROM homes WHERE id = ?', [homeId]);
        const details = await buildHomeDetails(homes[0], req.user.id);
        res.json(details);
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

router.put('/:homeId/zoneOrder', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const data = req.body;
        if (!Array.isArray(data)) return res.status(400).json({ error: 'Invalid input' });

        const ids = data.map(item => item.id || item);
        const pool = db.getPool();

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            for (let i = 0; i < ids.length; i++) {
                await connection.execute('UPDATE zones SET display_order = ? WHERE id = ? AND home_id = ?', [i, ids[i], homeId]);
            }
            await connection.commit();
        } catch (e) {
            await connection.rollback();
            throw e;
        } finally {
            connection.release();
        }
        res.status(204).end();
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/{homeId}/emailNotificationSettings
router.get('/:homeId/state', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const pool = db.getPool();
        const [homes] = await pool.execute('SELECT presence, presence_locked FROM homes WHERE id = ?', [homeId]);
        if (homes.length === 0) return res.status(404).json({ error: 'Home not found' });
        const presenceLocked = Boolean(homes[0].presence_locked);
        const [devices] = await pool.execute('SELECT 1 FROM mobile_devices WHERE home_id = ? AND geo_tracking_enabled = 1 LIMIT 1', [homeId]);
        const hasGeofencingDevice = devices.length > 0;

        res.json({
            presence: homes[0].presence || 'HOME',
            presenceLocked: presenceLocked,
            showSwitchToAutoGeofencingButton: presenceLocked && hasGeofencingDevice
        });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/v2/homes/{homeId}/admin/{adminUserId}
router.put('/:homeId/admin/:adminUserId', async (req, res) => {
    try {
        const { homeId, adminUserId } = req.params;
        const pool = db.getPool();

        // 1. Fetch home
        const [homes] = await pool.execute('SELECT * FROM homes WHERE id = ?', [homeId]);
        if (homes.length === 0) {
            return res.status(404).json({ error: 'Home not found' });
        }
        const home = homes[0];

        // 2. Determine current admin
        let currentAdminId = home.admin_user_id;
        if (!currentAdminId) {
            const [homeUsers] = await pool.execute('SELECT id FROM users WHERE home_id = ? LIMIT 1', [homeId]);
            if (homeUsers.length > 0) {
                currentAdminId = homeUsers[0].id;
            }
        }

        // 3. Verify logged-in user is the current admin
        if (req.user.id !== currentAdminId) {
            return res.status(403).json({ error: 'forbidden', error_description: 'Only the current admin can transfer admin rights' });
        }

        // 4. Verify the new admin is a member of the home
        const [newAdminMember] = await pool.execute('SELECT 1 FROM users WHERE home_id = ? AND id = ?', [homeId, adminUserId]);
        if (newAdminMember.length === 0) {
            return res.status(400).json({ error: 'bad_request', error_description: 'The new admin must be a member of the home' });
        }

        // 5. Update admin_user_id in homes table
        await pool.execute('UPDATE homes SET admin_user_id = ? WHERE id = ?', [adminUserId, homeId]);

        res.status(204).end();
    } catch (err) {
        _log('error', `Error transferring admin: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/v2/homes/{homeId}/presenceLock
router.put('/:homeId/presenceLock', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const { homePresence } = req.body;
        const presenceHelper = require('../../../lib/presence-helper');
        await presenceHelper.setManualPresenceLock(homeId, homePresence || 'HOME');
        res.json({ presenceLocked: true, presence: homePresence || 'HOME' });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// DELETE /api/v2/homes/{homeId}/presenceLock
router.delete('/:homeId/presenceLock', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const presenceHelper = require('../../../lib/presence-helper');
        await presenceHelper.removePresenceLock(homeId);
        res.status(204).end();
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/{homeId}/users
router.get('/:homeId/skills', async (req, res) => {
    res.json({
        "AUTO_ASSIST": [{
            "source": "SUBSCRIPTION",
            "productId": "com.tado.skills.autoassist",
            "startDate": "2026-01-01T00:00:00.000Z",
            "expirationDate": "2040-01-01T00:00:00.000Z",
            "status": "ACTIVE",
            "billingPeriod": "MONTHLY",
            "freeTrial": { "active": false },
            "store": "google",
            "fromRequestingUser": true
        }],
        "PRE_2025_FREE_FEATURES": [{
            "source": "TADO_MANAGED",
            "status": "ACTIVE",
            "type": "TADO_MANAGED",
            "startDate": "2026-01-01T00:00:00.000Z"
        }]
    });
});

module.exports = router;