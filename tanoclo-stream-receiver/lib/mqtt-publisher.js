/**
 * @file lib/mqtt-publisher.js
 * @brief MQTT publisher dispatching sniffer discrete states, raw telemetry, and receiver stats.
 */

'use strict';

let mqtt;
try {
    mqtt = require('mqtt');
} catch (e) {
    mqtt = null;
}

let mqttClient = null;
let config = null;
let batchQueue = [];
let batchTimeout = null;

const BASE_TOPIC = 'tado/sniffer';

function init(_config) {
    config = _config;
    if (!config.mqtt || !config.mqtt.enabled) return null;

    const options = {};
    if (config.mqtt.username) options.username = config.mqtt.username;
    if (config.mqtt.password) options.password = config.mqtt.password;
    if (config.mqtt.clientId) options.clientId = config.mqtt.clientId;

    console.log(`[MQTT] Connecting to broker at ${config.mqtt.host}...`);
    mqttClient = mqtt.connect(config.mqtt.host, options);

    mqttClient.on('connect', () => {
        console.log(`[MQTT] Connected successfully to broker at ${config.mqtt.host}`);
    });

    mqttClient.on('error', (err) => {
        console.error(`[MQTT] Broker error: ${err.message}`);
    });

    return mqttClient;
}

function getClient() {
    return mqttClient;
}

function setClient(client) {
    mqttClient = client;
}

function isConnected() {
    return mqttClient !== null && mqttClient.connected;
}

function batchPublish(topic, payload, opts = { retain: true, qos: 0 }) {
    if (!mqttClient || !mqttClient.connected) return;
    batchQueue.push({ topic, payload, opts });
    if (!batchTimeout) {
        batchTimeout = process.nextTick(() => {
            batchTimeout = null;
            const entries = batchQueue;
            batchQueue = [];
            for (const entry of entries) {
                try {
                    mqttClient.publish(entry.topic, entry.payload, entry.opts);
                } catch (e) {
                    // Ignore publish errors on closed socket
                }
            }
        });
    }
}

function pub(topic, value, retain = true) {
    if (value === undefined) return;
    const pubVal = (value === null) ? '' : String(value);
    batchPublish(topic, pubVal, { retain, qos: 0 });
}

function getDeviceTopicPrefix(deviceRecord) {
    const base = (config && config.mqtt && config.mqtt.topic) || BASE_TOPIC;
    if (deviceRecord && deviceRecord.serial) {
        return `${base}/d/${deviceRecord.serial}`;
    }
    const cleanMac = (deviceRecord && deviceRecord.cleanMac) || 'UNKNOWN';
    return `${base}/m/${cleanMac}`;
}

/**
 * Publish discrete read-only states for a device.
 */
