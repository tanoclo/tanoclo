/**
 * @file api/middleware/auth.js
 * @brief Main authorization middleware handling Bearer (JWT) and Mobile (base64) tokens.
 * 
 * Interrogates authorization headers, handles signature validation via jwt.verify,
 * checks token existence in oauth_access_tokens or mobile_devices database tables,
 * and sets req.user parameters for downstream route handlers.
 */

const jwt = require('jsonwebtoken');
const { getLogger } = require('../../lib/logger');
const config = require('../../lib/config');
const _log = getLogger('auth-mw');

module.exports = async function authMiddleware(req, res, next) {
    let authHeader = req.headers.authorization;
    if (!authHeader && req.query && req.query.token) {
        authHeader = `Bearer ${req.query.token}`;
    }
    if (!authHeader || (!authHeader.startsWith('Bearer ') && !authHeader.startsWith('Mobile '))) {
        _log('warn', `Unauthorized request to ${req.method} ${req.url}: No valid Authorization header`);
        return res.status(401).json({ error: 'unauthorized', error_description: 'Authentication is required to access this resource' });
    }

    const isMobileAuth = authHeader.startsWith('Mobile ');
    const token = authHeader.split(' ')[1];

    try {
        const db = require('../../lib/db');
        const pool = db.getPool();

        if (isMobileAuth) {
            const decodedToken = Buffer.from(token, 'base64').toString();
            const [deviceId, geofencingToken] = decodedToken.split('|');

            if (!deviceId || !geofencingToken) throw new Error('Invalid mobile token format');

            // geofencingToken is the decoded hex value; raw base64 `token` matches what's stored in DB
            const [devices] = await pool.execute(
                'SELECT md.*, u.email FROM mobile_devices md JOIN users u ON md.user_id = u.id WHERE md.id = ? AND md.geofencing_access_token = ?',
                [deviceId, token]
            );

            if (devices.length === 0) {
                _log('warn', `Mobile token not found or mismatch: ${deviceId}`);
                return res.status(401).json({ error: 'invalid_token', error_description: 'The mobile access token provided is not valid.' });
            }

            const device = devices[0];
            pool.execute(
                'UPDATE mobile_devices SET last_seen = ? WHERE id = ?',
                [new Date().toISOString(), deviceId]
            ).catch(err => _log('error', `Failed to update last_seen: ${err.message}`));

            req.user = {
                id: device.user_id,
                sub: device.user_id,
                email: device.email,
                mobileDeviceId: device.id,
                homeId: device.home_id
            };
            return next();
        }

        const parts = token.split('.');
        if (parts.length !== 3) throw new Error('Invalid token format');

        const { verifyBearerToken } = require('./verify-bearer');
        req.user = await verifyBearerToken(token);

        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            _log('info', `JWT Verification failed: ${err.message}`);
            return res.status(401).json({ error: 'invalid_token', error_description: 'Access token expired' });
        }

        _log('error', `JWT Verification failed: ${err.message}`);

        return res.status(401).json({ error: 'invalid_token', error_description: 'The access token provided is not valid.' });
    }
};
