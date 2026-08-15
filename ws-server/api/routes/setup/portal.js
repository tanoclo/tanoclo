/**
 * @file api/routes/setup/portal.js
 * @brief Sub-router gateway for admin setup portal elements.
 * 
 * Mounts portal sub-routes (authentication, diagnostics tools, general status dashboards).
 */

const express = require('express');
const router = express.Router();

// Mount sub-routers
router.use('/', require('./portal/auth'));
router.use('/', require('./portal/tools'));
router.use('/', require('./portal/dashboard'));

module.exports = router;