function publishDeviceTelemetry(deviceRecord, updates = {}) {
    if (!isConnected() || !deviceRecord) return;
    const prefix = getDeviceTopicPrefix(deviceRecord);

    // Core device fields
    pub(`${prefix}/availability`, 'online');
    if (updates.connection_state !== undefined) pub(`${prefix}/connection_state`, updates.connection_state ? 'ON' : 'OFF');
    if (updates.firmware_version !== undefined) pub(`${prefix}/firmware_version`, updates.firmware_version);
    if (updates.device_type !== undefined) pub(`${prefix}/device_type`, updates.device_type);
    if (updates.is_emulated !== undefined) pub(`${prefix}/is_emulated`, updates.is_emulated ? 'ON' : 'OFF');
    if (updates.reset_reason !== undefined) pub(`${prefix}/reset_reason`, updates.reset_reason);
    if (updates.error_flags !== undefined) pub(`${prefix}/error_flags`, updates.error_flags);

    // Battery fields (VA / RU)
    if (updates.battery_mv !== undefined) {
        const v = parseFloat((updates.battery_mv / 1000.0).toFixed(3));
        pub(`${prefix}/battery_mv`, v);
    }
    if (updates.battery_percent !== undefined) pub(`${prefix}/battery_percent`, updates.battery_percent);
    if (updates.battery_state !== undefined) pub(`${prefix}/battery_state`, updates.battery_state);

    // Environmental sensor fields
    if (updates.temperature !== undefined) pub(`${prefix}/temperature`, updates.temperature);
    if (updates.aux_temperature !== undefined) pub(`${prefix}/aux_temperature`, updates.aux_temperature);
    if (updates.humidity !== undefined) pub(`${prefix}/humidity`, updates.humidity);
    if (updates.light_level !== undefined) pub(`${prefix}/light_level`, updates.light_level);
    if (updates.rssi !== undefined) pub(`${prefix}/rssi`, updates.rssi);

    // Valve Actuator fields
    if (updates.valve_position !== undefined) pub(`${prefix}/valve_position`, updates.valve_position);
    if (updates.valve_position_pct !== undefined) pub(`${prefix}/valve_position_pct`, updates.valve_position_pct);
    if (updates.actuator_active !== undefined) pub(`${prefix}/actuator_active`, updates.actuator_active ? 'ON' : 'OFF');
    if (updates.mounting_state !== undefined) pub(`${prefix}/mounting_state`, updates.mounting_state);
    if (updates.actuator_deviation !== undefined) pub(`${prefix}/actuator_deviation`, updates.actuator_deviation);
    if (updates.child_lock !== undefined) pub(`${prefix}/child_lock`, updates.child_lock ? 'ON' : 'OFF');
    if (updates.orientation !== undefined) pub(`${prefix}/orientation`, updates.orientation);
    if (updates.actuator_limit_low !== undefined) pub(`${prefix}/actuator_limit_low`, updates.actuator_limit_low);
    if (updates.actuator_limit_high !== undefined) pub(`${prefix}/actuator_limit_high`, updates.actuator_limit_high);
    if (updates.actuator_drive_constant !== undefined) pub(`${prefix}/actuator_drive_constant`, updates.actuator_drive_constant);

    // Boiler / HVAC fields
    if (updates.flow_temperature !== undefined) pub(`${prefix}/boiler/flow_temperature`, updates.flow_temperature);
    if (updates.return_temperature !== undefined) pub(`${prefix}/boiler/return_temperature`, updates.return_temperature);
    if (updates.water_pressure_bar !== undefined) pub(`${prefix}/boiler/water_pressure_bar`, updates.water_pressure_bar);
    if (updates.boiler_active !== undefined) pub(`${prefix}/boiler/boiler_active`, updates.boiler_active ? 'ON' : 'OFF');
    if (updates.dhw_target_temperature !== undefined) pub(`${prefix}/boiler/dhw_target_temperature`, updates.dhw_target_temperature);
    if (updates.outside_temperature !== undefined) pub(`${prefix}/boiler/outside_temperature`, updates.outside_temperature);
    if (updates.exhaust_temperature !== undefined) pub(`${prefix}/boiler/exhaust_temperature`, updates.exhaust_temperature);
    if (updates.dhw_measured_temperature !== undefined) pub(`${prefix}/boiler/dhw_measured_temperature`, updates.dhw_measured_temperature);
}

/**
 * Publish raw packet telemetry for diagnostic inspection.
 */
function publishRawTelemetry(mac, pathStr, payloadData) {
    if (!isConnected()) return;
    const base = (config && config.mqtt && config.mqtt.topic) || BASE_TOPIC;
    const topic = `${base}/${mac}/${pathStr}`;
    batchPublish(topic, JSON.stringify(payloadData), { retain: false, qos: 0 });
}

/**
 * Publish sniffer receiver statistics.
 */
function publishReceiverStats(stats) {
    if (!isConnected()) return;
    const statsTopic = 'tado/sniffer/receiver/stats';
    const payload = {
        total_tcp_received: stats.statsTcpReceived,
        bad_crc_packets: stats.statsCrcFailed,
        duplicate_raw_packets: stats.statsDuplicateRaw,
        decryption_failures: stats.statsDecryptionFailed,
        successfully_decoded_coap: stats.statsDecodedCoap,
        active_whitelisted_pans: stats.whitelistedPanIdsSize
    };
    batchPublish(statsTopic, JSON.stringify(payload), { retain: false, qos: 0 });
}

function close() {
    if (mqttClient) {
        try {
            mqttClient.end(true);
        } catch (e) {
            // Ignore
        }
        mqttClient = null;
    }
}

module.exports = {
    init,
    getClient,
    setClient,
    isConnected,
    pub,
    getDeviceTopicPrefix,
    publishDeviceTelemetry,
    publishRawTelemetry,
    publishReceiverStats,
    close
};
