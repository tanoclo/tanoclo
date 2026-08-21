/**
 * @file lib/ha-discovery/emulated-builders.js
 * @brief Home Assistant discovery entity builders for emulated Tado RU devices.
 */

'use strict';

function buildEmulatedDeviceDiscovery(publishEntity, emulatedDevices) {
    if (!Array.isArray(emulatedDevices)) return;

    for (const dev of emulatedDevices) {
        const serial = dev.serial_no;
        const deviceType = dev.device_type || 'RU02';
        const homeId = dev.home_id;
        const viaDevId = dev.zone_id ? `tanoclo_h${homeId}_z${dev.zone_id}` : `tanoclo_home_${homeId}`;

        const hwDev = {
            identifiers: [`tanoclo_emulated_${serial}`],
            name: `Emulated ${deviceType} (${serial})`,
            manufacturer: 'TaNoClo ESP32 Emulator',
            model: `${deviceType} (Emulated)`,
            via_device: viaDevId
        };

        const stateTopic = `tado/tanoclo/emulated/${serial}/state`;

        // 1. Temperature Control / Sensor (Number Entity)
        publishEntity('number', `tanoclo_emulated_${serial}_temp`, {
            unique_id: `tanoclo_emulated_${serial}_temp`,
            name: 'Emulated Temperature',
            state_topic: stateTopic,
            command_topic: `tado/tanoclo/emulated/${serial}/set/temp`,
            value_template: '{{ value_json.temp_celsius }}',
            min: 5.0,
            max: 30.0,
            step: 0.5,
            unit_of_measurement: '°C',
            device_class: 'temperature',
            icon: 'mdi:thermometer',
            device: hwDev
        });

        // 2. Humidity Control / Sensor (Number Entity)
        publishEntity('number', `tanoclo_emulated_${serial}_humidity`, {
            unique_id: `tanoclo_emulated_${serial}_humidity`,
            name: 'Emulated Humidity',
            state_topic: stateTopic,
            command_topic: `tado/tanoclo/emulated/${serial}/set/humidity`,
            value_template: '{{ value_json.humidity_percent }}',
            min: 10.0,
            max: 95.0,
            step: 1.0,
            unit_of_measurement: '%',
            device_class: 'humidity',
            icon: 'mdi:water-percent',
            device: hwDev
        });

        // 3. Purge redundant Battery Voltage Sensor from HA
        publishEntity('sensor', `tanoclo_emulated_${serial}_battery`, null);

        // 4. Trigger Telemetry Push Button
        publishEntity('button', `tanoclo_emulated_${serial}_push`, {
            unique_id: `tanoclo_emulated_${serial}_push`,
            name: 'Send Telemetry Push',
            command_topic: `tado/tanoclo/emulated/${serial}/set/push`,
            payload_press: 'PRESS',
            icon: 'mdi:send-radio',
            device: hwDev
        });
    }
}

module.exports = {
    buildEmulatedDeviceDiscovery
};
