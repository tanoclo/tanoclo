/**
 * @file api/routes/auth/tokens.js
 */

'use strict';

/**
 * @file api/routes/auth.js
 * @brief OAuth2 / SSO authentication routes.
 * 
 * Implements authorization code grant flows, PKCE challenges, password grant exchanges,
 * access and refresh token revocations, and SSO cookies generation.
 */

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../../../lib/db');
const { hashToken } = require('../../../lib/db-base');
const { getLogger } = require('../../../lib/logger');
const geoUtils = require('../../../lib/geo-utils');
const authMiddleware = require('../../middleware/auth');

const router = express.Router();
const _log = getLogger('auth-api');

const config = require('../../../lib/config');

function generateRandomUuid() {
    return crypto.randomUUID();
}

function generateDeterministicUuid(namespace, name) {
    const hash = crypto.createHash('md5').update(namespace + name).digest('hex');
    return `${hash.substr(0, 8)}-${hash.substr(8, 4)}-4${hash.substr(13, 3)}-8${hash.substr(17, 3)}-${hash.substr(20, 12)}`;
}

/**
 * Constants for SSO
 */
const SSO_MAX_AGE = 365 * 24 * 60 * 60 * 1000; // 1 year

/**
 * Helper to set SSO cookies
 */
function setSSOCookies(res, userId, token, req) {
    const domainParts = req.hostname.split('.');
    const domain = domainParts.length >= 2 ? '.' + domainParts.slice(-2).join('.') : undefined;
    const cookieSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';

    const cookieOptions = {
        httpOnly: true,
        secure: cookieSecure,
        domain,
        path: '/',
        maxAge: SSO_MAX_AGE,
        sameSite: 'lax'
    };

    res.cookie('tanoclo_session', token, { ...cookieOptions, signed: true });

    res.cookie('fusionauth.sso', token, cookieOptions);
    res.cookie('fusionauth.li', 'true', cookieOptions);
    res.cookie('fusionauth.remember-device', 'true', cookieOptions);
}

/**
 * Handle browser-based OAuth2 authorization (GET)
 */


