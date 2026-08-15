/**
 * @file lib/state-snapshot.js
 * @brief Captures all active database state profiles to a snapshot.
 */

'use strict';

const db = require('./db');
const { getLogger } = require('./logger');
const log = getLogger('state-snapshot');

const _activeSessions = new Map(); // homeId → { snapshotId, manifest, captured: Map }

/**
 * Builds the expected messages manifest for a home.
 * @param {number} homeId 
 * @returns {Promise<Array>} List of manifest items
 */
async function buildManifest(homeId) {
    homeId = Number(homeId);
    const manifest = [];
    const pool = db.getPool();

    // 1. Devices
    const [devices] = await pool.execute(
        'SELECT serial_no, device_type FROM devices WHERE home_id = ?',
        [homeId]
    );
    for (const dev of devices) {
        const serial = dev.serial_no;
        manifest.push({
            path: `d/${serial}/config`,
            entity: 'device',
            entityId: serial,
            type: 'config',
            optional: false
        });
        if (dev.device_type && dev.device_type.startsWith('VA')) {
            manifest.push({
                path: `d/${serial}/lock`,
                entity: 'device',
                entityId: serial,
                type: 'lock',
                optional: true
            });
            manifest.push({
                path: `d/${serial}/act`,
                entity: 'device',
                entityId: serial,
                type: 'act',
                optional: true
            });
        }
    }

    // 2. Zones
    const [zones] = await pool.execute(
        'SELECT id FROM zones WHERE home_id = ?',
        [homeId]
    );
    for (const zone of zones) {
        const zoneId = zone.id;
        manifest.push({
            path: `h/${homeId}/z/${zoneId}/config`,
            entity: 'zone',
            entityId: zoneId,
            type: 'config',
            optional: false
        });
        manifest.push({
            path: `z/s?id=${zoneId}`,
            entity: 'zone',
            entityId: zoneId,
            type: 'state',
            optional: false
        });
    }

    // 3. Circuits
    const [circuits] = await pool.execute(
        'SELECT number FROM heating_circuits WHERE home_id = ?',
        [homeId]
    );
    for (const circuit of circuits) {
        const circuitNumber = circuit.number;
        manifest.push({
            path: `h/${homeId}/c/${circuitNumber}/config`,
            entity: 'circuit',
            entityId: circuitNumber,
            type: 'config',
            optional: false
        });
    }

    // 4. HVAC (all sub-paths required, only if home has heating circuits)
    if (circuits.length > 0) {
        manifest.push({
            path: `h/${homeId}/hvac/config`,
            entity: 'hvac',
            entityId: homeId,
            type: 'hvac_config',
            optional: false
        });
        manifest.push({
            path: `h/${homeId}/hvac/mon`,
            entity: 'hvac',
            entityId: homeId,
            type: 'hvac_mon',
            optional: false
        });
        manifest.push({
            path: `h/${homeId}/hvac/dhw`,
            entity: 'hvac',
            entityId: homeId,
            type: 'hvac_dhw',
            optional: false
        });
        manifest.push({
            path: `h/${homeId}/hvac/maint`,
            entity: 'hvac',
            entityId: homeId,
            type: 'hvac_maint',
            optional: false
        });
    }

    return manifest;
}

/**
 * Seeds captured items from permanent config-capture logs.
 * @param {number} homeId
 * @param {Array} manifest
 * @param {Map} captured
 * @returns {Promise<number>} Number of new/updated items seeded
 */
async function seedSession(homeId, manifest, captured) {
    let seededCount = 0;
    try {
        const pool = db.getPool();
        const [devices] = await pool.execute(
            'SELECT serial_no FROM devices WHERE home_id = ?',
            [homeId]
        );

        const configCapture = require('./config-capture');
        for (const dev of devices) {
            const captures = await configCapture.getCaptures(dev.serial_no);
            for (const entry of captures) {
                for (const item of manifest) {
                    if (matchPathToItem(entry.path, item)) {
                        const existingEntry = captured.get(item.path);
                        if (!existingEntry || new Date(entry.timestamp) > new Date(existingEntry.captured_at)) {
                            if (!existingEntry) seededCount++;
                            captured.set(item.path, {
                                fields: entry.fields,
                                etag: entry.coapEtag,
                                captured_at: entry.timestamp
                            });
                        }
                    }
                }
            }
        }
    } catch (e) {
        log('error', `[state-snapshot] Failed to seed capture: ${e.message}`);
    }
    return seededCount;
}

/**
 * Starts a state snapshot capture session.
 * @param {number} homeId 
 * @returns {Promise<Object>}
 */
