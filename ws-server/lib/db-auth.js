/**
 * @file lib/db-auth.js
 * @brief OAuth2 clients and tokens database helper queries.
 */

'use strict';
/**
 * @module db-auth
 * 
 * Authentication and authorization DB operations.
 * Handles admin status checks, user lookups, whitelists, OAuth sessions, and token cleanup.
 */
const { getPool, _log, safeJsonParse, isOffline, hashToken } = require('./db-base');

async function getAdminStatus(homeId, userId) {
    const pool = getPool();
    const [homes] = await pool.execute('SELECT admin_user_id FROM homes WHERE id = ?', [homeId]);
    if (homes.length === 0) return { isFound: false };
    const adminUserId = homes[0].admin_user_id;

    if (userId === adminUserId) {
        return { isFound: true, isTadoAdmin: true, isTaNoCloAdmin: false, isAdmin: true, adminUserId };
    }

    const [hu] = await pool.execute('SELECT is_tanoclo_admin FROM users WHERE id = ?', [userId]);
    if (hu.length > 0 && hu[0].is_tanoclo_admin === 1) {
        return { isFound: true, isTadoAdmin: false, isTaNoCloAdmin: true, isAdmin: true, adminUserId };
    }

    return { isFound: true, isTadoAdmin: false, isTaNoCloAdmin: false, isAdmin: false, adminUserId };
}

async function getUserByEmail(email) {
    const p = getPool();
    const [rows] = await p.execute('SELECT * FROM users WHERE email=? LIMIT 1', [email]);
    return rows.length > 0 ? rows[0] : null;
}

async function getMobileDevicesForHome(homeId) {
    const p = getPool();
    const [rows] = await p.execute('SELECT * FROM mobile_devices WHERE home_id=?', [homeId]);
    return rows;
}

async function checkWhitelist(type, value) {
    const p = getPool();
    const [counts] = await p.execute('SELECT COUNT(*) as c FROM websocket_whitelist');
    if (counts[0].c === 0) return true; // Whitelist disabled if empty

    const [rows] = await p.execute('SELECT id FROM websocket_whitelist WHERE type=? AND value=? LIMIT 1', [type, value]);
    return rows.length > 0;
}

async function createOauthSession(userId, token, userAgent, ipAddress) {
    const p = getPool();
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year
    await p.execute(
        'INSERT INTO oauth_sessions (user_id, session_token, user_agent, ip_address, expires_at) VALUES (?, ?, ?, ?, ?)',
        [userId, hashToken(token), userAgent, ipAddress, expiresAt]
    );
}

async function getOauthSession(token) {
    const p = getPool();
    const [rows] = await p.execute(
        'SELECT * FROM oauth_sessions WHERE session_token=? AND expires_at>CURRENT_TIMESTAMP LIMIT 1',
        [hashToken(token)]
    );
    return rows.length > 0 ? rows[0] : null;
}

async function deleteOauthSession(token) {
    const p = getPool();
    await p.execute('DELETE FROM oauth_sessions WHERE session_token=?', [hashToken(token)]);
}

async function deleteAllOauthSessionsForUser(userId) {
    const p = getPool();
    await p.execute('DELETE FROM oauth_sessions WHERE user_id=?', [userId]);
}

async function cleanupExpiredTokens() {
    if (isOffline()) return;
    const p = getPool();

    let totalDeleted = 0;
    try {
        const [r1] = await p.execute('DELETE FROM oauth_access_tokens WHERE expires_at < NOW()');
        totalDeleted += r1.affectedRows;
        const [r2] = await p.execute('DELETE FROM oauth_auth_codes WHERE expires_at < NOW()');
        totalDeleted += r2.affectedRows;
        const [r3] = await p.execute('DELETE FROM oauth_device_codes WHERE expires_at < NOW()');
        totalDeleted += r3.affectedRows;
        const [r4] = await p.execute('DELETE FROM oauth_refresh_tokens WHERE expires_at < NOW()');
        totalDeleted += r4.affectedRows;
        const [r5] = await p.execute('DELETE FROM oauth_sessions WHERE expires_at < NOW()');
        totalDeleted += r5.affectedRows;
        const [r6] = await p.execute('DELETE FROM oauth_consent_tokens WHERE expires_at < NOW()');
        totalDeleted += r6.affectedRows;

        if (totalDeleted > 0) {
            _log('info', `Cleaned up ${totalDeleted} expired OAuth records.`);
        }
    } catch (e) {
        _log('error', `Token cleanup failed: ${e.message}`);
    }
}

module.exports = {
    getAdminStatus,
    getUserByEmail,
    getMobileDevicesForHome,
    checkWhitelist,
    createOauthSession,
    getOauthSession,
    deleteOauthSession,
    deleteAllOauthSessionsForUser,
    cleanupExpiredTokens
};
