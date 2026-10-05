/**
 * Migration 0012: Add circuit_measurements table for short and long term statistics.
 */

async function up(pool) {
    console.log('[Migration 0012] Creating circuit_measurements table...');

    const createTableSql = `
        CREATE TABLE IF NOT EXISTS circuit_measurements (
            id BIGINT(20) NOT NULL AUTO_INCREMENT PRIMARY KEY,
            home_id INT(11) NOT NULL,
            circuit_number INT(11) NOT NULL,
            timestamp VARCHAR(64) NOT NULL,
            field_4000 DECIMAL(5,2) DEFAULT NULL COMMENT 'circuit_reference_temp',
            field_4040 DECIMAL(5,2) DEFAULT NULL COMMENT 'circuit_target_temp',
            field_4080 INT(11) DEFAULT NULL COMMENT 'circuit_demand_percent',
            field_2090 INT(11) DEFAULT NULL COMMENT 'circuit_mode_or_flags_2090',
            field_2040 DECIMAL(5,2) DEFAULT NULL COMMENT 'circuit_dhw_max_flow_temperature',
            field_044c DECIMAL(5,2) DEFAULT NULL COMMENT 'ch_flow_temperature',
            field_044d DECIMAL(5,2) DEFAULT NULL COMMENT 'ch_return_temperature',
            field_0450 DECIMAL(5,2) DEFAULT NULL COMMENT 'control_setpoint',
            field_0452 INT(11) DEFAULT NULL COMMENT 'relative_modulation',
            field_0457 TINYINT(4) DEFAULT NULL COMMENT 'flame_active',
            field_0460 INT(11) DEFAULT NULL COMMENT 'water_pressure_mbar',
            INDEX idx_cm_home_circuit_ts (home_id, circuit_number, timestamp),
            INDEX idx_cm_ts (timestamp)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;

    try {
        await pool.execute(createTableSql);
        console.log('[Migration 0012] Created circuit_measurements table.');
    } catch (e) {
        console.warn('[Migration 0012] circuit_measurements creation warning:', e.message);
    }

    // Add server_setting for cleanup_circuit_measurements_days if not present
    try {
        await pool.execute(`
            INSERT IGNORE INTO server_settings (\`key\`, \`value\`, updated_at) 
            VALUES ('cleanup_circuit_measurements_days', '390', NOW())
        `);
    } catch (e) {
        console.warn('[Migration 0012] cleanup_circuit_measurements_days setting warning:', e.message);
    }

    console.log('[Migration 0012] Migration complete.');
}

async function down(pool) {
    try {
        await pool.execute(`DROP TABLE IF EXISTS circuit_measurements;`);
        await pool.execute(`DELETE FROM server_settings WHERE \`key\` = 'cleanup_circuit_measurements_days';`);
    } catch (e) {}
}

module.exports = { up, down };
