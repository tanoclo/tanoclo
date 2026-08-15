/**
 * @file api/middleware/home-access.js
 * @brief Middleware verifying if the authenticated user has access rights to the requested homeId.
 * 
 * Interrogates req.params.homeId, runs database checks against the users table, and blocks
 * requests with 403 Forbidden on mismatch.
 */

const db = require('../../lib/db');
const { getLogger } = require('../../lib/logger');
const _log = getLogger('home-access');

/**
 * Middleware: verifies req.user has access to req.params.homeId.
 * Must be mounted AFTER auth middleware.
 */
module.exports = async function homeAccessMiddleware(req, res, next) {
    const homeId = req.params.homeId;
    if (!homeId) return next(); // No homeId in route — skip

    if (!req.user || !req.user.id) {
        return res.status(401).json({ error: 'unauthorized' });
    }

    try {
        const pool = db.getPool();
        const [rows] = await pool.execute(
            'SELECT 1 FROM users WHERE id = ? AND home_id = ?',
            [req.user.id, homeId]
        );
        if (rows.length === 0) {
            _log('warn', `[home-access] User ${req.user.id} denied access to home ${homeId}`);
            return res.status(403).json({ error: 'forbidden', error_description: 'You do not have access to this home' });
        }
        next();
    } catch (err) {
        _log('error', `[home-access] Error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
};
