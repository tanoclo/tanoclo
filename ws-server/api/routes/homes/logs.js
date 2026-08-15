/**
 * @file api/routes/homes/logs.js
 * @brief Logging and diagnostics configurations routes for home settings.
 * 
 * Supports triggering bridge proxy logging flags and allowing remote firmware log uploads.
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

// --- lines 1132 to 1144 ---
router.post('/proxy_log/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const action = req.body.action || 'enable';
        const pool = db.getPool();
        await pool.execute('UPDATE homes SET proxy_logging = ? WHERE id = ?', [action === 'enable' ? 1 : 0, id]);
        res.status(204).end();
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// POST /api/v2/homes/log_upload/:id


// --- lines 1145 to 1157 ---
router.post('/log_upload/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const action = req.body.action || 'enable';
        const pool = db.getPool();
        await pool.execute('UPDATE homes SET log_uploads_enabled = ? WHERE id = ?', [action === 'enable' ? 1 : 0, id]);
        res.status(204).end();
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/v2/homes/logs/location/:homeId/:deviceName


// --- lines 1158 to 1202 ---
router.put('/logs/location/:homeId/:deviceName', async (req, res) => {
    try {
        const { homeId, deviceName } = req.params;
        const pool = db.getPool();

        const [rows] = await pool.execute('SELECT log_uploads_enabled FROM homes WHERE id = ?', [homeId]);
        if (rows.length === 0 || !rows[0].log_uploads_enabled) {
            return res.status(403).json({ error: 'Log uploads are disabled for this home.' });
        }

        const storageDir = path.join(__dirname, '../../../storage/logs', homeId);
        try {
            await fs.promises.access(storageDir);
        } catch {
            await fs.promises.mkdir(storageDir, { recursive: true });
        }

        const safeName = deviceName.replace(/[^a-zA-Z0-9_\-]/g, '_');
        const filename = `${safeName}_${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
        const targetPath = path.join(storageDir, filename);

        const writeStream = fs.createWriteStream(targetPath);
        req.pipe(writeStream);

        writeStream.on('finish', () => {
            res.status(201).json({ success: true, file: filename });
        });

        writeStream.on('error', (err) => {
            _log('error', `Log upload write error: ${err.message}`);
            res.status(500).json({ error: 'Could not write log file' });
        });

    } catch (err) {
        _log('error', `Log upload error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});
module.exports = router;