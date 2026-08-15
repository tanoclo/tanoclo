/**
 * @file lib/db-zones/etags.js
 */

'use strict';

/**
 * @file lib/db-zones.js
 * @brief Zone settings, timetables, and schedules database queries.
 */

'use strict';
/**
 * @module db-zones
 * 
 * Zone-related DB operations.
 * Handles zone configurations, states, timetable schedules, overlays, and circuit configurations.
 */
const { getPool, _log, safeJsonParse, generateEtag, cleanFriendlyConfig, tadoHashStep, getFieldVal, calculateVADeviceETag, tlvNameToHex, mapOrientation } = require('../db-base');
const { getDeviceByFullSerial, getDeviceBySerial } = require('../db-devices');
const tlv = require('../tlv');
const { getLocalParts, parseLocalTimeInTimezone } = require('../utils');

// ==========================================
// 1. Zone ETag and Liveness Checking
// ==========================================

const dbHomes = require('../db-homes');
const getHomeTimezone = dbHomes.getHomeTimezone;
const getHome = dbHomes.getHome;
const getHomeState = dbHomes.getHomeState;

async function getZoneEtags(homeId, zoneId) {
    if (!homeId) throw new Error('homeId is required for getZoneEtags');
    const p = getPool();
    const [rows] = await p.execute('SELECT state_etag, config_etag, state_etag_real, config_etag_real FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
    if (rows.length === 0) return null;
    return {
        state: rows[0].state_etag,
        config: rows[0].config_etag,
        state_real: rows[0].state_etag_real,
        config_real: rows[0].config_etag_real
    };
}

async function storeRealZoneEtag(homeId, zoneId, resource, etag) {
    if (!['state', 'config'].includes(resource)) {
        throw new Error(`Invalid zone ETag resource: ${resource}`);
    }
    if (!homeId) throw new Error('homeId is required for storeRealZoneEtag');
    const p = getPool();
    const col = `${resource}_etag_real`;
    await p.execute(`UPDATE zones SET ${col}=? WHERE id=? AND home_id=?`, [etag, zoneId, homeId]);
}

async function storeRealCircuitEtag(homeId, circuitNumber, etag) {
    const p = getPool();
    const etagBuf = Buffer.isBuffer(etag) ? etag : Buffer.from(etag, 'hex');
    await p.execute('UPDATE heating_circuits SET config_etag_real=? WHERE home_id=? AND number=?', [etagBuf, homeId, circuitNumber]);
}

async function getCircuitEtags(homeId, circuitNumber) {
    const p = getPool();
    const [rows] = await p.execute('SELECT config_etag, config_etag_real FROM heating_circuits WHERE home_id = ? AND number = ? LIMIT 1', [homeId, circuitNumber]);
    if (rows.length === 0) return null;
    return {
        config: rows[0].config_etag,
        config_real: rows[0].config_etag_real
    };
}

async function isZoneAlive(homeId, zoneId) {
    if (!homeId) throw new Error('homeId is required for isZoneAlive');
    const p = getPool();
    const twentyMinsAgo = new Date(Date.now() - 20 * 60000).toISOString();

    // Check the zone's measuring device specifically
    const [zoneRows] = await p.execute(
        'SELECT measuring_device_serial FROM zones WHERE id = ? AND home_id = ? LIMIT 1',
        [zoneId, homeId]
    );

    if (zoneRows.length > 0 && zoneRows[0].measuring_device_serial) {
        const leaderSerial = zoneRows[0].measuring_device_serial;
        const [devRows] = await p.execute(
            'SELECT serial_no FROM devices WHERE serial_no = ? AND home_id = ? AND last_contact >= ? LIMIT 1',
            [leaderSerial, homeId, twentyMinsAgo]
        );
        if (devRows.length > 0) return true;
    }

    // Fallback: Check if ANY device in the zone is alive
    const [anyRows] = await p.execute(
        'SELECT serial_no FROM devices WHERE zone_id = ? AND home_id = ? AND last_contact >= ? LIMIT 1',
        [zoneId, homeId, twentyMinsAgo]
    );

    return anyRows.length > 0;
}

module.exports = {
    getZoneEtags,
    storeRealZoneEtag,
    storeRealCircuitEtag,
    getCircuitEtags,
    isZoneAlive
};