async function startCapture(homeId) {
    homeId = Number(homeId);
    if (_activeSessions.has(homeId)) {
        log('info', `Capture already active for home ${homeId}, resuming existing session.`);
        const session = _activeSessions.get(homeId);
        return { snapshotId: session.snapshotId, manifest: session.manifest };
    }

    // Check DB for any existing 'capturing' snapshot to resume
    const existing = await db.getActiveSnapshot(homeId);
    if (existing) {
        log('info', `Found existing active snapshot ${existing.id} in DB, resuming.`);
        const manifest = await buildManifest(homeId);
        const captured = deserializeSnapshot(existing.snapshot_json);
        const seeded = await seedSession(homeId, manifest, captured);
        if (seeded > 0) {
            const snapshotJson = serializeSnapshot(homeId, captured);
            await db.updateSnapshotJson(existing.id, snapshotJson);
            log('info', `[state-snapshot] Seeded ${seeded} missing items into resumed capture session ${existing.id}`);
        }
        _activeSessions.set(homeId, {
            snapshotId: existing.id,
            manifest,
            captured
        });
        return { snapshotId: existing.id, manifest };
    }

    const manifest = await buildManifest(homeId);
    const captured = new Map();
    await seedSession(homeId, manifest, captured);

    const snapshotId = await db.createSnapshot(homeId);
    const snapshotJson = serializeSnapshot(homeId, captured);
    await db.updateSnapshotJson(snapshotId, snapshotJson);

    _activeSessions.set(homeId, {
        snapshotId,
        manifest,
        captured
    });

    log('info', `Started state snapshot capture ${snapshotId} for home ${homeId}`);
    return { snapshotId, manifest };
}

/**
 * Normalizes CoAP path for comparison.
 */
