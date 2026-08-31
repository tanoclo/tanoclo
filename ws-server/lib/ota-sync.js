/**
 * @file ws-server/lib/ota-sync.js
 * @brief OTA Sync Manager module for fetching, caching, and extracting dist.zip from GitHub ota branch into frontend-dist.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const frontendDistPath = path.join(__dirname, '../frontend-dist');
const otaDataDir = path.join(__dirname, '../data/ota');
const manifestCacheFile = path.join(otaDataDir, 'manifest.json');
const distZipCacheFile = path.join(otaDataDir, 'dist.zip');
const apkCacheFile = path.join(otaDataDir, 'tanoclo.apk');

const DEFAULT_OTA_MANIFEST_URL = 'https://raw.githubusercontent.com/tanoclo/tanoclo/ota/manifest.json';
const DEFAULT_OTA_DIST_URL = 'https://raw.githubusercontent.com/tanoclo/tanoclo/ota/dist.zip';
const DEFAULT_OTA_APK_URL = 'https://raw.githubusercontent.com/tanoclo/tanoclo/ota/tanoclo.apk';

let currentManifest = null;
let isSyncing = false;
let checkTimer = null;

function computeFileSha256(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const fileBuffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(fileBuffer).digest('hex');
  } catch (err) {
    return null;
  }
}

function ensureDirs() {
  if (!fs.existsSync(frontendDistPath)) {
    fs.mkdirSync(frontendDistPath, { recursive: true });
  }
  if (!fs.existsSync(otaDataDir)) {
    fs.mkdirSync(otaDataDir, { recursive: true });
  }
}

function fetchUrlBuffer(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft <= 0) {
      return reject(new Error('Too many HTTP redirects'));
    }

    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'TaNoClo-Server-OTA' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const nextUrl = new URL(res.headers.location, url).toString();
        return resolve(fetchUrlBuffer(nextUrl, redirectsLeft - 1));
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage || ''}`));
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function getApkPath() {
  if (fs.existsSync(apkCacheFile)) return apkCacheFile;
  const distApk = path.join(frontendDistPath, 'tanoclo.apk');
  if (fs.existsSync(distApk)) return distApk;
  return null;
}

function getDistZipPath() {
  if (fs.existsSync(distZipCacheFile)) return distZipCacheFile;
  const distZip = path.join(frontendDistPath, 'dist.zip');
  if (fs.existsSync(distZip)) return distZip;
  return null;
}

function loadLocalManifest() {
  try {
    if (fs.existsSync(manifestCacheFile)) {
      const data = fs.readFileSync(manifestCacheFile, 'utf8');
      currentManifest = JSON.parse(data);
    } else {
      const distManifest = path.join(frontendDistPath, 'manifest.json');
      if (fs.existsSync(distManifest)) {
        const data = fs.readFileSync(distManifest, 'utf8');
        currentManifest = JSON.parse(data);
      }
    }
  } catch (err) {
    console.error('[OtaSync] Error reading local manifest:', err.message);
  }
  if (!currentManifest) {
    currentManifest = {
      webVersionCode: 1,
      webVersionName: '0.1.0',
      apkVersionCode: 1,
      apkVersionName: '0.1.0'
    };
  }
  const apkPath = getApkPath();
  if (apkPath) {
    const sha = computeFileSha256(apkPath);
    if (sha) {
      currentManifest.apkSha256 = sha;
      currentManifest.apkSize = fs.statSync(apkPath).size;
      currentManifest.apkUrl = '/api/v2/ota/tanoclo.apk';
    }
  }
  const zipPath = getDistZipPath();
  if (zipPath) {
    const sha = computeFileSha256(zipPath);
    if (sha) {
      currentManifest.webSha256 = sha;
      currentManifest.webSize = fs.statSync(zipPath).size;
      currentManifest.zipUrl = '/api/v2/ota/dist.zip';
    }
  }
  return currentManifest;
}

function extractZipBuffer(zipBuffer, targetDir) {
  const dest = targetDir || frontendDistPath;
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const zip = new AdmZip(zipBuffer);
  zip.extractAllTo(dest, true);
  console.log(`[OtaSync] Extracted web bundle assets to ${dest === frontendDistPath ? 'frontend-dist' : dest} successfully.`);
}

async function checkAndSync(force = false) {
  if (isSyncing) return currentManifest;
  isSyncing = true;
  ensureDirs();

  try {
    loadLocalManifest();

    // Snapshot local version codes BEFORE any remote fetch overwrites them
    const prevLocalWebCode = currentManifest ? (currentManifest.webVersionCode || 0) : 0;
    const prevLocalApkCode = currentManifest ? (currentManifest.apkVersionCode || 0) : 0;

    const manifestUrl = process.env.OTA_MANIFEST_URL || DEFAULT_OTA_MANIFEST_URL;
    const distUrl = process.env.OTA_DIST_URL || DEFAULT_OTA_DIST_URL;
    const apkUrl = process.env.OTA_APK_URL || DEFAULT_OTA_APK_URL;

    console.log('[OtaSync] Fetching remote OTA manifest from:', manifestUrl);
    let remoteManifest = null;
    try {
      const manifestBuf = await fetchUrlBuffer(manifestUrl);
      remoteManifest = JSON.parse(manifestBuf.toString('utf8'));
      fs.writeFileSync(manifestCacheFile, JSON.stringify(remoteManifest, null, 2));
    } catch (err) {
      console.warn('[OtaSync] Could not fetch remote OTA manifest:', err.message);
    }

    const targetManifest = remoteManifest || currentManifest || {
      webVersionCode: 1,
      webVersionName: '0.1.0',
      apkVersionCode: 1,
      apkVersionName: '0.1.0',
      zipUrl: distUrl,
      apkUrl: apkUrl
    };

    currentManifest = targetManifest;

    const indexHtmlPath = path.join(frontendDistPath, 'index.html');
    const indexHtmlReal = fs.existsSync(indexHtmlPath) && fs.statSync(indexHtmlPath).size > 500;
    const remoteWebCode = remoteManifest ? (remoteManifest.webVersionCode || 0) : 0;
    const distZipExists = fs.existsSync(distZipCacheFile);

    // Compare against snapshot of LOCAL codes, not the already-overwritten currentManifest
    const needsExtraction = force || !indexHtmlReal || !distZipExists || (remoteManifest && remoteWebCode > prevLocalWebCode);

    console.log(`[OtaSync] Web version check: local=${prevLocalWebCode} remote=${remoteWebCode} indexReal=${indexHtmlReal} distZipExists=${distZipExists} needsExtraction=${needsExtraction}`);

    if (needsExtraction && (remoteManifest?.zipUrl || distUrl)) {
      const downloadZipUrl = remoteManifest?.zipUrl || distUrl;
      console.log('[OtaSync] Downloading updated dist.zip from:', downloadZipUrl);
      try {
        const zipBuffer = await fetchUrlBuffer(downloadZipUrl);
        fs.writeFileSync(distZipCacheFile, zipBuffer);
        extractZipBuffer(zipBuffer);
        console.log('[OtaSync] dist.zip downloaded and extracted successfully');
      } catch (err) {
        console.error('[OtaSync] Failed to download or extract dist.zip:', err.message);
      }
    }

    // Background download APK for mobile client delivery — compare against local snapshot
    const remoteApkCode = remoteManifest ? (remoteManifest.apkVersionCode || 0) : 0;
    if (!fs.existsSync(apkCacheFile) || (remoteManifest && remoteApkCode > prevLocalApkCode)) {
      const downloadApkUrl = remoteManifest?.apkUrl || apkUrl;
      try {
        console.log(`[OtaSync] Downloading APK (local=${prevLocalApkCode} remote=${remoteApkCode}) from:`, downloadApkUrl);
        const apkBuffer = await fetchUrlBuffer(downloadApkUrl);
        fs.writeFileSync(apkCacheFile, apkBuffer);
      } catch (err) {
        console.warn('[OtaSync] Optional APK download skipped:', err.message);
      }
    }
  } catch (err) {
    console.error('[OtaSync] Sync failed:', err);
  } finally {
    isSyncing = false;
  }

  return currentManifest;
}

function boot(intervalMs = 3600000) {
  const config = require('./config');
  ensureDirs();
  loadLocalManifest();

  const indexHtmlPath = path.join(frontendDistPath, 'index.html');
  const indexHtmlReal = fs.existsSync(indexHtmlPath) && fs.statSync(indexHtmlPath).size > 500;

  if (!config.otaAutoUpdate && indexHtmlReal) {
    console.log('[OtaSync] Auto-update disabled in settings. Frontend files exist, skipping OTA sync.');
    return;
  }

  if (!config.otaAutoUpdate && !indexHtmlReal) {
    console.log('[OtaSync] Auto-update disabled but no real frontend found — overruling to perform initial sync.');
  }

  // Initial sync (forced if no real frontend files to ensure the UI loads)
  checkAndSync(!indexHtmlReal).catch(err => console.error('[OtaSync] Boot sync error:', err));

  // Only set up periodic timer if auto-update is enabled
  if (config.otaAutoUpdate) {
    if (checkTimer) clearInterval(checkTimer);
    checkTimer = setInterval(() => {
      checkAndSync(false).catch(err => console.error('[OtaSync] Timer sync error:', err));
    }, intervalMs);
  }
}

function stopTimer() {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}

function getManifest() {
  if (!currentManifest) {
    loadLocalManifest();
  }
  const manifest = currentManifest ? { ...currentManifest } : {
    webVersionCode: 1,
    webVersionName: '0.1.0',
    apkVersionCode: 1,
    apkVersionName: '0.1.0'
  };
  const apkPath = getApkPath();
  if (apkPath) {
    const sha = computeFileSha256(apkPath);
    if (sha) {
      manifest.apkSha256 = sha;
      manifest.apkSize = fs.statSync(apkPath).size;
      manifest.apkUrl = '/api/v2/ota/tanoclo.apk';
    }
  }
  const zipPath = getDistZipPath();
  if (zipPath) {
    const sha = computeFileSha256(zipPath);
    if (sha) {
      manifest.webSha256 = sha;
      manifest.webSize = fs.statSync(zipPath).size;
      manifest.zipUrl = '/api/v2/ota/dist.zip';
    }
  }
  return manifest;
}

module.exports = {
  boot,
  checkAndSync,
  getManifest,
  getDistZipPath,
  getApkPath,
  stopTimer,
  extractZipBuffer,
  computeFileSha256
};
