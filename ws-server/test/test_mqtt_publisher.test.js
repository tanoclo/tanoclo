/**
 * @file test/test_mqtt_publisher.test.js
 * @brief Vitest testing suite validating server modules.
 */

'use strict';

/**
 * Unit Tests for lib/mqtt-publisher.js
 *
 * Run: node test/test_mqtt_publisher.js
 */

const mqttPublisher = require('../lib/mqtt-publisher');
const battery = require('../lib/battery');



test('legacy test suite runs successfully', async () => {
  let passed = 0;
  let failed = 0;
  
  function test(name, condition, detail = '') {
      if (condition) { passed++; console.log(`  ✓ ${name}`); }
      else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
  }
  function section(title) { console.log(`\n══ ${title} ══`); }
  
  // Mock objects
  const publishedMessages = [];
  
  const mockMqttClient = {
      publish(topic, payload, opts) {
          publishedMessages.push({ topic, payload, opts });
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
      logLevel: 'debug'
  };
  
  const mockDb = {
      getPool() {
          return {
              execute() {
                  return Promise.resolve([[]]);
              }
          };
      },
      getZoneType(homeId, zoneId) {
          return Promise.resolve(zoneId === 0 ? 'HOT_WATER' : 'HEATING');
      }
  };
  
  // ═══════════════════════════════════════════
  // 1. Initialization and Batching
  // ═══════════════════════════════════════════
  section('1. Initialization & Batching');
  
  mqttPublisher.init(mockMqttClient, mockDb, mockConfig, mockLog);
  
  // Let's test publishZoneTelemetry
  publishedMessages.length = 0;
  mqttPublisher.publishZoneTelemetry(1, 10, {
      field_012d: 21.5,
      field_0135: 45.2,
      field_40a0: 60
  });
  
  // Since the publisher uses process.nextTick() for batching, we need to wait
  setTimeout(() => {
      test('Published 3 main telemetry topics for Zone under home-scoped path', publishedMessages.length >= 3);
      
      const tempMsg = publishedMessages.find(m => m.topic === 'tado/tanoclo/h/1/z/10/temperature');
      test('Zone temperature value matches', tempMsg && tempMsg.payload === '21.5');
  
      const debugTempMsg = publishedMessages.find(m => m.topic === 'tado/tanoclo_debug/h/1/z/10/field_012d');
      test('Debug topic published under home-scoped path', debugTempMsg && debugTempMsg.payload === '21.5');
  
      // ═══════════════════════════════════════════
      // 2. Gated Debug Topics
      // ═══════════════════════════════════════════
      section('2. Gated Debug Topics');
      
      mockConfig.logLevel = 'info';
      publishedMessages.length = 0;
      mqttPublisher.publishZoneTelemetry(1, 10, {
          field_012d: 22.0,
          field_0135: 40.0,
          field_40a0: 0
      });
  
      setTimeout(() => {
          const tempMsgInfo = publishedMessages.find(m => m.topic === 'tado/tanoclo/h/1/z/10/temperature');
          test('Normal topic published when logLevel is info', tempMsgInfo && tempMsgInfo.payload === '22');
          
          const debugTempMsgInfo = publishedMessages.find(m => m.topic === 'tado/tanoclo_debug/h/1/z/10/field_012d');
          test('Debug topic NOT published when logLevel is info', !debugTempMsgInfo);
  
          // Reset config
          mockConfig.logLevel = 'debug';
  
          // ═══════════════════════════════════════════
          // 3. Valve Position Percentage Calculation
          // ═══════════════════════════════════════════
          section('3. Valve Position Percentage Calculation');
          
          publishedMessages.length = 0;
          mqttPublisher.publishDeviceTelemetry('VA001', 1, 10, { field_0162: 2650 }, {
              serial_no: 'VA001',
              home_id: 1,
              device_type: 'VA02',
              field_0265: 2300, // current
              field_0273: 2500, // limitLow (closed)
              field_027c: 2100, // limitHigh (open)
              connection_state: 1
          });
  
          setTimeout(() => {
              const valvePctMsg = publishedMessages.find(m => m.topic === 'tado/tanoclo/h/1/d/VA001/valve_position_pct');
              test('Valve percentage matches calculation', valvePctMsg && valvePctMsg.payload === '50');
  
              const batteryMvMsg = publishedMessages.find(m => m.topic === 'tado/tanoclo/h/1/d/VA001/battery_mv');
              test('Battery voltage published in volts with 3 decimals (2650 -> 2.650)', batteryMvMsg && batteryMvMsg.payload === '2.650');
  
              // ═══════════════════════════════════════════
              // 4. HVAC Telemetry Scaling
              // ═══════════════════════════════════════════
              section('4. HVAC Telemetry Scaling');
              
              publishedMessages.length = 0;
              mqttPublisher.publishHvacTelemetry(1, {
                  field_044c: 65.5,
                  field_0460: 1500, // water pressure in millibar
                  field_0466: 2     // burner starts/hours in hours (already scaled)
              });
  
              setTimeout(() => {
                  const pressMsg = publishedMessages.find(m => m.topic === 'tado/tanoclo/h/1/boiler/water_pressure_bar');
                  test('Water pressure scaled from millibar to bar (1500 -> 1.5)', pressMsg && pressMsg.payload === '1.5');
  
                  const hoursMsg = publishedMessages.find(m => m.topic === 'tado/tanoclo/h/1/boiler/burner_hours');
                  test('Burner hours matches (2 -> 2)', hoursMsg && hoursMsg.payload === '2');
  
                  // ═══════════════════════════════════════════
                  // 5. DHW / HOT_WATER Telemetry & Open Window Suppression
                  // ═══════════════════════════════════════════
                  section('5. DHW / HOT_WATER Telemetry Suppression');
  
                  publishedMessages.length = 0;
                  // Zone 0 is mocked as HOT_WATER
                  mqttPublisher.publishZoneTelemetry(1, 0, {
                      field_012d: 22.0,
                      field_0135: 40.0,
                      field_40a0: 50
                  });
  
                  mqttPublisher.publishZoneStateTelemetry(1, 0, {
                      field_6240: 0,
                      open_window_detected: 1
                  });
  
                  setTimeout(() => {
                      const dhwTempMsg = publishedMessages.find(m => m.topic === 'tado/tanoclo/h/1/z/0/temperature');
                      test('DHW zone: temperature suppressed', !dhwTempMsg);
  
                      const dhwHumMsg = publishedMessages.find(m => m.topic === 'tado/tanoclo/h/1/z/0/humidity');
                      test('DHW zone: humidity suppressed', !dhwHumMsg);
  
                      const dhwPowerMsg = publishedMessages.find(m => m.topic === 'tado/tanoclo/h/1/z/0/heating_power');
                      test('DHW zone: heating_power suppressed', !dhwPowerMsg);
  
                      const dhwWindowMsg = publishedMessages.find(m => m.topic === 'tado/tanoclo/h/1/z/0/open_window');
                      test('DHW zone: open_window suppressed', !dhwWindowMsg);
  
                      // ═══════════════════════════════════════════
                      // 6. Overlay Temperature Clearing
                      // ═══════════════════════════════════════════
                      section('6. Overlay Temperature Clearing');
  
                      publishedMessages.length = 0;
                      // Test active overlay (mode > 0)
                      mqttPublisher.publishZoneStateTelemetry(1, 10, {
                          field_6240: 3, // MANUAL
                          field_6280: 21.0
                      });
  
                      // Test inactive overlay (mode == 0)
                      mqttPublisher.publishZoneStateTelemetry(1, 10, {
                          field_6240: 0, // SCHEDULE
                          field_6280: null
                      });
  
                      setTimeout(() => {
                          const activeOvrTemp = publishedMessages.find(m => m.topic === 'tado/tanoclo/h/1/z/10/overlay_temperature' && m.payload === '21');
                          test('Overlay temperature published when overlay is active', !!activeOvrTemp);
  
                          const inactiveOvrTemp = publishedMessages.find(m => m.topic === 'tado/tanoclo/h/1/z/10/overlay_temperature' && m.payload === '');
                          test('Overlay temperature cleared (empty payload) when overlay is inactive', !!inactiveOvrTemp);
  
                          // ═══════════════════════════════════════════
                          // Summary
                          // ═══════════════════════════════════════════
                          section('RESULTS');
                          const total = passed + failed;
                          console.log(`  Total: ${total} | Passed: ${passed} | Failed: ${failed}`);
                          console.log(`  ${failed === 0 ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'}\n`);
                          if (failed > 0) throw new Error('Some tests failed');
                      }, 50);
                  }, 50);
              }, 50);
          }, 50);
      }, 50);
  }, 50);
  
});