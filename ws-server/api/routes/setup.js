/**
 * @file api/routes/setup.js
 * @brief Gateway routing mountpoint for setup and administration portal API.
 * 
 * Sets up shared request properties (e.g. downlink cache parameters) and mounts sub-routers
 * (portal dashboard, homes list, global settings, system configuration).
 */

const express = require('express');
const router = express.Router();

const portalRouter = require('./setup/portal');
const homesRouter = require('./setup/homes');
const settingsRouter = require('./setup/settings');
const systemRouter = require('./setup/system');
const emulatedRouter = require('./setup/emulated');

let downlinkCache = null;

function setDownlinkCache(cache) {
    downlinkCache = cache;
}

// Pass downlinkCache to sub-routers via express app set() when requests come
router.use((req, res, next) => {
    if (downlinkCache) {
        req.app.set('downlinkCache', downlinkCache);
    }
    next();
});

router.get('/favicon.ico', (req, res) => res.status(204).end());

// Mount sub-routers
router.use('/', portalRouter);
router.use('/', homesRouter);
router.use('/', settingsRouter);
router.use('/', systemRouter);
router.use('/emulated', emulatedRouter);
router.use('/api/emulated', emulatedRouter);

module.exports = {
    router,
    setDownlinkCache
};
