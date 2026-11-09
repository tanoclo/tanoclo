/**
 * @file migrations/0030_add_virtual_leader.js
 * @brief Adds is_virtual_leader column to devices table for IB/gateway-hosted virtual zone leaders.
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
        console.log(`[Migration 0030] Added column ${table}.${column}`);
    } else {
        console.log(`[Migration 0030] Column ${table}.${column} already exists.`);
    }
}

async function up(pool) {
    console.log('[Migration 0030] Adding is_virtual_leader to devices table...');

    await addColumnIfNotExists(
        pool,
        'devices',
        'is_virtual_leader',
        "TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Flag indicating device is an IB/gateway-hosted virtual zone leader'"
    );

    console.log('[Migration 0030] Migration complete.');
}

async function down(pool) {
    try {
        await pool.execute('ALTER TABLE `devices` DROP COLUMN `is_virtual_leader`');
    } catch (e) {}
}

module.exports = { up, down };
