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

const modules = [
    { name: 'db-base', mod: dbBase },
    { name: 'db-auth', mod: dbAuth },
    { name: 'db-devices', mod: dbDevices },
    { name: 'db-zones', mod: dbZones },
    { name: 'db-homes', mod: dbHomes },
    { name: 'db-snapshots', mod: dbSnapshots },
    { name: 'db-utils', mod: dbUtils }
];

const merged = {};
for (const { name, mod } of modules) {
    for (const key of Object.keys(mod)) {
        if (key in merged) {
            console.warn(`[db] Export key collision detected: "${key}" from ${name} overwrites existing export`);
        }
        merged[key] = mod[key];
    }
}

module.exports = merged;