async function generateTokens(res, user, clientId, scope, grantType) {
    const pool = db.getPool();

    await pool.execute('DELETE FROM oauth_access_tokens WHERE user_id = ? AND client_id = ? AND expires_at < UTC_TIMESTAMP()', [user.id, clientId]);
    await pool.execute('DELETE FROM oauth_refresh_tokens WHERE user_id = ? AND client_id = ? AND expires_at < UTC_TIMESTAMP()', [user.id, clientId]);

    const [homes] = await pool.execute(
        'SELECT h.id FROM homes h JOIN users u ON h.id = u.home_id WHERE u.id = ?',
        [user.id]
    );
    const tadoHomes = homes.map(h => ({ id: h.id }));

    const now = Math.floor(Date.now() / 1000);
    const expiresIn = 14400;

    const tid = generateDeterministicUuid('tenant', String(user.id));
    const payload = {
        aud: ['partner'],
        exp: now + expiresIn,
        iat: now,
        iss: 'tado',
        nbf: now,
        sub: String(user.id),
        jti: generateRandomUuid(),
        email: user.email,
        email_verified: false,
        roles: [],
        auth_time: now,
        applicationId: 'eec8b609-9e2d-4403-9336-4f62a475271e',
        tid: tid,
        sid: generateRandomUuid(),
        tado_homes: tadoHomes,
        locale: user.locale || 'en',
        tado_scope: ['home.user'],
        scope: 'home.user offline_access',
        tado_username: user.email,
        name: user.name,
        tado_client_id: clientId || 'tado-mobile-app'
    };

    let accessToken = jwt.sign(payload, config.jwtSecret, {
        algorithm: 'HS256'
    });



    const userAgent = (res.req && res.req.headers['user-agent']) || '';
    const isMobileUA = /mobile|android|iphone|ipad|ipod|cordova|capacitor|tado|okhttp|cfnetwork/i.test(userAgent);
    const isRemember = res.req && (res.req.body?.remember === 'true' || res.req.body?.rememberMe === 'true' || res.req.query?.remember === 'true' || res.req.query?.rememberMe === 'true' || res.req.isLongLivedRefresh);

    const isLongLived = isMobileUA || isRemember;
    const refreshDays = isLongLived ? (10 * 365) : 30;

    const refreshToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date((now + expiresIn) * 1000).toISOString();
    const accessExpirationDate = new Date((now + expiresIn) * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const refreshExpirationDate = new Date((now + (refreshDays * 24 * 3600)) * 1000).toISOString().slice(0, 19).replace('T', ' ');

    await pool.execute(
        'INSERT INTO oauth_access_tokens (access_token, client_id, user_id, scope, expires_at) VALUES (?, ?, ?, ?, ?)',
        [hashToken(accessToken), clientId || 'tado-mobile-app', user.id, scope, accessExpirationDate]
    );

    await pool.execute(
        'INSERT INTO oauth_refresh_tokens (refresh_token, client_id, user_id, scope, expires_at) VALUES (?, ?, ?, ?, ?)',
        [hashToken(refreshToken), clientId || 'tado-mobile-app', user.id, scope, refreshExpirationDate]
    );

    const domainParts = res.req.hostname.split('.');
    const domain = domainParts.length >= 2 ? '.' + domainParts.slice(-2).join('.') : undefined;
    const cookieSecure = res.req.secure || res.req.headers['x-forwarded-proto'] === 'https';

    res.cookie('tado_locale', user.locale || 'en', {
        maxAge: 31536000000,
        domain,
        path: '/',
        secure: cookieSecure,
        sameSite: 'lax'
    });

    // Set httpOnly cookie with the refresh token so web clients don't need localStorage.
    // Native (Capacitor) clients ignore this cookie and use the body value instead.
    res.cookie('tanoclo_rt', refreshToken, {
        httpOnly: true,
        secure: cookieSecure,
        domain,
        path: '/',
        maxAge: refreshDays * 24 * 60 * 60 * 1000,
        sameSite: 'lax',
        signed: true
    });

    res.json({
        access_token: accessToken,
        expires_at: expiresAt,
        expires_in: expiresIn,
        refresh_token: refreshToken,
        refresh_token_id: payload.sid,
        scope: scope,
        token_type: 'Bearer',
        userId: user.id
    });
}

router.post(['/oauth/token', '/oauth2/token'], async (req, res) => {
    try {
        let { grant_type, client_id, scope } = req.body || {};

        if (!client_id && req.headers.authorization && req.headers.authorization.startsWith('Basic ')) {
            try {
                const b64auth = req.headers.authorization.split(' ')[1];
                const auth = Buffer.from(b64auth, 'base64').toString();
                client_id = auth.split(':')[0];
            } catch (e) {
                _log('warn', '[OAUTH-TOKEN] Failed to parse Basic Auth header');
            }
        }

        const pool = db.getPool();

        if (grant_type === 'password') {
            const { username, password } = req.body || {};
            if (!username || !password) return res.status(400).json({ error: 'invalid_request' });

            const [users] = await pool.execute('SELECT * FROM users WHERE username = ? OR email = ?', [username, username]);
            if (users.length === 0) return res.status(400).json({ error: 'invalid_grant' });

            const user = users[0];

            const valid = await bcrypt.compare(password, user.password);

            if (!valid) return res.status(400).json({ error: 'invalid_grant' });

            await pool.execute('DELETE FROM invitations WHERE email = ?', [user.email]);

            _log('debug', `[OAUTH-TOKEN] Password grant success for ${username}`);
            return await generateTokens(res, user, client_id, scope || 'home.user offline_access', 'password');
        }

        if (grant_type === 'authorization_code') {
            const { code, redirect_uri, code_verifier } = req.body || {};
            if (!code) {
                _log('warn', '[OAUTH-TOKEN] authorization_code grant missing code');
                return res.status(400).json({ error: 'invalid_request', error_description: 'Code missing' });
            }

            const [records] = await pool.execute('SELECT * FROM oauth_auth_codes WHERE code = ?', [code]);
            if (records.length === 0) {
                _log('warn', `[OAUTH-TOKEN] authorization_code grant: code not found: [REDACTED]`);
                return res.status(400).json({ error: 'invalid_grant', error_description: 'Code invalid' });
            }

            const record = records[0];

            if (new Date(record.expires_at + 'Z') < new Date()) {
                _log('warn', `[OAUTH-TOKEN] authorization_code grant: code expired: [REDACTED]`);
                return res.status(400).json({ error: 'invalid_grant', error_description: 'Code expired' });
            }

            if (record.code_challenge) {
                if (!code_verifier) {
                    _log('warn', '[OAUTH-TOKEN] PKCE: code_verifier missing');
                    return res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier missing' });
                }

                let verified = false;
                if (record.code_challenge_method === 'S256') {
                    const hash = crypto.createHash('sha256').update(code_verifier).digest('base64');
                    const challenge = hash.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
                    verified = (challenge === record.code_challenge);
                } else {
                    verified = (code_verifier === record.code_challenge);
                }

                if (!verified) {
                    _log('warn', `[OAUTH-TOKEN] PKCE: verification failed. Expected ${record.code_challenge}, got [REDACTED] (method=${record.code_challenge_method})`);
                    return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
                }
            }

            await pool.execute('DELETE FROM oauth_auth_codes WHERE code = ?', [code]);
            const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [record.user_id]);
            if (users.length === 0) {
                _log('warn', `[OAUTH-TOKEN] authorization_code grant: user not found: ${records[0].user_id}`);
                return res.status(400).json({ error: 'invalid_grant' });
            }

            _log('debug', `[OAUTH-TOKEN] Auth code grant success for user ${record.user_id}`);
            return await generateTokens(res, users[0], client_id || records[0].client_id, records[0].scope, 'authorization_code');
        }

        if (grant_type === 'refresh_token') {
            // Accept refresh token from request body (native clients) or httpOnly cookie (web clients)
            const refresh_token = req.body?.refresh_token ||
                (req.signedCookies && req.signedCookies.tanoclo_rt) || null;
            if (!refresh_token) return res.status(400).json({ error: 'invalid_request' });

            const [records] = await pool.execute('SELECT * FROM oauth_refresh_tokens WHERE refresh_token = ?', [hashToken(refresh_token)]);

            if (records.length === 0 || new Date(records[0].expires_at + 'Z') < new Date()) {
                return res.status(400).json({ error: 'invalid_grant' });
            }

            const originalExpiresAt = new Date(records[0].expires_at + 'Z');
            const nowTime = new Date();
            const diffDays = (originalExpiresAt - nowTime) / (1000 * 60 * 60 * 24);
            if (diffDays > 30) {
                req.isLongLivedRefresh = true;
            }

            await pool.execute('DELETE FROM oauth_refresh_tokens WHERE refresh_token = ?', [hashToken(refresh_token)]);

            const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [records[0].user_id]);
            _log('debug', `[OAUTH-TOKEN] Refresh token grant success for user ${records[0].user_id}`);
            return await generateTokens(res, users[0], client_id || records[0].client_id, records[0].scope, 'refresh_token');
        }

        if (grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
            const { device_code } = req.body || {};
            if (!device_code) return res.status(400).json({ error: 'invalid_request' });

            const [records] = await pool.execute('SELECT * FROM oauth_device_codes WHERE device_code = ?', [device_code]);
            if (records.length === 0) {
                _log('warn', `[OAUTH-TOKEN] device_code grant: code not found: [REDACTED]`);
                return res.status(400).json({ error: 'invalid_grant' });
            }

            const record = records[0];
            if (new Date(record.expires_at + 'Z') < new Date()) {
                _log('warn', `[OAUTH-TOKEN] device_code grant: code expired: [REDACTED]`);
                return res.status(400).json({ error: 'expired_token' });
            }

            if (record.is_approved === 0) {
                return res.status(400).json({ error: 'authorization_pending' });
            }

            await pool.execute('DELETE FROM oauth_device_codes WHERE device_code = ?', [device_code]);
            const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [record.user_id]);
            if (users.length === 0) {
                _log('warn', `[OAUTH-TOKEN] device_code grant: user not found: ${record.user_id}`);
                return res.status(400).json({ error: 'invalid_grant' });
            }

            _log('debug', `[OAUTH-TOKEN] Device grant success for user ${record.user_id}`);
            return await generateTokens(res, users[0], record.client_id, record.scope, 'device_code');
        }

        _log('warn', `Unsupported grant type: ${grant_type}`);
        return res.status(400).json({ error: 'unsupported_grant_type' });
    } catch (err) {
        _log('error', `Token generation error: ${err.stack || err.message}`);
        res.status(500).json({ error: 'internal_error', details: err.message });
    }
});

module.exports = router;
