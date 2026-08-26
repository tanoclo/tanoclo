/**
 * Migration 0009: Add field_015d column to devices table.
 */

async function up(pool) {
    console.log('[Migration 0009] Adding field_015d to devices table...');

    try {
        await pool.execute(`ALTER TABLE devices ADD COLUMN field_015d INT DEFAULT NULL COMMENT 'Device role/type: 71=Wired Thermostat, 200=Wireless Sensor, 112/113=VA';`);
        console.log('[Migration 0009] Added field_015d to devices.');
    } catch (e) {
        if (!e.message.includes('Duplicate column')) {
            console.warn('[Migration 0009] devices.field_015d warning:', e.message);
        }
    }

    console.log('[Migration 0009] Migration complete.');
}

async function down(pool) {
    try {
        await pool.execute(`ALTER TABLE devices DROP COLUMN field_015d;`);
    } catch (e) {}
}

module.exports = { up, down };
