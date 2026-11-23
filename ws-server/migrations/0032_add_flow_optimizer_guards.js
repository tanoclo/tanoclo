/**
 * @file migrations/0032_add_flow_optimizer_guards.js
 * @brief Adds granular guard configuration columns to flow_temperature_settings.
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
        console.log(`[Migration 0032] Added column ${table}.${column}`);
    } else {
        console.log(`[Migration 0032] Column ${table}.${column} already exists.`);
    }
}

async function up(pool) {
    console.log('[Migration 0032] Adding flow optimizer guard configuration columns...');

    await addColumnIfNotExists(pool, 'flow_temperature_settings', 'guard_lockout_enabled', "TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Anti-flapping standby lockout toggle'");
    await addColumnIfNotExists(pool, 'flow_temperature_settings', 'guard_lockout_duration_min', "INT NOT NULL DEFAULT 10 COMMENT 'Anti-flapping lockout duration in minutes'");
    await addColumnIfNotExists(pool, 'flow_temperature_settings', 'guard_lockout_override_deficit', "DECIMAL(3,1) NOT NULL DEFAULT 2.0 COMMENT 'Room deficit threshold to bypass lockout in °C'");

    await addColumnIfNotExists(pool, 'flow_temperature_settings', 'guard_delta_t_enabled', "TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Warm loop Delta-T anti-microburn toggle'");
    await addColumnIfNotExists(pool, 'flow_temperature_settings', 'guard_delta_t_min_temp', "DECIMAL(3,1) NOT NULL DEFAULT 5.0 COMMENT 'Minimum target-to-actual flow temp delta to permit firing in °C'");

    await addColumnIfNotExists(pool, 'flow_temperature_settings', 'guard_min_runtime_enabled', "TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Minimum active burn run-time hold toggle'");
    await addColumnIfNotExists(pool, 'flow_temperature_settings', 'guard_min_runtime_seconds', "INT NOT NULL DEFAULT 180 COMMENT 'Minimum active burn run-time hold in seconds'");

    await addColumnIfNotExists(pool, 'flow_temperature_settings', 'guard_thermal_load_enabled', "TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Thermal load coincidence and gating toggle'");

    await addColumnIfNotExists(pool, 'flow_temperature_settings', 'guard_radiator_floor_enabled', "TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Radiator circuit minimum flow temperature floor toggle'");
    await addColumnIfNotExists(pool, 'flow_temperature_settings', 'guard_radiator_floor_temp', "INT NOT NULL DEFAULT 48 COMMENT 'Radiator circuit minimum flow floor in °C'");

    await addColumnIfNotExists(pool, 'flow_temperature_settings', 'guard_rate_limit_enabled', "TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Steady-state flow temperature rate limiting toggle'");
    await addColumnIfNotExists(pool, 'flow_temperature_settings', 'guard_rate_limit_max_step', "DECIMAL(3,1) NOT NULL DEFAULT 3.0 COMMENT 'Maximum flow temperature change per evaluation in °C'");

    console.log('[Migration 0032] Migration complete.');
}

async function down(pool) {
    const cols = [
        'guard_lockout_enabled',
        'guard_lockout_duration_min',
        'guard_lockout_override_deficit',
        'guard_delta_t_enabled',
        'guard_delta_t_min_temp',
        'guard_min_runtime_enabled',
        'guard_min_runtime_seconds',
        'guard_thermal_load_enabled',
        'guard_radiator_floor_enabled',
        'guard_radiator_floor_temp',
        'guard_rate_limit_enabled',
        'guard_rate_limit_max_step'
    ];
    for (const col of cols) {
        try {
            await pool.execute(`ALTER TABLE \`flow_temperature_settings\` DROP COLUMN \`${col}\``);
        } catch (e) {}
    }
}

module.exports = { up, down };
