/**
 * @file addon-entrypoint.js
 * @brief Home Assistant addon entry point for TaNoClo Websocket and HTTP API Server.
 * 
 * Extracts Home Assistant configuration properties (database connection strings, ports, domain parameters),
 * manages persistent JWT secrets generation, and spawns the main server.js module from the ws-server folder.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let options = {};
try {
    if (fs.existsSync('/data/options.json')) {
        options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
    }
} catch (e) {
    console.error('[Addon Entrypoint] Error reading options.json:', e.message);
}

// Map configuration values to environment variables
const env = { ...process.env };
if (options.db_host) {
    // Basic hostname validation: alphanumeric, dots, hyphens, colons (IPv6)
    if (/^[a-zA-Z0-9._:-]+$/.test(options.db_host)) {
        env.DB_HOST = options.db_host;
    } else {
        console.error('[Addon Entrypoint] WARNING: db_host contains invalid characters, using default.');
    }
}
if (options.db_port) env.DB_PORT = String(options.db_port);
if (options.db_name) env.DB_NAME = options.db_name;
if (options.db_user) env.DB_USER = options.db_user;
env.DB_PASS = options.db_password || '';
if (!options.db_password) {
    console.warn('[Addon Entrypoint] WARNING: db_password is empty. Configure a database password for security.');
}

// Handle JWT Secret - persistent auto-generation if not set
let jwtSecret = options.jwt_secret;
if (!jwtSecret) {
    const secretPath = '/data/jwt_secret.txt';
    if (fs.existsSync(secretPath)) {
        jwtSecret = fs.readFileSync(secretPath, 'utf8').trim();
    } else {
        jwtSecret = require('crypto').randomBytes(32).toString('hex');
        try {
            fs.writeFileSync(secretPath, jwtSecret, { encoding: 'utf8', mode: 0o600 });
            console.log('[Addon Entrypoint] Generated and saved new persistent JWT secret');
        } catch (err) {
            console.error('[Addon Entrypoint] Failed to save persistent JWT secret:', err.message);
        }
    }
}
env.JWT_SECRET = jwtSecret;

if (options.ws_port) env.WS_PORT = String(options.ws_port);
if (options.http_api_port) env.HTTP_API_PORT = String(options.http_api_port);
if (options.log_level) env.LOG_LEVEL = options.log_level;
if (options.tanoclo_domain) env.TANOCLO_DOMAIN = options.tanoclo_domain;
if (options.zone_config_readonly !== undefined) {
    env.TANOCLO_ZONE_CONFIG_READONLY = String(options.zone_config_readonly);
}
if (options.mqtt_enabled !== undefined) {
    env.MQTT_ENABLED = String(options.mqtt_enabled);
}
if (options.mqtt_host) env.MQTT_HOST = options.mqtt_host;
if (options.mqtt_username) env.MQTT_USERNAME = options.mqtt_username;
if (options.mqtt_password) env.MQTT_PASSWORD = options.mqtt_password;

// Force SSL files lookup to use the mounted /ssl folder if mapped
env.SSL_KEY_PATH = '/ssl/tanoclo_key.pem';
env.SSL_CERT_PATH = '/ssl/tanoclo_cert.pem';
env.TADO_ROOT_CA_PATH = '/ssl/tadoRootCA.cer';

console.log('[Addon Entrypoint] Launching TaNoClo server...');
const server = spawn('node', ['server.js'], { 
    stdio: 'inherit', 
    env,
    cwd: path.join(__dirname, '../ws-server')
});

// Forward OS termination signals to the spawned server child process
process.on('SIGTERM', () => {
    console.log('[Addon Entrypoint] SIGTERM received. Terminating child server...');
    server.kill('SIGTERM');
});
process.on('SIGINT', () => {
    console.log('[Addon Entrypoint] SIGINT received. Terminating child server...');
    server.kill('SIGINT');
});

server.on('exit', (code) => {
    process.exit(code || 0);
});
