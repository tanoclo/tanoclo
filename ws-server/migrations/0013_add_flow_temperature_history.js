/**
 * Migration 0013: Add flow_temperature_history table for flow temperature optimization tracking.
 */

async function up(pool) {
    console.log('[Migration 0013] Creating flow_temperature_history table...');

    const createTableSql = `
        CREATE TABLE IF NOT EXISTS flow_temperature_history (
            id BIGINT(20) NOT NULL AUTO_INCREMENT PRIMARY KEY,
            home_id INT(11) NOT NULL,
            timestamp VARCHAR(64) NOT NULL,
            computed_flow_temp DECIMAL(5,2) DEFAULT NULL,
            actual_flow_temp DECIMAL(5,2) DEFAULT NULL,
            outside_temp DECIMAL(5,2) DEFAULT NULL,
            max_zone_error DECIMAL(5,2) DEFAULT NULL,
            modulation_pct INT(11) DEFAULT NULL,
            demand_pct INT(11) DEFAULT NULL,
            reason VARCHAR(64) DEFAULT NULL,
            INDEX idx_fth_home_ts (home_id, timestamp),
            INDEX idx_fth_ts (timestamp)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;

    try {
        await pool.execute(createTableSql);
        console.log('[Migration 0013] Created flow_temperature_history table.');
    } catch (e) {
        console.warn('[Migration 0013] flow_temperature_history creation warning:', e.message);
    }

    try {
        await pool.execute(`
            INSERT IGNORE INTO server_settings (\`key\`, \`value\`, updated_at) 
            VALUES ('cleanup_flow_temperature_history_days', '90', NOW())
        `);
    } catch (e) {
        console.warn('[Migration 0013] cleanup_flow_temperature_history_days setting warning:', e.message);
    }

    console.log('[Migration 0013] Migration complete.');
}

async function down(pool) {
    try {
        await pool.execute(`DROP TABLE IF EXISTS flow_temperature_history;`);
        await pool.execute(`DELETE FROM server_settings WHERE \`key\` = 'cleanup_flow_temperature_history_days';`);
    } catch (e) {}
}

module.exports = { up, down };
