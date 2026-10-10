/**
 * Migration 0017: Reset zone PID demand tuning parameters to firmware default values.
 * 
 * Tuning parameters:
 * - field_6080 (0x6080): Kp Proportional Gain -> 0.50 (raw 50)
 * - field_60a0 (0x60a0): Ki Integral Gain     -> 5.00 (raw 500)
 * - field_60c0 (0x60c0): Kd Derivative Gain   -> 19.00 (raw 1900 / 0x76c)
 * 
 * Resets all existing zone rows to these defaults, updates column schema defaults,
 * and synchronizes cached last_config_json entries.
 */

'use strict';

const db = require('../lib/db');

async function up(pool) {
    console.log('[Migration 0017] Resetting zone PID tuning parameters to defaults...');

    // 1. Reset columns to defaults for all existing zones
    await pool.execute(`
        UPDATE zones 
        SET field_60a0 = 5.00,
            field_60c0 = 19.00,
            field_6080 = 0.50
    `);
    console.log('[Migration 0017] Reset field_60a0 (Ki), field_60c0 (Kd), and field_6080 (Kp) in zones table.');

    // 2. Update column schema default values
    try {
        await pool.execute(`
            ALTER TABLE zones 
            MODIFY COLUMN field_60a0 DECIMAL(5,2) DEFAULT 5.00 COMMENT 'zone_pid_ki',
            MODIFY COLUMN field_60c0 DECIMAL(5,2) DEFAULT 19.00 COMMENT 'zone_pid_kd',
            MODIFY COLUMN field_6080 DECIMAL(5,2) DEFAULT 0.50 COMMENT 'zone_pid_kp'
        `);
        console.log('[Migration 0017] Updated column default constraints in zones table.');
    } catch (err) {
        console.warn('[Migration 0017] Warning updating schema column defaults:', err.message);
    }

    // 3. Synchronize cached last_config_json if present
    const [zones] = await pool.execute(`SELECT id, home_id, last_config_json FROM zones WHERE last_config_json IS NOT NULL`);
    for (const z of zones) {
        try {
            let config = typeof z.last_config_json === 'string' ? JSON.parse(z.last_config_json) : z.last_config_json;
            if (config && typeof config === 'object') {
                config['0x60a0'] = 500;
                config['0x60c0'] = 1900;
                config['0x6080'] = 50;
                await pool.execute(
                    `UPDATE zones SET last_config_json = ? WHERE id = ? AND home_id = ?`,
                    [JSON.stringify(config), z.id, z.home_id]
                );
            }
        } catch (e) {
            // Ignore parse errors on individual stale config rows
        }
    }
    console.log(`[Migration 0017] Synchronized last_config_json for ${zones.length} zone(s).`);
}

async function down(pool) {
    try {
        await pool.execute(`
            ALTER TABLE zones 
            MODIFY COLUMN field_6080 DECIMAL(5,2) DEFAULT 0.50 COMMENT 'zone_temperature_deviation_limit',
            MODIFY COLUMN field_60c0 DECIMAL(5,2) DEFAULT 19.00 COMMENT 'zone_temperature_baseline'
        `);
    } catch (e) {}
}

module.exports = { up, down };

if (require.main === module) {
    (async () => {
        try {
            const pool = db.getPool();
            await up(pool);
            console.log('Migration 0017 complete.');
            process.exit(0);
        } catch (e) {
            console.error('Migration 0017 failed:', e);
            process.exit(1);
        }
    })();
}
