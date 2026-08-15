/**
 * @file api/routes/zones.js
 * @brief Gateway routing mountpoint for home zone-specific endpoints.
 * 
 * Verifies token auth and home access permissions before mounting sub-routers
 * (schedules, open window detection, zone states, devices links, reports).
 */

const express = require('express');
const authMiddleware = require('../middleware/auth');
const homeAccessMiddleware = require('../middleware/home-access');

const router = express.Router();

// Mount middlewares
router.use(authMiddleware);
router.use(homeAccessMiddleware);

// Mount sub-routers
router.use('/', require('./zones/base'));
router.use('/', require('./zones/schedule'));
router.use('/', require('./zones/owd'));
router.use('/', require('./zones/state'));
router.use('/', require('./zones/devices'));
router.use('/', require('./zones/reports'));

module.exports = router;