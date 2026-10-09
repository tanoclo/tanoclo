/**
 * Migration 0015: Add balancing_snapshots table.
 * 
 * Stores historical hydraulic balancing analysis results and tracking of applied valve sensitivities.
 */

'use strict';

async function up(pool) {
    console.log('[Migration 0015] Creating balancing_snapshots table...');

    const createTableSql = `
        CREATE TABLE IF NOT EXISTS balancing_snapshots (
            id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            home_id INT(11) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            analysis_json JSON NOT NULL,
            applied TINYINT(1) NOT NULL DEFAULT 0,
            applied_at TIMESTAMP NULL DEFAULT NULL,
            INDEX idx_bs_home (home_id, created_at DESC)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;

    try {
        await pool.execute(createTableSql);
        console.log('[Migration 0015] Created balancing_snapshots table.');
    } catch (e) {
        console.warn('[Migration 0015] balancing_snapshots creation warning:', e.message);
    }
}

async function down(pool) {
    try {
        await pool.execute('DROP TABLE IF EXISTS balancing_snapshots;');
    } catch (e) {}
}

module.exports = { up, down };
