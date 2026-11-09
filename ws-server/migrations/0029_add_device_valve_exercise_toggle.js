/**
 * @file migrations/0029_add_device_valve_exercise_toggle.js
 * @brief Adds auto_valve_exercise_enabled column to devices table for per-device control.
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
        console.log(`[Migration 0029] Added column ${table}.${column}`);
    } else {
        console.log(`[Migration 0029] Column ${table}.${column} already exists.`);
    }
}

async function up(pool) {
    console.log('[Migration 0029] Adding auto_valve_exercise_enabled to devices table...');

    await addColumnIfNotExists(
        pool,
        'devices',
        'auto_valve_exercise_enabled',
        "TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Per-device automated valve exercise enable toggle'"
    );

    console.log('[Migration 0029] Migration complete.');
}

async function down(pool) {
    try {
        await pool.execute('ALTER TABLE `devices` DROP COLUMN `auto_valve_exercise_enabled`');
    } catch (e) {}
}

module.exports = { up, down };
