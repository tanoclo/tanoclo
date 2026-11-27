/**
 * @file migrations/0033_add_boiler_cycles_and_hvac_stats.js
 * @brief Adds boiler_cycles table and extends circuit_measurements with full HVAC statistics columns.
 */

'use strict';

async function addColumnIfNotExists(pool, table, column, colDef) {
    const [rows] = await pool.execute(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
    );
    if (rows.length === 0) {
        await pool.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${colDef}`);
        console.log(`[Migration 0033] Added column ${table}.${column}`);
    } else {
        console.log(`[Migration 0033] Column ${table}.${column} already exists.`);
    }
}

async function up(pool) {
    console.log('[Migration 0033] Creating boiler_cycles table and expanding circuit_measurements columns...');

    const createCyclesSql = `
        CREATE TABLE IF NOT EXISTS boiler_cycles (
            id BIGINT(20) NOT NULL AUTO_INCREMENT PRIMARY KEY,
            home_id INT(11) NOT NULL,
            circuit_number INT(11) NOT NULL DEFAULT 1,
            start_time DATETIME NOT NULL,
            end_time DATETIME DEFAULT NULL,
            duration_seconds INT(11) DEFAULT 0,
            cycle_type ENUM('CH', 'DHW', 'KEEP_WARM', 'UNKNOWN') NOT NULL DEFAULT 'CH',
            start_flow_temp DECIMAL(5,2) DEFAULT NULL,
            max_flow_temp DECIMAL(5,2) DEFAULT NULL,
            end_flow_temp DECIMAL(5,2) DEFAULT NULL,
            start_return_temp DECIMAL(5,2) DEFAULT NULL,
            max_return_temp DECIMAL(5,2) DEFAULT NULL,
            end_return_temp DECIMAL(5,2) DEFAULT NULL,
            avg_modulation DECIMAL(5,2) DEFAULT NULL,
            max_modulation INT(11) DEFAULT NULL,
            burner_starts_counter INT(11) DEFAULT NULL,
            ch_hours_counter INT(11) DEFAULT NULL,
            dhw_hours_counter INT(11) DEFAULT NULL,
            INDEX idx_bc_home_start (home_id, start_time),
            INDEX idx_bc_home_type (home_id, cycle_type)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;
    await pool.execute(createCyclesSql);
    console.log('[Migration 0033] boiler_cycles table verified.');

    const hvacCols = [
        { name: 'field_0463', def: "INT(11) DEFAULT NULL COMMENT 'burner_starts'" },
        { name: 'field_0464', def: "INT(11) DEFAULT NULL COMMENT 'dhw_burner_starts'" },
        { name: 'field_0465', def: "INT(11) DEFAULT NULL COMMENT 'ch_burner_starts'" },
        { name: 'field_0466', def: "INT(11) DEFAULT NULL COMMENT 'burner_hours_total'" },
        { name: 'field_0467', def: "INT(11) DEFAULT NULL COMMENT 'burner_hours_ch'" },
        { name: 'field_0468', def: "INT(11) DEFAULT NULL COMMENT 'burner_hours_dhw'" },
        { name: 'field_0458', def: "DECIMAL(5,2) DEFAULT NULL COMMENT 'flame_current_ua'" },
        { name: 'field_045b', def: "DECIMAL(5,2) DEFAULT NULL COMMENT 'dhw_target_temperature'" },
        { name: 'field_0471', def: "DECIMAL(5,2) DEFAULT NULL COMMENT 'dhw_setpoint_upper_bound'" },
        { name: 'field_046f', def: "DECIMAL(5,2) DEFAULT NULL COMMENT 'max_ch_flow_temperature'" },
        { name: 'field_046c', def: "TINYINT(1) DEFAULT NULL COMMENT 'dhw_storage_tank'" },
        { name: 'field_046d', def: "TINYINT(1) DEFAULT NULL COMMENT 'dhw_instantaneous'" }
    ];

    for (const c of hvacCols) {
        await addColumnIfNotExists(pool, 'circuit_measurements', c.name, c.def);
    }

    console.log('[Migration 0033] Migration complete.');
}

async function down(pool) {
    try {
        await pool.execute('DROP TABLE IF EXISTS boiler_cycles');
    } catch (_) {}

    const cols = [
        'field_0463', 'field_0464', 'field_0465', 'field_0466',
        'field_0467', 'field_0468', 'field_0458', 'field_045b',
        'field_0471', 'field_046f', 'field_046c', 'field_046d'
    ];
    for (const c of cols) {
        try {
            await pool.execute(`ALTER TABLE \`circuit_measurements\` DROP COLUMN \`${c}\``);
        } catch (_) {}
    }
}

module.exports = { up, down };
