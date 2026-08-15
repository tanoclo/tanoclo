/**
 * @file api/routes/setup-mqtt.js
 * @brief REST routes configuring the server-level MQTT broker credentials.
 * 
 * Supports updating server_settings tables with custom MQTT broker hosts, ports, passwords,
 * and triggering Home Assistant discovery config republishes.
 */

const express = require('express');
const router = express.Router();
const db = require('../../lib/db');
const config = require('../../lib/config');
const { getLogger } = require('../../lib/logger');
const _log = getLogger('setup-mqtt');
const adminAuth = require('../middleware/admin-auth');
const mqttHaDiscovery = require('../../lib/mqtt-ha-discovery');

// --- MQTT Settings API ---

router.get('/mqtt', adminAuth, async (req, res) => {
    try {
        const pool = db.getPool();
        const [rows] = await pool.execute('SELECT `key`, `value` FROM server_settings WHERE `key` LIKE ?', ['mqtt_%']);
        const settings = {};
        for (const row of rows) {
            const shortKey = row.key.replace('mqtt_', '');
            settings[shortKey] = row.value;
        }
        res.json({
            host: settings.host || '',
            port: parseInt(settings.port, 10) || 1883,
            user: settings.user || '',
            password: settings.password || '',
            ha_discovery: settings.ha_discovery === '1' || settings.ha_discovery === 'true',
            ha_path: settings.ha_path || 'homeassistant',
        });
    } catch (err) {
        _log('error', `[setup] GET /mqtt error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.post('/mqtt', adminAuth, async (req, res) => {
    try {
        const pool = db.getPool();
        const now = new Date().toISOString();
        const { host, port, user, password, ha_discovery, ha_path } = req.body;

        const pairs = [
            ['mqtt_host', host || ''],
            ['mqtt_port', String(port || 1883)],
            ['mqtt_user', user || ''],
            ['mqtt_password', password || ''],
            ['mqtt_ha_discovery', ha_discovery ? '1' : '0'],
            ['mqtt_ha_path', ha_path || 'homeassistant'],
        ];

        for (const [key, value] of pairs) {
            await pool.execute(
                'INSERT INTO server_settings (`key`, `value`, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), updated_at = VALUES(updated_at)',
                [key, value, now]
            );
        }

        // Hot-reload config
        await config.reloadFromDb();
        _log('info', `[setup] MQTT settings updated`);

        res.json({ success: true });
    } catch (err) {
        _log('error', `[setup] POST /mqtt error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.post('/mqtt/test', adminAuth, async (req, res) => {
    try {
        const { host, port, user, password } = req.body;
        if (!host) return res.status(400).json({ error: 'Host is required' });

        const mqtt = require('mqtt');
        const client = mqtt.connect(`mqtt://${host}:${port || 1883}`, {
            username: user || undefined,
            password: password || undefined,
            connectTimeout: 5000,
            reconnectPeriod: 0, // Don't auto-reconnect for test
        });

        const timeout = setTimeout(() => {
            client.end(true);
            res.json({ success: false, error: 'Connection timeout (5s)' });
        }, 5000);

        client.on('connect', () => {
            clearTimeout(timeout);
            client.end();
            res.json({ success: true });
        });

        client.on('error', (err) => {
            clearTimeout(timeout);
            client.end(true);
            res.json({ success: false, error: err.message });
        });
    } catch (err) {
        _log('error', `MQTT test connection exception: ${err.message}`);
        res.json({ success: false, error: 'internal_error' });
    }
});

router.post('/homes/:id/reset', adminAuth, async (req, res) => {
    const homeId = req.params.id;
    const pool = db.getPool();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();
        const [devicesToUnpublish] = await conn.execute('SELECT id FROM mobile_devices WHERE home_id = ?', [homeId]);
        await conn.execute('DELETE FROM zone_overlays WHERE home_id = ?', [homeId]);
        await conn.execute('DELETE FROM zone_timetables WHERE home_id = ?', [homeId]);
        await conn.execute('DELETE FROM schedule_blocks WHERE home_id = ?', [homeId]);
        await conn.execute('DELETE FROM away_configurations WHERE home_id = ?', [homeId]);
        await conn.execute('DELETE FROM heating_circuits WHERE home_id = ?', [homeId]);
        await conn.execute('DELETE FROM flow_temperature_settings WHERE home_id = ?', [homeId]);
        await conn.execute('DELETE FROM mobile_devices WHERE home_id = ?', [homeId]);
        await conn.commit();
        for (const md of devicesToUnpublish) {
            mqttHaDiscovery.unpublishMobileDevice(md.id);
            const mqttPublisher = require('../../lib/mqtt-publisher');
            mqttPublisher.publishMobileDeviceTelemetry(homeId, md.id, false, null, null, null, false).catch(() => {});
        }
        mqttHaDiscovery.publishAllDiscovery().catch(() => { });
        res.json({ success: true });
    } catch (err) {
        if (conn) await conn.rollback();
        _log('error', `Home reset error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    } finally {
        if (conn) conn.release();
    }
});

router.post('/homes/:id/delete', adminAuth, async (req, res) => {
    const homeId = req.params.id;
    const pool = db.getPool();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();
        const [devicesToUnpublish] = await conn.execute('SELECT id FROM mobile_devices WHERE home_id = ?', [homeId]);
        await conn.execute('DELETE FROM device_measurements WHERE home_id = ?', [homeId]);
        await conn.execute('DELETE FROM zone_measurements WHERE home_id = ?', [homeId]);
        await conn.execute('DELETE FROM devices WHERE home_id = ?', [homeId]);
        await conn.execute('DELETE FROM zones WHERE home_id = ?', [homeId]);
        await conn.execute('DELETE FROM mobile_devices WHERE home_id = ?', [homeId]);
        await conn.execute('DELETE FROM users WHERE home_id = ?', [homeId]);
        await conn.execute('DELETE FROM homes WHERE id = ?', [homeId]);
        await conn.commit();
        for (const md of devicesToUnpublish) {
            mqttHaDiscovery.unpublishMobileDevice(md.id);
            const mqttPublisher = require('../../lib/mqtt-publisher');
            mqttPublisher.publishMobileDeviceTelemetry(homeId, md.id, false, null, null, null, false).catch(() => {});
        }
        mqttHaDiscovery.publishAllDiscovery().catch(() => { });
        res.json({ success: true });
    } catch (err) {
        if (conn) await conn.rollback();
        _log('error', `Home delete error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    } finally {
        if (conn) conn.release();
    }
});

module.exports = router;
