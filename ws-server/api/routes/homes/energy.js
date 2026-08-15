/**
 * @file api/routes/homes/energy.js
 * @brief Energy consumption estimation and tracking routes.
 * 
 * Computes energy usage metrics (hours of boiler activity, equivalent gas usage estimators)
 * for custom daily and monthly date ranges to emulate Tado energy saving dashboards.
 */

const express = require('express');
const db = require('../../../lib/db');
const energy = require('../../../lib/energy');
const config = require('../../../lib/config');
const { getLogger } = require('../../../lib/logger');
const { mapDevice } = require('../../../lib/mappers');
const geoUtils = require('../../../lib/geo-utils');
const fs = require('fs');
const path = require('path');
const { buildHomeDetails, checkZoneConfigReadonly } = require('./helpers');

const router = express.Router();
const _log = getLogger('homes-api');

// --- lines 1203 to 1219 ---
router.get('/:homeId/energy', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const pool = db.getPool();
        const days = parseInt(req.query.days) || 30;
        const to = new Date();
        const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

        const result = await energy.getHomeEnergyUsage(pool, homeId, from, to);
        res.json(result);
    } catch (err) {
        _log('error', `energy error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/{homeId}/energy/daily — daily energy summary


// --- lines 1220 to 1234 ---
router.get('/:homeId/energy/daily', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const pool = db.getPool();
        const days = parseInt(req.query.days) || 30;

        const result = await energy.getDailyEnergySummary(pool, homeId, days);
        res.json(result);
    } catch (err) {
        _log('error', `energy/daily error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/{homeId}/zones/{zoneId}/energy — zone-specific energy usage


// --- lines 1235 to 1252 ---
router.get('/:homeId/zones/:zoneId/energy', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const pool = db.getPool();
        const days = parseInt(req.query.days) || 30;
        const to = new Date();
        const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

        const result = await energy.getZoneEnergyUsage(pool, homeId, zoneId, from, to);
        res.json({ zoneId: parseInt(zoneId, 10), homeId: parseInt(homeId, 10), ...result });
    } catch (err) {
        _log('error', `zone energy error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

module.exports = router;



module.exports = router;