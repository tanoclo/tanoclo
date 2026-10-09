/**
 * @file api/routes/homes/balancing.js
 * @brief Advisory hydraulic balancing endpoints for homes.
 * 
 * Provides endpoints to compute rise-rate balancing recommendations,
 * batch-apply suggested valve sensitivity settings to physical TRVs,
 * and view historical analysis snapshots.
 */

'use strict';

const express = require('express');
const db = require('../../../lib/db');
const { getLogger } = require('../../../lib/logger');
const commandApi = require('../../../lib/command-api');
const mqttPublisher = require('../../../lib/mqtt-publisher');
const { checkZoneConfigReadonly } = require('./helpers');
const { analyzeBalancing } = require('../../../lib/balancing-analyzer');

const router = express.Router();
const _log = getLogger('balancing-api');

/**
 * GET /:homeId/balancing/analysis
 * Run hydraulic balancing analyzer and return recommendations.
 */
router.get('/:homeId/balancing/analysis', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const hours = req.query.hours ? parseInt(req.query.hours, 10) : 72;

        const analysis = await analyzeBalancing(homeId, { hours });

        if (!analysis.ok) {
            const statusCode = analysis.error === 'insufficient_data' ? 422 : 400;
            return res.status(statusCode).json(analysis);
        }

        // Store snapshot in history
        const pool = db.getPool();
        let snapshotId = null;
        try {
            const [insertRes] = await pool.execute(
                'INSERT INTO balancing_snapshots (home_id, analysis_json, applied) VALUES (?, ?, 0)',
                [homeId, JSON.stringify(analysis)]
            );
            snapshotId = insertRes.insertId;
        } catch (dbErr) {
            _log('warn', `Failed to save balancing snapshot for home ${homeId}: ${dbErr.message}`);
        }

        res.json({
            ...analysis,
            snapshotId
        });
    } catch (err) {
        _log('error', `Failed to run balancing analysis: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
});

/**
 * POST /:homeId/balancing/apply
 * Batch-apply valve sensitivity values to devices and push config refresh.
 */
router.post('/:homeId/balancing/apply', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const { isReadOnly, devBypass } = await checkZoneConfigReadonly(homeId);
        if (isReadOnly && !devBypass) {
            return res.status(403).json({ error: 'config_readonly', message: 'Configuration is read-only' });
        }

        const { devices, snapshotId } = req.body;
        if (!Array.isArray(devices) || devices.length === 0) {
            return res.status(400).json({ error: 'invalid_body', message: 'devices array is required' });
        }

        const pool = db.getPool();
        const appliedSerials = [];

        for (const item of devices) {
            const serial = item.serial || item.serial_no || item.deviceId;
            const rawVal = item.sensitivity !== undefined ? item.sensitivity : item.valveSensitivity;
            const val = parseInt(rawVal, 10);

            if (!serial || isNaN(val) || val < 50 || val > 100) {
                continue;
            }

            await pool.execute(
                'UPDATE devices SET valve_sensitivity = ? WHERE serial_no = ? AND home_id = ?',
                [val, serial, homeId]
            );

            await commandApi.pushConfigRefresh(serial).catch(err => {
                _log('warn', `Balancing apply: config refresh failed for ${serial}: ${err.message}`);
            });

            if (mqttPublisher && mqttPublisher.publishValveSensitivity) {
                await mqttPublisher.publishValveSensitivity(serial, val).catch(err => {
                    _log('warn', `Balancing apply: MQTT publish failed for ${serial}: ${err.message}`);
                });
            }

            appliedSerials.push({ serial, sensitivity: val });
        }

        if (snapshotId) {
            await pool.execute(
                'UPDATE balancing_snapshots SET applied = 1, applied_at = NOW() WHERE id = ? AND home_id = ?',
                [snapshotId, homeId]
            ).catch(err => {
                _log('warn', `Failed to mark snapshot ${snapshotId} as applied: ${err.message}`);
            });
        }

        res.json({
            ok: true,
            appliedCount: appliedSerials.length,
            devices: appliedSerials
        });
    } catch (err) {
        _log('error', `Failed to apply balancing suggestions: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
});

/**
 * GET /:homeId/balancing/history
 * Retrieve recent balancing snapshots.
 */
router.get('/:homeId/balancing/history', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const pool = db.getPool();

        const [rows] = await pool.execute(
            `SELECT id, home_id, created_at, analysis_json, applied, applied_at 
             FROM balancing_snapshots 
             WHERE home_id = ? 
             ORDER BY created_at DESC 
             LIMIT 10`,
            [homeId]
        );

        const snapshots = rows.map(r => {
            let parsed = null;
            try {
                parsed = typeof r.analysis_json === 'string' ? JSON.parse(r.analysis_json) : r.analysis_json;
            } catch (e) {
                parsed = r.analysis_json;
            }
            return {
                id: r.id,
                homeId: r.home_id,
                createdAt: r.created_at,
                applied: Boolean(r.applied),
                appliedAt: r.applied_at,
                analysis: parsed
            };
        });

        res.json({ snapshots });
    } catch (err) {
        _log('error', `Failed to fetch balancing history: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
});

module.exports = router;
