/**
 * @file lib/config.js
 * @brief Global server parameters loader from environment and JSON files.
 */

'use strict';

// NOTE: This module uses console.log/error instead of ./logger because
// logger.js depends on config.js (circular dependency). These messages
// appear in stdout but not in the log file.

const fs = require('fs');
const path = require('path');

function loadIpCertsConfig() {
    const ipCertsPath = path.join(__dirname, '..', 'certs', 'ip_certs.json');
    try {
        if (fs.existsSync(ipCertsPath)) {
            const content = fs.readFileSync(ipCertsPath, 'utf-8');
            const data = JSON.parse(content);
            const resolvedData = {};
            for (const [ip, certs] of Object.entries(data)) {
                resolvedData[ip] = {
                    key: path.resolve(__dirname, '..', certs.key),
                    cert: path.resolve(__dirname, '..', certs.cert)
                };
            }
            return resolvedData;
        }
    } catch (e) {
        console.error(`[config] Failed to load ip_certs.json: ${e.message}`);
    }
    return {};
}

function loadDatabaseConfig() {
    return {
        host: process.env.DB_HOST || '127.0.0.1',
        database: process.env.DB_NAME || 'tanoclo',
        user: process.env.DB_USER || 'tanoclo',
        password: process.env.DB_PASS || '',
    };
}

const config = {
    wsPort: parseInt(process.env.WS_PORT || '988', 10),
    httpApiPort: parseInt(process.env.HTTP_API_PORT || '3111', 10),

    sslKeyPath: process.env.SSL_KEY_PATH || path.join(__dirname, '..', 'certs', 'tanoclo_key.pem'),
    sslCertPath: process.env.SSL_CERT_PATH || path.join(__dirname, '..', 'certs', 'tanoclo_cert.pem'),
    tadoRootCA: process.env.TADO_ROOT_CA_PATH || path.join(__dirname, '..', 'certs', 'tadoRootCA.cer'),
    ipCerts: loadIpCertsConfig(),

    db: loadDatabaseConfig(),

    jwtSecret: process.env.JWT_SECRET || 'secret_key',
    domain: process.env.TANOCLO_DOMAIN || 'tanoclo.domain.com',
    logLevel: process.env.LOG_LEVEL || 'debug', // 'debug', 'info', 'warn', 'error'
    // Default: readonly (true). Set TANOCLO_ZONE_CONFIG_READONLY=false to allow config pushes.
    // Protects against accidental writes in new deployments.
    zoneConfigReadonly: process.env.TANOCLO_ZONE_CONFIG_READONLY !== 'false',
    swaggerEnabled: process.env.TANOCLO_SWAGGER_ENABLED !== 'false',
    otaAutoUpdate: process.env.OTA_AUTO_UPDATE !== 'false', // Auto-update frontend from GitHub OTA branch

    // Database cleanup settings (retention in days)
    cleanupDeviceMeasurementsDays: 30,
    cleanupZoneMeasurementsDays: 390, // approx 13 months
    cleanupHomeWeatherDays: 390,       // approx 13 months

    // MQTT configuration (defaults — overridden from DB)
    mqtt: {
        host: process.env.MQTT_HOST || '',
        port: parseInt(process.env.MQTT_PORT || '1883', 10),
        user: process.env.MQTT_USERNAME || '',
        password: process.env.MQTT_PASSWORD || '',
        haDiscovery: process.env.MQTT_ENABLED === 'true' || false,
        haPath: process.env.MQTT_HA_PATH || 'homeassistant',
    },

    /**
     * Load settings from the server_settings DB table.
     * Overlays DB values onto the config object. Env vars remain as fallback.
     * Call this once on startup after the DB pool is available.
     */
    async loadFromDb() {
        try {
            const db = require('./db');
            const pool = db.getPool();
            const [rows] = await pool.execute('SELECT `key`, `value` FROM server_settings');
            _applySettings(rows);
            console.log(`[config] Loaded ${rows.length} settings from database`);
        } catch (err) {
            console.error(`[config] Failed to load settings from DB: ${err.message}`);
        }

        // Auto-generate secure JWT secret if still using insecure default
        if (this.jwtSecret === 'secret_key') {
            try {
                const crypto = require('crypto');
                const generated = crypto.randomBytes(32).toString('hex');
                const db = require('./db');
                const pool = db.getPool();
                await pool.execute(
                    'INSERT INTO server_settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
                    ['jwt_secret', generated, generated]
                );
                this.jwtSecret = generated;
                console.log(`[config] ⚠ JWT secret was insecure default. Auto-generated secure secret and saved to database.`);
            } catch (genErr) {
                console.error(`[config] FATAL: JWT secret is insecure default and auto-generation failed: ${genErr.message}`);
                console.error(`[config] Set jwt_secret in server_settings or JWT_SECRET env var before starting.`);
                process.exit(1);
            }
        }
    },

    /**
     * Reload settings from DB at runtime (e.g. after setup portal saves).
     * Same as loadFromDb but intended for hot-reload scenarios.
     */
    async reloadFromDb() {
        await this.loadFromDb();
    },

    _mqttChangeCallbacks: [],
    onMqttChange(cb) {
        this._mqttChangeCallbacks.push(cb);
    }
};

