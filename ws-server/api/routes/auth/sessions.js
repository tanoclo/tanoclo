/**
 * @file api/routes/auth/sessions.js
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


router.get('/login', (req, res, next) => {
    const { client_id, redirect_to } = req.query;
    if (!client_id && !redirect_to) {
        return next();
    }
    const { redirect_uri, state, code_challenge, code_challenge_method } = req.query;

    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Login - TaNoClo</title>
            <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600&display=swap" rel="stylesheet">
            <style>
                :root {
                    --primary: #00d1b2;
                    --bg: #0f172a;
                    --card-bg: #1e293b;
                    --text: #f8fafc;
                    --input-bg: #334155;
                }
                body {
                    font-family: 'Outfit', sans-serif;
                    background-color: var(--bg);
                    color: var(--text);
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    margin: 0;
                    overflow: hidden;
                }
                .login-card {
                    background: var(--card-bg);
                    padding: 2.5rem;
                    border-radius: 1.5rem;
                    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
                    width: 100%;
                    max-width: 400px;
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    backdrop-filter: blur(10px);
                    animation: fadeIn 0.6s ease-out;
                }
                @keyframes fadeIn {
                    from { opacity: 0; transform: translateY(20px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                h1 {
                    font-size: 2rem;
                    font-weight: 600;
                    margin-bottom: 0.5rem;
                    text-align: center;
                    background: linear-gradient(to right, #00d1b2, #3e8ed0);
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                }
                p.subtitle {
                    text-align: center;
                    color: #94a3b8;
                    margin-bottom: 2rem;
                }
                .form-group {
                    margin-bottom: 1.5rem;
                }
                label {
                    display: block;
                    margin-bottom: 0.5rem;
                    font-size: 0.875rem;
                    color: #94a3b8;
                }
                input {
                    width: 100%;
                    padding: 0.75rem 1rem;
                    border-radius: 0.75rem;
                    border: 1px solid #334155;
                    background: var(--input-bg);
                    color: white;
                    font-size: 1rem;
                    transition: border-color 0.2s, box-shadow 0.2s;
                    box-sizing: border-box;
                }
                input:focus {
                    outline: none;
                    border-color: var(--primary);
                    box-shadow: 0 0 0 3px rgba(0, 209, 178, 0.2);
                }
                button {
                    width: 100%;
                    padding: 0.75rem;
                    border-radius: 0.75rem;
                    border: none;
                    background: linear-gradient(to right, #00d1b2, #00b89c);
                    color: white;
                    font-size: 1rem;
                    font-weight: 600;
                    cursor: pointer;
                    transition: transform 0.1s, opacity 0.2s;
                    margin-top: 1rem;
                }
                button:hover {
                    opacity: 0.9;
                }
                button:active {
                    transform: scale(0.98);
                }
                .error {
                    color: #f87171;
                    font-size: 0.875rem;
                    text-align: center;
                    margin-top: 1rem;
                }
            </style>
        </head>
        <body>
            <div class="login-card">
                <h1>TaNoClo Login</h1>
                <p class="subtitle">Enter your credentials to continue</p>
                <form method="POST" action="/login?${new URLSearchParams(req.query).toString()}">
                    <div class="form-group">
                        <label for="loginId">Email Address or Username</label>
                        <input type="text" id="loginId" name="loginId" required placeholder="name@example.com" autocomplete="username">
                    </div>
                    <div class="form-group">
                        <label for="password">Password</label>
                        <input type="password" id="password" name="password" required placeholder="••••••••" autocomplete="current-password">
                    </div>
                    <button type="submit">Log In</button>
                    ${req.query.error ? `<div class="error">Invalid credentials</div>` : ''}
                </form>
            </div>
        </body>
        </html>
    `);
});

router.post('/login', async (req, res) => {
    const { loginId, password } = req.body || {};
    const pool = db.getPool();

    try {
        const [users] = await pool.execute('SELECT * FROM users WHERE email = ? OR username = ?', [loginId, loginId]);
        if (users.length === 0) {
            return res.redirect(`/login?${new URLSearchParams(req.query).toString()}&error=1`);
        }

        const user = users[0];
        const match = await bcrypt.compare(password, user.password);

        if (!match) {
            return res.redirect(`/login?${new URLSearchParams(req.query).toString()}&error=1`);
        }

        const sessionToken = crypto.randomBytes(48).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

        await db.createOauthSession(
            user.id,
            sessionToken,
            req.headers['user-agent'] || 'unknown',
            req.ip || req.headers['x-forwarded-for'] || 'unknown'
        );

        setSSOCookies(res, user.id, sessionToken, req);

        const qs = new URLSearchParams(req.query);
        if (qs.has('client_id')) {
            return res.redirect(`/oauth2/authorize?${qs.toString()}`);
        }

        res.redirect('/en/');
    } catch (err) {
        _log('error', `Login POST error: ${err.message}`);
        res.status(500).send("Internal Error");
    }
});

router.post('/oauth2/device/authorize', async (req, res) => {
    try {
        const { client_id, scope } = req.body || {};
        const deviceCode = crypto.randomBytes(32).toString('hex');
        const userCode = crypto.randomBytes(4).toString('hex').toUpperCase();
        const expiresAt = new Date(Date.now() + 300000).toISOString().slice(0, 19).replace('T', ' '); // 5 mins

        const pool = db.getPool();
        await pool.execute(
            'INSERT INTO oauth_device_codes (device_code, user_code, client_id, scope, expires_at, user_id, is_approved) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [deviceCode, userCode, client_id || 'tado-mobile-app', scope || 'home.user offline_access', expiresAt, '', 0]
        );

        _log('info', `[OAUTH-DEVICE] Authorize: client=${client_id} user_code=${userCode}`);

        res.json({
            device_code: deviceCode,
            user_code: userCode,
            verification_uri: `https://${req.hostname}/oauth2/device`,
            verification_uri_complete: `https://${req.hostname}/oauth2/device?user_code=${userCode}`,
            expires_in: 300,
            interval: 5
        });
    } catch (err) {
        _log('error', `Device authorize error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.get('/oauth2/device', (req, res) => {
    const userId = req.signedCookies ? req.signedCookies.tanoclo_session : null;
    if (!userId) {
        return res.redirect(`/login?redirect_to=${encodeURIComponent(req.originalUrl)}`);
    }
    const userCode = req.query.user_code || '';
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Connect Device - TaNoClo</title>
            <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600&display=swap" rel="stylesheet">
            <style>
                :root {
                    --primary: #00d1b2;
                    --bg: #0f172a;
                    --card-bg: #1e293b;
                    --text: #f8fafc;
                    --input-bg: #334155;
                }
                body {
                    font-family: 'Outfit', sans-serif;
                    background-color: var(--bg);
                    color: var(--text);
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    margin: 0;
                }
                .card {
                    background: var(--card-bg);
                    padding: 2.5rem;
                    border-radius: 1.5rem;
                    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
                    width: 100%;
                    max-width: 400px;
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    text-align: center;
                }
                h2 { font-weight: 600; margin-bottom: 0.5rem; }
                p.subtitle { color: #94a3b8; margin-bottom: 2rem; }
                .user-info { font-size: 0.875rem; color: var(--primary); margin-bottom: 1.5rem; }
                input {
                    width: 100%;
                    padding: 1rem;
                    border-radius: 0.75rem;
                    border: 1px solid #334155;
                    background: var(--input-bg);
                    color: white;
                    font-size: 1.5rem;
                    text-align: center;
                    letter-spacing: 0.25rem;
                    font-weight: 600;
                    margin-bottom: 1.5rem;
                    text-transform: uppercase;
                }
                button {
                    width: 100%;
                    padding: 0.75rem;
                    border-radius: 0.75rem;
                    border: none;
                    background: linear-gradient(to right, #00d1b2, #00b89c);
                    color: white;
                    font-size: 1rem;
                    font-weight: 600;
                    cursor: pointer;
                }
            </style>
        </head>
        <body>
            <div class="card">
                <h2>Connect Device</h2>
                <p class="subtitle">Enter the code shown on your device</p>
                <div class="user-info">Logged in as User ${userId}</div>
                <form method="POST" action="/oauth2/device">
                    <input type="text" name="user_code" value="${userCode}" placeholder="ABCD-1234" required maxlength="8" autocomplete="off" />
                    <button type="submit">Approve Device</button>
                    ${req.query.error ? `<div style="color: #f87171; margin-top: 1rem;">Invalid or expired code</div>` : ''}
                </form>
            </div>
        </body>
        </html>
    `);
});

router.post('/oauth2/device', async (req, res) => {
    const userCode = req.body ? req.body.user_code : undefined;
    const userId = req.signedCookies ? req.signedCookies.tanoclo_session : null;

    if (!userId) return res.status(401).send("Unauthorized");
    if (!userCode) return res.status(400).send("User code required");

    try {
        const pool = db.getPool();
        const [codes] = await pool.execute('SELECT * FROM oauth_device_codes WHERE user_code = ?', [userCode]);
        if (codes.length === 0) return res.status(404).send("Invalid Code");

        await pool.execute('UPDATE oauth_device_codes SET is_approved = 1, user_id = ? WHERE user_code = ?', [userId, userCode]);
        res.send(`
            <!DOCTYPE html><html><head><title>Approved - TaNoClo</title>
            <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600&display=swap" rel="stylesheet">
            <style>body{font-family:'Outfit',sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;background:#0f172a;color:white;text-align:center;}</style>
            </head><body>
                <div style="background:#1e293b;padding:2.5rem;border-radius:1.5rem;max-width:400px;border:1px solid rgba(255,255,255,0.1);">
                    <h2 style="color:#00d1b2;">Device Approved!</h2>
                    <p>You can now return to your application or device.</p>
                </div>
            </body></html>
        `);
    } catch (e) {
        _log('error', `Device approval error: ${e.message}`);
        res.status(500).send("Error");
    }
});

router.get('/api/v2/me', authMiddleware, async (req, res) => {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Surrogate-Control': 'no-store'
    });
    res.removeHeader('ETag');
    try {
        const userId = req.user.id;
        const pool = db.getPool();
        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
        if (users.length === 0) return res.status(404).json({ error: 'not_found' });

        const user = users[0];
        const [userHomes] = await pool.execute(
            'SELECT h.* FROM homes h JOIN users u ON h.id = u.home_id WHERE u.id = ?',
            [userId]
        );

        const [userDevices] = await pool.execute('SELECT * FROM mobile_devices WHERE user_id = ?', [userId]);

        const mappedDevices = userDevices.map(d => {
            const home = userHomes.find(h => h.id === d.home_id);
            let bearing = { degrees: 0.0, radians: 0.0 };
            let relativeDistance = 0.0;

            if (home && d.latitude !== null && d.longitude !== null && home.latitude && home.longitude) {
                const homeLat = parseFloat(home.latitude);
                const homeLon = parseFloat(home.longitude);
                const devLat = parseFloat(d.latitude);
                const devLon = parseFloat(d.longitude);

                const dist = geoUtils.haversineDistance(homeLat, homeLon, devLat, devLon);
                const radius = parseFloat(home.away_radius_in_meters || 200);
                relativeDistance = dist - radius;

                const brngRad = geoUtils.calculateBearing(homeLat, homeLon, devLat, devLon);
                bearing = {
                    degrees: geoUtils.radiansToDegrees(brngRad),
                    radians: brngRad
                };
            }

            return {
                id: isNaN(Number(d.id)) ? d.id : parseInt(d.id, 10),
                name: d.name,
                settings: {
                    geoTrackingEnabled: Boolean(d.geo_tracking_enabled),
                    specialOffersEnabled: Boolean(d.special_offers_enabled ?? true),
                    onDemandLogRetrievalEnabled: Boolean(d.on_demand_log_retrieval_enabled),
                    smartRemindersInAppEnabled: Boolean(d.smart_reminders_in_app_enabled ?? true),
                    pushNotifications: d.push_notifications_json ? JSON.parse(d.push_notifications_json) : {
                        lowBatteryReminder: true,
                        awayModeReminder: true,
                        homeModeReminder: true,
                        openWindowReminder: true,
                        energySavingsReportReminder: true,
                        incidentDetection: true,
                        energyIqReminder: false,
                        tariffHighPriceAlert: true,
                        tariffLowPriceAlert: true,
                        smartReminders: true
                    }
                },
                location: Boolean(d.geo_tracking_enabled) ? {
                    stale: d.last_seen ? (Date.now() - new Date(d.last_seen).getTime() > 24 * 60 * 60 * 1000) : true,
                    atHome: Boolean(d.at_home),
                    bearingFromHome: bearing,
                    relativeDistanceFromHomeFence: relativeDistance,
                    lastSeen: d.last_seen || null
                } : null,
                deviceMetadata: {
                    platform: d.platform || 'Unknown',
                    osVersion: d.os_version || 'Unknown',
                    model: d.model || 'Unknown',
                    locale: d.locale || 'en'
                }
            };
        });

        const domainParts = req.hostname.split('.');
        const domain = domainParts.length >= 2 ? '.' + domainParts.slice(-2).join('.') : undefined;
        const cookieSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';

        res.cookie('tado_locale', user.locale || 'en', {
            maxAge: 31536000000,
            domain,
            path: '/',
            secure: cookieSecure,
            sameSite: 'lax'
        });

        res.json({
            name: user.name || req.user.name,
            email: user.email || req.user.email,
            username: user.email || req.user.email,
            id: String(user.id || req.user.sub),
            roles: [],
            homes: userHomes.map(h => ({ id: isNaN(Number(h.id)) ? h.id : parseInt(h.id, 10), name: h.name })),
            locale: user.locale || req.user.locale || 'en',
            mobileDevices: mappedDevices
        });

    } catch (err) {
        _log('error', `Me route error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.post('/api/logout', async (req, res) => {
    const { refreshToken } = req.body || {};
    const pool = db.getPool();

    // Revoke refresh token from body (native clients)
    if (refreshToken) {
        pool.execute('DELETE FROM oauth_refresh_tokens WHERE refresh_token = ?', [hashToken(refreshToken)])
            .catch(err => _log('error', `Token revoke error: ${err.message}`));
    }

    // Revoke refresh token from httpOnly cookie (web clients)
    const cookieRt = req.signedCookies && req.signedCookies.tanoclo_rt;
    if (cookieRt && cookieRt !== refreshToken) {
        pool.execute('DELETE FROM oauth_refresh_tokens WHERE refresh_token = ?', [hashToken(cookieRt)])
            .catch(err => _log('error', `Cookie token revoke error: ${err.message}`));
    }

    let sessionToken = req.signedCookies ? req.signedCookies.tanoclo_session : null;
    if (!sessionToken && req.cookies) sessionToken = req.cookies['fusionauth.sso'];

    if (sessionToken) {
        await db.deleteOauthSession(sessionToken).catch(e => { });
    }

    const domainParts = req.hostname.split('.');
    const domain = domainParts.length >= 2 ? '.' + domainParts.slice(-2).join('.') : undefined;
    const cookieSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';

    const clearOpts = { domain, httpOnly: true, secure: cookieSecure, sameSite: 'lax', path: '/' };
    const clearOptsPln = { domain, path: '/', secure: cookieSecure, sameSite: 'lax' };

    res.clearCookie('tanoclo_session', clearOpts);
    res.clearCookie('tanoclo_rt', clearOpts);
    res.clearCookie('fusionauth.sso', clearOpts);
    res.clearCookie('fusionauth.li', clearOpts);
    res.clearCookie('fusionauth.remember-device', clearOpts);
    res.clearCookie('tado_locale', clearOptsPln);
    res.status(200).end();
});

router.post('/signupCheck', async (req, res) => {
    try {
        const { email } = req.body || {};
        if (!email) return res.status(400).json({ error: 'Email is required' });

        const pool = db.getPool();
        const [users] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);

        if (users.length > 0) {
            return res.status(200).end();
        } else {
            return res.status(404).json({ error: 'User not found' });
        }
    } catch (err) {
        _log('error', `signupCheck error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.get('/oauth2/logout', (req, res) => {
    const postLogoutRedirectUri = req.query.post_logout_redirect_uri;

    let sessionToken = req.signedCookies ? req.signedCookies.tanoclo_session : null;
    if (!sessionToken && req.cookies) sessionToken = req.cookies['fusionauth.sso'];

    if (sessionToken) {
        db.deleteOauthSession(sessionToken).catch(e => { });
    }

    const domainParts = req.hostname.split('.');
    const domain = domainParts.length >= 2 ? '.' + domainParts.slice(-2).join('.') : undefined;
    const cookieSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';

    const clearOpts = { domain, httpOnly: true, secure: cookieSecure, sameSite: 'lax', path: '/' };
    const clearOptsPln = { domain, path: '/', secure: cookieSecure, sameSite: 'lax' };

    res.clearCookie('tanoclo_session', clearOpts);
    res.clearCookie('fusionauth.sso', clearOpts);
    res.clearCookie('fusionauth.li', clearOpts);
    res.clearCookie('fusionauth.remember-device', clearOpts);
    res.clearCookie('tado_locale', clearOptsPln);

    if (postLogoutRedirectUri) {
        try {
            const url = new URL(postLogoutRedirectUri);
            const domainParts = req.hostname.split('.');
            const baseDomain = domainParts.length >= 2 ? domainParts.slice(-2).join('.') : req.hostname;
            if (!url.hostname.endsWith(baseDomain)) {
                return res.redirect('/login');
            }
            return res.redirect(postLogoutRedirectUri);
        } catch (e) {
            return res.redirect(postLogoutRedirectUri);
        }
    }
    res.redirect('/login');
});

module.exports = router;
