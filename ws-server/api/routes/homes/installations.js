/**
 * @file api/routes/homes/installations.js
 * @brief Home installations wizard endpoints.
 * 
 * Exposes routes to list physical device mounting setups, query specific installation states,
 * and mark installation processes as completed.
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

// --- lines 446 to 464 ---
router.get('/:homeId/installations', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const pool = db.getPool();
        const [rows] = await pool.execute('SELECT * FROM installations WHERE home_id = ?', [homeId]);
        const mappedInstallations = rows.map(r => ({
            id: r.id,
            type: r.type || 'HOME_KIT',
            revision: r.revision || 0,
            state: r.state || 'COMPLETED',
            devices: []
        }));
        res.json(mappedInstallations);
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/{homeId}/installations/{installationId}


// --- lines 465 to 484 ---
router.get('/:homeId/installations/:installationId', async (req, res) => {
    try {
        const { homeId, installationId } = req.params;
        const pool = db.getPool();
        const [rows] = await pool.execute('SELECT * FROM installations WHERE id = ? AND home_id = ?', [installationId, homeId]);
        if (rows.length === 0) return res.status(404).json({ error: 'Installation not found' });
        const r = rows[0];
        res.json({
            id: r.id,
            type: r.type || 'HOME_KIT',
            revision: r.revision || 0,
            state: r.state || 'COMPLETED',
            devices: []
        });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/{homeId}/heatingSystem


// --- lines 580 to 608 ---
router.get('/:homeId/deviceList', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const pool = db.getPool();
        const [devices] = await pool.execute('SELECT * FROM devices WHERE home_id = ?', [homeId]);

        const entries = devices.map(d => {
            const entry = {
                type: d.device_type,
                device: mapDevice(d)
            };

            if (d.zone_id) {
                entry.zone = { discriminator: parseInt(d.zone_id, 10) };
                if (['SU02', 'RU01', 'RU02', 'BU01'].includes(d.device_type)) {
                    entry.zone.duties = ['UI'];
                }
            }

            return entry;
        });

        res.json({ entries: entries });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/{homeId}/heatingCircuits


module.exports = router;