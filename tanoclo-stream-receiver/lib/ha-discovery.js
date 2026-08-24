/**
 * @file lib/ha-discovery.js
 * @brief Home Assistant MQTT Auto-Discovery engine for passively sniffed Tado RF devices.
 * 
 * Generates 100% read-only discovery configurations in a segregated namespace (tanoclo_sniffer_*),
 * avoiding any collision with devices provisioned by the primary websocket server.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const mqttPublisher = require('./mqtt-publisher');

let config = null;
let haPath = 'homeassistant';
const registeredEntities = new Set();

const cacheFile = fs.existsSync('/data')
    ? '/data/discovered_ha_entities.json'
    : path.join(__dirname, '../.discovered_ha_entities.json');

function loadRegisteredCache() {
    if (fs.existsSync(cacheFile)) {
        try {
            const list = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            if (Array.isArray(list)) {
                list.forEach(k => registeredEntities.add(k));
            }
        } catch (e) {
            // Ignore
        }
    }
}

function saveRegisteredEntity(key) {
    registeredEntities.add(key);
    try {
        fs.writeFileSync(cacheFile, JSON.stringify(Array.from(registeredEntities)), 'utf8');
    } catch (e) {
        // Ignore
    }
}

let explicitMqttClient = null;

function setMqttClient(client) {
    explicitMqttClient = client;
}

function clearCache() {
    registeredEntities.clear();
}

function init(_config) {
    config = _config;
    haPath = process.env.MQTT_HA_PATH || (config.mqtt && config.mqtt.haPath) || 'homeassistant';
    loadRegisteredCache();
}

function publishEntity(domain, entityId, payload) {
    const client = explicitMqttClient || mqttPublisher.getClient();
    if (!client || !client.connected) return;
    const topic = `${haPath}/${domain}/${entityId}/config`;
    client.publish(topic, JSON.stringify(payload), { retain: true, qos: 1 });
}

/**
 * Publish Home Assistant Discovery for the Sniffer Receiver hardware node.
 */
function publishReceiverDiscovery() {
    const client = mqttPublisher.getClient();
    if (!client || !client.connected) return;

    const statsTopic = 'tado/sniffer/receiver/stats';
    const receiverDev = {
        identifiers: ['tanoclo_sniffer_receiver'],
        name: 'TaNoClo RF Sniffer Receiver',
        manufacturer: 'TaNoClo',
        model: 'RF Sniffer Stream Receiver',
        sw_version: '1.0.0'
    };

    const statsSensors = [
        { key: 'total_tcp_received', name: 'Total Packets Received', icon: 'mdi:counter', unit: 'pkts' },
        { key: 'bad_crc_packets', name: 'Bad CRC Packets', icon: 'mdi:alert-outline', unit: 'pkts' },
        { key: 'duplicate_raw_packets', name: 'Duplicate Packets', icon: 'mdi:content-copy', unit: 'pkts' },
        { key: 'decryption_failures', name: 'Decryption Failures', icon: 'mdi:lock-open-alert', unit: 'pkts' },
        { key: 'successfully_decoded_coap', name: 'Decoded CoAP Packets', icon: 'mdi:message-text-outline', unit: 'pkts' },
        { key: 'active_whitelisted_pans', name: 'Active PANs', icon: 'mdi:radio-tower', unit: 'PANs' }
    ];

    statsSensors.forEach(sensor => {
        const entityId = `tanoclo_sniffer_receiver_${sensor.key}`;
        const configKey = `receiver:${sensor.key}`;

        if (!registeredEntities.has(configKey)) {
            publishEntity('sensor', entityId, {
                unique_id: entityId,
                name: sensor.name,
                state_topic: statsTopic,
                value_template: `{{ value_json.${sensor.key} }}`,
                icon: sensor.icon,
                unit_of_measurement: sensor.unit,
                state_class: 'measurement',
                device: receiverDev
            });
            saveRegisteredEntity(configKey);
        }
    });
}

/**
 * Publishes read-only discovery configurations for a sniffed physical or emulated device.
 * 
 * @param {object} deviceRecord - Device entry from DeviceRegistry
 */
