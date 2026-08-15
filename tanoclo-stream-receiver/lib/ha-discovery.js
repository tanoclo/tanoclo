/**
 * @file lib/ha-discovery.js
 * @brief Handles Home Assistant MQTT discovery configurations publishing for sniffer packets.
 * 
 * Auto-registers physical receiver nodes and battery-powered sensors (valves, wall thermostats)
 * in Home Assistant. Generates standard JSON config payloads under configured topic paths
 * (e.g. temperature, humidity, RSSI, battery voltages, dial steps).
 */

const fs = require('fs');
const path = require('path');

let mqttClient = null;
let config = null;
let haPath = 'homeassistant';
const registeredDevices = new Set();
const deviceStates = new Map();

// Determine persistent cache file location
const discoveredDevicesFile = fs.existsSync('/data') 
    ? '/data/discovered_devices.json' 
    : path.join(__dirname, '../.discovered_devices.json');

// SENSOR DEFINITIONS FOR MQTT DISCOVERY
const SENSOR_CONFIGS = {
    // Ambient conditions
    temperature_ambient: {
        name: 'Ambient Temperature',
        component: 'sensor',
        extra: { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' }
    },
    aux_temperature_1: {
        name: 'Aux Temperature 1',
        component: 'sensor',
        extra: { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' }
    },
    aux_temperature_2: {
        name: 'Aux Temperature 2',
        component: 'sensor',
        extra: { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' }
    },
    humidity_percent: {
        name: 'Humidity',
        component: 'sensor',
        extra: { device_class: 'humidity', unit_of_measurement: '%', state_class: 'measurement' }
    },
    ambient_light_level: {
        name: 'Ambient Light Level',
        component: 'sensor',
        extra: { icon: 'mdi:brightness-5', state_class: 'measurement' }
    },
    dial_encoder_steps: {
        name: 'Dial Encoder Steps',
        component: 'sensor',
        extra: { icon: 'mdi:rotate-right' }
    },
    // Battery
    battery_voltage: {
        name: 'Battery Voltage',
        component: 'sensor',
        extra: { device_class: 'voltage', unit_of_measurement: 'V', state_class: 'measurement' }
    },
    battery_level: {
        name: 'Battery Level',
        component: 'sensor',
        extra: { device_class: 'battery', unit_of_measurement: '%', state_class: 'measurement' }
    },
    battery_low: {
        name: 'Battery Status Low',
        component: 'binary_sensor',
        extra: { device_class: 'battery' }
    },
    // Actuators & Valves
    va_act_position_steps: {
        name: 'Actuator Position Steps',
        component: 'sensor',
        extra: { icon: 'mdi:stepper', state_class: 'measurement' }
    },
    va_act_position2_steps: {
        name: 'Secondary Actuator Position Steps',
        component: 'sensor',
        extra: { icon: 'mdi:stepper', state_class: 'measurement' }
    },
    va_mount_state: {
        name: 'Mount State',
        component: 'sensor',
        extra: { icon: 'mdi:cog' }
    },
    demand_percent: {
        name: 'Heat Demand',
        component: 'sensor',
        extra: { unit_of_measurement: '%', state_class: 'measurement', icon: 'mdi:radiator' }
    },
    // HVAC & Boiler (OpenTherm)
    ot_ch_flow_temperature: {
        name: 'CH Flow Temperature',
        component: 'sensor',
        extra: { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' }
    },
    ot_ch_return_temperature: {
        name: 'CH Return Temperature',
        component: 'sensor',
        extra: { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' }
    },
    ot_outside_temperature: {
        name: 'OT Outside Temperature',
        component: 'sensor',
        extra: { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' }
    },
    ot_dhw_flow_rate: {
        name: 'DHW Flow Rate',
        component: 'sensor',
        extra: { unit_of_measurement: 'L/min', state_class: 'measurement', icon: 'mdi:water-pump' }
    },
    water_pressure: {
        name: 'Water Pressure',
        component: 'sensor',
        extra: { device_class: 'pressure', unit_of_measurement: 'bar', state_class: 'measurement' }
    },
    dhw_target_temperature: {
        name: 'DHW Target Temperature',
        component: 'sensor',
        extra: { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' }
    },
    boiler_active: {
        name: 'Boiler Active',
        component: 'binary_sensor',
        extra: { device_class: 'running' }
    },
    // Zone
    schedule_target_temp: {
        name: 'Schedule Target Temperature',
        component: 'sensor',
        extra: { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' }
    },
    overlay_target_temp: {
        name: 'Overlay Target Temperature',
        component: 'sensor',
        extra: { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' }
    },
    // Sniffer RSSI
    rssi: {
        name: 'Signal Strength (RSSI)',
        component: 'sensor',
        extra: { device_class: 'signal_strength', unit_of_measurement: 'dBm', state_class: 'measurement' }
    }
};

function loadDiscoveredDevices() {
    if (fs.existsSync(discoveredDevicesFile)) {
        try {
            const list = JSON.parse(fs.readFileSync(discoveredDevicesFile, 'utf8'));
            if (Array.isArray(list)) {
                list.forEach(mac => registeredDevices.add(mac));
            }
            console.log(`[HA Discovery] Loaded ${registeredDevices.size} registered entities from cache`);
        } catch (e) {
            console.warn(`[HA Discovery] Error reading ${discoveredDevicesFile}:`, e.message);
        }
    }
}

function saveDiscoveredDevice(key) {
    registeredDevices.add(key);
    try {
        fs.writeFileSync(discoveredDevicesFile, JSON.stringify(Array.from(registeredDevices)), 'utf8');
    } catch (e) {
        // Silently ignore errors (e.g. read-only filesystem)
    }
}

function init(_mqttClient, _config) {
    mqttClient = _mqttClient;
    config = _config;
    haPath = process.env.MQTT_HA_PATH || (config.mqtt && config.mqtt.haPath) || 'homeassistant';
    loadDiscoveredDevices();
}

function publishReceiverDiscovery() {
    if (!mqttClient) return;
    
    const statsTopic = 'tado/sniffer/receiver/stats';
    const receiverDev = {
        identifiers: ['tanoclo_sniffer_receiver'],
        name: 'TaNoClo RF Sniffer Receiver',
        manufacturer: 'TaNoClo',
        model: 'RF Sniffer Receiver',
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
        
        if (!registeredDevices.has(configKey)) {
            const topic = `${haPath}/sensor/${entityId}/config`;
            const payload = {
                unique_id: entityId,
                name: sensor.name,
                state_topic: statsTopic,
                value_template: `{{ value_json.${sensor.key} }}`,
                icon: sensor.icon,
                unit_of_measurement: sensor.unit,
                state_class: 'measurement',
                device: receiverDev
            };
            mqttClient.publish(topic, JSON.stringify(payload), { retain: true, qos: 1 });
            saveDiscoveredDevice(configKey);
        }
    });

    // Auto Exclusion Switch entity
    const switchEntityId = 'tanoclo_sniffer_receiver_auto_exclusion';
    const switchConfigKey = 'receiver:auto_exclusion_switch';
    if (!registeredDevices.has(switchConfigKey)) {
        const switchTopic = `${haPath}/switch/${switchEntityId}/config`;
        const switchPayload = {
            unique_id: switchEntityId,
            name: 'Auto Exclusion',
            state_topic: 'tado/sniffer/state/auto_exclusion',
            command_topic: 'tado/sniffer/set/auto_exclusion',
            payload_on: 'ON',
            payload_off: 'OFF',
            icon: 'mdi:shield-cancel',
            device: receiverDev
        };
        mqttClient.publish(switchTopic, JSON.stringify(switchPayload), { retain: true, qos: 1 });
        saveDiscoveredDevice(switchConfigKey);
    }
}

function publishReceiverStats(stats) {
    if (!mqttClient) return;
    const statsTopic = 'tado/sniffer/receiver/stats';
    const payload = {
        total_tcp_received: stats.statsTcpReceived,
        bad_crc_packets: stats.statsCrcFailed,
        duplicate_raw_packets: stats.statsDuplicateRaw,
        decryption_failures: stats.statsDecryptionFailed,
        successfully_decoded_coap: stats.statsDecodedCoap,
        active_whitelisted_pans: stats.whitelistedPanIdsSize
    };
    mqttClient.publish(statsTopic, JSON.stringify(payload), { qos: 0 });
}

function publishSensorDiscovery(mac, sensorKey, sensorConfig) {
    const registryKey = `${mac}:${sensorKey}`;
    if (registeredDevices.has(registryKey)) return; // already registered

    const cleanMac = mac.replace(/:/g, '').toUpperCase();
    const shortMac = mac.split(':').slice(4).join('');
    const isIb = mac.includes(':31:55:') || mac.endsWith('(IB)');
    const deviceTypeStr = isIb ? 'IB' : 'VA/RU';
    
    const hwDev = {
        identifiers: [`tanoclo_sniffer_${cleanMac}`],
        name: `Tado ${deviceTypeStr} (${shortMac})`,
        manufacturer: 'Tado',
        model: isIb ? 'Internet Bridge' : 'Thermostat/Valve',
        via_device: 'tanoclo_sniffer_receiver'
    };

    const entityId = `tanoclo_sniffer_${cleanMac}_${sensorKey}`;
    const topic = `${haPath}/${sensorConfig.component || 'sensor'}/${entityId}/config`;
    
    const payload = {
        unique_id: entityId,
        name: sensorConfig.name,
        state_topic: `tado/sniffer/device/${mac}/state`,
        value_template: `{{ value_json.${sensorKey} }}`,
        device: hwDev,
        ...sensorConfig.extra
    };

    mqttClient.publish(topic, JSON.stringify(payload), { retain: true, qos: 1 });
    saveDiscoveredDevice(registryKey);
}

/**
 * @brief Processes an incoming RF sniffer packet.
 * 
 * Extracts TLV metrics, maps battery/pressure sub-values, updates internal device
 * state maps, and publishes discovery config states to MQTT when changes are detected.
 * 
 * @param {object} packet - Decoded packet object.
 * @param {string} type - Packet completeness type ('unfragmented' or 'complete').
 * @param {object} meta - Packet metadata containing RSSI info.
 */
function handlePacket(packet, type, meta) {
    if (!mqttClient) return;
    if (type !== 'unfragmented' && type !== 'complete') return;
    
    const senderMac = packet.macInfo.src.split(' ')[0];
    
    // Extract TLV values
    const updates = {};
    if (packet.tlv && packet.tlv.items) {
        packet.tlv.items.forEach(item => {
            updates[item.name] = item.value;
            
            // Battery helpers
            if (item.name === 'battery_mv' && typeof item.value === 'number') {
                updates.battery_voltage = parseFloat((item.value / 1000.0).toFixed(3));
                updates.battery_level = Math.max(0, Math.min(100, Math.round((item.value - 2000) / 10)));
                updates.battery_low = item.value < 2400 ? 'ON' : 'OFF';
            }
            
            // Water pressure helper
            if (item.name === 'hvac_water_pressure_mbar' && typeof item.value === 'number') {
                updates.water_pressure = parseFloat((item.value / 1000.0).toFixed(3));
            }
        });
    }
    
    if (meta && meta.rssi !== undefined) {
        updates.rssi = meta.rssi;
    }

    if (Object.keys(updates).length > 0) {
        if (!deviceStates.has(senderMac)) {
            deviceStates.set(senderMac, {});
        }
        const state = deviceStates.get(senderMac);
        Object.assign(state, updates);
        state.last_seen = new Date().toISOString();

        // Publish discovery configs for any new sensors
        Object.keys(updates).forEach(key => {
            if (SENSOR_CONFIGS[key]) {
                publishSensorDiscovery(senderMac, key, SENSOR_CONFIGS[key]);
            }
        });
        
        // Publish flat state payload
        const stateTopic = `tado/sniffer/device/${senderMac}/state`;
        mqttClient.publish(stateTopic, JSON.stringify(state), { qos: 0 });
    }
}

module.exports = {
    init,
    publishReceiverDiscovery,
    publishReceiverStats,
    handlePacket
};
