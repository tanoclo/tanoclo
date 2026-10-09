/**
 * Migration 0016: Add battery_curve_custom and va_motor_error_detection to devices table.
 * 
 * Supports per-device custom battery discharge curves and VA low battery inference from persistent motor errors.
 */

'use strict';

const db = require('../lib/db');

async function up(pool) {
    console.log('[Migration 0016] Checking columns in devices table...');

    const [cols] = await pool.execute(`
        SELECT COLUMN_NAME 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
          AND TABLE_NAME = 'devices' 
          AND COLUMN_NAME IN ('battery_curve_custom', 'va_motor_error_detection')
    `);
    const existing = cols.map(c => c.COLUMN_NAME);

    if (!existing.includes('battery_curve_custom')) {
        console.log('[Migration 0016] Adding battery_curve_custom column to devices table...');
        await pool.execute(`
            ALTER TABLE devices 
            ADD COLUMN battery_curve_custom JSON DEFAULT NULL 
            COMMENT 'Custom discharge curve [[mv, pct], ...] overrides default for battery_type. Sorted descending by mV.'
        `);
        console.log('[Migration 0016] Added battery_curve_custom column.');
    } else {
        console.log('[Migration 0016] battery_curve_custom column already exists.');
    }

    if (!existing.includes('va_motor_error_detection')) {
        console.log('[Migration 0016] Adding va_motor_error_detection column to devices table...');
        await pool.execute(`
            ALTER TABLE devices 
            ADD COLUMN va_motor_error_detection TINYINT(1) NOT NULL DEFAULT 0 
            COMMENT 'Enable low-battery inference from persistent Motor Blocked/Calibration Fault errors (VA only)'
        `);
        console.log('[Migration 0016] Added va_motor_error_detection column.');
    } else {
        console.log('[Migration 0016] va_motor_error_detection column already exists.');
    }
}

async function down(pool) {
    try {
        await pool.execute('ALTER TABLE devices DROP COLUMN IF EXISTS battery_curve_custom;');
        await pool.execute('ALTER TABLE devices DROP COLUMN IF EXISTS va_motor_error_detection;');
    } catch (e) {}
}

module.exports = { up, down };

if (require.main === module) {
    (async () => {
        try {
            const pool = db.getPool();
            await up(pool);
            console.log('Migration 0016 complete.');
            process.exit(0);
        } catch (e) {
            console.error('Migration 0016 failed:', e);
            process.exit(1);
        }
    })();
}
