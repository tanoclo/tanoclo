/**
 * Migration 0010: Add carto_api_key default setting to server_settings table.
 */

'use strict';

async function up(pool) {
    console.log('[Migration 0010] Ensuring carto_api_key exists in server_settings...');

    const [rows] = await pool.execute('SELECT `value` FROM server_settings WHERE `key` = ?', ['carto_api_key']);
    if (rows.length === 0) {
        const now = new Date().toISOString();
        await pool.execute(
            'INSERT INTO server_settings (`key`, `value`, updated_at) VALUES (?, ?, ?)',
            ['carto_api_key', process.env.CARTO_API_KEY || '', now]
        );
        console.log('[Migration 0010] Seeded carto_api_key in server_settings.');
    } else {
        console.log('[Migration 0010] carto_api_key setting already present.');
    }

    console.log('[Migration 0010] Migration complete.');
}

async function down(pool) {
    try {
        await pool.execute('DELETE FROM server_settings WHERE `key` = ?', ['carto_api_key']);
    } catch (e) {}
}

module.exports = { up, down };
