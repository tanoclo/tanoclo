/**
 * @file migrations/0003_migrate_setup_settings.js
 * @brief Database schema migration step.
 */

'use strict';

module.exports = {
    async up(pool) {
        // 1. Create server_settings table
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS server_settings (
                \`key\` VARCHAR(100) NOT NULL,
                \`value\` TEXT DEFAULT NULL,
                updated_at VARCHAR(64) DEFAULT NULL,
                PRIMARY KEY (\`key\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✓ Created server_settings table');

        // 2. Add zone_config_readonly column to homes (if not exists)
        const [cols] = await pool.execute(`
            SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = 'tanoclo' AND TABLE_NAME = 'homes' AND COLUMN_NAME = 'zone_config_readonly'
        `);
        if (cols.length === 0) {
            await pool.execute(`ALTER TABLE homes ADD COLUMN zone_config_readonly TINYINT(1) DEFAULT NULL`);
            console.log('✓ Added zone_config_readonly column to homes');
        } else {
            console.log('· zone_config_readonly column already exists in homes');
        }

        // 3. Seed default settings from env vars (if table is empty)
        const [existing] = await pool.execute('SELECT COUNT(*) as cnt FROM server_settings');
        if (existing[0].cnt === 0) {
            const now = new Date().toISOString();
            await pool.execute(
                'INSERT INTO server_settings (`key`, `value`, updated_at) VALUES (?, ?, ?)',
                ['log_level', process.env.LOG_LEVEL || 'debug', now]
            );
            await pool.execute(
                'INSERT INTO server_settings (`key`, `value`, updated_at) VALUES (?, ?, ?)',
                ['jwt_secret', process.env.JWT_SECRET || 'secret_key', now]
            );
            await pool.execute(
                'INSERT INTO server_settings (`key`, `value`, updated_at) VALUES (?, ?, ?)',
                ['mqtt_host', process.env.MQTT_HOST || '', now]
            );
            await pool.execute(
                'INSERT INTO server_settings (`key`, `value`, updated_at) VALUES (?, ?, ?)',
                ['mqtt_port', process.env.MQTT_PORT || '1883', now]
            );
            await pool.execute(
                'INSERT INTO server_settings (`key`, `value`, updated_at) VALUES (?, ?, ?)',
                ['mqtt_user', process.env.MQTT_USERNAME || '', now]
            );
            await pool.execute(
                'INSERT INTO server_settings (`key`, `value`, updated_at) VALUES (?, ?, ?)',
                ['mqtt_password', process.env.MQTT_PASSWORD || '', now]
            );
            await pool.execute(
                'INSERT INTO server_settings (`key`, `value`, updated_at) VALUES (?, ?, ?)',
                ['mqtt_ha_discovery', process.env.MQTT_ENABLED || 'false', now]
            );
            await pool.execute(
                'INSERT INTO server_settings (`key`, `value`, updated_at) VALUES (?, ?, ?)',
                ['mqtt_ha_path', process.env.MQTT_HA_PATH || 'homeassistant', now]
            );
            console.log('✓ Seeded default server settings');
        } else {
            console.log('· server_settings already has data, skipping seed');
        }
    }
};
