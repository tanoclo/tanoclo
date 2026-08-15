/**
 * Migration 0007: Add tables for ESP32 hardware nodes and emulated Tado devices.
 */

async function up(pool) {
    console.log('[Migration 0007] Creating esp32_nodes and emulated_devices tables...');
    
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS esp32_nodes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            ip_address VARCHAR(45) NOT NULL,
            api_port INT DEFAULT 80,
            api_key VARCHAR(255) DEFAULT NULL,
            status VARCHAR(20) DEFAULT 'OFFLINE',
            last_seen VARCHAR(64) DEFAULT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS emulated_devices (
            serial_no VARCHAR(100) PRIMARY KEY,
            esp32_node_id INT NOT NULL,
            device_type VARCHAR(50) DEFAULT 'RU02',
            mode VARCHAR(50) DEFAULT 'WIRELESS_SENSOR',
            home_id INT NOT NULL,
            zone_id INT DEFAULT NULL,
            ipv6_address VARCHAR(45) NOT NULL,
            pairing_state VARCHAR(50) DEFAULT 'IDLE',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_telemetry TIMESTAMP NULL DEFAULT NULL,
            nvs_synced TINYINT(1) DEFAULT 0,
            FOREIGN KEY (esp32_node_id) REFERENCES esp32_nodes(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    console.log('[Migration 0007] Migration complete.');
}

async function down(pool) {
    await pool.execute(`DROP TABLE IF EXISTS emulated_devices;`);
    await pool.execute(`DROP TABLE IF EXISTS esp32_nodes;`);
}

module.exports = { up, down };
