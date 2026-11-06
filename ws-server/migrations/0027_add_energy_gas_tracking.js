/**
 * @file migrations/0027_add_energy_gas_tracking.js
 * @brief Creates home_energy_settings and gas_meter_readings tables for gas consumption and cost tracking.
 */

'use strict';

async function up(pool) {
    console.log('[Migration 0027] Creating gas energy tracking tables...');

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS \`home_energy_settings\` (
            \`home_id\` int(11) NOT NULL,
            \`gas_meter_topic\` varchar(255) DEFAULT NULL,
            \`gas_cost_topic\` varchar(255) DEFAULT NULL,
            \`gas_unit_cost\` decimal(8,4) NOT NULL DEFAULT 1.4500,
            \`currency\` varchar(10) NOT NULL DEFAULT '€',
            \`allocation_method\` enum('demand','area_weighted') NOT NULL DEFAULT 'demand',
            \`calorific_value_kwh_per_m3\` decimal(5,2) NOT NULL DEFAULT 10.00,
            \`created_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
            \`updated_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (\`home_id\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS \`gas_meter_readings\` (
            \`id\` int(11) NOT NULL AUTO_INCREMENT,
            \`home_id\` int(11) NOT NULL,
            \`timestamp\` varchar(64) NOT NULL,
            \`meter_m3\` decimal(12,3) NOT NULL,
            \`unit_cost\` decimal(8,4) DEFAULT NULL,
            \`source\` varchar(32) NOT NULL DEFAULT 'mqtt',
            PRIMARY KEY (\`id\`),
            KEY \`idx_gas_readings_home_time\` (\`home_id\`,\`timestamp\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    console.log('[Migration 0027] Migration complete.');
}

async function down(pool) {
    try {
        await pool.execute('DROP TABLE IF EXISTS `gas_meter_readings`');
    } catch (e) {}
    try {
        await pool.execute('DROP TABLE IF EXISTS `home_energy_settings`');
    } catch (e) {}
}

module.exports = { up, down };
