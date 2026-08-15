/**
 * @file api/routes/auth/oauth-flows.js
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


router.get(['/oauth2/authorize', '/oauth/authorize'], async (req, res) => {
    const { client_id, response_type, redirect_uri, scope, state, code_challenge, code_challenge_method } = req.query;

    let userId = null;
    let sessionToken = req.signedCookies ? req.signedCookies.tanoclo_session : null;

    if (!sessionToken && req.cookies && req.cookies['fusionauth.sso']) {
        sessionToken = req.cookies['fusionauth.sso'];
    }

    if (sessionToken) {
        const session = await db.getOauthSession(sessionToken);
        if (session) {
            userId = session.user_id;
            _log('info', `[OAUTH-GET-AUTH] Valid SSO session found for user ${userId}, token starting with ${sessionToken.substring(0, 8)}`);
        }
    }

    if (userId) {
        _log('info', `[OAUTH-GET-AUTH] Redirecting to consent for user ${userId}`);
        const consentToken = crypto.randomBytes(24).toString('hex');
        const pool = db.getPool();
        await pool.execute(
            'INSERT INTO oauth_consent_tokens (token, user_id, created_at, expires_at) VALUES (?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 5 MINUTE))',
            [consentToken, userId]
        );
        const query = new URLSearchParams(req.query);
        query.delete('user_id');
        query.set('consent_token', consentToken);
        return res.redirect(302, `/oauth2/consent?${query.toString()}`);
    }

    _log('info', `[OAUTH-GET-AUTH] No valid session, redirecting to login page`);
    const query = new URLSearchParams(req.query).toString();
    res.redirect(302, `/login?${query}`);
});

router.post(['/oauth2/authorize', '/oauth/authorize'], async (req, res) => {
    try {
        const {
            client_id, redirect_uri, scope, state,
            code_challenge, code_challenge_method,
            loginId, password
        } = req.body || {};

        _log('info', `[OAUTH-AUTH] Authorize request for ${loginId} (client=${client_id})`);

        if (!loginId || !password) {
            return res.status(400).json({ error: 'invalid_request', error_description: 'Missing credentials' });
        }

        const pool = db.getPool();
        const [users] = await pool.execute('SELECT * FROM users WHERE email = ? OR username = ?', [loginId, loginId]);

        if (users.length === 0) {
            return res.status(401).json({ error: 'invalid_grant', error_description: 'User not found' });
        }

        const user = users[0];
        const valid = await bcrypt.compare(password, user.password);

        if (!valid) {
            return res.status(401).json({ error: 'invalid_grant', error_description: 'Invalid password' });
        }

        // Generate a cryptographically secure session token
        const sessionToken = crypto.randomBytes(48).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

        await db.createOauthSession(
            user.id,
            sessionToken,
            req.headers['user-agent'] || 'unknown',
            req.ip || req.headers['x-forwarded-for'] || 'unknown'
        );

        setSSOCookies(res, user.id, sessionToken, req);

        const consentToken = crypto.randomBytes(24).toString('hex');
        await pool.execute(
            'INSERT INTO oauth_consent_tokens (token, user_id, created_at, expires_at) VALUES (?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 5 MINUTE))',
            [consentToken, user.id]
        );

        const query = new URLSearchParams({
            client_id: client_id || '',
            redirect_uri: redirect_uri || '',
            scope: scope || 'home.user offline_access',
            state: state || '',
            code_challenge: code_challenge || '',
            code_challenge_method: code_challenge_method || 'plain',
            consent_token: consentToken
        }).toString();

        _log('info', `[OAUTH-AUTH] Login success for ${loginId}, redirecting to complete-registration`);
        res.redirect(302, `/oauth2/complete-registration?${query}`);
    } catch (err) {
        _log('error', `Authorize error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.get('/oauth2/complete-registration', (req, res) => {
    const query = new URL(req.url, `http://${req.headers.host}`).search;
    res.redirect(302, `/oauth2/consent${query}`);
});

router.get('/oauth2/consent', async (req, res) => {
    try {
        const {
            client_id, redirect_uri, scope, state,
            code_challenge, code_challenge_method
        } = req.query;

        const pool = db.getPool();
        let user_id = req.query.user_id; // Legacy fallback
        if (!user_id && req.query.consent_token) {
            const [tokenRows] = await pool.execute(
                'SELECT user_id FROM oauth_consent_tokens WHERE token = ? AND expires_at > NOW()',
                [req.query.consent_token]
            );
            if (tokenRows.length > 0) {
                user_id = tokenRows[0].user_id;
                // Delete used token
                await pool.execute('DELETE FROM oauth_consent_tokens WHERE token = ?', [req.query.consent_token]);
            }
        }
        if (!user_id && req.signedCookies && req.signedCookies.tanoclo_session) {
            const session = await db.getOauthSession(req.signedCookies.tanoclo_session);
            if (session) {
                user_id = session.user_id;
            }
        }

        if (!client_id || !redirect_uri || !user_id) {
            _log('warn', `[OAUTH-CONSENT] Missing params: client=${!!client_id} redir=${!!redirect_uri} user=${!!user_id}`);
            return res.status(400).send('Missing required OAuth2 parameters');
        }
        const code = crypto.randomBytes(20).toString('hex');
        const expiresAt = new Date(Date.now() + 300000).toISOString().slice(0, 19).replace('T', ' '); // 5 mins

        await pool.execute(
            'INSERT INTO oauth_auth_codes (code, client_id, user_id, redirect_uri, scope, expires_at, code_challenge, code_challenge_method) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [code, client_id, user_id, redirect_uri, scope || 'home.user offline_access', expiresAt, code_challenge || null, code_challenge_method || 'plain']
        );

        const [users] = await pool.execute('SELECT locale FROM users WHERE id = ?', [user_id]);
        const locale = users.length > 0 ? users[0].locale : 'en';
        const localeParam = `${locale}_${locale.toUpperCase()}`;

        const redirectUrl = new URL(redirect_uri);
        redirectUrl.searchParams.set('code', code);
        redirectUrl.searchParams.set('locale', localeParam);
        if (state) redirectUrl.searchParams.set('state', state);
        redirectUrl.searchParams.set('userState', 'AuthenticatedNotVerified');

        const domainParts = res.req.hostname.split('.');
        const domain = domainParts.length >= 2 ? '.' + domainParts.slice(-2).join('.') : undefined;
        res.cookie('tado_locale', locale, {
            maxAge: 31536000000,
            domain,
            path: '/',
            secure: res.req.secure || res.req.headers['x-forwarded-proto'] === 'https',
            sameSite: 'lax'
        });

        const loggedUrl = new URL(redirectUrl.toString());
        if (loggedUrl.searchParams.has('code')) {
            loggedUrl.searchParams.set('code', '[REDACTED]');
        }
        _log('info', `[OAUTH-AUTH] Redirecting back to app: ${loggedUrl.toString()}`);
        res.redirect(302, redirectUrl.toString());
    } catch (err) {
        _log('error', `Consent error: ${err.message}`);
        res.status(500).send('Internal Server Error');
    }
});

module.exports = router;
