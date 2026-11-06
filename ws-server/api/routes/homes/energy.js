/**
 * @file api/routes/homes/energy.js
 * @brief Energy consumption estimation and tracking routes.
 * 
 * Computes energy usage metrics (hours of boiler activity, equivalent gas usage estimators)
 * for custom daily and monthly date ranges
 */

const express = require('express');
const db = require('../../../lib/db');
const energy = require('../../../lib/energy');
const gasEnergy = require('../../../lib/gas-energy-analyzer');
const mqttCommands = require('../../../lib/mqtt-commands');
const config = require('../../../lib/config');
const { getLogger } = require('../../../lib/logger');
const { mapDevice } = require('../../../lib/mappers');
const geoUtils = require('../../../lib/geo-utils');
const fs = require('fs');
const path = require('path');
const { buildHomeDetails, checkZoneConfigReadonly } = require('./helpers');

const router = express.Router();
const _log = getLogger('homes-api');

// --- Gas Energy & Cost Routes ---

// GET /api/v2/homes/{homeId}/energy/gas — gas usage and costs breakdown
router.get('/:homeId/energy/gas', async (req, res) => {
    try {
        const homeId = parseInt(req.params.homeId, 10);
        const pool = db.getPool();

        let from, to;
        if (req.query.from && req.query.to) {
            const fromStr = String(req.query.from).includes('T') ? req.query.from : `${req.query.from}T00:00:00Z`;
            const toStr = String(req.query.to).includes('T') ? req.query.to : `${req.query.to}T23:59:59Z`;
            from = new Date(fromStr);
            to = new Date(toStr);
            if (isNaN(from.getTime()) || isNaN(to.getTime())) {
                return res.status(400).json({ error: 'invalid_date_format' });
            }
        } else {
            const days = parseInt(req.query.days, 10) || 30;
            to = new Date();
            from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
        }

        const result = await gasEnergy.getGasUsageAndCosts(pool, homeId, from, to);
        res.json(result);
    } catch (err) {
        _log('error', `gas energy error: ${err.message}\n${err.stack}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/{homeId}/energy/gas/daily — daily gas usage & cost history
router.get('/:homeId/energy/gas/daily', async (req, res) => {
    try {
        const homeId = parseInt(req.params.homeId, 10);
        const pool = db.getPool();
        const days = parseInt(req.query.days, 10) || 30;

        const result = await gasEnergy.getDailyGasSummary(pool, homeId, days);
        res.json(result);
    } catch (err) {
        _log('error', `gas energy daily error: ${err.message}\n${err.stack}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/homes/{homeId}/energy/settings — get gas energy & tariff settings
router.get('/:homeId/energy/settings', async (req, res) => {
    try {
        const homeId = parseInt(req.params.homeId, 10);
        const pool = db.getPool();

        const settings = await gasEnergy.getHomeEnergySettings(pool, homeId);
        const latestReading = await gasEnergy.getLatestGasReading(pool, homeId);

        res.json({
            ...settings,
            latestReading
        });
    } catch (err) {
        _log('error', `energy settings error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/v2/homes/{homeId}/energy/settings — update gas energy settings
router.put('/:homeId/energy/settings', async (req, res) => {
    try {
        const homeId = parseInt(req.params.homeId, 10);
        const pool = db.getPool();

        const updated = await gasEnergy.saveHomeEnergySettings(pool, homeId, req.body || {});

        // Dynamically register custom MQTT topics if specified
        if (mqttCommands && mqttCommands.registerCustomEnergyTopic) {
            if (updated.gas_meter_topic && !updated.gas_meter_topic.includes('{homeId}')) {
                mqttCommands.registerCustomEnergyTopic(homeId, updated.gas_meter_topic, 'meter');
            }
            if (updated.gas_cost_topic && !updated.gas_cost_topic.includes('{homeId}')) {
                mqttCommands.registerCustomEnergyTopic(homeId, updated.gas_cost_topic, 'cost');
            }
        }

        const latestReading = await gasEnergy.getLatestGasReading(pool, homeId);
        res.json({
            ...updated,
            latestReading
        });
    } catch (err) {
        _log('error', `update energy settings error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// POST /api/v2/homes/{homeId}/energy/gas/reading — manually post a meter reading
router.post('/:homeId/energy/gas/reading', async (req, res) => {
    try {
        const homeId = parseInt(req.params.homeId, 10);
        const pool = db.getPool();
        const { meter_m3, unit_cost } = req.body || {};

        if (meter_m3 === undefined || meter_m3 === null || isNaN(parseFloat(meter_m3))) {
            return res.status(400).json({ error: 'meter_m3_required' });
        }

        const reading = await gasEnergy.recordGasMeterReading(pool, homeId, meter_m3, unit_cost, 'manual');
        res.status(201).json(reading);
    } catch (err) {
        _log('error', `post gas reading error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// --- Existing Boiler/Zone Activity Routes ---

router.get('/:homeId/energy', async (req, res) => {
    try {
        const homeId = parseInt(req.params.homeId, 10);
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
router.get('/:homeId/energy/daily', async (req, res) => {
    try {
        const homeId = parseInt(req.params.homeId, 10);
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