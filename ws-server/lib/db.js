/**
 * @file lib/db.js
 * @brief MariaDB connection pool lifecycle initializer.
 */

'use strict';

/**
 * @module db
 * 
 * Re-exports connection pooling and high-level schema methods from divided sub-modules.
 */

const dbBase = require('./db-base');
const dbAuth = require('./db-auth');
const dbDevices = require('./db-devices');
const dbZones = require('./db-zones');
const dbHomes = require('./db-homes');
const dbSnapshots = require('./db-snapshots');
const dbUtils = require('./db-utils');

module.exports = {
    ...dbBase,
    ...dbAuth,
    ...dbDevices,
    ...dbZones,
    ...dbHomes,
    ...dbSnapshots,
    ...dbUtils
};
