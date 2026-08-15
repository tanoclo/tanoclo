/**
 * @file api/middleware/verify-bearer.js
 * @brief Shared Bearer token verification helper.
 * 
 * Extracts and validates a JWT Bearer token: signature check via jwt.verify,
 * then confirms existence in the oauth_access_tokens table.
 * Used by both the main auth middleware and SSE auth handler.
 */

const jwt = require('jsonwebtoken');
const config = require('../../lib/config');

/**
 * @brief Verifies a Bearer token and returns the decoded user object.
 * @param {string} token - The raw JWT access token string.
 * @returns {Promise<object>} Decoded user object with id, sub, homes.
 * @throws {Error} If the token is invalid, expired, or not found in DB.
 */
async function verifyBearerToken(token) {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid token format');

    const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });

    const db = require('../../lib/db');
    const { hashToken } = require('../../lib/db-base');
    const pool = db.getPool();
    const [tokens] = await pool.execute('SELECT * FROM oauth_access_tokens WHERE access_token = ?', [hashToken(token)]);

    if (tokens.length === 0) {
        const err = new Error('Token not found in database');
        err.code = 'TOKEN_NOT_FOUND';
        throw err;
    }

    return {
        ...decoded,
        id: decoded.sub,
        homes: decoded.tado_homes ? decoded.tado_homes.map(h => h.id) : []
    };
}

module.exports = { verifyBearerToken };
