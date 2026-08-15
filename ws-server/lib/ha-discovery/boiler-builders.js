/**
 * @file lib/ha-discovery/boiler-builders.js
 * @brief Home Assistant discovery entity builders for modulating boilers.
 */

'use strict';

function buildBoilerDiscovery(publishEntity, heatingSystems, homesMap) {
    for (const hs of heatingSystems) {
        const home = homesMap ? (homesMap.get(hs.home_id) || { name: `Home ${hs.home_id}` }) : { name: `Home ${hs.home_id}` };
        const boilerDev = {
            identifiers: [`tanoclo_boiler_${hs.home_id}`],
            name: `Boiler (${home.name})`,
            manufacturer: 'TaNoClo (Tado)',
            model: 'Heating System',
            via_device: `tanoclo_home_${hs.home_id}`
        };

        const boilerAvailTopic = `tado/tanoclo/h/${hs.home_id}/boiler/availability`;

        publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_flow_temperature`, {
            unique_id: `tanoclo_boiler_${hs.home_id}_flow_temperature`,
            name: 'Flow Temperature',
            state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/flow_temperature`,
            device_class: 'temperature',
            unit_of_measurement: '°C',
            availability_topic: boilerAvailTopic,
            device: boilerDev
        });

        publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_return_temperature`, {
            unique_id: `tanoclo_boiler_${hs.home_id}_return_temperature`,
            name: 'Return Temperature',
            state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/return_temperature`,
            device_class: 'temperature',
            unit_of_measurement: '°C',
            availability_topic: boilerAvailTopic,
            device: boilerDev
        });

        publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_control_setpoint`, {
            unique_id: `tanoclo_boiler_${hs.home_id}_control_setpoint`,
            name: 'Control Setpoint',
            state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/control_setpoint`,
            device_class: 'temperature',
            unit_of_measurement: '°C',
            availability_topic: boilerAvailTopic,
            device: boilerDev
        });

        publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_modulation`, {
            unique_id: `tanoclo_boiler_${hs.home_id}_modulation`,
            name: 'Modulation',
            state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/modulation`,
            unit_of_measurement: '%',
            icon: 'mdi:fire',
            availability_topic: boilerAvailTopic,
            device: boilerDev
        });

        publishEntity('binary_sensor', `tanoclo_boiler_${hs.home_id}_active`, {
            unique_id: `tanoclo_boiler_${hs.home_id}_active`,
            name: 'Boiler Active',
            state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/boiler_active`,
            device_class: 'heat',
            payload_on: 'ON',
            payload_off: 'OFF',
            availability_topic: boilerAvailTopic,
            device: boilerDev
        });

        publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_water_pressure`, {
            unique_id: `tanoclo_boiler_${hs.home_id}_water_pressure`,
            name: 'Water Pressure',
            state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/water_pressure_bar`,
            device_class: 'pressure',
            unit_of_measurement: 'bar',
            availability_topic: boilerAvailTopic,
            device: boilerDev
        });

        // Clean up old dhw_temperature entity (no longer needed)
        publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_dhw_temperature`, null);
        publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_dhw_setpoint_boundaries`, null);

        // DHW Target Temperature (0x045b)
        publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_dhw_target_temperature`, {
            unique_id: `tanoclo_boiler_${hs.home_id}_dhw_target_temperature`,
            name: 'DHW Target Temperature',
            state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/dhw_target_temperature`,
            device_class: 'temperature',
            unit_of_measurement: '°C',
            availability_topic: boilerAvailTopic,
            device: boilerDev
        });

        // DHW Measured Temperature (0x045a)
        publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_dhw_measured_temperature`, {
            unique_id: `tanoclo_boiler_${hs.home_id}_dhw_measured_temperature`,
            name: 'DHW Measured Temperature',
            state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/dhw_measured_temperature`,
            device_class: 'temperature',
            unit_of_measurement: '°C',
            state_class: 'measurement',
            availability_topic: boilerAvailTopic,
            device: boilerDev
        });

        // DHW Setpoint (0x046f)
        publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_dhw_setpoint`, {
            unique_id: `tanoclo_boiler_${hs.home_id}_dhw_setpoint`,
            name: 'DHW Setpoint',
            state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/dhw_setpoint`,
            device_class: 'temperature',
            unit_of_measurement: '°C',
            availability_topic: boilerAvailTopic,
            device: boilerDev
        });

        // Outside Temperature (0x044f)
        publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_outside_temperature`, {
            unique_id: `tanoclo_boiler_${hs.home_id}_outside_temperature`,
            name: 'Outside Temperature',
            state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/outside_temperature`,
            device_class: 'temperature',
            unit_of_measurement: '°C',
            state_class: 'measurement',
            availability_topic: boilerAvailTopic,
            device: boilerDev
        });

        // Exhaust Temperature (0x044e)
        publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_exhaust_temperature`, {
            unique_id: `tanoclo_boiler_${hs.home_id}_exhaust_temperature`,
            name: 'Exhaust Temperature',
            state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/exhaust_temperature`,
            device_class: 'temperature',
            unit_of_measurement: '°C',
            state_class: 'measurement',
            availability_topic: boilerAvailTopic,
            device: boilerDev
        });

        // CH Pump Starts (0x0464)
        publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_ch_pump_starts`, {
            unique_id: `tanoclo_boiler_${hs.home_id}_ch_pump_starts`,
            name: 'CH Pump Starts',
            state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/ch_pump_starts`,
            icon: 'mdi:counter',
            state_class: 'total_increasing',
            availability_topic: boilerAvailTopic,
            device: boilerDev
        });

        // DHW Pump Starts (0x0465)
        publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_dhw_pump_starts`, {
            unique_id: `tanoclo_boiler_${hs.home_id}_dhw_pump_starts`,
            name: 'DHW Pump Starts',
            state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/dhw_pump_starts`,
            icon: 'mdi:counter',
            state_class: 'total_increasing',
            availability_topic: boilerAvailTopic,
            device: boilerDev
        });

        // CH Burner Hours (0x0467)
        publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_ch_burner_hours`, {
            unique_id: `tanoclo_boiler_${hs.home_id}_ch_burner_hours`,
            name: 'CH Burner Hours',
            state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/ch_burner_hours`,
            unit_of_measurement: 'h',
            icon: 'mdi:clock-outline',
            state_class: 'total_increasing',
            availability_topic: boilerAvailTopic,
            device: boilerDev
        });

        // DHW Burner Hours (0x0468)
        publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_dhw_burner_hours`, {
            unique_id: `tanoclo_boiler_${hs.home_id}_dhw_burner_hours`,
            name: 'DHW Burner Hours',
            state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/dhw_burner_hours`,
            unit_of_measurement: 'h',
            icon: 'mdi:clock-outline',
            state_class: 'total_increasing',
            availability_topic: boilerAvailTopic,
            device: boilerDev
        });

        // Fault Flags (0x0452)
        publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_fault_flags`, {
            unique_id: `tanoclo_boiler_${hs.home_id}_fault_flags`,
            name: 'Fault Flags',
            state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/fault_flags`,
            icon: 'mdi:alert',
            availability_topic: boilerAvailTopic,
            device: boilerDev
        });

        publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_burner_starts`, {
            unique_id: `tanoclo_boiler_${hs.home_id}_burner_starts`,
            name: 'Burner Starts',
            state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/burner_starts`,
            icon: 'mdi:counter',
            state_class: 'total_increasing',
            availability_topic: boilerAvailTopic,
            device: boilerDev
        });

        publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_burner_hours`, {
            unique_id: `tanoclo_boiler_${hs.home_id}_burner_hours`,
            name: 'Burner Hours',
            state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/burner_hours`,
            unit_of_measurement: 'h',
            icon: 'mdi:clock-outline',
            state_class: 'total_increasing',
            availability_topic: boilerAvailTopic,
            device: boilerDev
        });
    }
}

module.exports = { buildBoilerDiscovery };
