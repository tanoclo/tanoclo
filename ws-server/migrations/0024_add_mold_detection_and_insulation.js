/**
 * @file migrations/0024_add_mold_detection_and_insulation.js
 * @brief Adds insulation_factor to homes and zones, and creates zone_mold_state table.
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
        console.log(`[Migration 0024] Added column ${table}.${column}`);
    } else {
        console.log(`[Migration 0024] Column ${table}.${column} already exists.`);
    }
}

async function up(pool) {
    console.log('[Migration 0024] Adding mold detection and insulation factor columns...');

    await addColumnIfNotExists(pool, 'homes', 'insulation_factor', "DECIMAL(3,2) NOT NULL DEFAULT 0.70 COMMENT 'Building insulation factor f_Rsi'");
    await addColumnIfNotExists(pool, 'zones', 'insulation_factor', "DECIMAL(3,2) DEFAULT NULL COMMENT 'Room insulation factor override f_Rsi'");

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS \`zone_mold_state\` (
            \`home_id\` int(11) NOT NULL,
            \`zone_id\` int(11) NOT NULL,
            \`mold_index\` decimal(4,2) NOT NULL DEFAULT 0.00,
            \`risk_level\` enum('LOW','ELEVATED','HIGH') NOT NULL DEFAULT 'LOW',
            \`surface_temp\` decimal(5,2) DEFAULT NULL,
            \`surface_humidity\` decimal(5,2) DEFAULT NULL,
            \`dew_point\` decimal(5,2) DEFAULT NULL,
            \`critical_humidity\` decimal(5,2) DEFAULT NULL,
            \`condensation_risk\` tinyint(1) NOT NULL DEFAULT 0,
            \`effective_insulation_factor\` decimal(3,2) NOT NULL DEFAULT 0.70,
            \`hours_evaluated\` int(11) NOT NULL DEFAULT 0,
            \`status\` enum('CALIBRATING','READY') NOT NULL DEFAULT 'CALIBRATING',
            \`last_transition\` datetime DEFAULT NULL,
            \`updated_at\` datetime NOT NULL,
            PRIMARY KEY (\`home_id\`, \`zone_id\`),
            KEY \`idx_zone_mold_home\` (\`home_id\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    console.log('[Migration 0024] Migration complete.');
}

async function down(pool) {
    try {
        await pool.execute('DROP TABLE IF EXISTS `zone_mold_state`');
    } catch (e) {}
    try {
        await pool.execute('ALTER TABLE `zones` DROP COLUMN `insulation_factor`');
    } catch (e) {}
    try {
        await pool.execute('ALTER TABLE `homes` DROP COLUMN `insulation_factor`');
    } catch (e) {}
}

module.exports = { up, down };