/**
 * Apply key-value rows from server_settings to the config object.
 */
function _applySettings(rows) {
    const oldMqtt = {
        host: config.mqtt.host,
        port: config.mqtt.port,
        user: config.mqtt.user,
        password: config.mqtt.password,
        haDiscovery: config.mqtt.haDiscovery,
        haPath: config.mqtt.haPath,
    };

    for (const row of rows) {
        switch (row.key) {
            case 'log_level':
                if (row.value && ['debug', 'info', 'warn', 'error'].includes(row.value)) {
                    config.logLevel = row.value;
                }
                break;
            case 'jwt_secret':
                if (row.value && row.value.length > 0) {
                    config.jwtSecret = row.value;
                }
                break;
            case 'mqtt_host':
                config.mqtt.host = row.value || '';
                break;
            case 'mqtt_port':
                config.mqtt.port = parseInt(row.value, 10) || 1883;
                break;
            case 'mqtt_user':
                config.mqtt.user = row.value || '';
                break;
            case 'mqtt_password':
                config.mqtt.password = row.value || '';
                break;
            case 'mqtt_ha_discovery':
                config.mqtt.haDiscovery = row.value === '1' || row.value === 'true';
                break;
            case 'mqtt_ha_path':
                config.mqtt.haPath = row.value || 'homeassistant';
                break;
            case 'cleanup_device_measurements_days':
                if (row.value) {
                    const val = parseInt(row.value, 10);
                    if (!isNaN(val) && val >= 1) {
                        config.cleanupDeviceMeasurementsDays = val;
                    }
                }
                break;
            case 'cleanup_zone_measurements_days':
                if (row.value) {
                    const val = parseInt(row.value, 10);
                    if (!isNaN(val) && val >= 1) {
                        config.cleanupZoneMeasurementsDays = val;
                    }
                }
                break;
            case 'cleanup_home_weather_days':
                if (row.value) {
                    const val = parseInt(row.value, 10);
                    if (!isNaN(val) && val >= 1) {
                        config.cleanupHomeWeatherDays = val;
                    }
                }
                break;
            case 'swagger_enabled':
                config.swaggerEnabled = row.value === '1' || row.value === 'true';
                break;
            case 'ota_auto_update':
                config.otaAutoUpdate = row.value === '1' || row.value === 'true';
                break;
        }
    }

    const changed = (
        oldMqtt.host !== config.mqtt.host ||
        oldMqtt.port !== config.mqtt.port ||
        oldMqtt.user !== config.mqtt.user ||
        oldMqtt.password !== config.mqtt.password ||
        oldMqtt.haDiscovery !== config.mqtt.haDiscovery ||
        oldMqtt.haPath !== config.mqtt.haPath
    );

    if (changed && config._mqttChangeCallbacks.length > 0) {
        for (const cb of config._mqttChangeCallbacks) {
            try { cb(); } catch (e) { console.error(`[config] MQTT change callback error: ${e.message}`); }
        }
    }
}

module.exports = config;
