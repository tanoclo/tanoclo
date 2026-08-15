/**
 * @file lib/ha-discovery/zone-builders.js
 * @brief Home Assistant discovery entity builders for individual climate zones.
 */

'use strict';

function buildZoneDiscovery(publishEntity, zones, config) {
    for (const zone of zones) {
        // Unpublish old non-home-unique entities to clean up Home Assistant
        const oldSuffixes = [
            ['climate', 'climate'],
            ['sensor', 'temperature'],
            ['sensor', 'humidity'],
            ['sensor', 'heating_power'],
            ['sensor', 'target_temperature'],
            ['sensor', 'tado_mode'],
            ['sensor', 'overlay_mode'],
            ['binary_sensor', 'overlay'],
            ['binary_sensor', 'early_start'],
            ['binary_sensor', 'open_window'],
            ['binary_sensor', 'power'],
            ['switch', 'offline_schedule_enabled'],
            ['button', 'offline_schedule_sync'],
            ['switch', 'open_window_set'],
            ['switch', 'owd_detection'],
            ['select', 'owd_source'],
            ['water_heater', 'water_heater']
        ];
        for (const [comp, suffix] of oldSuffixes) {
            publishEntity(comp, 'tanoclo_z' + zone.id + '_' + suffix, null);
        }

        const zoneDev = {
            identifiers: [`tanoclo_h${zone.home_id}_z${zone.id}`],
            name: zone.name,
            manufacturer: 'TaNoClo (Tado)',
            model: zone.type === 'HEATING' ? 'Heating Zone' : 'Hot Water Zone',
            via_device: `tanoclo_home_${zone.home_id}`
        };

        const zAvailTopic = `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/availability`;

        // Unpublish old water_heater entity if previously published
        publishEntity('water_heater', `tanoclo_h${zone.home_id}_z${zone.id}_water_heater`, null);

        const isHeating = zone.type === 'HEATING';
        const isHotWater = zone.type === 'HOT_WATER' || zone.type === 'DHW';

        if (isHeating || isHotWater) {
            // Climate Entity
            publishEntity('climate', `tanoclo_h${zone.home_id}_z${zone.id}_climate`, {
                unique_id: `tanoclo_h${zone.home_id}_z${zone.id}_climate`,
                name: null, // default to device name
                mode_command_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/set/mode`,
                mode_state_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/hvac_mode`,
                temperature_command_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/set/target_temperature`,
                temperature_state_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/target_temperature`,
                current_temperature_topic: isHotWater ? undefined : `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/temperature`,
                preset_mode_command_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/set/preset_mode`,
                preset_mode_state_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/preset_mode`,
                action_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/hvac_action`,
                modes: ['auto', 'heat', 'off'],
                preset_modes: ['SCHEDULE', 'TIMER', 'NEXT_BLOCK', 'MANUAL'],
                min_temp: isHotWater ? 30.0 : 5.0,
                max_temp: isHotWater ? 65.0 : 25.0,
                temp_step: isHotWater ? 1.0 : 0.5,
                icon: isHotWater ? 'mdi:water-boiler' : undefined,
                availability_topic: zAvailTopic,
                device: zoneDev
            });

            if (isHeating) {
                // Temperature Sensor
                publishEntity('sensor', `tanoclo_h${zone.home_id}_z${zone.id}_temperature`, {
                    unique_id: `tanoclo_h${zone.home_id}_z${zone.id}_temperature`,
                    name: 'Temperature',
                    state_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/temperature`,
                    device_class: 'temperature',
                    unit_of_measurement: '°C',
                    state_class: 'measurement',
                    availability_topic: zAvailTopic,
                    device: zoneDev
                });

                // Humidity Sensor
                publishEntity('sensor', `tanoclo_h${zone.home_id}_z${zone.id}_humidity`, {
                    unique_id: `tanoclo_h${zone.home_id}_z${zone.id}_humidity`,
                    name: 'Humidity',
                    state_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/humidity`,
                    device_class: 'humidity',
                    unit_of_measurement: '%',
                    state_class: 'measurement',
                    availability_topic: zAvailTopic,
                    device: zoneDev
                });

                // Heating Power
                publishEntity('sensor', `tanoclo_h${zone.home_id}_z${zone.id}_heating_power`, {
                    unique_id: `tanoclo_h${zone.home_id}_z${zone.id}_heating_power`,
                    name: 'Heating',
                    state_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/heating_power`,
                    unit_of_measurement: '%',
                    icon: 'mdi:fire',
                    state_class: 'measurement',
                    availability_topic: zAvailTopic,
                    device: zoneDev
                });
            }

            // Target Temperature Sensor
            publishEntity('sensor', `tanoclo_h${zone.home_id}_z${zone.id}_target_temperature`, {
                unique_id: `tanoclo_h${zone.home_id}_z${zone.id}_target_temperature`,
                name: 'Target Temperature',
                state_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/target_temperature`,
                device_class: 'temperature',
                unit_of_measurement: '°C',
                availability_topic: zAvailTopic,
                device: zoneDev
            });

            // Tado Mode Sensor
            publishEntity('sensor', `tanoclo_h${zone.home_id}_z${zone.id}_tado_mode`, {
                unique_id: `tanoclo_h${zone.home_id}_z${zone.id}_tado_mode`,
                name: 'Tado Mode',
                state_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/tado_mode`,
                availability_topic: zAvailTopic,
                device: zoneDev
            });

            // Remove legacy Overlay Mode select (now handled by climate preset_modes)
            publishEntity('select', `tanoclo_h${zone.home_id}_z${zone.id}_overlay_mode`, null);

            // Default Overlay Duration Number
            publishEntity('number', `tanoclo_h${zone.home_id}_z${zone.id}_default_overlay_duration`, {
                unique_id: `tanoclo_h${zone.home_id}_z${zone.id}_default_overlay_duration`,
                name: 'Timer Overlay Duration',
                state_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/default_overlay_duration`,
                command_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/set/default_overlay_duration`,
                unit_of_measurement: 'min',
                min: 5,
                max: 720,
                step: 5,
                icon: 'mdi:timer-sand',
                entity_category: 'config',
                availability_topic: zAvailTopic,
                device: zoneDev
            });

            // Overlay Time Remaining Sensor
            publishEntity('sensor', `tanoclo_h${zone.home_id}_z${zone.id}_overlay_time_remaining`, {
                unique_id: `tanoclo_h${zone.home_id}_z${zone.id}_overlay_time_remaining`,
                name: 'Overlay Time Remaining',
                state_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/overlay_time_remaining`,
                unit_of_measurement: 'min',
                icon: 'mdi:timer-outline',
                availability_topic: zAvailTopic,
                device: zoneDev
            });

            // Overlay Binary Sensor
            publishEntity('binary_sensor', `tanoclo_h${zone.home_id}_z${zone.id}_overlay`, {
                unique_id: `tanoclo_h${zone.home_id}_z${zone.id}_overlay`,
                name: 'Overlay',
                state_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/overlay_active`,
                payload_on: 'ON',
                payload_off: 'OFF',
                availability_topic: zAvailTopic,
                device: zoneDev
            });

            if (isHeating) {
                // Early Start Binary Sensor
                publishEntity('binary_sensor', `tanoclo_h${zone.home_id}_z${zone.id}_early_start`, {
                    unique_id: `tanoclo_h${zone.home_id}_z${zone.id}_early_start`,
                    name: 'Early Start',
                    state_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/early_start`,
                    payload_on: 'ON',
                    payload_off: 'OFF',
                    availability_topic: zAvailTopic,
                    device: zoneDev
                });

                // Open Window Binary Sensor
                publishEntity('binary_sensor', `tanoclo_h${zone.home_id}_z${zone.id}_open_window`, {
                    unique_id: `tanoclo_h${zone.home_id}_z${zone.id}_open_window`,
                    name: 'Open Window',
                    state_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/open_window`,
                    payload_on: 'ON',
                    payload_off: 'OFF',
                    device_class: 'window',
                    availability_topic: zAvailTopic,
                    device: zoneDev
                });
            }

            // Power Binary Sensor
            publishEntity('binary_sensor', `tanoclo_h${zone.home_id}_z${zone.id}_power`, {
                unique_id: `tanoclo_h${zone.home_id}_z${zone.id}_power`,
                name: 'Power',
                state_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/zone_enabled`,
                payload_on: 'ON',
                payload_off: 'OFF',
                device_class: 'power',
                availability_topic: zAvailTopic,
                device: zoneDev
            });

            if (isHeating) {
                // Offline Schedule Enabled Switch
                publishEntity('switch', `tanoclo_h${zone.home_id}_z${zone.id}_offline_schedule_enabled`, {
                    unique_id: `tanoclo_h${zone.home_id}_z${zone.id}_offline_schedule_enabled`,
                    name: 'Offline Schedule Enabled',
                    state_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/offline_schedule_enabled`,
                    command_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/set/offline_schedule_enabled`,
                    payload_on: 'ON',
                    payload_off: 'OFF',
                    entity_category: 'config',
                    availability_topic: zAvailTopic,
                    device: zoneDev
                });

                // Offline Schedule Sync Button
                publishEntity('button', `tanoclo_h${zone.home_id}_z${zone.id}_offline_schedule_sync`, {
                    unique_id: `tanoclo_h${zone.home_id}_z${zone.id}_offline_schedule_sync`,
                    name: 'Offline Schedule Sync',
                    command_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/set/offline_schedule_sync`,
                    payload_press: 'PRESS',
                    entity_category: 'config',
                    availability_topic: zAvailTopic,
                    device: zoneDev
                });

                // Open Window Control Switch (controllable)
                publishEntity('switch', `tanoclo_h${zone.home_id}_z${zone.id}_open_window_set`, {
                    unique_id: `tanoclo_h${zone.home_id}_z${zone.id}_open_window_set`,
                    name: 'Open Window Control',
                    state_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/open_window`,
                    command_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/set/open_window`,
                    payload_on: 'ON',
                    payload_off: 'OFF',
                    icon: 'mdi:window-open-variant',
                    entity_category: 'config',
                    availability_topic: zAvailTopic,
                    device: zoneDev
                });

                // OWD Detection Enable Switch
                publishEntity('switch', `tanoclo_h${zone.home_id}_z${zone.id}_owd_detection`, {
                    unique_id: `tanoclo_h${zone.home_id}_z${zone.id}_owd_detection`,
                    name: 'OWD Detection',
                    state_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/open_window_detection`,
                    command_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/set/open_window_detection`,
                    payload_on: 'ON',
                    payload_off: 'OFF',
                    icon: 'mdi:window-shutter-alert',
                    entity_category: 'config',
                    availability_topic: zAvailTopic,
                    device: zoneDev
                });

                // OWD Source Select
                publishEntity('select', `tanoclo_h${zone.home_id}_z${zone.id}_owd_source`, {
                    unique_id: `tanoclo_h${zone.home_id}_z${zone.id}_owd_source`,
                    name: 'OWD Source',
                    state_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/open_window_source`,
                    command_topic: `tado/tanoclo/h/${zone.home_id}/z/${zone.id}/set/open_window_source`,
                    options: ['device', 'server', 'both', 'external'],
                    icon: 'mdi:source-branch',
                    entity_category: 'config',
                    availability_topic: zAvailTopic,
                    device: zoneDev
                });
            }
        }
    }
}

module.exports = { buildZoneDiscovery };
