/**
 * @file migrations/0006_add_neighbor_data.js
 * @brief Adds neighbor_data column to devices table if missing.
 */

'use strict';

module.exports = {
    async up(pool) {
        const [cols] = await pool.execute(
            `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' 
             AND COLUMN_NAME = 'neighbor_data'`
        );

        if (cols.length === 0) {
            await pool.execute('ALTER TABLE devices ADD COLUMN neighbor_data LONGTEXT DEFAULT NULL');
            console.log('✓ Added neighbor_data column to devices table');
        } else {
            console.log('- neighbor_data column already exists in devices table');
        }
    }
};
