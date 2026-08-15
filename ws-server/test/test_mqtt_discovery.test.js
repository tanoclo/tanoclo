/**
 * @file test/test_mqtt_discovery.test.js
 * @brief Vitest testing suite validating server modules.
 */

'use strict';

/**
 * Unit Tests for lib/mqtt-ha-discovery.js
 *
 * Run: node test/test_mqtt_discovery.js
 */

const mqttHaDiscovery = require('../lib/mqtt-ha-discovery');



test('legacy test suite runs successfully', async () => {
  let passed = 0;
  let failed = 0;
  
  function test(name, condition, detail = '') {
      if (condition) { passed++; console.log(`  ✓ ${name}`); }
      else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
  }
  function section(title) { console.log(`\n══ ${title} ══`); }
  
  // Mock objects
  const publishedConfigs = [];
  
  const mockMqttClient = {
      publish(topic, payload, opts) {
          if (payload) {
              publishedConfigs.push({ topic, payload: JSON.parse(payload), opts });
          } else {
              publishedConfigs.push({ topic, payload: '', opts });
          }
      }
  };
  
  const mockLog = Object.assign(
      (level, ...args) => {},
      {
          info() {},
          error() {},
          debug() {},
          warn() {}
      }
  );
  
  const mockConfig = {
      mqtt: {
          haDiscovery: true,
          haPath: 'homeassistant'
      }
  };
  
  const mockDb = {
      getPool() {
          return {
              async execute(query) {
                  if (query.includes('FROM homes')) {
                      return [[{ id: 1, name: 'My Home' }]];
                  }
                  if (query.includes('FROM zones')) {
                      return [[
                          { id: 10, home_id: 1, name: 'Living Room', type: 'HEATING', early_start_enabled: 1 },
                          { id: 0, home_id: 1, name: 'Warm Water', type: 'HOT_WATER', early_start_enabled: 0 }
                      ]];
                  }
                  if (query.includes('FROM devices')) {
                      return [[
                          {
                              serial_no: 'VA1234567890',
                              device_type: 'VA02',
                              home_id: 1,
                              zone_id: 10,
                              current_fw_version: '92.1',
                              connection_state: 1,
                              child_lock_enabled: 0
                          },
                          {
                              serial_no: 'RU1234567890',
                              device_type: 'RU02',
                              home_id: 1,
                              zone_id: 10,
                              current_fw_version: '92.1',
                              connection_state: 1,
                              child_lock_enabled: 0
                          }
                      ]];
                  }
                  if (query.includes('FROM heating_circuits')) {
                      return [[{ home_id: 1, number: 1, field_4000: 20.0, field_4040: 19.5, field_4080: 30 }]];
                  }
                  if (query.includes('FROM heating_systems')) {
                      return [[{ home_id: 1, field_044c: 60.0, field_044d: 50.0 }]];
                  }
                  return [[]];
              }
          };
      }
  };
  
  // ═══════════════════════════════════════════
  // 1. HA Discovery Entity Generation
  // ═══════════════════════════════════════════
  section('1. HA Discovery Entity Generation');
  
  mqttHaDiscovery.init(mockMqttClient, mockDb, mockConfig, mockLog);
  
  (async () => {
      publishedConfigs.length = 0;
      await mqttHaDiscovery.publishAllDiscovery();
  
      test('Discovery entities were published', publishedConfigs.length > 0);
  
      // Climate entity verification
      const climateEntity = publishedConfigs.find(c => c.topic.includes('climate/tanoclo_h1_z10_climate'));
      test('Climate entity discovered', !!climateEntity);
      if (climateEntity) {
          test('Climate target temp command topic matches home-scoped path', climateEntity.payload.temperature_command_topic === 'tado/tanoclo/h/1/z/10/set/target_temperature');
          test('Climate target temp state topic matches home-scoped path', climateEntity.payload.temperature_state_topic === 'tado/tanoclo/h/1/z/10/target_temperature');
          test('Climate preset command topic matches zone-scoped path', climateEntity.payload.preset_mode_command_topic === 'tado/tanoclo/h/1/z/10/set/preset_mode');
          test('Climate preset modes are SCHEDULE, TIMER, NEXT_BLOCK, MANUAL', Array.isArray(climateEntity.payload.preset_modes) && climateEntity.payload.preset_modes.join(',') === 'SCHEDULE,TIMER,NEXT_BLOCK,MANUAL');
          test('Climate modes are auto, heat, off', Array.isArray(climateEntity.payload.modes) && climateEntity.payload.modes.join(',') === 'auto,heat,off');
      }

      // Home presence entities verification
      const homePresenceSelect = publishedConfigs.find(c => c.topic.includes('select/tanoclo_h1_presence'));
      test('Home presence select entity discovered', !!homePresenceSelect);
      if (homePresenceSelect) {
          test('Home presence select options are AUTO, HOME, AWAY', Array.isArray(homePresenceSelect.payload.options) && homePresenceSelect.payload.options.join(',') === 'AUTO,HOME,AWAY');
      }

      const homePresenceSensor = publishedConfigs.find(c => c.topic.includes('sensor/tanoclo_h1_presence_mode'));
      test('Home presence mode sensor entity discovered', !!homePresenceSensor);
  
      // DHW Climate entity verification (HOT_WATER)
      const dhwClimateEntity = publishedConfigs.find(c => c.topic.includes('climate/tanoclo_h1_z0_climate'));
      test('DHW climate entity discovered', !!dhwClimateEntity);
      if (dhwClimateEntity) {
          test('DHW climate does NOT contain current_temperature_topic', !dhwClimateEntity.payload.current_temperature_topic);
          test('DHW climate target temp command topic matches zone-scoped path', dhwClimateEntity.payload.temperature_command_topic === 'tado/tanoclo/h/1/z/0/set/target_temperature');
          test('DHW climate preset modes are SCHEDULE, TIMER, NEXT_BLOCK, MANUAL', Array.isArray(dhwClimateEntity.payload.preset_modes) && dhwClimateEntity.payload.preset_modes.join(',') === 'SCHEDULE,TIMER,NEXT_BLOCK,MANUAL');
      }
  
      // ═══════════════════════════════════════════
      // 2. Device Hierarchy (via_device)
      // ═══════════════════════════════════════════
      section('2. Device Hierarchy (via_device)');
  
      if (climateEntity) {
          test('Zone climate device lists home as via_device', climateEntity.payload.device.via_device === 'tanoclo_home_1');
      }
  
      const hardwareDevEntity = publishedConfigs.find(c => c.topic.includes('binary_sensor/tanoclo_VA1234567890_connection'));
      test('Hardware device entity discovered', !!hardwareDevEntity);
      if (hardwareDevEntity) {
          test('Hardware device lists zone as via_device', hardwareDevEntity.payload.device.via_device === 'tanoclo_h1_z10');
          test('Hardware device details match', hardwareDevEntity.payload.device.model === 'VA02' && hardwareDevEntity.payload.device.sw_version === '92.1');
      }
  
      const batteryMvEntity = publishedConfigs.find(c => c.topic.includes('sensor/tanoclo_VA1234567890_battery_mv'));
      test('Battery voltage entity discovered', !!batteryMvEntity);
      if (batteryMvEntity) {
          test('Battery voltage unit is V', batteryMvEntity.payload.unit_of_measurement === 'V');
          test('Battery voltage device_class is voltage', batteryMvEntity.payload.device_class === 'voltage');
          test('Battery voltage state topic is home-scoped', batteryMvEntity.payload.state_topic === 'tado/tanoclo/h/1/d/VA1234567890/battery_mv');
      }
  
      const resetReasonEntity = publishedConfigs.find(c => c.topic.includes('sensor/tanoclo_VA1234567890_reset_reason'));
      test('Reset reason entity discovered', !!resetReasonEntity);
      if (resetReasonEntity) {
          test('Reset reason icon is mdi:restart', resetReasonEntity.payload.icon === 'mdi:restart');
          test('Reset reason state topic is correct', resetReasonEntity.payload.state_topic === 'tado/tanoclo/h/1/d/VA1234567890/reset_reason');
      }
  
      const errorFlagsEntity = publishedConfigs.find(c => c.topic.includes('sensor/tanoclo_VA1234567890_error_flags'));
      test('Error flags entity discovered', !!errorFlagsEntity);
      if (errorFlagsEntity) {
          test('Error flags icon is mdi:alert-circle-outline', errorFlagsEntity.payload.icon === 'mdi:alert-circle-outline');
          test('Error flags state topic is correct', errorFlagsEntity.payload.state_topic === 'tado/tanoclo/h/1/d/VA1234567890/error_flags');
      }
  
      const actDevEntity = publishedConfigs.find(c => c.topic.includes('sensor/tanoclo_VA1234567890_actuator_deviation'));
      test('Actuator deviation entity discovered', !!actDevEntity);
      if (actDevEntity) {
          test('Actuator deviation unit is steps', actDevEntity.payload.unit_of_measurement === 'steps');
          test('Actuator deviation icon is mdi:arrow-expand-horizontal', actDevEntity.payload.icon === 'mdi:arrow-expand-horizontal');
          test('Actuator deviation state topic is correct', actDevEntity.payload.state_topic === 'tado/tanoclo/h/1/d/VA1234567890/actuator_deviation');
      }
  
      const otVoltEntity = publishedConfigs.find(c => c.topic.includes('sensor/tanoclo_RU1234567890_opentherm_voltage'));
      test('OpenTherm voltage entity discovered for RU', !!otVoltEntity);
      if (otVoltEntity) {
          test('OpenTherm voltage unit is V', otVoltEntity.payload.unit_of_measurement === 'V');
          test('OpenTherm voltage device_class is voltage', otVoltEntity.payload.device_class === 'voltage');
          test('OpenTherm voltage state topic is correct', otVoltEntity.payload.state_topic === 'tado/tanoclo/h/1/d/RU1234567890/opentherm_voltage');
      }
  
      const vaOtVoltEntity = publishedConfigs.find(c => c.topic.includes('sensor/tanoclo_VA1234567890_opentherm_voltage'));
      test('OpenTherm voltage entity NOT discovered for VA', !vaOtVoltEntity);
  
      // ═══════════════════════════════════════════
      // 3. Circuits
      // ═══════════════════════════════════════════
      section('3. Circuits');
      const circuitTargetEntity = publishedConfigs.find(c => c.topic.includes('sensor/tanoclo_circuit_1_1_target'));
      test('Circuit target temperature sensor discovered', !!circuitTargetEntity);
      if (circuitTargetEntity) {
          test('Circuit state topic is home-scoped and clean', circuitTargetEntity.payload.state_topic === 'tado/tanoclo/h/1/c/1/target_temperature');
      }
  
      // ═══════════════════════════════════════════
      // Summary
      // ═══════════════════════════════════════════
      section('RESULTS');
      const total = passed + failed;
      console.log(`  Total: ${total} | Passed: ${passed} | Failed: ${failed}`);
      console.log(`  ${failed === 0 ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'}\n`);
      if (failed > 0) throw new Error('Some tests failed');
  })();
  
});