function normalizePath(path) {
    if (!path) return '';
    let p = path.toLowerCase().replace(/^\//, '');
    p = p.replace(/^h\/\d+\//, '');
    return p;
}

/**
 * Matches an incoming path against a manifest item.
 */
function matchPathToItem(path, item) {
    const normPath = normalizePath(path);
    const normItemPath = normalizePath(item.path);

    if (normPath === normItemPath) return true;

    // Regex extraction matching
    let m;
    if (item.entity === 'device' && (m = /^d\/([^/]+)\/(config|lock|act)$/.exec(normPath))) {
        const [, serial, type] = m;
        return item.entityId.toLowerCase() === serial && item.type === type;
    }
    if (item.entity === 'zone' && item.type === 'config' && (m = /^z\/(\d+)\/config$/.exec(normPath))) {
        const [, zoneId] = m;
        return item.entityId.toString() === zoneId;
    }
    if (item.entity === 'zone' && item.type === 'state') {
        let zoneId = null;
        if ((m = /^z\/s\?id=(\d+)$/.exec(normPath))) {
            zoneId = m[1];
        } else if ((m = /^z\/(\d+)\/s$/.exec(normPath))) {
            zoneId = m[1];
        }
        return zoneId && item.entityId.toString() === zoneId.toString();
    }
    if (item.entity === 'circuit' && item.type === 'config' && (m = /^c\/(\d+)\/config$/.exec(normPath))) {
        const [, circuitNumber] = m;
        return item.entityId.toString() === circuitNumber;
    }
    if (item.entity === 'hvac') {
        if (normPath.includes('hvac')) {
            if (normPath.endsWith('/mon') && item.type === 'hvac_mon') return true;
            if (normPath.endsWith('/dhw') && item.type === 'hvac_dhw') return true;
            if (normPath.endsWith('/maint') && item.type === 'hvac_maint') return true;
            if (!normPath.endsWith('/mon') && !normPath.endsWith('/dhw') && !normPath.endsWith('/maint') && item.type === 'hvac_config') {
                return true;
            }
        }
    }

    return false;
}

/**
 * Records a proxy message fields in the active snapshot.
 * @param {number} homeId 
 * @param {string} path 
 * @param {Object} fields 
 * @param {Buffer|string} etag 
 */
async function recordMessage(homeId, path, fields, etag) {
    homeId = Number(homeId);
    const session = _activeSessions.get(homeId);
    if (!session) return;

    let matchedItem = null;
    for (const item of session.manifest) {
        if (matchPathToItem(path, item)) {
            matchedItem = item;
            break;
        }
    }

    if (!matchedItem) {
        log('debug', `Received message for path ${path} but it is not in the manifest for home ${homeId}`);
        return;
    }

    const etagStr = etag ? (Buffer.isBuffer(etag) ? etag.toString('hex') : etag.toString()) : null;

    session.captured.set(matchedItem.path, {
        fields,
        etag: etagStr,
        captured_at: new Date().toISOString()
    });

    const snapshotJson = serializeSnapshot(homeId, session.captured);
    await db.updateSnapshotJson(session.snapshotId, snapshotJson);

    log('info', `[state-snapshot] Recorded path ${matchedItem.path} for home ${homeId} (${session.captured.size}/${session.manifest.length})`);
}

/**
 * Gets progress status for a home's snapshot.
 * @param {number} homeId 
 * @returns {Promise<Object>}
 */
async function getProgress(homeId) {
    homeId = Number(homeId);
    const session = _activeSessions.get(homeId);
    if (session) {
        const items = session.manifest.map(m => {
            const cap = session.captured.get(m.path);
            return {
                ...m,
                captured: session.captured.has(m.path),
                captured_at: cap ? cap.captured_at : null
            };
        });

        const total = items.length;
        const captured = items.filter(i => i.captured).length;
        const requiredTotal = items.filter(i => !i.optional).length;
        const requiredCaptured = items.filter(i => !i.optional && i.captured).length;

        return {
            snapshotId: session.snapshotId,
            status: 'capturing',
            total,
            captured,
            requiredTotal,
            requiredCaptured,
            items
        };
    }

    // Check database for the latest snapshot
    const latest = await db.getActiveSnapshot(homeId);
    if (!latest) {
        // Fallback: check complete or incomplete snapshots
        const pool = db.getPool();
        const [rows] = await pool.execute(
            'SELECT * FROM state_snapshots WHERE home_id = ? ORDER BY created_at DESC LIMIT 1',
            [homeId]
        );
        if (!rows[0]) {
            return { status: 'none', total: 0, captured: 0, items: [] };
        }
        const snap = rows[0];
        const manifest = await buildManifest(homeId);
        const captured = deserializeSnapshot(snap.snapshot_json);
        const items = manifest.map(m => {
            const cap = captured.get(m.path);
            return {
                ...m,
                captured: captured.has(m.path),
                captured_at: cap ? cap.captured_at : null
            };
        });
        const total = items.length;
        const capturedCount = items.filter(i => i.captured).length;
        const requiredTotal = items.filter(i => !i.optional).length;
        const requiredCaptured = items.filter(i => !i.optional && i.captured).length;

        return {
            snapshotId: snap.id,
            status: snap.status,
            total,
            captured: capturedCount,
            requiredTotal,
            requiredCaptured,
            items
        };
    }

    // Active session not in memory but marked 'capturing' in DB
    const manifest = await buildManifest(homeId);
    const captured = deserializeSnapshot(latest.snapshot_json);
    const seeded = await seedSession(homeId, manifest, captured);
    if (seeded > 0) {
        const snapshotJson = serializeSnapshot(homeId, captured);
        await db.updateSnapshotJson(latest.id, snapshotJson);
        log('info', `[state-snapshot] Seeded ${seeded} missing items into active capture session ${latest.id}`);
    }
    _activeSessions.set(homeId, {
        snapshotId: latest.id,
        manifest,
        captured
    });

    return getProgress(homeId);
}

/**
 * Checks if a capture session is active for a home.
 * @param {number} homeId 
 * @returns {boolean}
 */
function isCapturing(homeId) {
    return _activeSessions.has(Number(homeId));
}

/**
 * Completes capture session for a home.
 * @param {number} homeId 
 */
async function completeCapture(homeId) {
    homeId = Number(homeId);
    const session = _activeSessions.get(homeId);
    if (!session) return;

    // Check if all non-optional paths are captured
    let allRequiredCaptured = true;
    for (const item of session.manifest) {
        if (!item.optional && !session.captured.has(item.path)) {
            allRequiredCaptured = false;
            break;
        }
    }

    const finalStatus = allRequiredCaptured ? 'complete' : 'incomplete';
    await db.completeSnapshot(session.snapshotId, finalStatus);
    _activeSessions.delete(homeId);

    log('info', `Completed state snapshot capture ${session.snapshotId} for home ${homeId}. Status: ${finalStatus}`);
}

/**
 * Resumes capturing sessions from DB after server restart.
 */
async function resumeCapture() {
    try {
        const pool = db.getPool();
        const [rows] = await pool.execute(
            "SELECT * FROM state_snapshots WHERE status = 'capturing'"
        );
        for (const row of rows) {
            const homeId = Number(row.home_id);
            const manifest = await buildManifest(homeId);
            const captured = deserializeSnapshot(row.snapshot_json);
            const seeded = await seedSession(homeId, manifest, captured);
            if (seeded > 0) {
                const snapshotJson = serializeSnapshot(homeId, captured);
                await db.updateSnapshotJson(row.id, snapshotJson);
                log('info', `[state-snapshot] Seeded ${seeded} missing items into resumed capture session ${row.id}`);
            }
            _activeSessions.set(homeId, {
                snapshotId: row.id,
                manifest,
                captured
            });
            log('info', `Resumed state snapshot capture session ${row.id} for home ${homeId}`);
        }
    } catch (e) {
        log('error', `Failed to resume capture sessions: ${e.message}`);
    }
}

/**
 * Helper to serialize captured map to structured JSON.
 */
function serializeSnapshot(homeId, capturedMap) {
    const devices = {};
    const zones = {};
    const circuits = {};
    const hvac = {};

    for (const [path, data] of capturedMap.entries()) {
        const normPath = normalizePath(path);
        let m;
        if ((m = /^d\/([^/]+)\/(config|lock|act)$/.exec(normPath))) {
            const [, serial, type] = m;
            const serialUpper = serial.toUpperCase();
            if (!devices[serialUpper]) devices[serialUpper] = {};
            devices[serialUpper][type] = {
                path,
                fields: data.fields,
                etag: data.etag,
                captured_at: data.captured_at
            };
        } else if ((m = /^z\/(\d+)\/config$/.exec(normPath))) {
            const [, zoneId] = m;
            if (!zones[zoneId]) zones[zoneId] = {};
            zones[zoneId].config = {
                path,
                fields: data.fields,
                etag: data.etag,
                captured_at: data.captured_at
            };
        } else if ((m = /^z\/s\?id=(\d+)$/.exec(normPath))) {
            const [, zoneId] = m;
            if (!zones[zoneId]) zones[zoneId] = {};
            zones[zoneId].state = {
                path,
                fields: data.fields,
                etag: data.etag,
                captured_at: data.captured_at
            };
        } else if ((m = /^c\/(\d+)\/config$/.exec(normPath))) {
            const [, circuitId] = m;
            if (!circuits[circuitId]) circuits[circuitId] = {};
            circuits[circuitId].config = {
                path,
                fields: data.fields,
                etag: data.etag,
                captured_at: data.captured_at
            };
        } else if (normPath.includes('hvac')) {
            let type = 'config';
            if (normPath.endsWith('/mon')) type = 'mon';
            else if (normPath.endsWith('/dhw')) type = 'dhw';
            else if (normPath.endsWith('/maint')) type = 'maint';
            hvac[type] = {
                path,
                fields: data.fields,
                etag: data.etag,
                captured_at: data.captured_at
            };
        }
    }

    return JSON.stringify({
        home_id: homeId,
        captured_at: new Date().toISOString(),
        devices,
        zones,
        circuits,
        hvac
    }, null, 2);
}

/**
 * Helper to deserialize structured JSON to captured map.
 */
function deserializeSnapshot(snapshotJson) {
    const capturedMap = new Map();
    if (!snapshotJson) return capturedMap;
    let data;
    try {
        data = typeof snapshotJson === 'string' ? JSON.parse(snapshotJson) : snapshotJson;
    } catch (e) {
        return capturedMap;
    }

    if (data.devices) {
        for (const [serial, devData] of Object.entries(data.devices)) {
            for (const [type, item] of Object.entries(devData)) {
                if (item && item.path) {
                    capturedMap.set(item.path, {
                        fields: item.fields,
                        etag: item.etag,
                        captured_at: item.captured_at
                    });
                }
            }
        }
    }
    if (data.zones) {
        for (const [zoneId, zoneData] of Object.entries(data.zones)) {
            for (const [type, item] of Object.entries(zoneData)) {
                if (item && item.path) {
                    capturedMap.set(item.path, {
                        fields: item.fields,
                        etag: item.etag,
                        captured_at: item.captured_at
                    });
                }
            }
        }
    }
    if (data.circuits) {
        for (const [circuitId, circuitData] of Object.entries(data.circuits)) {
            for (const [type, item] of Object.entries(circuitData)) {
                if (item && item.path) {
                    capturedMap.set(item.path, {
                        fields: item.fields,
                        etag: item.etag,
                        captured_at: item.captured_at
                    });
                }
            }
        }
    }
    if (data.hvac) {
        for (const [type, item] of Object.entries(data.hvac)) {
            if (item && item.path) {
                capturedMap.set(item.path, {
                    fields: item.fields,
                    etag: item.etag,
                    captured_at: item.captured_at
                });
            }
        }
    }
    return capturedMap;
}

module.exports = {
    startCapture,
    recordMessage,
    getProgress,
    isCapturing,
    completeCapture,
    resumeCapture,
    buildManifest
};
