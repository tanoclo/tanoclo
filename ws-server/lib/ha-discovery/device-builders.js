/**
 * @file lib/ha-discovery/device-builders.js
 * @brief Home Assistant discovery entity builders for physical thermostats and valves.
 */

'use strict';

function buildDeviceDiscovery(publishEntity, devices, config) {
    for (const dev of devices) {
        const shortSerial = dev.serial_no;
        const serial = dev.serial_no;
        const deviceType = dev.device_type;
        const isVA = deviceType && deviceType.startsWith('VA');
        const isRU = deviceType && (deviceType.startsWith('RU') || deviceType.startsWith('SU'));
        const isIB = deviceType && (deviceType.startsWith('IB') || deviceType.startsWith('BP') || deviceType.startsWith('BR') || deviceType.startsWith('WR'));

        const viaDevId = dev.zone_id ? `tanoclo_h${dev.home_id}_z${dev.zone_id}` : `tanoclo_home_${dev.home_id}`;
        const devAvailTopic = `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/availability`;

        const hwDev = {
            identifiers: [`tanoclo_dev_${serial}`],
            name: dev.friendly_name ? `${dev.friendly_name} (${shortSerial})` : `${deviceType} (${shortSerial})`,
            manufacturer: 'TaNoClo (Tado)',
            model: deviceType,
            sw_version: dev.current_fw_version,
            via_device: viaDevId
        };

        // Connection Sensor
        publishEntity('binary_sensor', `tanoclo_${serial}_connection`, {
            unique_id: `tanoclo_${serial}_connection`,
            name: 'Connection',
            state_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/connection_state`,
            device_class: 'connectivity',
            value_template: '{{ value }}',
            availability_topic: devAvailTopic,
            device: hwDev
        });

        // Firmware Sensor
        publishEntity('sensor', `tanoclo_${serial}_firmware`, {
            unique_id: `tanoclo_${serial}_firmware`,
            name: 'Firmware',
            state_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/firmware_version`,
            icon: 'mdi:chip',
            availability_topic: devAvailTopic,
            device: hwDev
        });

        // Reset Reason
        publishEntity('sensor', `tanoclo_${serial}_reset_reason`, {
            unique_id: `tanoclo_${serial}_reset_reason`,
            name: 'Reset Reason',
            state_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/reset_reason`,
            icon: 'mdi:restart',
            availability_topic: devAvailTopic,
            device: hwDev
        });

        // Error Flags
        publishEntity('sensor', `tanoclo_${serial}_error_flags`, {
            unique_id: `tanoclo_${serial}_error_flags`,
            name: 'Error Flags',
            state_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/error_flags`,
            icon: 'mdi:alert-circle-outline',
            availability_topic: devAvailTopic,
            device: hwDev
        });

        if (isVA || isRU) {
            // Battery level
            publishEntity('sensor', `tanoclo_${serial}_battery_level`, {
                unique_id: `tanoclo_${serial}_battery_level`,
                name: 'Battery Level',
                state_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/battery_percent`,
                device_class: 'battery',
                unit_of_measurement: '%',
                state_class: 'measurement',
                availability_topic: devAvailTopic,
                device: hwDev
            });

            // Battery voltage
            publishEntity('sensor', `tanoclo_${serial}_battery_mv`, {
                unique_id: `tanoclo_${serial}_battery_mv`,
                name: 'Battery Voltage',
                state_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/battery_mv`,
                device_class: 'voltage',
                unit_of_measurement: 'V',
                state_class: 'measurement',
                availability_topic: devAvailTopic,
                device: hwDev
            });

            // Battery binary sensor
            publishEntity('binary_sensor', `tanoclo_${serial}_battery`, {
                unique_id: `tanoclo_${serial}_battery`,
                name: 'Battery Status',
                state_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/battery_state`,
                device_class: 'battery',
                value_template: "{% if value == 'LOW' or value == 'CRITICAL' or value == 'DEPLETED' %}ON{% else %}OFF{% endif %}",
                availability_topic: devAvailTopic,
                device: hwDev
            });

            // Temperature
            publishEntity('sensor', `tanoclo_${serial}_temperature`, {
                unique_id: `tanoclo_${serial}_temperature`,
                name: 'Temperature',
                state_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/temperature`,
                device_class: 'temperature',
                unit_of_measurement: '°C',
                state_class: 'measurement',
                availability_topic: devAvailTopic,
                device: hwDev
            });

            // Aux Temperature
            publishEntity('sensor', `tanoclo_${serial}_aux_temperature`, {
                unique_id: `tanoclo_${serial}_aux_temperature`,
                name: 'Aux Temperature',
                state_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/aux_temperature`,
                device_class: 'temperature',
                unit_of_measurement: '°C',
                state_class: 'measurement',
                availability_topic: devAvailTopic,
                device: hwDev
            });

            // Humidity
            publishEntity('sensor', `tanoclo_${serial}_humidity`, {
                unique_id: `tanoclo_${serial}_humidity`,
                name: 'Humidity',
                state_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/humidity`,
                device_class: 'humidity',
                unit_of_measurement: '%',
                state_class: 'measurement',
                availability_topic: devAvailTopic,
                device: hwDev
            });

            // Light Level
            publishEntity('sensor', `tanoclo_${serial}_light_level`, {
                unique_id: `tanoclo_${serial}_light_level`,
                name: 'Light Level',
                state_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/light_level`,
                icon: 'mdi:brightness-5',
                state_class: 'measurement',
                availability_topic: devAvailTopic,
                device: hwDev
            });

            if (deviceType && deviceType.startsWith('RU')) {
                // OpenTherm Voltage
                publishEntity('sensor', `tanoclo_${serial}_opentherm_voltage`, {
                    unique_id: `tanoclo_${serial}_opentherm_voltage`,
                    name: 'OpenTherm Voltage',
                    state_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/opentherm_voltage`,
                    device_class: 'voltage',
                    unit_of_measurement: 'V',
                    state_class: 'measurement',
                    availability_topic: devAvailTopic,
                    device: hwDev
                });
            }
        }

        if (isVA) {
            // Valve position
            publishEntity('sensor', `tanoclo_${serial}_valve_position`, {
                unique_id: `tanoclo_${serial}_valve_position`,
                name: 'Valve Position',
                state_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/valve_position_pct`,
                unit_of_measurement: '%',
                icon: 'mdi:valve',
                state_class: 'measurement',
                availability_topic: devAvailTopic,
                device: hwDev
            });

            // Actuator Deviation
            publishEntity('sensor', `tanoclo_${serial}_actuator_deviation`, {
                unique_id: `tanoclo_${serial}_actuator_deviation`,
                name: 'Actuator Deviation',
                state_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/actuator_deviation`,
                unit_of_measurement: 'steps',
                icon: 'mdi:arrow-expand-horizontal',
                state_class: 'measurement',
                availability_topic: devAvailTopic,
                device: hwDev
            });

            // Valve Raw Steps
            publishEntity('sensor', `tanoclo_${serial}_valve_raw_steps`, {
                unique_id: `tanoclo_${serial}_valve_raw_steps`,
                name: 'Raw Steps',
                state_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/valve_position`,
                unit_of_measurement: 'steps',
                icon: 'mdi:stepper-motor',
                state_class: 'measurement',
                availability_topic: devAvailTopic,
                device: hwDev
            });

            // Actuator Active
            publishEntity('binary_sensor', `tanoclo_${serial}_actuator`, {
                unique_id: `tanoclo_${serial}_actuator`,
                name: 'Actuator Active',
                state_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/actuator_active`,
                payload_on: 'ON',
                payload_off: 'OFF',
                availability_topic: devAvailTopic,
                device: hwDev
            });

            // Mounting State
            publishEntity('sensor', `tanoclo_${serial}_mounting`, {
                unique_id: `tanoclo_${serial}_mounting`,
                name: 'Mounting State',
                state_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/mounting_state`,
                availability_topic: devAvailTopic,
                device: hwDev
            });

            // Child lock switch
            publishEntity('switch', `tanoclo_${serial}_child_lock`, {
                unique_id: `tanoclo_${serial}_child_lock`,
                name: 'Child Lock',
                state_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/child_lock`,
                command_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/set/child_lock`,
                payload_on: 'ON',
                payload_off: 'OFF',
                entity_category: 'config',
                availability_topic: devAvailTopic,
                device: hwDev
            });

            // Actuator Low Steps Number
            publishEntity('number', `tanoclo_${serial}_actuator_limit_low`, {
                unique_id: `tanoclo_${serial}_actuator_limit_low`,
                name: 'Actuator Low Steps',
                state_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/actuator_limit_low`,
                command_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/set/actuator_limit_low`,
                min: 0,
                max: 5000,
                step: 1,
                mode: 'box',
                entity_category: 'config',
                availability_topic: devAvailTopic,
                device: hwDev
            });

            // Actuator High Steps Number
            publishEntity('number', `tanoclo_${serial}_actuator_limit_high`, {
                unique_id: `tanoclo_${serial}_actuator_limit_high`,
                name: 'Actuator High Steps',
                state_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/actuator_limit_high`,
                command_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/set/actuator_limit_high`,
                min: 0,
                max: 5000,
                step: 1,
                mode: 'box',
                entity_category: 'config',
                availability_topic: devAvailTopic,
                device: hwDev
            });

            // Actuator Drive Constant Number
            publishEntity('number', `tanoclo_${serial}_actuator_drive_constant`, {
                unique_id: `tanoclo_${serial}_actuator_drive_constant`,
                name: 'Actuator Drive Constant',
                state_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/actuator_drive_constant`,
                command_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/set/actuator_drive_constant`,
                min: 0,
                max: 5000,
                step: 1,
                mode: 'box',
                entity_category: 'config',
                availability_topic: devAvailTopic,
                device: hwDev
            });

            // Apply Actuator Limits Button
            publishEntity('button', `tanoclo_${serial}_actuator_limits_apply`, {
                unique_id: `tanoclo_${serial}_actuator_limits_apply`,
                name: 'Apply Actuator Limits',
                command_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/set/actuator_limits_apply`,
                payload_press: 'PRESS',
                entity_category: 'config',
                availability_topic: devAvailTopic,
                device: hwDev
            });
        }

        // Identify Button (for devices supporting it based on database column)
        if (dev.cap_identify !== 0) {
            publishEntity('button', `tanoclo_${serial}_identify`, {
                unique_id: `tanoclo_${serial}_identify`,
                name: 'Identify',
                command_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/set/identify`,
                payload_press: 'PRESS',
                entity_category: 'config',
                availability_topic: devAvailTopic,
                device: hwDev
            });
        } else {
            publishEntity('button', `tanoclo_${serial}_identify`, null);
        }

        // Display Orientation Select (for VA02 devices supporting it)
        if (deviceType === 'VA02') {
            publishEntity('select', `tanoclo_${serial}_orientation`, {
                unique_id: `tanoclo_${serial}_orientation`,
                name: 'Display Orientation',
                state_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/orientation`,
                command_topic: `tado/tanoclo/h/${dev.home_id}/d/${shortSerial}/set/orientation`,
                options: ['VERTICAL', 'HORIZONTAL'],
                entity_category: 'config',
                availability_topic: devAvailTopic,
                device: hwDev
            });
        } else {
            publishEntity('select', `tanoclo_${serial}_orientation`, null);
        }
    }
}

module.exports = { buildDeviceDiscovery };
