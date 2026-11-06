/**
 * @file migrations/0026_add_zone_room_size.js
 * @brief Adds room_size_sqm column to zones table for size-based PID tuning.
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
        console.log(`[Migration 0026] Added column ${table}.${column}`);
    } else {
        console.log(`[Migration 0026] Column ${table}.${column} already exists.`);
    }
}

async function up(pool) {
    console.log('[Migration 0026] Adding room_size_sqm column to zones table...');

    await addColumnIfNotExists(
        pool,
        'zones',
        'room_size_sqm',
        "DECIMAL(5,1) DEFAULT NULL COMMENT 'Room area in square meters (m²)'"
    );

    console.log('[Migration 0026] Migration complete.');
}

async function down(pool) {
    try {
        await pool.execute('ALTER TABLE `zones` DROP COLUMN `room_size_sqm`');
    } catch (e) {}
}

module.exports = { up, down };
