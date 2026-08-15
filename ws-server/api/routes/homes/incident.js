/**
 * @file api/routes/homes/incident.js
 * @brief Incident detection settings endpoints for homes.
 * 
 * Supports reading and updating the incident detection enabled status parameters
 * for auto-assist warnings.
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

// --- lines 550 to 562 ---
router.get('/:homeId/incidentDetection', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const pool = db.getPool();
        const [homes] = await pool.execute('SELECT incident_detection_enabled FROM homes WHERE id = ?', [homeId]);
        const enabled = Boolean(homes[0]?.incident_detection_enabled);
        res.json({ supported: true, enabled: enabled });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/v2/homes/{homeId}/incidentDetection


// --- lines 563 to 579 ---
router.put('/:homeId/incidentDetection', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const { enabled } = req.body;
        const pool = db.getPool();
        await pool.execute('UPDATE homes SET incident_detection_enabled = ? WHERE id = ?', [enabled ? 1 : 0, homeId]);
        res.status(204).end();
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// mapDevice is imported from lib/mappers.js

// GET /:homeId/devices is handled by devices.js (canonical handler)

// GET /api/v2/homes/{homeId}/deviceList


module.exports = router;