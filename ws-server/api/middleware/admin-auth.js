/**
 * @file api/middleware/admin-auth.js
 * @brief Middleware for setup/admin portal authorization.
 * 
 * Verifies the setup_token cookie against the configured JWT secret,
 * sets the req.admin property, and handles redirects or JSON error responses
 * upon signature verification errors.
 */

const jwt = require('jsonwebtoken');
const config = require('../../lib/config');

module.exports = (req, res, next) => {
    const token = req.cookies?.setup_token;
    if (!token) {
        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.status(401).json({ error: 'unauthorized' });
        }
        return res.redirect('/setup/login');
    }
    try {
        const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
        req.admin = decoded;
        next();
    } catch (e) {
        res.clearCookie('setup_token');
        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.status(401).json({ error: 'unauthorized' });
        }
        res.redirect('/setup/login');
    }
};
