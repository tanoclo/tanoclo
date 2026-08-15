/**
 * @file api/routes/setup/homes.js
 * @brief Admin/Setup home management routes.
 * 
 * Provides administrative endpoints to query all registered homes, read associated user details,
 * manage zone configs bypasses, and verify TOTP codes for advanced diagnostic triggers.
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

router.post('/homes/:id/proxy', adminAuth, async (req, res) => {
    const pool = db.getPool();
    const homeId = req.params.id;
    const enabled = req.body.enabled ? 1 : 0;
    await pool.execute('UPDATE homes SET is_proxied = ? WHERE id = ?', [enabled, homeId]);

    const proxyManager = require('../../../lib/proxy-manager');
    if (proxyManager && proxyManager.clearProxyConnectionsForHome) {
        proxyManager.clearProxyConnectionsForHome(homeId);
    }

    await commandApi.pushHomeIbReboot(homeId).catch(err => {
        _log('warn', `[homes] Failed to trigger IB restart for home ${homeId}: ${err.message}`);
    });

    res.json({ success: true });
});

router.post('/homes/:id/proxy-log', adminAuth, async (req, res) => {
    const pool = db.getPool();
    await pool.execute('UPDATE homes SET proxy_logging = ? WHERE id = ?', [req.body.enabled, req.params.id]);
    res.json({ success: true });
});

router.post('/homes/:id/log-upload', adminAuth, async (req, res) => {
    const pool = db.getPool();
    await pool.execute('UPDATE homes SET log_uploads_enabled = ? WHERE id = ?', [req.body.enabled, req.params.id]);
    res.json({ success: true });
});

router.post('/homes/:id/allow-commands-in-proxy', adminAuth, async (req, res) => {
    const pool = db.getPool();
    await pool.execute('UPDATE homes SET allow_commands_in_proxy = ? WHERE id = ?', [req.body.enabled, req.params.id]);
    res.json({ success: true });
});

router.post('/homes/:id/zone-config-readonly', adminAuth, async (req, res) => {
    const pool = db.getPool();
    await pool.execute('UPDATE homes SET zone_config_readonly = ? WHERE id = ?', [req.body.enabled ? 1 : 0, req.params.id]);
    res.json({ success: true });
});

router.post('/homes/:id/dev-bypass', adminAuth, async (req, res) => {
    const pool = db.getPool();
    await pool.execute('UPDATE homes SET dev_bypass = ? WHERE id = ?', [req.body.enabled ? 1 : 0, req.params.id]);
    res.json({ success: true });
});

router.post('/homes/:id/ha-discovery', adminAuth, async (req, res) => {
    try {
        const pool = db.getPool();
        await pool.execute('UPDATE homes SET ha_discovery_enabled = ? WHERE id = ?', [req.body.enabled ? 1 : 0, req.params.id]);

        // Trigger immediate HA discovery update
        const mqttHaDiscovery = require('../../../lib/mqtt-ha-discovery');
        if (mqttHaDiscovery && mqttHaDiscovery.publishAllDiscovery) {
            mqttHaDiscovery.publishAllDiscovery().catch(err => {
                _log('error', `Failed to run discovery update on toggle: ${err.message}`);
            });
        }
        res.json({ success: true });
    } catch (err) {
        _log('error', `Failed to toggle HA discovery: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.post('/homes/:id/admin', adminAuth, async (req, res) => {
    try {
        const { adminUserId } = req.body;
        if (!adminUserId) return res.status(400).json({ error: 'adminUserId required' });

        const pool = db.getPool();
        // Verify user belongs to the home
        const [rows] = await pool.execute('SELECT * FROM users WHERE home_id = ? AND id = ?', [req.params.id, adminUserId]);
        if (rows.length === 0) {
            return res.status(400).json({ error: 'User does not belong to this home' });
        }

        // Update home admin user ID
        await pool.execute('UPDATE homes SET admin_user_id = ? WHERE id = ?', [adminUserId, req.params.id]);

        _log('info', `Home ${req.params.id} admin updated to user ${adminUserId}`);
        res.json({ success: true });
    } catch (err) {
        _log('error', `Failed to update home admin: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

module.exports = router;
