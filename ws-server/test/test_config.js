/**
 * @file test/test_config.js
 * @brief Vitest testing suite validating server modules.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Default safe (non-private) configuration settings
const defaults = {
    DB_HOST: '127.0.0.1',
    DB_NAME: 'tanoclo',
    DB_USER: 'tanoclo',
    DB_PASS: 'password',
    WS_URL: 'wss://127.0.0.1:988/hw/v2',
    CMD_API: 'http://127.0.0.1:3111',
    API_URL: 'https://my.tanoclo.example.com',
    AUTH_URL: 'https://my.tanoclo.example.com',
    API_USER: 'admin',
    API_PASS: 'password',
    API_TOKEN: '',
    DEVICE_ID: 'IB0000000001',
    HOME_ID: '999999',
    ZONE_ID: '1',
    TEST_API_USER: 'admin',
    TEST_API_PASS: 'admin123',
    TEST_DEVICE_ID: 'IB0000000001',
    TEST_HOME_ID: '999999',
    TEST_ZONE_ID: '1',
    JWT_SECRET: 'fallback_secret_for_tanoclo_development'
};

const configPath = path.join(__dirname, 'test_config.json');
let localConfig = {};

if (fs.existsSync(configPath)) {
    try {
        const rawContent = fs.readFileSync(configPath, 'utf8');
        localConfig = JSON.parse(rawContent);
    } catch (e) {
        console.warn(`[test-config] Warning: Failed to parse test_config.json: ${e.message}`);
    }
}

// Assemble configuration (priority: process.env > test_config.json > defaults)
const config = {};
for (const key of Object.keys(defaults)) {
    const value = process.env[key] || localConfig[key] || defaults[key];
    config[key] = value;
    
    // Inject database parameters directly into process.env so that lib/db.js inherits them
    if (key.startsWith('DB_')) {
        process.env[key] = value;
    }
}

module.exports = config;
