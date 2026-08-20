/**
 * @file addon-entrypoint.js
 * @brief Home Assistant addon entry point for TaNoClo RF Sniffer Stream Receiver.
 * 
 * Reads options.json configuration options file exported by the Home Assistant Supervisor supervisor,
 * maps properties (tcp ports, Pan IDs, MQTT hosts) to corresponding environment variables,
 * and spawns the node stream_receiver.js subprocess.
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
if (options.tcp_port) env.TCP_PORT = String(options.tcp_port);
if (options.tado_keys) env.TADO_KEYS = options.tado_keys;
if (options.tado_pan_ids) env.TADO_PAN_IDS = options.tado_pan_ids;
env.MQTT_ENABLED = options.mqtt_enabled !== false ? 'true' : 'false';
if (options.mqtt_host) env.MQTT_HOST = options.mqtt_host;
if (options.mqtt_topic) env.MQTT_TOPIC = options.mqtt_topic;
if (options.mqtt_username) env.MQTT_USERNAME = options.mqtt_username;
if (options.mqtt_password) env.MQTT_PASSWORD = options.mqtt_password;
if (options.mqtt_ha_path) env.MQTT_HA_PATH = options.mqtt_ha_path;
env.FILE_LOGGING = options.file_logging !== false ? 'true' : 'false';
if (options.max_log_size_mb !== undefined) env.MAX_LOG_SIZE_MB = String(options.max_log_size_mb);
else if (options.max_log_size !== undefined) env.MAX_LOG_SIZE = String(options.max_log_size);
if (options.max_rotated_logs !== undefined) env.MAX_ROTATED_LOGS = String(options.max_rotated_logs);
env.CONSOLE_LOGGING = options.console_logging !== false ? 'true' : 'false';
env.AUTO_EXCLUSION = options.auto_exclusion !== false ? 'true' : 'false';

// Build command line args
const args = ['stream_receiver.js'];
if (options.stats) {
    args.push('--stats');
}

console.log('[Addon Entrypoint] Launching TaNoClo RF Sniffer Receiver...');

const server = spawn('node', args, {
    stdio: 'inherit',
    env,
    cwd: __dirname
});

server.on('exit', (code) => {
    process.exit(code || 0);
});