function publishDeviceDiscovery(deviceRecord) {
    const client = explicitMqttClient || mqttPublisher.getClient();
    if (!client || !client.connected || !deviceRecord) return;

    const devIdStr = deviceRecord.serial || deviceRecord.cleanMac;
    if (!devIdStr) return;

    const prefix = mqttPublisher.getDeviceTopicPrefix(deviceRecord);
    const availTopic = `${prefix}/availability`;

    const deviceType = deviceRecord.deviceType || 'UNKNOWN';
    const isVA = deviceType.startsWith('VA');
    const isRU = deviceType.startsWith('RU') || deviceType.startsWith('SU');
    const isIB = deviceType.startsWith('IB') || deviceType.startsWith('BP') || deviceType.startsWith('BR') || deviceType.startsWith('WR');

    const devHw = {
        identifiers: [`tanoclo_sniffer_dev_${devIdStr}`],
        name: deviceRecord.friendlyName ? `Sniffed ${deviceRecord.friendlyName} (${devIdStr})` : `Sniffed ${deviceType} (${devIdStr})`,
        manufacturer: 'TaNoClo (Sniffed)',
        model: `${deviceType} (Sniffed RF)`,
        sw_version: deviceRecord.fwVersion || undefined,
        via_device: 'tanoclo_sniffer_receiver'
    };

    const registerSensor = (sensorKey, domain, name, extra = {}) => {
        const entityId = `tanoclo_sniffer_${devIdStr}_${sensorKey}`;
        const registryKey = `${devIdStr}:${sensorKey}`;
        if (registeredEntities.has(registryKey)) return;

        const payload = {
            unique_id: entityId,
            name,
            state_topic: `${prefix}/${sensorKey}`,
            availability_topic: availTopic,
            device: devHw,
            ...extra
        };

        publishEntity(domain, entityId, payload);
        saveRegisteredEntity(registryKey);
    };

    // 1. Core Connection & Status Sensors
    registerSensor('connection_state', 'binary_sensor', 'Connection', {
        device_class: 'connectivity',
        value_template: '{{ value }}'
    });
    registerSensor('firmware_version', 'sensor', 'Firmware', { icon: 'mdi:chip' });
    registerSensor('reset_reason', 'sensor', 'Reset Reason', { icon: 'mdi:restart' });
    registerSensor('error_flags', 'sensor', 'Error Flags', { icon: 'mdi:alert-circle-outline' });
    registerSensor('is_emulated', 'binary_sensor', 'Emulated Device', { icon: 'mdi:robot-outline', value_template: '{{ value }}' });
    registerSensor('rssi', 'sensor', 'Signal Strength (RSSI)', {
        device_class: 'signal_strength',
        unit_of_measurement: 'dBm',
        state_class: 'measurement'
    });

    // 2. Environmental & Battery (VA and RU)
    if (isVA || isRU || !isIB) {
        registerSensor('temperature', 'sensor', 'Temperature', {
            device_class: 'temperature',
            unit_of_measurement: '°C',
            state_class: 'measurement'
        });
        registerSensor('aux_temperature', 'sensor', 'Aux Temperature', {
            device_class: 'temperature',
            unit_of_measurement: '°C',
            state_class: 'measurement'
        });
        registerSensor('humidity', 'sensor', 'Humidity', {
            device_class: 'humidity',
            unit_of_measurement: '%',
            state_class: 'measurement'
        });
        registerSensor('light_level', 'sensor', 'Light Level', {
            icon: 'mdi:brightness-5',
            state_class: 'measurement'
        });

        // Battery Sensors (suppressed only if explicitly emulated)
        if (!deviceRecord.isEmulated) {
            registerSensor('battery_level', 'sensor', 'Battery Level', {
                device_class: 'battery',
                unit_of_measurement: '%',
                state_class: 'measurement'
            });
            registerSensor('battery_mv', 'sensor', 'Battery Voltage', {
                device_class: 'voltage',
                unit_of_measurement: 'V',
                state_class: 'measurement'
            });
            registerSensor('battery_state', 'binary_sensor', 'Battery Low', {
                device_class: 'battery',
                value_template: "{% if value == 'LOW' or value == 'CRITICAL' or value == 'DEPLETED' %}ON{% else %}OFF{% endif %}"
            });
        }

        if (isRU) {
            registerSensor('opentherm_voltage', 'sensor', 'OpenTherm Voltage', {
                device_class: 'voltage',
                unit_of_measurement: 'V',
                state_class: 'measurement'
            });
        }
    }

    // 3. Valve Actuator specific read-only sensors
    if (isVA) {
        registerSensor('valve_position_pct', 'sensor', 'Valve Position', {
            unit_of_measurement: '%',
            icon: 'mdi:valve',
            state_class: 'measurement'
        });
        registerSensor('valve_position', 'sensor', 'Raw Steps', {
            unit_of_measurement: 'steps',
            icon: 'mdi:stepper-motor',
            state_class: 'measurement'
        });
        registerSensor('actuator_deviation', 'sensor', 'Actuator Deviation', {
            unit_of_measurement: 'steps',
            icon: 'mdi:arrow-expand-horizontal',
            state_class: 'measurement'
        });
        registerSensor('actuator_active', 'binary_sensor', 'Actuator Active', {
            icon: 'mdi:cog',
            payload_on: 'ON',
            payload_off: 'OFF'
        });
        registerSensor('mounting_state', 'sensor', 'Mounting State', { icon: 'mdi:cog' });

        // PASSIVE READ-ONLY: child lock as binary_sensor (no switch)
        registerSensor('child_lock', 'binary_sensor', 'Child Lock State', {
            icon: 'mdi:lock',
            payload_on: 'ON',
            payload_off: 'OFF'
        });

        // PASSIVE READ-ONLY: orientation as sensor (no select)
        registerSensor('orientation', 'sensor', 'Display Orientation', { icon: 'mdi:screen-rotation' });

        // PASSIVE READ-ONLY: limits as diagnostic sensors (no number)
        registerSensor('actuator_limit_low', 'sensor', 'Actuator Low Steps', {
            icon: 'mdi:numeric',
            unit_of_measurement: 'steps'
        });
        registerSensor('actuator_limit_high', 'sensor', 'Actuator High Steps', {
            icon: 'mdi:numeric',
            unit_of_measurement: 'steps'
        });
        registerSensor('actuator_drive_constant', 'sensor', 'Actuator Drive Constant', {
            icon: 'mdi:numeric'
        });
    }

    // 4. Boiler / HVAC read-only sensors (if RU or IB relays telemetry)
    if (isRU || isIB) {
        const boilerSensors = [
            { key: 'boiler/flow_temperature', name: 'Flow Temperature', extra: { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' } },
            { key: 'boiler/return_temperature', name: 'Return Temperature', extra: { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' } },
            { key: 'boiler/water_pressure_bar', name: 'Water Pressure', extra: { device_class: 'pressure', unit_of_measurement: 'bar', state_class: 'measurement' } },
            { key: 'boiler/boiler_active', name: 'Boiler Active', domain: 'binary_sensor', extra: { device_class: 'running', payload_on: 'ON', payload_off: 'OFF' } },
            { key: 'boiler/dhw_target_temperature', name: 'DHW Target Temperature', extra: { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' } },
            { key: 'boiler/outside_temperature', name: 'Outside Temperature', extra: { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' } },
            { key: 'boiler/exhaust_temperature', name: 'Exhaust Temperature', extra: { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' } },
            { key: 'boiler/dhw_measured_temperature', name: 'DHW Measured Temperature', extra: { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' } }
        ];

        boilerSensors.forEach(b => {
            const cleanKey = b.key.replace(/\//g, '_');
            const entityId = `tanoclo_sniffer_${devIdStr}_${cleanKey}`;
            const registryKey = `${devIdStr}:${cleanKey}`;
            if (!registeredEntities.has(registryKey)) {
                publishEntity(b.domain || 'sensor', entityId, {
                    unique_id: entityId,
                    name: b.name,
                    state_topic: `${prefix}/${b.key}`,
                    availability_topic: availTopic,
                    device: devHw,
                    ...b.extra
                });
                saveRegisteredEntity(registryKey);
            }
        });
    }
}

module.exports = {
    init,
    setMqttClient,
    clearCache,
    publishReceiverDiscovery,
    publishDeviceDiscovery
};
