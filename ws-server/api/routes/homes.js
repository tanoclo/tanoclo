/**
 * @file api/routes/homes.js
 * @brief Gateway routing mountpoint for home-specific endpoints.
 * 
 * Verifies token auth and home access permissions before mounting sub-routers
 * (heating, weather, users, energy, installation logs, incidents, etc.).
 */

const express = require('express');
const authMiddleware = require('../middleware/auth');
const homeAccessMiddleware = require('../middleware/home-access');

const router = express.Router();

// Mount auth and home access verification middlewares
router.use(authMiddleware);
router.use(homeAccessMiddleware);

// Mount modular sub-routers
router.use('/', require('./homes/base'));
router.use('/', require('./homes/heating'));
router.use('/', require('./homes/weather'));
router.use('/', require('./homes/users'));
router.use('/', require('./homes/energy'));
router.use('/', require('./homes/installations'));
router.use('/', require('./homes/logs'));
router.use('/', require('./homes/incident'));

module.exports = router;
