/**
 * Migration 0008: Add factory_key column to emulated_devices and devices tables.
 */

async function up(pool) {
    console.log('[Migration 0008] Adding factory_key to emulated_devices and devices tables...');

    try {
        await pool.execute(`ALTER TABLE emulated_devices ADD COLUMN factory_key VARCHAR(64) DEFAULT NULL;`);
        console.log('[Migration 0008] Added factory_key to emulated_devices.');
    } catch (e) {
        if (!e.message.includes('Duplicate column')) {
            console.warn('[Migration 0008] emulated_devices.factory_key warning:', e.message);
        }
    }

    try {
        await pool.execute(`ALTER TABLE devices ADD COLUMN factory_key VARCHAR(64) DEFAULT NULL;`);
        console.log('[Migration 0008] Added factory_key to devices.');
    } catch (e) {
        if (!e.message.includes('Duplicate column')) {
            console.warn('[Migration 0008] devices.factory_key warning:', e.message);
        }
    }

    console.log('[Migration 0008] Migration complete.');
}

async function down(pool) {
    try {
        await pool.execute(`ALTER TABLE emulated_devices DROP COLUMN factory_key;`);
    } catch (e) {}
    try {
        await pool.execute(`ALTER TABLE devices DROP COLUMN factory_key;`);
    } catch (e) {}
}

module.exports = { up, down };
