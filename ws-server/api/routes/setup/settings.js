/**
 * @file api/routes/setup/settings.js
 * @brief REST routes configuring server-level global parameters.
 * 
 * Supports reading/updating domain names, toggling zone config readonly locks, and managing
 * websocket whitelist entries.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../../../lib/db');
const { getLogger } = require('../../../lib/logger');
const wsBridge = require('../../../lib/ws-bridge');
const coap = require('../../../lib/coap');
const tlv = require('../../../lib/tlv');
const commandApi = require('../../../lib/command-api');
const stateSnapshot = require('../../../lib/state-snapshot');
const stateRestore = require('../../../lib/state-restore');
const config = require('../../../lib/config');
const mqttHaDiscovery = require('../../../lib/mqtt-ha-discovery');
const adminAuth = require('../../middleware/admin-auth');

const router = express.Router();
const _log = getLogger('setup-api');

const TOTP = {
    verify(secret, code, window = 1) {
        if (!secret) return true;
        const timestamp = Math.floor(Date.now() / 1000);
        for (let i = -window; i <= window; i++) {
            if (this.getCode(secret, timestamp + (i * 30)) === code.toString()) {
                return true;
            }
        }
        return false;
    },

    getCode(secret, time) {
        const timeSlice = Buffer.alloc(8);
        const slice = BigInt(Math.floor(time / 30));
        timeSlice.writeBigUInt64BE(slice);

        const key = this.base32Decode(secret);
        const hmac = crypto.createHmac('sha1', key).update(timeSlice).digest();

        const offset = hmac[hmac.length - 1] & 0xf;
        const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000;
        return code.toString().padStart(6, '0');
    },

    base32Decode(base32) {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let bits = '';
        let output = Buffer.alloc(Math.ceil(base32.length * 5 / 8));
        let index = 0;

        const cleanBase32 = base32.toUpperCase().replace(/=+$/, '');
        for (let i = 0; i < cleanBase32.length; i++) {
            const val = alphabet.indexOf(cleanBase32[i]);
            if (val === -1) throw new Error('Invalid base32 character');
            bits += val.toString(2).padStart(5, '0');
            while (bits.length >= 8) {
                output[index++] = parseInt(bits.substring(0, 8), 2);
                bits = bits.substring(8);
            }
        }
        return output.subarray(0, index);
    }
};

router.get('/settings', adminAuth, async (req, res) => {
    try {
        const pool = db.getPool();
        const [rows] = await pool.execute('SELECT `key`, `value` FROM server_settings');
        const settings = {};
        for (const row of rows) {
            settings[row.key] = row.value;
        }
        res.json({
            log_level: settings.log_level || config.logLevel,
            jwt_secret: settings.jwt_secret || config.jwtSecret,
            cleanup_device_measurements_days: settings.cleanup_device_measurements_days !== undefined ? parseInt(settings.cleanup_device_measurements_days, 10) : config.cleanupDeviceMeasurementsDays,
            cleanup_zone_measurements_days: settings.cleanup_zone_measurements_days !== undefined ? parseInt(settings.cleanup_zone_measurements_days, 10) : config.cleanupZoneMeasurementsDays,
            cleanup_home_weather_days: settings.cleanup_home_weather_days !== undefined ? parseInt(settings.cleanup_home_weather_days, 10) : config.cleanupHomeWeatherDays,
            swagger_enabled: settings.swagger_enabled !== undefined ? (settings.swagger_enabled === '1' || settings.swagger_enabled === 'true') : config.swaggerEnabled,
            ota_auto_update: settings.ota_auto_update !== undefined ? (settings.ota_auto_update === '1' || settings.ota_auto_update === 'true') : config.otaAutoUpdate,
            carto_api_key: settings.carto_api_key !== undefined ? settings.carto_api_key : (config.cartoApiKey || '')
        });
    } catch (err) {
        _log('error', `[setup] GET /settings error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.post('/settings', adminAuth, async (req, res) => {
    try {
        const pool = db.getPool();
        const now = new Date().toISOString();
        const { log_level, jwt_secret, cleanup_device_measurements_days, cleanup_zone_measurements_days, cleanup_home_weather_days, swagger_enabled, carto_api_key } = req.body;

        if (log_level && ['debug', 'info', 'warn', 'error'].includes(log_level)) {
            await pool.execute(
                'INSERT INTO server_settings (`key`, `value`, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), updated_at = VALUES(updated_at)',
                ['log_level', log_level, now]
            );
        }

        if (jwt_secret && jwt_secret.length > 0) {
            await pool.execute(
                'INSERT INTO server_settings (`key`, `value`, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), updated_at = VALUES(updated_at)',
                ['jwt_secret', jwt_secret, now]
            );
        }

        if (carto_api_key !== undefined) {
            await pool.execute(
                'INSERT INTO server_settings (`key`, `value`, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), updated_at = VALUES(updated_at)',
                ['carto_api_key', typeof carto_api_key === 'string' ? carto_api_key.trim() : '', now]
            );
        }

        if (cleanup_device_measurements_days !== undefined) {
            const val = parseInt(cleanup_device_measurements_days, 10);
            if (!isNaN(val) && val >= 1) {
                await pool.execute(
                    'INSERT INTO server_settings (`key`, `value`, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), updated_at = VALUES(updated_at)',
                    ['cleanup_device_measurements_days', String(val), now]
                );
            }
        }

        if (cleanup_zone_measurements_days !== undefined) {
            const val = parseInt(cleanup_zone_measurements_days, 10);
            if (!isNaN(val) && val >= 1) {
                await pool.execute(
                    'INSERT INTO server_settings (`key`, `value`, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), updated_at = VALUES(updated_at)',
                    ['cleanup_zone_measurements_days', String(val), now]
                );
            }
        }

        if (cleanup_home_weather_days !== undefined) {
            const val = parseInt(cleanup_home_weather_days, 10);
            if (!isNaN(val) && val >= 1) {
                await pool.execute(
                    'INSERT INTO server_settings (`key`, `value`, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), updated_at = VALUES(updated_at)',
                    ['cleanup_home_weather_days', String(val), now]
                );
            }
        }

        if (swagger_enabled !== undefined) {
            await pool.execute(
                'INSERT INTO server_settings (`key`, `value`, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), updated_at = VALUES(updated_at)',
                ['swagger_enabled', swagger_enabled ? 'true' : 'false', now]
            );
        }

        if (req.body.ota_auto_update !== undefined) {
            await pool.execute(
                'INSERT INTO server_settings (`key`, `value`, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), updated_at = VALUES(updated_at)',
                ['ota_auto_update', req.body.ota_auto_update ? 'true' : 'false', now]
            );
        }

        // Hot-reload config
        await config.reloadFromDb();
        _log('info', `[setup] Server settings updated. Log level: ${config.logLevel}`);

        res.json({ success: true });
    } catch (err) {
        _log('error', `[setup] POST /settings error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// --- Manual OTA Sync ---
router.post('/ota/sync', adminAuth, async (req, res) => {
    try {
        const otaSync = require('../../../lib/ota-sync');
        _log('info', '[setup] Manual OTA sync triggered by admin');
        const manifest = await otaSync.checkAndSync(true);
        res.json({ success: true, manifest });
    } catch (err) {
        _log('error', `[setup] Manual OTA sync failed: ${err.message}`);
        res.status(500).json({ error: 'OTA sync failed', details: err.message });
    }
});

// --- Server Restart ---

/**
 * POST /setup/server/restart — Admin-only server restart endpoint.
 *
 * Mechanism: Calls process.exit(0) on the API child process after flushing
 * the response. The parent WS server (server.js) monitors the child via
 * apiProcess.on('exit') and automatically respawns it with exponential
 * backoff (5s base, 1.5x multiplier, 60s max). This effectively restarts
 * the entire API + re-initializes DB connections, TLV labels, and MQTT.
 *
 * Note: Any inflight API requests at the time of exit will be dropped.
 * The parent WS server (WebSocket connections, CoAP processing) is NOT
 * affected — only the REST API child process restarts.
 */
router.post('/server/restart', adminAuth, async (req, res) => {
    _log('info', '[setup] Server restart requested by admin');
    res.json({ success: true, message: 'Server is restarting...' });

    // Give the response time to flush, then exit. Docker restart: always will restart the container.
    setTimeout(() => {
        _log('info', '[setup] Shutting down for restart...');
        process.exit(0);
    }, 500);
});

// --- MQTT Settings API (delegated) ---
const setupMqttRouter = require('../setup-mqtt');
router.use('/', setupMqttRouter);

module.exports = router;
