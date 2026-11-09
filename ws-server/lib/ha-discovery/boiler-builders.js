/**
 * @file lib/ha-discovery/boiler-builders.js
 * @brief Home Assistant discovery entity builders for modulating boilers.
 */

'use strict';

const interfaceModules = require('../interface-modules');

function buildBoilerDiscovery(publishEntity, heatingSystems, homesMap) {
    for (const hs of heatingSystems) {
        const home = homesMap ? (homesMap.get(hs.home_id) || { name: `Home ${hs.home_id}` }) : { name: `Home ${hs.home_id}` };
        const effective015d = hs.field_015d !== null && hs.field_015d !== undefined ? hs.field_015d : 71;
        const modInfo = interfaceModules.getInterfaceModuleInfo(effective015d);
        const supported = new Set(interfaceModules.computeSupportedMetrics(effective015d, hs));

        const boilerDev = {
            identifiers: [`tanoclo_boiler_${hs.home_id}`],
            name: `Boiler (${home.name})`,
            manufacturer: 'TaNoClo (Tado)',
            model: modInfo.familyName || 'Heating System',
            via_device: `tanoclo_home_${hs.home_id}`
        };

        const boilerAvailTopic = `tado/tanoclo/h/${hs.home_id}/boiler/availability`;

        if (supported.has('flowTemperature')) {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_flow_temperature`, {
                unique_id: `tanoclo_boiler_${hs.home_id}_flow_temperature`,
                name: 'Flow Temperature',
                state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/flow_temperature`,
                device_class: 'temperature',
                unit_of_measurement: '°C',
                availability_topic: boilerAvailTopic,
                device: boilerDev
            });
        } else {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_flow_temperature`, null);
        }

        if (supported.has('returnTemperature')) {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_return_temperature`, {
                unique_id: `tanoclo_boiler_${hs.home_id}_return_temperature`,
                name: 'Return Temperature',
                state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/return_temperature`,
                device_class: 'temperature',
                unit_of_measurement: '°C',
                availability_topic: boilerAvailTopic,
                device: boilerDev
            });
        } else {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_return_temperature`, null);
        }

        if (supported.has('controlSetpoint')) {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_control_setpoint`, {
                unique_id: `tanoclo_boiler_${hs.home_id}_control_setpoint`,
                name: 'Control Setpoint',
                state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/control_setpoint`,
                device_class: 'temperature',
                unit_of_measurement: '°C',
                availability_topic: boilerAvailTopic,
                device: boilerDev
            });
        } else {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_control_setpoint`, null);
        }

        if (supported.has('modulationPercentage')) {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_modulation`, {
                unique_id: `tanoclo_boiler_${hs.home_id}_modulation`,
                name: 'Modulation',
                state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/modulation`,
                unit_of_measurement: '%',
                icon: 'mdi:fire',
                availability_topic: boilerAvailTopic,
                device: boilerDev
            });
        } else {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_modulation`, null);
        }

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

        if (supported.has('waterPressureBar')) {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_water_pressure`, {
                unique_id: `tanoclo_boiler_${hs.home_id}_water_pressure`,
                name: 'Water Pressure',
                state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/water_pressure_bar`,
                device_class: 'pressure',
                unit_of_measurement: 'bar',
                availability_topic: boilerAvailTopic,
                device: boilerDev
            });
        } else {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_water_pressure`, null);
        }

        // Clean up old dhw_temperature entity (no longer needed)
        publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_dhw_temperature`, null);
        publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_dhw_setpoint_boundaries`, null);

        // DHW Target Temperature (0x045b)
        if (supported.has('dhwTargetTemperature')) {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_dhw_target_temperature`, {
                unique_id: `tanoclo_boiler_${hs.home_id}_dhw_target_temperature`,
                name: 'DHW Target Temperature',
                state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/dhw_target_temperature`,
                device_class: 'temperature',
                unit_of_measurement: '°C',
                availability_topic: boilerAvailTopic,
                device: boilerDev
            });
        } else {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_dhw_target_temperature`, null);
        }

        // DHW Measured Temperature (0x045a)
        if (supported.has('dhwMeasuredTemperature')) {
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
        } else {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_dhw_measured_temperature`, null);
        }

        // DHW Setpoint (0x046f)
        if (supported.has('maxChFlowTemperature')) {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_dhw_setpoint`, {
                unique_id: `tanoclo_boiler_${hs.home_id}_dhw_setpoint`,
                name: 'DHW Setpoint',
                state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/dhw_setpoint`,
                device_class: 'temperature',
                unit_of_measurement: '°C',
                availability_topic: boilerAvailTopic,
                device: boilerDev
            });
        } else {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_dhw_setpoint`, null);
        }

        // Outside Temperature (0x044f)
        if (supported.has('outsideTemperature')) {
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
        } else {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_outside_temperature`, null);
        }

        // Exhaust Temperature (0x044e)
        if (supported.has('exhaustTemperature')) {
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
        } else {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_exhaust_temperature`, null);
        }

        // CH Pump Starts (0x0464)
        if (supported.has('chPumpStarts')) {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_ch_pump_starts`, {
                unique_id: `tanoclo_boiler_${hs.home_id}_ch_pump_starts`,
                name: 'CH Pump Starts',
                state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/ch_pump_starts`,
                icon: 'mdi:counter',
                state_class: 'total_increasing',
                availability_topic: boilerAvailTopic,
                device: boilerDev
            });
        } else {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_ch_pump_starts`, null);
        }

        // CH Burner Starts (0x0465)
        if (supported.has('chBurnerStarts')) {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_ch_burner_starts`, {
                unique_id: `tanoclo_boiler_${hs.home_id}_ch_burner_starts`,
                name: 'CH Burner Starts',
                state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/ch_burner_starts`,
                icon: 'mdi:counter',
                state_class: 'total_increasing',
                availability_topic: boilerAvailTopic,
                device: boilerDev
            });
        } else {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_ch_burner_starts`, null);
        }

        // CH Burner Hours (0x0467)
        if (supported.has('burnerHoursCh')) {
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
        } else {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_ch_burner_hours`, null);
        }

        // DHW Burner Hours (0x0468)
        if (supported.has('burnerHoursDhw')) {
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
        } else {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_dhw_burner_hours`, null);
        }

        // Fault Flags (0x0452)
        if (supported.has('flameCurrentUa') || (hs.field_0458 !== null && hs.field_0458 !== undefined)) {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_fault_flags`, {
                unique_id: `tanoclo_boiler_${hs.home_id}_fault_flags`,
                name: 'Fault Flags',
                state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/fault_flags`,
                icon: 'mdi:alert',
                availability_topic: boilerAvailTopic,
                device: boilerDev
            });
        } else {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_fault_flags`, null);
        }

        if (supported.has('burnerStarts')) {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_burner_starts`, {
                unique_id: `tanoclo_boiler_${hs.home_id}_burner_starts`,
                name: 'Burner Starts',
                state_topic: `tado/tanoclo/h/${hs.home_id}/boiler/burner_starts`,
                icon: 'mdi:counter',
                state_class: 'total_increasing',
                availability_topic: boilerAvailTopic,
                device: boilerDev
            });
        } else {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_burner_starts`, null);
        }

        if (supported.has('burnerHoursTotal')) {
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
        } else {
            publishEntity('sensor', `tanoclo_boiler_${hs.home_id}_burner_hours`, null);
        }
    }
}

module.exports = { buildBoilerDiscovery };