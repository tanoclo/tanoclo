/**
 * @file migrations/0025_add_zone_underfloor_heating.js
 * @brief Adds per-room heating_type and underfloor_mass to zones table.
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
        console.log(`[Migration 0025] Added column ${table}.${column}`);
    } else {
        console.log(`[Migration 0025] Column ${table}.${column} already exists.`);
    }
}

async function up(pool) {
    console.log('[Migration 0025] Adding per-room underfloor heating columns...');

    await addColumnIfNotExists(
        pool,
        'zones',
        'heating_type',
        "VARCHAR(32) NOT NULL DEFAULT 'RADIATOR' COMMENT 'Room heat emitter type (RADIATOR, UNDERFLOOR)'"
    );

    await addColumnIfNotExists(
        pool,
        'zones',
        'underfloor_mass',
        "VARCHAR(32) NOT NULL DEFAULT 'SCREED' COMMENT 'Thermal mass inertia for underfloor heating (SCREED, DRY_SYSTEM)'"
    );

    console.log('[Migration 0025] Migration complete.');
}

async function down(pool) {
    try {
        await pool.execute('ALTER TABLE `zones` DROP COLUMN `underfloor_mass`');
    } catch (e) {}
    try {
        await pool.execute('ALTER TABLE `zones` DROP COLUMN `heating_type`');
    } catch (e) {}
}

module.exports = { up, down };
