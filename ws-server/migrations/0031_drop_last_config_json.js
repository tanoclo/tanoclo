/**
 * @file migrations/0031_drop_last_config_json.js
 * @brief Drops deprecated last_config_json column from all tables.
 */

'use strict';

async function dropColumnIfExists(pool, table, column) {
    const [rows] = await pool.execute(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
    );
    if (rows.length > 0) {
        await pool.execute(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
        console.log(`[Migration 0031] Dropped column ${table}.${column}`);
    } else {
        console.log(`[Migration 0031] Column ${table}.${column} does not exist.`);
    }
}

async function up(pool) {
    console.log('[Migration 0031] Dropping deprecated last_config_json columns...');

    await dropColumnIfExists(pool, 'devices', 'last_config_json');
    await dropColumnIfExists(pool, 'zones', 'last_config_json');
    await dropColumnIfExists(pool, 'heating_systems', 'last_config_json');
    await dropColumnIfExists(pool, 'heating_circuits', 'last_config_json');

    console.log('[Migration 0031] Migration complete.');
}

async function down(pool) {
    // No-op: last_config_json is deprecated and replaced by individual FID columns
}

module.exports = { up, down };
