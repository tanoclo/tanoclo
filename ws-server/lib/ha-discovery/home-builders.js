/**
 * @file lib/ha-discovery/home-builders.js
 * @brief Home Assistant discovery entity builders for home presence status.
 */

'use strict';

function buildHomeDiscovery(publishEntity, homes, profilesByHome = new Map()) {
    for (const home of homes) {
        const homeDev = {
            identifiers: [`tanoclo_home_${home.id}`],
            name: home.name,
            manufacturer: 'TaNoClo (Tado)',
            model: 'Home'
        };

        const profileOptions = (profilesByHome.get && profilesByHome.get(home.id)) || ['Autumn', 'Winter', 'Spring', 'Holiday'];

        // Schedule Profile Select
        publishEntity('select', `tanoclo_h${home.id}_schedule_profile`, {
            unique_id: `tanoclo_h${home.id}_schedule_profile`,
            name: 'Heating Schedule Profile',
            icon: 'mdi:calendar-sync',
            state_topic: `tado/tanoclo/h/${home.id}/schedule_profile`,
            command_topic: `tado/tanoclo/h/${home.id}/set/schedule_profile`,
            options: profileOptions.length > 0 ? profileOptions : ['Default'],
            availability_topic: 'tado/tanoclo/status',
            device: homeDev
        });

        // Presence Select
        publishEntity('select', `tanoclo_h${home.id}_presence`, {
            unique_id: `tanoclo_h${home.id}_presence`,
            name: 'Presence',
            state_topic: `tado/tanoclo/h/${home.id}/presence_lock_setting`,
            command_topic: `tado/tanoclo/h/${home.id}/set/presence`,
            options: ['AUTO', 'HOME', 'AWAY'],
            availability_topic: 'tado/tanoclo/status',
            device: homeDev
        });

        // Presence Mode Sensor
        publishEntity('sensor', `tanoclo_h${home.id}_presence_mode`, {
            unique_id: `tanoclo_h${home.id}_presence_mode`,
            name: 'Current Presence',
            state_topic: `tado/tanoclo/h/${home.id}/presence`,
            icon: 'mdi:home-account',
            availability_topic: 'tado/tanoclo/status',
            device: homeDev
        });

        // Outside Temp
        publishEntity('sensor', `tanoclo_h${home.id}_outside_temperature`, {
            unique_id: `tanoclo_h${home.id}_outside_temperature`,
            name: 'Outside Temperature',
            state_topic: `tado/tanoclo/h/${home.id}/outside_temperature`,
            device_class: 'temperature',
            unit_of_measurement: '°C',
            state_class: 'measurement',
            availability_topic: 'tado/tanoclo/status',
            device: homeDev
        });

        // Solar Intensity
        publishEntity('sensor', `tanoclo_h${home.id}_solar_intensity`, {
            unique_id: `tanoclo_h${home.id}_solar_intensity`,
            name: 'Solar Percentage',
            state_topic: `tado/tanoclo/h/${home.id}/solar_intensity`,
            unit_of_measurement: '%',
            icon: 'mdi:white-balance-sunny',
            state_class: 'measurement',
            availability_topic: 'tado/tanoclo/status',
            device: homeDev
        });

        // Weather State
        publishEntity('sensor', `tanoclo_h${home.id}_weather_state`, {
            unique_id: `tanoclo_h${home.id}_weather_state`,
            name: 'Weather',
            state_topic: `tado/tanoclo/h/${home.id}/weather_state`,
            icon: 'mdi:weather-partly-cloudy',
            availability_topic: 'tado/tanoclo/status',
            device: homeDev
        });

        // Proxy Enabled Switch
        publishEntity('switch', `tanoclo_h${home.id}_proxy_enabled`, {
            unique_id: `tanoclo_h${home.id}_proxy_enabled`,
            name: 'Proxy Enabled',
            state_topic: `tado/tanoclo/h/${home.id}/is_proxied`,
            command_topic: `tado/tanoclo/h/${home.id}/set/is_proxied`,
            payload_on: 'ON',
            payload_off: 'OFF',
            availability_topic: 'tado/tanoclo/status',
            device: homeDev
        });

        // Proxy Logging Switch
        publishEntity('switch', `tanoclo_h${home.id}_proxy_logging`, {
            unique_id: `tanoclo_h${home.id}_proxy_logging`,
            name: 'Proxy Logging',
            state_topic: `tado/tanoclo/h/${home.id}/proxy_logging`,
            command_topic: `tado/tanoclo/h/${home.id}/set/proxy_logging`,
            payload_on: 'ON',
            payload_off: 'OFF',
            availability_topic: 'tado/tanoclo/status',
            device: homeDev
        });

        // Log Uploads Enabled Switch
        publishEntity('switch', `tanoclo_h${home.id}_log_uploads_enabled`, {
            unique_id: `tanoclo_h${home.id}_log_uploads_enabled`,
            name: 'Log Uploads Enabled',
            state_topic: `tado/tanoclo/h/${home.id}/log_uploads_enabled`,
            command_topic: `tado/tanoclo/h/${home.id}/set/log_uploads_enabled`,
            payload_on: 'ON',
            payload_off: 'OFF',
            availability_topic: 'tado/tanoclo/status',
            device: homeDev
        });

        // Allow Commands In Proxy Switch
        publishEntity('switch', `tanoclo_h${home.id}_allow_commands_in_proxy`, {
            unique_id: `tanoclo_h${home.id}_allow_commands_in_proxy`,
            name: 'Allow Commands in Proxy',
            state_topic: `tado/tanoclo/h/${home.id}/allow_commands_in_proxy`,
            command_topic: `tado/tanoclo/h/${home.id}/set/allow_commands_in_proxy`,
            payload_on: 'ON',
            payload_off: 'OFF',
            availability_topic: 'tado/tanoclo/status',
            device: homeDev
        });

        // Config Readonly Switch
        publishEntity('switch', `tanoclo_h${home.id}_zone_config_readonly`, {
            unique_id: `tanoclo_h${home.id}_zone_config_readonly`,
            name: 'Config Readonly',
            state_topic: `tado/tanoclo/h/${home.id}/zone_config_readonly`,
            command_topic: `tado/tanoclo/h/${home.id}/set/zone_config_readonly`,
            payload_on: 'ON',
            payload_off: 'OFF',
            availability_topic: 'tado/tanoclo/status',
            device: homeDev
        });

        // Remove HA Discovery Enabled Switch configuration
        publishEntity('switch', `tanoclo_h${home.id}_ha_discovery_enabled`, null);

        // Auto Valve Exercise Switch
        publishEntity('switch', `tanoclo_h${home.id}_auto_valve_exercise`, {
            unique_id: `tanoclo_h${home.id}_auto_valve_exercise`,
            name: 'Auto Valve Exercise',
            icon: 'mdi:valve',
            state_topic: `tado/tanoclo/h/${home.id}/auto_valve_exercise`,
            command_topic: `tado/tanoclo/h/${home.id}/set/auto_valve_exercise`,
            payload_on: 'ON',
            payload_off: 'OFF',
            availability_topic: 'tado/tanoclo/status',
            device: homeDev
        });

        // Exercise All Valves Button
        publishEntity('button', `tanoclo_h${home.id}_exercise_valves`, {
            unique_id: `tanoclo_h${home.id}_exercise_valves`,
            name: 'Exercise All Valves',
            icon: 'mdi:valve',
            command_topic: `tado/tanoclo/h/${home.id}/set/exercise_valves`,
            payload_press: 'PRESS',
            availability_topic: 'tado/tanoclo/status',
            device: homeDev
        });
    }
}

module.exports = { buildHomeDiscovery };