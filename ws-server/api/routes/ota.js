/**
 * @file api/routes/ota.js
 * @brief OTA updates API routes providing authenticated access to manifest, dist.zip, and APK downloads.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const authMiddleware = require('../middleware/auth');
const otaSync = require('../../lib/ota-sync');
const { getLogger } = require('../../lib/logger');

const router = express.Router();
const _log = getLogger('ota-api');

// GET /api/v2/ota/manifest
router.get('/manifest', (req, res) => {
  try {
    const manifest = otaSync.getManifest();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json(manifest);
  } catch (err) {
    _log('error', `[OTA-API] Error fetching manifest: ${err.message}`);
    res.status(500).json({ error: 'Failed to retrieve OTA manifest' });
  }
});

// GET /api/v2/ota/dist.zip
router.get('/dist.zip', (req, res) => {
  try {
    const zipPath = otaSync.getDistZipPath();
    if (!zipPath || !fs.existsSync(zipPath)) {
      return res.status(404).json({ error: 'dist.zip package not found on server' });
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="dist.zip"');
    res.setHeader('Cache-Control', 'no-store, no-cache');
    res.sendFile(zipPath);
  } catch (err) {
    _log('error', `[OTA-API] Error streaming dist.zip: ${err.message}`);
    res.status(500).json({ error: 'Failed to download dist.zip' });
  }
});

// GET /api/v2/ota/tanoclo.apk
router.get('/tanoclo.apk', (req, res) => {
  try {
    const apkPath = otaSync.getApkPath();
    if (!apkPath || !fs.existsSync(apkPath)) {
      return res.status(404).json({ error: 'APK package not found on server' });
    }
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="tanoclo.apk"');
    res.setHeader('Cache-Control', 'no-store, no-cache');
    res.sendFile(apkPath);
  } catch (err) {
    _log('error', `[OTA-API] Error streaming APK: ${err.message}`);
    res.status(500).json({ error: 'Failed to download APK' });
  }
});

// POST /api/v2/ota/sync - Manual admin trigger
router.post('/sync', authMiddleware, async (req, res) => {
  try {
    const manifest = await otaSync.checkAndSync(true);
    res.json({ success: true, manifest });
  } catch (err) {
    _log('error', `[OTA-API] Manual sync trigger failed: ${err.message}`);
    res.status(500).json({ error: 'Manual OTA sync failed' });
  }
});

module.exports = router;
