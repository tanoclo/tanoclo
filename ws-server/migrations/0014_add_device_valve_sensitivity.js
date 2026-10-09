/**
 * Migration 0014: Add valve_sensitivity to devices table.
 * 
 * Supports per-VA valve sensitivity scaling via hardware FID 0x4160 (demand_scale_denominator).
 * Range 50–100 (default 100 = 1.0x gain, <100 amplifies valve opening).
 */

async function up(pool) {
    console.log('[Migration 0014] Checking valve_sensitivity column in devices table...');

    const [cols] = await pool.execute(`
        SELECT COLUMN_NAME 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
          AND TABLE_NAME = 'devices' 
          AND COLUMN_NAME = 'valve_sensitivity'
    `);

    if (cols.length === 0) {
        console.log('[Migration 0014] Adding valve_sensitivity column to devices table...');
        await pool.execute(`
            ALTER TABLE devices 
            ADD COLUMN valve_sensitivity INT(11) NOT NULL DEFAULT 100 
            COMMENT 'Valve demand scale denominator (0x4160): 50-100 (default 100)'
        `);
        console.log('[Migration 0014] valve_sensitivity column added successfully.');
    } else {
        console.log('[Migration 0014] valve_sensitivity column already exists.');
    }
}

async function down(pool) {
    try {
        await pool.execute(`ALTER TABLE devices DROP COLUMN IF EXISTS valve_sensitivity;`);
    } catch (e) {}
}

module.exports = { up, down };
