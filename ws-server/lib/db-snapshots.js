/**
 * @file lib/db-snapshots.js
 * @brief Snapshot metadata and captured states database queries.
 */

'use strict';

/**
 * @module db-snapshots
 * 
 * Snapshot-related database queries.
 */

const { getPool } = require('./db-base');

async function createSnapshot(homeId) {
    const pool = getPool();
    const [result] = await pool.execute(
        'INSERT INTO state_snapshots (home_id, snapshot_json, created_at) VALUES (?, ?, ?)',
        [homeId, '{}', new Date()]
    );
    return result.insertId;
}

async function updateSnapshotJson(snapshotId, jsonStr) {
    const pool = getPool();
    await pool.execute(
        'UPDATE state_snapshots SET snapshot_json = ? WHERE id = ?',
        [jsonStr, snapshotId]
    );
}

async function getActiveSnapshot(homeId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        "SELECT * FROM state_snapshots WHERE home_id = ? AND status = 'capturing' ORDER BY created_at DESC LIMIT 1",
        [homeId]
    );
    return rows[0] || null;
}

async function getSnapshotById(snapshotId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT * FROM state_snapshots WHERE id = ?',
        [snapshotId]
    );
    return rows[0] || null;
}

async function listSnapshots(homeId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT id, home_id, created_at, status, LENGTH(snapshot_json) as json_size FROM state_snapshots WHERE home_id = ? ORDER BY created_at DESC',
        [homeId]
    );
    return rows;
}

async function deleteSnapshot(snapshotId) {
    const pool = getPool();
    await pool.execute('DELETE FROM state_snapshots WHERE id = ?', [snapshotId]);
}

async function completeSnapshot(snapshotId, status) {
    const pool = getPool();
    await pool.execute(
        'UPDATE state_snapshots SET status = ? WHERE id = ?',
        [status, snapshotId]
    );
}

module.exports = {
    createSnapshot,
    updateSnapshotJson,
    getActiveSnapshot,
    getSnapshotById,
    listSnapshots,
    deleteSnapshot,
    completeSnapshot
};
