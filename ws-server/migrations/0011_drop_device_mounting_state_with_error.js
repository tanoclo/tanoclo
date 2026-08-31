/**
 * Migration 0011: Drop mounting_state_with_error column from devices table.
 * It is redundant with field_016a.
 */

async function up(pool) {
    console.log('[Migration 0011] Dropping mounting_state_with_error from devices table...');

    try {
        await pool.execute(`ALTER TABLE devices DROP COLUMN mounting_state_with_error;`);
        console.log('[Migration 0011] Dropped mounting_state_with_error from devices.');
    } catch (e) {
        if (!e.message.includes("Can't DROP") && !e.message.includes('check that column/key exists')) {
            console.warn('[Migration 0011] devices.mounting_state_with_error warning:', e.message);
        }
    }

    console.log('[Migration 0011] Migration complete.');
}

async function down(pool) {
    try {
        await pool.execute(`ALTER TABLE devices ADD COLUMN mounting_state_with_error varchar(50) DEFAULT NULL;`);
    } catch (e) {}
}

module.exports = { up, down };
