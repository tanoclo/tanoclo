/**
 * @file api/routes/misc.js
 * @brief Miscellaneous API routes including device diagnostics uploads and global configs.
 * 
 * Manages multipart diagnostic logs uploads, storage folders initialization,
 * and regional settings (country lists, languages configurations).
 */

const express = require('express');
const db = require('../../lib/db');
const authMiddleware = require('../middleware/auth');
const homeAccessMiddleware = require('../middleware/home-access');
const fs = require('fs');
const path = require('path');
const { getLogger } = require('../../lib/logger');

const router = express.Router();
const _log = getLogger('misc-api');

router.post('/api/v2/homes/:homeId/devices/:deviceId/logs', authMiddleware, homeAccessMiddleware, async (req, res) => {
    try {
        const { homeId, deviceId } = req.params;

        // Validate content length (10MB max)
        const contentLength = parseInt(req.headers['content-length'] || '0', 10);
        if (contentLength > 10 * 1024 * 1024) {
            return res.status(413).json({ error: 'File too large. Maximum 10MB.' });
        }

        // Validate content type (zip or octet-stream only)
        const contentType = req.headers['content-type'] || '';
        if (!contentType.includes('application/zip') && !contentType.includes('application/octet-stream')) {
            return res.status(415).json({ error: 'Unsupported media type. Expected application/zip.' });
        }

        const pool = db.getPool();

        const [homes] = await pool.execute('SELECT log_uploads_enabled FROM homes WHERE id = ?', [homeId]);
        if (homes.length === 0 || !homes[0].log_uploads_enabled) {
            return res.status(403).json({ error: 'Log uploads are disabled for this home.' });
        }

        const safeDeviceName = deviceId.replace(/[^a-zA-Z0-9_\-]/g, '_');
        const d = new Date();
        const filename = `${safeDeviceName}_${d.toISOString().replace(/[:.]/g, '-')}.zip`;
        const storageDir = path.join(__dirname, '../../storage/logs', homeId);

        await fs.promises.mkdir(storageDir, { recursive: true });

        const targetFile = path.join(storageDir, filename);
        const writeStream = fs.createWriteStream(targetFile);

        req.pipe(writeStream);

        req.on('end', () => res.status(201).json({ success: true, file: filename }));
        req.on('error', () => res.status(500).json({ error: 'Upload failed' }));

    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// state and presenceLock routes are handled by homes.js (canonical handler)

router.get(['/api/features', '/api/v1/features'], (req, res) => {
    res.json({
        canAccessEnergyPrices: false,
        canAccessEnergyReadings: false,
        canAccessPushNotificationSettings: false,
        isAccountOwner: false,
        isAccountLinkedToHome: false,
        canAccessConsumption: false
    });
});

router.get(['/api/homes/:homeId/notifications', '/api/homes/:homeId/promotions', '/api/v2/homes/:homeId/promotions'], authMiddleware, homeAccessMiddleware, (req, res) => {
    res.json({ notifications: [], promotions: [] });
});

router.get(['/v1/homes/:homeId/incidents', '/api/v2/homes/:homeId/incidents'], authMiddleware, homeAccessMiddleware, (req, res) => {
    res.json({ incidents: [] });
});

router.get('/banners', (req, res) => res.json({ bannersToShow: [] }));
router.get('/savingsAdvice', (req, res) => res.json({ owd: null, showBanner: false }));
router.get('/meterReadings', (req, res) => res.json({ readings: [] }));

module.exports = router;