/**
 * @file migrations/0018_fix_pid_and_sensitivity_defaults.js
 * @brief Migration 0018: Fix PID defaults and clamp valve sensitivity.
 * 
 * Corrects legacy PID defaults (Kp 0.50 -> 10.00, Kd 19.00 -> 15.00) in the zones table
 * and ensures any devices with valve_sensitivity > 100 are clamped to 100 (hardware maximum).
 * Synchronizes cached last_config_json entries across affected zones.
 */

'use strict';

const db = require('../lib/db');

async function columnExists(pool, table, column) {
    const [rows] = await pool.execute(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
    );
    return rows.length > 0;
}

async function up(pool) {
    console.log('[Migration 0018] Fixing PID schema defaults and clamping valve sensitivity...');

    // 1. Ensure table column schema defaults are set correctly
    await pool.execute(`
        ALTER TABLE zones 
        MODIFY COLUMN field_60a0 DECIMAL(5,2) DEFAULT 5.00 COMMENT 'zone_pid_ki',
        MODIFY COLUMN field_60c0 DECIMAL(5,2) DEFAULT 15.00 COMMENT 'zone_pid_kd',
        MODIFY COLUMN field_6080 DECIMAL(5,2) DEFAULT 10.00 COMMENT 'zone_pid_kp'
    `);
    console.log('[Migration 0018] Ensured column default constraints in zones table.');

    // 2. Reset corrupted PID values in zones table
    const [zoneResult] = await pool.execute(`
        UPDATE zones 
        SET field_6080 = 10.00,
            field_60a0 = 5.00,
            field_60c0 = 15.00
        WHERE field_6080 = 0.50 OR field_60c0 = 19.00
    `);
    console.log(`[Migration 0018] Reset PID parameters for ${zoneResult.affectedRows} affected zone(s).`);

    // 3. Clamp valve_sensitivity > 100 on devices to 100 (firmware passthrough ceiling)
    const [devResult] = await pool.execute(`
        UPDATE devices 
        SET valve_sensitivity = 100 
        WHERE valve_sensitivity > 100
    `);
    console.log(`[Migration 0018] Clamped valve_sensitivity for ${devResult.affectedRows} device(s).`);

    // 4. Synchronize last_config_json for zones with legacy or missing PID entries
    if (await columnExists(pool, 'zones', 'last_config_json')) {
        const [zones] = await pool.execute(`SELECT id, home_id, last_config_json FROM zones WHERE last_config_json IS NOT NULL`);
        let syncedZones = 0;
        for (const z of zones) {
            try {
                let config = typeof z.last_config_json === 'string' ? JSON.parse(z.last_config_json) : z.last_config_json;
                if (config && typeof config === 'object') {
                    if (config['0x6080'] === 50 || config['0x60c0'] === 1900 || !config['0x6080']) {
                        config['0x60a0'] = 500;
                        config['0x60c0'] = 1500;
                        config['0x6080'] = 1000;
                        await pool.execute(
                            `UPDATE zones SET last_config_json = ? WHERE id = ? AND home_id = ?`,
                            [JSON.stringify(config), z.id, z.home_id]
                        );
                        syncedZones++;
                    }
                }
            } catch (e) {
                // Ignore parse errors on individual stale config rows
            }
        }
        console.log(`[Migration 0018] Synchronized last_config_json for ${syncedZones} zone(s).`);
    } else {
        console.log('[Migration 0018] zones.last_config_json does not exist, skipping.');
    }
}

async function down(pool) {
    // Non-destructive rollback: keep valid defaults
}

module.exports = { up, down };

if (require.main === module) {
    (async () => {
        try {
            const pool = db.getPool();
            await up(pool);
            console.log('Migration 0018 complete.');
            process.exit(0);
        } catch (e) {
            console.error('Migration 0018 failed:', e);
            process.exit(1);
        }
    })();
}
