/**
 * @file lib/mqtt-ha-discovery.js
 * @brief MQTT discovery configurations broadcaster for Home Assistant integration.
 */

'use strict';

const homeBuilders = require('./ha-discovery/home-builders');
const zoneBuilders = require('./ha-discovery/zone-builders');
const deviceBuilders = require('./ha-discovery/device-builders');
const emulatedBuilders = require('./ha-discovery/emulated-builders');
const boilerBuilders = require('./ha-discovery/boiler-builders');
const circuitBuilders = require('./ha-discovery/circuit-builders');
const mobileBuilders = require('./ha-discovery/mobile-builders');

let mqttClient = null;
let db = null;
let config = null;
let log = null;

function init(_mqttClient, _db, _config, _log) {
    mqttClient = _mqttClient;
    db = _db;
    config = _config;
    log = _log;
}

async function publishAllDiscovery() {
    if (!db || !mqttClient || !config || !config.mqtt) return;

    const haEnabled = config.mqtt.haDiscovery === true || config.mqtt.haDiscovery === '1' || config.mqtt.haDiscovery === 'true';
    const haPath = config.mqtt.haPath || 'homeassistant';

    try {
        if (log) log('info', `[mqtt-ha] Running HA discovery (enabled: ${haEnabled}, path: ${haPath})...`);
        const pool = db.getPool();

        // 1. Fetch homes
        const [homes] = await pool.execute('SELECT * FROM homes');
        // 2. Fetch zones
        const [zones] = await pool.execute('SELECT * FROM zones');
        // 3. Fetch devices
        const [devices] = await pool.execute('SELECT * FROM devices');
        // 4. Fetch circuits
        const [circuits] = await pool.execute('SELECT * FROM heating_circuits');
        // 5. Fetch heating systems (boilers)
        const [heatingSystems] = await pool.execute('SELECT * FROM heating_systems');

        const homesMap = new Map(homes.map(h => [h.id, h]));
        const zoneToHomeId = new Map(zones.map(z => [z.id, z.home_id]));
        const deviceSerialToHomeId = new Map(devices.map(d => [d.serial_no, d.home_id]));

        // 6. Fetch mobile devices and emulated devices
        const [mobileDevices] = await pool.execute('SELECT * FROM mobile_devices');
        const [emulatedDevices] = await pool.execute('SELECT * FROM emulated_devices');
        const mobileDeviceToHomeId = new Map(mobileDevices.map(md => [md.id, md.home_id]));

        // --- Helper for publishing HA config ---
        const publishEntity = (component, entityId, payload) => {
            const topic = `${haPath}/${component}/${entityId}/config`;
            
            // Try to deduce homeId from entityId prefix
            let homeId = null;
            let m;
            if ((m = entityId.match(/^tanoclo_h(\d+)_/))) {
                homeId = parseInt(m[1], 10);
            } else if ((m = entityId.match(/^tanoclo_md(\d+)_/))) {
                const mdId = parseInt(m[1], 10);
                homeId = mobileDeviceToHomeId.get(mdId);
            } else if ((m = entityId.match(/^tanoclo_z(\d+)_/))) {
                const zoneId = parseInt(m[1], 10);
                homeId = zoneToHomeId.get(zoneId);
            } else if ((m = entityId.match(/^tanoclo_boiler_(\d+)_/))) {
                homeId = parseInt(m[1], 10);
            } else if ((m = entityId.match(/^tanoclo_circuit_(\d+)_/))) {
                homeId = parseInt(m[1], 10);
            } else if ((m = entityId.match(/^tanoclo_([A-Za-z0-9\-]+)_/))) {
                const serial = m[1];
                homeId = deviceSerialToHomeId.get(serial);
            }
            
            const home = homeId ? homesMap.get(homeId) : null;
            let homeHaEnabled = home ? (home.ha_discovery_enabled === 1 || home.ha_discovery_enabled === true || home.ha_discovery_enabled === null || home.ha_discovery_enabled === undefined) : true;
            if (homeId === 999999) {
                homeHaEnabled = false;
            }
            
            if (haEnabled && homeHaEnabled && payload) {
                mqttClient.publish(topic, JSON.stringify(payload), { retain: true, qos: 1 });
            } else {
                mqttClient.publish(topic, '', { retain: true, qos: 1 });
            }
        };

        // Delegate to modular builders
        homeBuilders.buildHomeDiscovery(publishEntity, homes);
        zoneBuilders.buildZoneDiscovery(publishEntity, zones, config);
        deviceBuilders.buildDeviceDiscovery(publishEntity, devices, config);
        emulatedBuilders.buildEmulatedDeviceDiscovery(publishEntity, emulatedDevices);
        boilerBuilders.buildBoilerDiscovery(publishEntity, heatingSystems, homesMap);
        circuitBuilders.buildCircuitDiscovery(publishEntity, circuits, homesMap);
        mobileBuilders.buildMobileDiscovery(publishEntity, mobileDevices);

    } catch (err) {
        if (log) log('error', `[mqtt-ha] HA discovery failed: ${err.message}`, err.stack);
    }
}

function unpublishMobileDevice(deviceId) {
    if (!mqttClient || !config || !config.mqtt) return;
    const haPath = config.mqtt.haPath || 'homeassistant';
    const topic = `${haPath}/device_tracker/tanoclo_md${deviceId}_tracker/config`;
    mqttClient.publish(topic, '', { retain: true, qos: 1 });
    if (log) log('info', `[mqtt-ha] Unpublished mobile device discovery configuration for device ID ${deviceId}`);
}

module.exports = {
    init,
    publishAllDiscovery,
    unpublishMobileDevice
};