/**
 * @file test/test_classify_path.test.js
 * @brief Vitest testing suite validating server modules.
 */

'use strict';

const assert = require('assert');
const handlers = require('../lib/handlers');



test('legacy test suite runs successfully', async () => {
  console.log('Running path classification tests...');
  
  // Mock dependencies
  const dbMock = {
      getZoneForDevice: async (deviceId) => {
          if (deviceId === 'IB_MOCK_DEV') {
              return { zoneId: 5, homeId: 456 };
          }
          return null;
      },
      getHomeForDevice: async (deviceId) => {
          if (deviceId === 'IB_MOCK_DEV') {
              return 456;
          }
          return null;
      }
  };
  
  handlers.init({
      db: dbMock,
      extractShortSerial: (id) => id
  });
  
  async function test() {
      // 1. Simple routes
      const sensor = await handlers.classifyPath('/d/IB123/sen', [], 'IB_ACTIVE');
      assert.deepStrictEqual(sensor, { type: 'device_sensor', deviceId: 'IB123', homeId: null });
  
      const info = await handlers.classifyPath('/d/IB123/info', [], 'IB_ACTIVE');
      assert.deepStrictEqual(info, { type: 'device_info', deviceId: 'IB123', homeId: null });
  
      const dbg = await handlers.classifyPath('/d/IB123/dbg', [], 'IB_ACTIVE');
      assert.deepStrictEqual(dbg, { type: 'device_debug', deviceId: 'IB123', homeId: null });
  
      const dbg2 = await handlers.classifyPath('/d/IB123/dbg2', [], 'IB_ACTIVE');
      assert.deepStrictEqual(dbg2, { type: 'device_debug', deviceId: 'IB123', homeId: null });
  
      const dispsettings = await handlers.classifyPath('/d/IB123/dispsettings', [], 'IB_ACTIVE');
      assert.deepStrictEqual(dispsettings, { type: 'device_dispsettings', deviceId: 'IB123', homeId: null });
  
      const err = await handlers.classifyPath('/d/IB123/err', [], 'IB_ACTIVE');
      assert.deepStrictEqual(err, { type: 'device_error', deviceId: 'IB123', homeId: null });
  
      const mnt = await handlers.classifyPath('/d/IB123/mnt', [], 'IB_ACTIVE');
      assert.deepStrictEqual(mnt, { type: 'mount', deviceId: 'IB123', homeId: null });
  
      const neighbors = await handlers.classifyPath('/d/IB123/neighbors', [], 'IB_ACTIVE');
      assert.deepStrictEqual(neighbors, { type: 'neighbors', deviceId: 'IB123', homeId: null });
  
      const selftest = await handlers.classifyPath('/d/IB123/selftest', [], 'IB_ACTIVE');
      assert.deepStrictEqual(selftest, { type: 'selftest', deviceId: 'IB123', homeId: null });
  
      const rfkey = await handlers.classifyPath('/d/IB123/rfkey', [], 'IB_ACTIVE');
      assert.deepStrictEqual(rfkey, { type: 'rfkey', deviceId: 'IB123', homeId: null });
  
      const lock = await handlers.classifyPath('/d/IB123/lock', [], 'IB_ACTIVE');
      assert.deepStrictEqual(lock, { type: 'lock', deviceId: 'IB123', homeId: null });

      const reboot = await handlers.classifyPath('/d/IB123/reboot', [], 'IB_ACTIVE');
      assert.deepStrictEqual(reboot, { type: 'device_reboot', deviceId: 'IB123', homeId: null });
  
      const time = await handlers.classifyPath('/time', [], 'IB_ACTIVE');
      assert.deepStrictEqual(time, { type: 'time', deviceId: 'IB_ACTIVE' });
  
      const pair = await handlers.classifyPath('/pair', [], 'IB_ACTIVE');
      assert.deepStrictEqual(pair, { type: 'pair', deviceId: 'IB_ACTIVE' });
  
      const identify = await handlers.classifyPath('/identify', [], 'IB_ACTIVE');
      assert.deepStrictEqual(identify, { type: 'identify', deviceId: 'IB_ACTIVE' });
  
      const extui = await handlers.classifyPath('/h/123/z/1/extui', [], 'IB_ACTIVE');
      assert.deepStrictEqual(extui, { type: 'zone_extui', zoneId: 1, homeId: '123', deviceId: 'IB_ACTIVE' });
  
      const ov = await handlers.classifyPath('/h/123/z/1/ov', [], 'IB_ACTIVE');
      assert.deepStrictEqual(ov, { type: 'zone_overlay', zoneId: 1, homeId: '123', deviceId: 'IB_ACTIVE' });
  
      const params = await handlers.classifyPath('/h/123/z/1/p', [], 'IB_ACTIVE');
      assert.deepStrictEqual(params, { type: 'zone_params', zoneId: 1, homeId: '123', deviceId: 'IB_ACTIVE' });
  
      const ow = await handlers.classifyPath('/h/123/z/1/ow', [], 'IB_ACTIVE');
      assert.deepStrictEqual(ow, { type: 'open_window', zoneId: 1, homeId: '123', deviceId: 'IB_ACTIVE' });
  
      // 2. Complex routes
      // Auth key / token
      const authKey = await handlers.classifyPath('/d/IB123/auth/key', [], 'IB_ACTIVE');
      assert.deepStrictEqual(authKey, { type: 'auth_key', deviceId: 'IB123', homeId: null });
  
      const authToken = await handlers.classifyPath('/d/IB123/auth/token', [], 'IB_ACTIVE');
      assert.deepStrictEqual(authToken, { type: 'auth_token', deviceId: 'IB123', homeId: null });
  
      // Actuators
      const circuitAct = await handlers.classifyPath('/h/123/c/1/act', [], 'IB_ACTIVE');
      assert.deepStrictEqual(circuitAct, { type: 'circuit_actuator', circuitId: '1', homeId: '123', deviceId: 'IB_ACTIVE' });
  
      const deviceAct = await handlers.classifyPath('/h/123/d/IB123/act', [], 'IB_ACTIVE');
      assert.deepStrictEqual(deviceAct, { type: 'device_actuator', deviceId: 'IB123', homeId: '123' });
  
      const zoneAct = await handlers.classifyPath('/h/123/z/1/act', [], 'IB_ACTIVE');
      assert.deepStrictEqual(zoneAct, { type: 'zone_actuator', zoneId: '1', homeId: '123', deviceId: 'IB_ACTIVE' });
  
      // Configs
      const deviceConfig = await handlers.classifyPath('/h/123/d/IB123/config', [], 'IB_ACTIVE');
      assert.deepStrictEqual(deviceConfig, { type: 'device_config', deviceId: 'IB123', homeId: '123' });
  
      const circuitConfig = await handlers.classifyPath('/h/123/c/1/config', [], 'IB_ACTIVE');
      assert.deepStrictEqual(circuitConfig, { type: 'circuit_config', circuitId: '1', homeId: '123', deviceId: 'IB_ACTIVE' });
  
      const zoneConfig = await handlers.classifyPath('/h/123/z/1/config', [], 'IB_ACTIVE');
      assert.deepStrictEqual(zoneConfig, { type: 'zone_config', zoneId: '1', homeId: '123', deviceId: 'IB_ACTIVE' });
  
      const hvacConfig = await handlers.classifyPath('/h/123/hvac/config', [], 'IB_ACTIVE');
      assert.deepStrictEqual(hvacConfig, { type: 'hvac_config', homeId: '123', deviceId: 'IB_ACTIVE' });
  
      // FW State
      const fwState = await handlers.classifyPath('/h/123/d/IB123/fw/state', [], 'IB_ACTIVE');
      assert.deepStrictEqual(fwState, { type: 'firmware_state', deviceId: 'IB123', homeId: '123' });
  
      // Fallbacks
      const zoneFallback = await handlers.classifyPath('/h/123/z/1/fallback', [], 'IB_ACTIVE');
      assert.deepStrictEqual(zoneFallback, { type: 'zone_fallback', zoneId: '1', homeId: '123', deviceId: 'IB_ACTIVE' });
  
      const deviceFallback = await handlers.classifyPath('/h/123/d/IB123/fallback', [], 'IB_ACTIVE');
      assert.deepStrictEqual(deviceFallback, { type: 'device_fallback', deviceId: 'IB123', homeId: '123' });
  
      // Zone state
      const zoneState = await handlers.classifyPath('/h/123/z/1/s', [], 'IB_ACTIVE');
      assert.deepStrictEqual(zoneState, { type: 'zone_state', zoneId: 1, homeId: '123', deviceId: 'IB_ACTIVE' });
  
      // Overlay
      const zoneOverlay = await handlers.classifyPath('/h/123/z/overlay', ['id=4'], 'IB_ACTIVE');
      assert.deepStrictEqual(zoneOverlay, { type: 'zone_overlay', zoneId: 4, homeId: '123', deviceId: 'IB_ACTIVE' });
  
      // HVAC monitoring
      const hvacMon = await handlers.classifyPath('/h/123/hvac/mon', [], 'IB_ACTIVE');
      assert.deepStrictEqual(hvacMon, { type: 'hvac_mon', homeId: '123', deviceId: 'IB_ACTIVE' });
  
      const hvacDhw = await handlers.classifyPath('/h/123/hvac/dhw', [], 'IB_ACTIVE');
      assert.deepStrictEqual(hvacDhw, { type: 'hvac_dhw', homeId: '123', deviceId: 'IB_ACTIVE' });
  
      // 3. Fallback homeId inference
      const deviceOnly = await handlers.classifyPath('/d/IB_MOCK_DEV/info', [], null);
      assert.deepStrictEqual(deviceOnly, { type: 'device_info', deviceId: 'IB_MOCK_DEV', homeId: '456' });
  
      console.log('\x1b[32m✔ All path classification tests passed!\x1b[0m');
  
      // process.exit(0);
  }
  
  await test();

});