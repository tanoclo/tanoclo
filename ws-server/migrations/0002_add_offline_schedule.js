/**
 * @file migrations/0002_add_offline_schedule.js
 * @brief Database schema migration step.
 */

'use strict';

module.exports = {
    async up(pool) {
        // Check if columns already exist
        const [cols] = await pool.execute(
            `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
             WHERE TABLE_SCHEMA = 'tanoclo' AND TABLE_NAME = 'zones' 
             AND COLUMN_NAME IN ('offline_schedule_enabled', 'offline_schedule_synced_at')`
        );
        const existing = cols.map(c => c.COLUMN_NAME);

        if (!existing.includes('offline_schedule_enabled')) {
            await pool.execute('ALTER TABLE zones ADD COLUMN offline_schedule_enabled TINYINT(1) DEFAULT 0');
            console.log('✓ Added offline_schedule_enabled');
        } else {
            console.log('- offline_schedule_enabled already exists');
        }

        if (!existing.includes('offline_schedule_synced_at')) {
            await pool.execute('ALTER TABLE zones ADD COLUMN offline_schedule_synced_at DATETIME DEFAULT NULL');
            console.log('✓ Added offline_schedule_synced_at');
        } else {
            console.log('- offline_schedule_synced_at already exists');
        }
    }
};
