/**
 * @file api/routes/setup/system.js
 * @brief REST routes managing system-level server processes.
 * 
 * Supports triggering child REST process restarts, broadcasting raw CoAP/TLV command frames
 * directly to physical hardware nodes, and managing the websocket client database tables.
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
const battery = require('../../../lib/battery');
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


router.post('/devices/:serial/battery', adminAuth, async (req, res) => {
    try {
        const pool = db.getPool();
        const serial = req.params.serial;
        const batteryType = req.body.type;
        await pool.execute('UPDATE devices SET battery_type = ? WHERE serial_no = ?', [batteryType, serial]);

        const [meas] = await pool.execute(
            'SELECT field_0162 FROM device_measurements WHERE device_serial = ? AND field_0162 IS NOT NULL AND field_0162 > 0 ORDER BY id DESC LIMIT 1',
            [serial]
        );
        if (meas.length > 0 && meas[0].field_0162) {
            const batteryPercent = battery.getBatteryPercent(meas[0].field_0162, serial, batteryType);
            if (batteryPercent != null) {
                let batteryState = 'NORMAL';
                if (batteryPercent <= 5) batteryState = 'DEPLETED';
                else if (batteryPercent <= 30) batteryState = 'LOW';

                await pool.execute(
                    'UPDATE devices SET battery_percent = ?, battery_state = ? WHERE serial_no = ?',
                    [batteryPercent, batteryState, serial]
                );
            }
        }

        mqttHaDiscovery.publishAllDiscovery().catch(() => { });
        res.json({ success: true });
    } catch (err) {
        _log('error', `Battery update error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});


// --- Zone / Offline Schedule API Routes ---

router.get('/zones/list', adminAuth, async (req, res) => {
    try {
        const pool = db.getPool();
        const [zones] = await pool.execute(`
            SELECT z.id, z.name, z.type, z.home_id, z.offline_schedule_enabled, z.offline_schedule_synced_at,
                   (SELECT COUNT(*) FROM devices d WHERE d.zone_id = z.id AND d.device_type LIKE 'VA%') as va_count,
                   (SELECT type FROM zone_timetables WHERE zone_id = z.id AND home_id = z.home_id AND is_active = 1 LIMIT 1) as timetable_type
            FROM zones z
            ORDER BY z.home_id ASC, z.id ASC
        `);
        res.json(zones);
    } catch (err) {
        _log('error', `Zone list error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.post('/zones/:id/offline-schedule', adminAuth, async (req, res) => {
    try {
        const zoneId = req.params.id;
        const { homeId, enabled } = req.body;
        if (!homeId) return res.status(400).json({ error: 'homeId is required' });

        const result = await commandApi.pushOfflineScheduleEnable(homeId, zoneId, enabled !== false);
        mqttHaDiscovery.publishAllDiscovery().catch(() => { });
        res.json({ success: true, ...result });
    } catch (err) {
        _log('error', `Offline schedule enable error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.post('/zones/:id/offline-schedule/sync', adminAuth, async (req, res) => {
    try {
        const zoneId = req.params.id;
        const { homeId } = req.body;
        if (!homeId) return res.status(400).json({ error: 'homeId is required' });

        const result = await commandApi.pushOfflineScheduleSync(homeId, zoneId);
        res.json({ success: true, ...result });
    } catch (err) {
        _log('error', `Offline schedule sync error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// --- Tuning API Routes ---

router.get('/tuning/list', adminAuth, async (req, res) => {
    try {
        const pool = db.getPool();
        // Get VA devices
        const [devices] = await pool.execute(`
            SELECT d.serial_no, d.serial_no as short_serial_no, d.device_type, d.home_id, d.zone_id,
                   d.field_0273, d.field_027c, d.field_0280, d.field_0265, d.field_0266, d.field_028c,
                   d.field_0283, d.field_01b5, d.field_01b6, d.field_01fa, d.field_01fb, d.field_016a,
                   h.name as home_name
            FROM devices d
            LEFT JOIN homes h ON d.home_id = h.id
            WHERE d.device_type LIKE 'VA%'
            ORDER BY d.serial_no ASC
        `);

        res.json({ devices });
    } catch (err) {
        _log('error', `Tuning list error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});


router.post('/devices/:serial/actuator-limits', adminAuth, async (req, res) => {
    try {
        const serial = req.params.serial;
        const { lowSteps, highSteps, driveConstant } = req.body;

        // 1. Push to device via CoAP
        const result = await commandApi.pushActuatorLimits(serial, { lowSteps, highSteps, driveConstant });

        // 2. Update devices columns in DB
        const pool = db.getPool();
        const updates = [];
        const params = [];
        if (lowSteps !== undefined && lowSteps !== null) { updates.push('field_0273 = ?'); params.push(Number(lowSteps)); }
        if (highSteps !== undefined && highSteps !== null) { updates.push('field_027c = ?'); params.push(Number(highSteps)); }
        if (driveConstant !== undefined && driveConstant !== null) { updates.push('field_0280 = ?'); params.push(Number(driveConstant)); }

        if (updates.length > 0) {
            params.push(serial); // For serial_no = ?
            await pool.execute(`UPDATE devices SET ${updates.join(', ')} WHERE serial_no = ?`, params);
        }
        mqttHaDiscovery.publishAllDiscovery().catch(() => { });

        res.json({ success: true, mid: result });
    } catch (err) {
        _log('error', `Actuator limits tuning error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// --- Whitelist API Routes ---

router.post('/whitelist', adminAuth, async (req, res) => {
    try {
        const { type, value } = req.body;
        const pool = db.getPool();
        await pool.execute('INSERT IGNORE INTO websocket_whitelist (type, value) VALUES (?, ?)', [type, value]);
        res.json({ success: true });
    } catch (err) {
        _log('error', `Whitelist add error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.delete('/whitelist/:id', adminAuth, async (req, res) => {
    try {
        const pool = db.getPool();
        await pool.execute('DELETE FROM websocket_whitelist WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        _log('error', `Whitelist delete error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// --- User API Routes ---

router.delete('/users/:id', adminAuth, async (req, res) => {
    const pool = db.getPool();
    let conn;
    try {
        const [adminHomes] = await pool.execute('SELECT * FROM homes WHERE admin_user_id = ?', [req.params.id]);
        if (adminHomes.length > 0) {
            return res.status(400).json({ error: 'Cannot delete the admin user of a home' });
        }

        conn = await pool.getConnection();
        await conn.beginTransaction();
        await conn.execute('DELETE FROM users WHERE id = ?', [req.params.id]);
        await conn.commit();
        res.json({ success: true });
    } catch (err) {
        if (conn) await conn.rollback();
        _log('error', `User delete error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    } finally {
        if (conn) conn.release();
    }
});

router.post('/users/:id/password', adminAuth, async (req, res) => {
    try {
        const pool = db.getPool();
        const hashed = await bcrypt.hash(req.body.password, 10);
        await pool.execute('UPDATE users SET password = ? WHERE id = ?', [hashed, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        _log('error', `User password update error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.post('/users/:id/email', adminAuth, async (req, res) => {
    try {
        const pool = db.getPool();
        await pool.execute('UPDATE users SET email = ?, username = ? WHERE id = ?', [req.body.email, req.body.email, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        _log('error', `User email update error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// --- Admin Security API ---

router.post('/admin/password', adminAuth, async (req, res) => {
    try {
        const { password, totp } = req.body;
        if (!password) return res.status(400).json({ error: 'Password required' });

        const pool = db.getPool();
        const [rows] = await pool.execute('SELECT * FROM admin_users WHERE id = ?', [req.admin.id]);
        const admin = rows[0];

        if (admin.totp_secret) {
            if (!totp || !TOTP.verify(admin.totp_secret, totp)) {
                return res.status(401).json({ error: 'Invalid 2FA code' });
            }
        }

        const hash = await bcrypt.hash(password, 10);
        await pool.execute('UPDATE admin_users SET password_hash = ? WHERE id = ?', [hash, req.admin.id]);
        _log('info', `Admin password updated for user ${req.admin.id}`);
        res.json({ success: true });
    } catch (err) {
        _log('error', `Admin password update error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.post('/admin/totp', adminAuth, async (req, res) => {
    try {
        const { secret, totp } = req.body;
        const pool = db.getPool();
        const [rows] = await pool.execute('SELECT * FROM admin_users WHERE id = ?', [req.admin.id]);
        const admin = rows[0];

        if (secret) {
            if (!totp || !TOTP.verify(secret, totp)) {
                return res.status(401).json({ error: 'Invalid 2FA code from NEW secret' });
            }
        } else {
            if (admin.totp_secret) {
                if (!totp || !TOTP.verify(admin.totp_secret, totp)) {
                    return res.status(401).json({ error: 'Invalid 2FA code' });
                }
            }
        }

        await pool.execute('UPDATE admin_users SET totp_secret = ? WHERE id = ?', [secret || null, req.admin.id]);
        _log('info', `Admin 2FA secret updated for user ${req.admin.id}`);
        res.json({ success: true });
    } catch (err) {
        _log('error', `Admin TOTP update error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// --- Seeding Logic ---

// H5 fix: seedingSessions with TTL cleanup to prevent memory leaks
let seedingSessions = {};
const SEEDING_SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Clean up expired seeding sessions every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [adminId, session] of Object.entries(seedingSessions)) {
        if (now - session.createdAt > SEEDING_SESSION_TTL_MS) {
            delete seedingSessions[adminId];
            _log('info', `[Seeding] Expired stale seeding session for admin ${adminId}`);
        }
    }
}, 5 * 60 * 1000).unref();

router.post('/seed/start', adminAuth, async (req, res) => {
    try {
        const response = await fetch('https://login.tado.com/oauth2/device_authorize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `client_id=1bb50063-6b0c-4d11-bd99-387f4a91cc46&scope=offline_access home.user`
        });
        const data = await response.json();
        seedingSessions[req.admin.id] = { device_code: data.device_code, createdAt: Date.now() };
        res.json({
            user_code: data.user_code,
            verification_uri: data.verification_uri_complete || data.verification_uri
        });
    } catch (err) {
        _log('error', `System API error at line 342: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.get('/seed/check', adminAuth, async (req, res) => {
    const session = seedingSessions[req.admin.id];
    if (!session) return res.status(400).json({ status: 'error', message: 'No active seeding' });

    try {
        const response = await fetch('https://login.tado.com/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `client_id=1bb50063-6b0c-4d11-bd99-387f4a91cc46&grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${session.device_code}`
        });

        const data = await response.json();
        if (data.error === 'authorization_pending') {
            return res.json({ status: 'pending' });
        }

        if (data.access_token) {
            delete seedingSessions[req.admin.id];
            try {
                await performSeeding(data.access_token);
                mqttHaDiscovery.publishAllDiscovery().catch(() => { });
                return res.json({ status: 'success' });
            } catch (seedErr) {
                _log('error', `Seeding execution failed: ${seedErr.message}\n${seedErr.stack}`);
                return res.status(500).json({ status: 'error', message: seedErr.message });
            }
        }

        res.status(400).json({ status: 'error', message: data.error_description || data.error });
    } catch (err) {
        _log('error', `Seeding check failed: ${err.message}\n${err.stack}`);
        res.status(500).json({ status: 'error', message: 'Seeding check failed' });
    }
});

async function performSeeding(accessToken) {
    const tadoFetch = (endpoint) => fetch(`https://my.tado.com/api/v2${endpoint}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
    }).then(async r => {
        const body = await r.json();
        if (!r.ok) throw new Error(`Tado API ${endpoint} failed (${r.status}): ${JSON.stringify(body)}`);
        return body;
    });

    const formatDate = (iso) => {
        if (!iso) return null;
        try {
            const d = new Date(iso);
            if (isNaN(d.getTime())) return null;
            return d.toISOString().slice(0, 19).replace('T', ' ');
        } catch (e) {
            return null;
        }
    };

    const pool = db.getPool();
    let conn;

    try {
        const me = await tadoFetch('/me');
        if (!me.homes || me.homes.length === 0) throw new Error('No homes found in Tado account');
        const homeId = me.homes[0].id;
        _log('info', `Importing Home ${homeId} (${me.name || 'Unknown'})`);

        const [home, zones, devices, users] = await Promise.all([
            tadoFetch(`/homes/${homeId}`),
            tadoFetch(`/homes/${homeId}/zones`),
            tadoFetch(`/homes/${homeId}/devices`),
            tadoFetch(`/homes/${homeId}/users`)
        ]);

        let emailSettings = {}, zoneStates = {};
        try { emailSettings = await tadoFetch(`/homes/${homeId}/emailNotificationSettings`); } catch (e) { }
        try { zoneStates = await tadoFetch(`/homes/${homeId}/zoneStates`); } catch (e) { }

        conn = await pool.getConnection();
        await conn.beginTransaction();

        // Preserve existing settings
        const [existing] = await conn.execute('SELECT is_proxied, proxy_logging, log_uploads_enabled, allow_commands_in_proxy FROM homes WHERE id = ?', [homeId]);
        const settings = existing[0] || { is_proxied: 0, proxy_logging: 0, log_uploads_enabled: 0, allow_commands_in_proxy: 0 };

        // Fetch mobile device IDs before deleting them
        const [oldDevices] = await conn.execute('SELECT id FROM mobile_devices WHERE home_id = ?', [homeId]);
        const oldDeviceIds = oldDevices.map(d => d.id);

        await conn.execute('DELETE FROM zone_overlays WHERE home_id = ?', [homeId]);
        await conn.execute('DELETE FROM away_configurations WHERE home_id = ?', [homeId]);
        await conn.execute('DELETE FROM zone_timetables WHERE home_id = ?', [homeId]);
        await conn.execute('DELETE FROM schedule_blocks WHERE home_id = ?', [homeId]);
        await conn.execute('DELETE FROM heating_systems WHERE home_id = ?', [homeId]);
        await conn.execute('DELETE FROM heating_circuits WHERE home_id = ?', [homeId]);
        await conn.execute('DELETE FROM flow_temperature_settings WHERE home_id = ?', [homeId]);
        await conn.execute('DELETE FROM mobile_devices WHERE home_id = ? AND geofencing_access_token IS NULL', [homeId]);

        const adminUser = users.find(u => u.name === home.adminUser || u.email === home.contactDetails?.email) || users[0];
        const adminUserId = adminUser.id;

        // INSERT Home
        await conn.execute(`
            INSERT INTO homes (
                id, name, date_created, temperature_unit, installation_completed, simple_smart_schedule_enabled, 
                away_radius_in_meters, installation_method, incident_detection_enabled, latitude, longitude, 
                presence, presence_locked, email_low_battery_reminder,
                address_line1, address_line2, address_zip_code, address_city, address_state, address_country,
                contact_name, contact_email, contact_phone, 
                generation, zones_count, language, christmas_mode_enabled, 
                show_auto_assist_reminders, consent_grant_skippable, is_air_comfort_eligible, 
                is_energy_iq_eligible, is_heat_source_installed, is_heat_pump_installed, supports_flow_temperature_optimization,
                date_time_zone, is_proxied, proxy_logging, log_uploads_enabled, allow_commands_in_proxy, admin_user_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE 
                name=VALUES(name), temperature_unit=VALUES(temperature_unit), installation_completed=VALUES(installation_completed),
                latitude=VALUES(latitude), longitude=VALUES(longitude), 
                email_low_battery_reminder=VALUES(email_low_battery_reminder),
                address_line1=VALUES(address_line1), address_line2=VALUES(address_line2), address_zip_code=VALUES(address_zip_code), address_city=VALUES(address_city), address_state=VALUES(address_state), address_country=VALUES(address_country),
                contact_name=VALUES(contact_name), contact_email=VALUES(contact_email), contact_phone=VALUES(contact_phone),
                zones_count=VALUES(zones_count), language=VALUES(language), date_time_zone=VALUES(date_time_zone), admin_user_id=VALUES(admin_user_id)
        `, [
            homeId, home.name, formatDate(home.dateCreated || new Date()), home.temperatureUnit || 'CELSIUS',
            home.installationCompleted ? 1 : 0, home.simpleSmartScheduleEnabled ? 1 : 0,
            home.awayRadiusInMeters || 0, 'MANUAL', home.incidentDetection?.enabled ? 1 : 0,
            home.geolocation?.latitude || 0, home.geolocation?.longitude || 0,
            'HOME', 0, emailSettings.lowBatteryReminder !== false ? 1 : 0,
            home.address?.addressLine1 || '', home.address?.addressLine2 || '', home.address?.zipCode || '', home.address?.city || '', home.address?.state || '', home.address?.country || '',
            home.contactDetails?.name || '', home.contactDetails?.email || '', home.contactDetails?.phone || '',
            home.generation || 'PRE_LINE_X', home.zonesCount || 0, home.language || 'en',
            home.christmasModeEnabled ? 1 : 0,
            home.showAutoAssistReminders ? 1 : 0, home.consentGrantSkippable ? 1 : 0,
            home.isAirComfortEligible ? 1 : 0, home.isEnergyIqEligible ? 1 : 0,
            home.isHeatSourceInstalled ? 1 : 0, home.isHeatPumpInstalled ? 1 : 0, home.supportsFlowTemperatureOptimization ? 1 : 0,
            home.dateTimeZone || 'Europe/Berlin', settings.is_proxied, settings.proxy_logging, settings.log_uploads_enabled, settings.allow_commands_in_proxy || 0, adminUserId
        ]);

        const mobileDeviceUserMap = {};
        for (const u of users) {
            await conn.execute(`
               INSERT INTO users (id, username, name, email, password, locale, home_id) 
               VALUES (?, ?, ?, ?, ?, ?, ?) 
               ON DUPLICATE KEY UPDATE name=VALUES(name), email=VALUES(email), locale=VALUES(locale), home_id=VALUES(home_id)
           `, [u.id, u.username || u.email, u.name, u.email, await bcrypt.hash('tanoclo2026', 10), u.locale || 'en', homeId]);
            if (u.mobileDevices) u.mobileDevices.forEach(md => mobileDeviceUserMap[md.id] = u.id);
        }

        // Mobile Devices
        try {
            const mobileDevices = await tadoFetch(`/homes/${homeId}/mobileDevices`);
            for (const md of mobileDevices) {
                const uId = mobileDeviceUserMap[md.id] || users[0].id;
                const push = md.settings?.pushNotifications || {};
                await conn.execute(`
                    INSERT INTO mobile_devices (
                        id, user_id, home_id, name, platform, os_version, model, locale, geo_tracking_enabled,
                        push_low_battery_reminder, push_away_mode_reminder, push_home_mode_reminder,
                        push_open_window_reminder, push_energy_savings_report_reminder, push_incident_detection,
                        push_energy_iq_reminder, push_tariff_high_price_alert, push_tariff_low_price_alert, push_smart_reminders
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE
                        name=VALUES(name), platform=VALUES(platform), os_version=VALUES(os_version), model=VALUES(model), locale=VALUES(locale),
                        geo_tracking_enabled=VALUES(geo_tracking_enabled),
                        push_low_battery_reminder=VALUES(push_low_battery_reminder), push_away_mode_reminder=VALUES(push_away_mode_reminder),
                        push_home_mode_reminder=VALUES(push_home_mode_reminder), push_open_window_reminder=VALUES(push_open_window_reminder),
                        push_energy_savings_report_reminder=VALUES(push_energy_savings_report_reminder), push_incident_detection=VALUES(push_incident_detection),
                        push_energy_iq_reminder=VALUES(push_energy_iq_reminder), push_tariff_high_price_alert=VALUES(push_tariff_high_price_alert),
                        push_tariff_low_price_alert=VALUES(push_tariff_low_price_alert), push_smart_reminders=VALUES(push_smart_reminders)
                `, [
                    md.id, uId, homeId, md.name,
                    md.deviceMetadata?.platform || 'unknown', md.deviceMetadata?.osVersion || 'unknown', md.deviceMetadata?.model || 'unknown', md.deviceMetadata?.locale || 'en',
                    md.settings?.geoTrackingEnabled ? 1 : 0,
                    push.lowBatteryReminder !== false ? 1 : 0,
                    push.awayModeReminder !== false ? 1 : 0,
                    push.homeModeReminder !== false ? 1 : 0,
                    push.openWindowReminder !== false ? 1 : 0,
                    push.energySavingsReportReminder !== false ? 1 : 0,
                    push.incidentDetection !== false ? 1 : 0,
                    push.energyIqReminder === true ? 1 : 0,
                    push.tariffHighPriceAlert !== false ? 1 : 0,
                    push.tariffLowPriceAlert !== false ? 1 : 0,
                    push.smartReminders !== false ? 1 : 0
                ]);
            }
        } catch (e) { }

        let hasDhwZone = false;
        // Zones
        for (const z of zones) {
            if (z.type === 'HOT_WATER' || z.type === 'DHW') {
                hasDhwZone = true;
            }
            let defOverlay = {}, control = {}, state = {}, caps = {}, awayConfig = {};
            try { defOverlay = await tadoFetch(`/homes/${homeId}/zones/${z.id}/defaultOverlay`); } catch (e) { }
            try { control = await tadoFetch(`/homes/${homeId}/zones/${z.id}/control`); } catch (e) { }
            try { state = await tadoFetch(`/homes/${homeId}/zones/${z.id}/state`); } catch (e) { }
            try { caps = await tadoFetch(`/homes/${homeId}/zones/${z.id}/capabilities`); } catch (e) { }
            try { awayConfig = await tadoFetch(`/homes/${homeId}/zones/${z.id}/awayConfiguration`); } catch (e) { }

            const minTemp = caps.temperatures?.celsius?.min || 5.0;
            const maxTemp = caps.temperatures?.celsius?.max || 25.0;
            const stepTemp = caps.temperatures?.celsius?.step || 0.1;

            let overlayType = 'MANUAL', overlayJson = '{}', overlayDuration = 0;
            if (defOverlay && Object.keys(defOverlay).length > 0) {
                overlayJson = JSON.stringify(defOverlay);
                overlayType = defOverlay.terminationCondition?.type || 'MANUAL';
                overlayDuration = defOverlay.terminationCondition?.durationInSeconds || 0;
            }

            const zoneOrderIds = zoneStates.zoneStates ? Object.keys(zoneStates.zoneStates) : [];
            const displayOrder = zoneOrderIds.indexOf(String(z.id));
            const finalDisplayOrder = displayOrder !== -1 ? displayOrder : zones.indexOf(z);

            await conn.execute(`
                INSERT INTO zones (
                    id, home_id, name, type, date_created, open_window_enabled, open_window_timeout, 
                    dazzle_enabled, early_start_enabled, default_overlay_type, 
                    default_overlay_duration, min_temp, max_temp, step_temp, heating_circuit, display_order
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE 
                    name=VALUES(name), type=VALUES(type), open_window_enabled=VALUES(open_window_enabled),
                    dazzle_enabled=VALUES(dazzle_enabled), early_start_enabled=VALUES(early_start_enabled),
                    default_overlay_type=VALUES(default_overlay_type), default_overlay_duration=VALUES(default_overlay_duration),
                    min_temp=VALUES(min_temp), max_temp=VALUES(max_temp), display_order=VALUES(display_order)
            `, [
                z.id, homeId, z.name, z.type, formatDate(z.dateCreated || new Date()),
                z.openWindowDetection?.enabled ? 1 : 0, z.openWindowDetection?.timeoutInSeconds || 900,
                z.dazzleEnabled ? 1 : 0, z.earlyStartEnabled ? 1 : 0, overlayType,
                overlayDuration, minTemp, maxTemp, stepTemp, control.heatingCircuit || null, finalDisplayOrder
            ]);

            // Zone Leader serial
            let leaderSerial = control.duties?.leader?.serialNo || (z.devices?.find(zd => zd.duties?.includes('ZONE_LEADER'))?.serialNo);
            if (leaderSerial) await conn.execute('UPDATE zones SET measuring_device_serial = ? WHERE id = ?', [leaderSerial, z.id]);

            // Zone State/Measurement
            if (state && state.sensorDataPoints) {
                await conn.execute(`
                    INSERT INTO zone_measurements (
                        home_id, zone_id, timestamp, field_012d, field_0135, field_40a0, 
                        link_state, tado_mode, field_61e0, field_6160, field_6240, field_6280, field_6200
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    homeId, z.id, formatDate(new Date()),
                    state.sensorDataPoints.insideTemperature?.celsius || null,
                    state.sensorDataPoints.humidity?.percentage || null,
                    state.activityDataPoints?.heatingPower?.percentage || 0.0,
                    state.link?.state || 'ONLINE', state.tadoMode || 'HOME', 1, 0, null,
                    state.overlay?.setting?.temperature?.celsius || null,
                    state.setting?.temperature?.celsius || null
                ]);

                if (state.overlay) {
                    const oSetting = state.overlay.setting || {};
                    const oTemp = oSetting.temperature || {};
                    await conn.execute(`
                        INSERT INTO zone_overlays (home_id, zone_id, setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit, termination_type, termination_duration_seconds, termination_expiry)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [
                        homeId, z.id,
                        oSetting.type || 'HEATING', oSetting.power || 'ON',
                        oTemp.celsius || null, oTemp.fahrenheit || null,
                        state.overlay.termination?.type || 'MANUAL', state.overlay.termination?.durationInSeconds || null, state.overlay.termination?.expiry || null
                    ]);
                }
            }

            if (awayConfig && Object.keys(awayConfig).length > 0) {
                const type = awayConfig.type || 'HEATING';
                const preheatingLevel = awayConfig.preheatingLevel || null;
                const minAwayTempC = awayConfig.minimumAwayTemperature?.celsius ?? null;
                const minAwayTempF = awayConfig.minimumAwayTemperature?.fahrenheit ?? null;
                const settingType = awayConfig.setting?.type || null;
                const settingPower = awayConfig.setting?.power || null;
                const settingTempC = awayConfig.setting?.temperature?.celsius ?? null;
                const settingTempF = awayConfig.setting?.temperature?.fahrenheit ?? null;

                await conn.execute(`
                    INSERT INTO away_configurations (
                        home_id, zone_id, auto_adjust, type, preheating_level, 
                        min_away_temp_celsius, min_away_temp_fahrenheit, 
                        setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    homeId, z.id, awayConfig.autoAdjust ? 1 : 0, type, preheatingLevel,
                    minAwayTempC, minAwayTempF, settingType, settingPower, settingTempC, settingTempF
                ]);
            }

            // Timetables
            try {
                const activeTt = await tadoFetch(`/homes/${homeId}/zones/${z.id}/schedule/activeTimetable`);
                const tadoTtId = activeTt.id ?? 1;
                const ttType = (tadoTtId === 0) ? 'ONE_DAY' : (tadoTtId === 2 ? 'SEVEN_DAY' : 'THREE_DAY');

                const [ttResult] = await conn.execute('INSERT INTO zone_timetables (home_id, zone_id, type, is_active) VALUES (?, ?, ?, 1)', [homeId, z.id, ttType]);
                const localTtId = ttResult.insertId;

                const blocks = await tadoFetch(`/homes/${homeId}/zones/${z.id}/schedule/timetables/${tadoTtId}/blocks`);
                for (const b of blocks) {
                    const settingType = b.setting?.type || 'HEATING';
                    const settingPower = b.setting?.power || 'ON';
                    const settingTempC = b.setting?.temperature?.celsius ?? null;
                    const settingTempF = b.setting?.temperature?.fahrenheit ?? null;

                    await conn.execute(`
                        INSERT INTO schedule_blocks (
                            home_id, timetable_id, day_type, start_time, end_time, geolocation_override, 
                            setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [
                        homeId, localTtId, b.dayType, b.start, b.end, b.geolocationOverride ? 1 : 0,
                        settingType, settingPower, settingTempC, settingTempF
                    ]);
                }
                await conn.execute('UPDATE zones SET last_schedule_change_at = NOW() WHERE id = ? AND home_id = ?', [z.id, homeId]);
            } catch (e) { }
        }

        // Devices
        for (const d of devices) {
            const zoneId = zones.find(z => z.devices?.some(zd => zd.serialNo === d.serialNo))?.id || null;
            const connState = d.connectionState?.value ? 1 : 0;
            const connStateTs = d.connectionState?.timestamp || new Date().toISOString();
            const caps = JSON.stringify(d.characteristics?.capabilities || []);
            const childLock = d.childLockEnabled !== undefined ? (d.childLockEnabled ? 1 : 0) : (d.characteristics?.childLockEnabled ? 1 : 0);
            const field_0149 = d.orientation || d.mountingState?.field_0149 || d.field_0149 || null;

            let mountingValue = null, mountingTs = null;
            if (d.deviceType === 'VA02') {
                mountingValue = d.mountingState?.value || 'CALIBRATED';
                mountingTs = d.mountingState?.timestamp || new Date().toISOString();
            }

            const dCaps = d.characteristics?.capabilities || [];
            const capInsideTemp = dCaps.includes('INSIDE_TEMPERATURE_MEASUREMENT') ? 1 : 0;
            const capIdentify = dCaps.includes('IDENTIFY') ? 1 : 0;
            const capRadio = dCaps.includes('RADIO_ENCRYPTION_KEY_ACCESS') ? 1 : 0;

            await conn.execute(`
                INSERT INTO devices (
                    serial_no, device_type, home_id, zone_id, current_fw_version,
                    connection_state, connection_state_timestamp, in_pairing_mode,
                    cap_inside_temp_measurement, cap_identify, cap_radio_encryption_key_access, field_0140,
                    battery_state, battery_percent, child_lock_enabled, field_0149,
                    field_016a, mounting_state_timestamp
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    zone_id=VALUES(zone_id), current_fw_version=VALUES(current_fw_version),
                    cap_inside_temp_measurement=VALUES(cap_inside_temp_measurement), cap_identify=VALUES(cap_identify), cap_radio_encryption_key_access=VALUES(cap_radio_encryption_key_access),
                    child_lock_enabled=VALUES(child_lock_enabled), field_0149=VALUES(field_0149), field_016a=VALUES(field_016a)
            `, [
                d.serialNo, d.deviceType, homeId, zoneId, d.currentFwVersion || null,
                connState, formatDate(connStateTs), 0,
                capInsideTemp, capIdentify, capRadio, 0.0,
                d.batteryState || 'NORMAL', d.batteryPercentage || 100,
                childLock, field_0149, mountingValue, formatDate(mountingTs)
            ]);

            if (d.deviceType === 'IB01') await conn.execute('INSERT IGNORE INTO websocket_whitelist (type, value) VALUES ("device", ?)', [d.serialNo]);
        }
        await conn.execute('INSERT IGNORE INTO websocket_whitelist (type, value) VALUES ("home", ?)', [homeId]);

        // Heating System & Flow
        try {
            const hs = await tadoFetch(`/homes/${homeId}/heatingSystem`);
            if (hs.boiler) {
                await conn.execute(`
                    INSERT INTO heating_systems (home_id, boiler_present, boiler_id, boiler_found, underfloor_heating_present, field_0457)
                    VALUES (?, ?, ?, ?, ?, 1)
                `, [homeId, hs.boiler.present ? 1 : 0, hs.boiler.id || null, hs.boiler.found ? 1 : 0, hs.underfloorHeating?.present ? 1 : 0]);
            }
            let flow;
            try {
                flow = await tadoFetch(`/homes/${homeId}/flowTemperatureOptimization`);
            } catch (e) { }

            if (flow) {
                await conn.execute(`
                    INSERT INTO flow_temperature_settings (home_id, max_flow_temperature, min_flow_temperature, max_flow_temperature_limit, auto_adaptation_enabled)
                    VALUES (?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE 
                        max_flow_temperature=VALUES(max_flow_temperature), 
                        min_flow_temperature=VALUES(min_flow_temperature), 
                        max_flow_temperature_limit=VALUES(max_flow_temperature_limit), 
                        auto_adaptation_enabled=VALUES(auto_adaptation_enabled)
                `, [homeId, flow.maxFlowTemperature || 60, flow.maxFlowTemperatureConstraints?.min || 30, flow.maxFlowTemperatureConstraints?.max || 80, flow.autoAdaptation?.enabled ? 1 : 0]);
            } else if (hasDhwZone) {
                await conn.execute(`
                    INSERT INTO flow_temperature_settings (home_id, max_flow_temperature, min_flow_temperature, max_flow_temperature_limit, auto_adaptation_enabled)
                    VALUES (?, 60, 30, 80, 0)
                    ON DUPLICATE KEY UPDATE home_id = home_id
                `, [homeId]);
            }
        } catch (e) { }

        // Heating Circuits
        try {
            const circuits = await tadoFetch(`/homes/${homeId}/heatingCircuits`);
            for (const hc of circuits) {
                await conn.execute(`
                    INSERT INTO heating_circuits (home_id, number, driver_serial_no) VALUES (?, ?, ?)
                `, [homeId, hc.number, hc.driverSerialNo || null]);
            }
        } catch (e) {
            _log('error', `Failed to import heating circuits for home ${homeId}: ${e.message}\n${e.stack}`);
        }

        await conn.commit();
        _log('info', `Seeding completed for home ${homeId}`);

        // Compare old device IDs with new device IDs, unpublish those that were removed
        try {
            const [newDevices] = await pool.execute('SELECT id FROM mobile_devices WHERE home_id = ?', [homeId]);
            const newDeviceIds = new Set(newDevices.map(d => d.id));
            const mqttPublisher = require('../../../lib/mqtt-publisher');
            for (const oldId of oldDeviceIds) {
                if (!newDeviceIds.has(oldId)) {
                    mqttHaDiscovery.unpublishMobileDevice(oldId);
                    mqttPublisher.publishMobileDeviceTelemetry(homeId, oldId, false, null, null, null, false).catch(() => {});
                }
            }
        } catch (unpubErr) {
            _log('error', `Failed to unpublish removed mobile devices after seeding: ${unpubErr.message}`);
        }
    } catch (err) {
        if (conn) await conn.rollback();
        _log('error', `Seeding failed: ${err.message}\n${err.stack}`);
        throw err;
    } finally {
        if (conn) conn.release();
    }
}

// --- State Snapshot Routes (delegated) ---
const setupSnapshotsRouter = require('../setup-snapshots');
router.use('/', setupSnapshotsRouter);

module.exports = router;
