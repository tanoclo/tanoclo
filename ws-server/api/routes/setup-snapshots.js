/**
 * @file api/routes/setup-snapshots.js
 * @brief REST routes orchestrating database state snapshots captures and restores.
 * 
 * Supports capturing current home states (active zones configurations, schedules, devices links),
 * polling snapshot build progress, and restoring database settings from previous captures.
 */

const express = require('express');
const router = express.Router();
const db = require('../../lib/db');
const adminAuth = require('../middleware/admin-auth');
const stateSnapshot = require('../../lib/state-snapshot');
const stateRestore = require('../../lib/state-restore');
const { getLogger } = require('../../lib/logger');
const _log = getLogger('setup-snapshots');

// --- State Snapshot Routes ---

router.post('/homes/:id/snapshot/start', adminAuth, async (req, res) => {
    try {
        const result = await stateSnapshot.startCapture(parseInt(req.params.id));
        res.json({ ok: true, ...result });
    } catch (e) {
        _log('error', `POST /homes/:id/snapshot/start error: ${e.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.post('/homes/:id/snapshot/stop', adminAuth, async (req, res) => {
    try {
        await stateSnapshot.completeCapture(parseInt(req.params.id));
        res.json({ ok: true });
    } catch (e) {
        _log('error', `POST /homes/:id/snapshot/stop error: ${e.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.get('/homes/:id/snapshot/progress', adminAuth, async (req, res) => {
    try {
        const progress = await stateSnapshot.getProgress(parseInt(req.params.id));
        res.json(progress);
    } catch (e) {
        _log('error', `GET /homes/:id/snapshot/progress error: ${e.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.get('/homes/:id/snapshot/list', adminAuth, async (req, res) => {
    try {
        const pool = db.getPool();
        const [rows] = await pool.execute(
            'SELECT id, home_id, created_at, status, LENGTH(snapshot_json) as json_size FROM state_snapshots WHERE home_id = ? ORDER BY created_at DESC',
            [parseInt(req.params.id)]
        );
        res.json(rows);
    } catch (e) {
        _log('error', `GET /homes/:id/snapshot/list error: ${e.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.get('/homes/:id/snapshot/:snapshotId', adminAuth, async (req, res) => {
    try {
        const pool = db.getPool();
        const [rows] = await pool.execute(
            'SELECT * FROM state_snapshots WHERE id = ? AND home_id = ?',
            [req.params.snapshotId, req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ error: 'not found' });
        res.json(rows[0]);
    } catch (e) {
        _log('error', `GET /homes/:id/snapshot/:snapshotId error: ${e.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.post('/homes/:id/snapshot/:snapshotId/restore', adminAuth, async (req, res) => {
    try {
        const result = await stateRestore.restoreSnapshot(
            parseInt(req.params.id),
            parseInt(req.params.snapshotId)
        );
        res.json({ ok: true, ...result });
    } catch (e) {
        _log('error', `POST /homes/:id/snapshot/:snapshotId/restore error: ${e.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.delete('/homes/:id/snapshot/:snapshotId', adminAuth, async (req, res) => {
    try {
        const pool = db.getPool();
        await pool.execute(
            'DELETE FROM state_snapshots WHERE id = ? AND home_id = ?',
            [req.params.snapshotId, req.params.id]
        );
        res.json({ ok: true });
    } catch (e) {
        _log('error', `DELETE /homes/:id/snapshot/:snapshotId error: ${e.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.get('/homes/:id/snapshot/:snapshotId/export', adminAuth, async (req, res) => {
    try {
        const pool = db.getPool();
        const [rows] = await pool.execute(
            'SELECT * FROM state_snapshots WHERE id = ? AND home_id = ?',
            [req.params.snapshotId, req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ error: 'not found' });
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition',
            `attachment; filename="tanoclo_snapshot_${req.params.id}_${req.params.snapshotId}.json"`);
        res.send(rows[0].snapshot_json || '{}');
    } catch (e) {
        _log('error', `GET /homes/:id/snapshot/:snapshotId/export error: ${e.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.post('/homes/:id/snapshot/import', adminAuth, async (req, res) => {
    try {
        const { snapshot_json } = req.body;
        if (!snapshot_json) return res.status(400).json({ error: 'snapshot_json required' });
        const parsed = JSON.parse(snapshot_json); // validate JSON
        const pool = db.getPool();
        const [result] = await pool.execute(
            "INSERT INTO state_snapshots (home_id, status, snapshot_json, created_at) VALUES (?, 'complete', ?, ?)",
            [parseInt(req.params.id), JSON.stringify(parsed), new Date()]
        );
        res.json({ ok: true, snapshotId: result.insertId });
    } catch (e) {
        _log('error', `POST /homes/:id/snapshot/import error: ${e.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

module.exports = router;
