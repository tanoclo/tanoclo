/**
 * @file migrations/0028_add_valve_exercise.js
 * @brief Adds last_exercised_at column to devices and auto_valve_exercise_enabled to homes.
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
        console.log(`[Migration 0028] Added column ${table}.${column}`);
    } else {
        console.log(`[Migration 0028] Column ${table}.${column} already exists.`);
    }
}

async function up(pool) {
    console.log('[Migration 0028] Adding valve exercise columns to devices and homes tables...');

    await addColumnIfNotExists(
        pool,
        'devices',
        'last_exercised_at',
        "DATETIME DEFAULT NULL COMMENT 'Timestamp of last anti-seize stroke exercise'"
    );

    await addColumnIfNotExists(
        pool,
        'homes',
        'auto_valve_exercise_enabled',
        "TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Automated monthly anti-seize valve exercise'"
    );

    console.log('[Migration 0028] Migration complete.');
}

async function down(pool) {
    try {
        await pool.execute('ALTER TABLE `devices` DROP COLUMN `last_exercised_at`');
        await pool.execute('ALTER TABLE `homes` DROP COLUMN `auto_valve_exercise_enabled`');
    } catch (e) {}
}

module.exports = { up, down };
