/**
 * @file test/test_mesh_recovery.test.js
 * @brief Vitest unit tests for 6LoWPAN / CoAP mesh recovery & keep-alive manager.
 */

'use strict';
require('./test_config');
const meshRecovery = require('../lib/mesh-recovery');
const coap = require('../lib/coap');

describe('mesh-recovery module', () => {
    let pushedCommands = [];
    let rebootedDevices = [];

    const TEST_HOME_ID = 999999;
    const TEST_ZONE_ID = 1;
    const TEST_VA_SERIAL = 'VA0000000001';
    const TEST_RU_SERIAL = 'RU0000000001';

    const mockDb = {
        getPool: () => ({
            execute: async (sql, params) => {
                if (sql.includes('FROM devices WHERE zone_id = ?')) {
                    return [[{ serial_no: TEST_VA_SERIAL, device_type: 'VA02' }]];
                }
                if (sql.includes('FROM zones WHERE id = ?')) {
                    return [[{ heating_circuit: 1 }]];
                }
                if (sql.includes('FROM heating_circuits WHERE home_id = ?')) {
                    return [[{ driver_serial_no: TEST_RU_SERIAL }]];
                }
                if (sql.includes('FROM devices d')) {
                    return [[
                        { serial_no: TEST_VA_SERIAL, device_type: 'VA02', last_contact: new Date(Date.now() - 15 * 60000).toISOString(), ipv6_address: 'fd00::1' },
                        { serial_no: TEST_RU_SERIAL, device_type: 'RU02', last_contact: new Date(Date.now() - 5 * 60000).toISOString(), ipv6_address: 'fd00::2' }
                    ]];
                }
                return [[]];
            }
        })
    };

    const mockCommandApi = {
        internalPushViabridge: async (deviceId, code, path, payload, etag, customOptions, skipVendor, type, token, commandLabel) => {
            pushedCommands.push({ deviceId, code, path, customOptions, type, commandLabel });
            return 0x1234;
        },
        pushDeviceReboot: async (deviceId) => {
            rebootedDevices.push(deviceId);
            return 0x5678;
        }
    };

    beforeEach(() => {
        pushedCommands = [];
        rebootedDevices = [];
        meshRecovery._activeFallbacks.clear();
        meshRecovery._deviceLinkLossMap.clear();
        meshRecovery.init(mockDb, mockCommandApi, mockCommandApi, () => {});
    });

    test('probeDevice transmits firmware-true CON GET /d/info with Option 17 (Accept: 42)', async () => {
        const mid = await meshRecovery.probeDevice(TEST_VA_SERIAL);
        expect(mid).toBe(0x1234);
        expect(pushedCommands.length).toBe(1);
        expect(pushedCommands[0].deviceId).toBe(TEST_VA_SERIAL);
        expect(pushedCommands[0].code).toBe(coap.CODE_GET);
        expect(pushedCommands[0].path).toBe('d/info');
        expect(pushedCommands[0].type).toBe(coap.TYPE_CON);
        expect(pushedCommands[0].customOptions).toEqual([{ num: 17, value: Buffer.from([0x2a]) }]);
    });

    test('onZoneFallback triggers NUD probe for zone devices and circuit driver', async () => {
        await meshRecovery.onZoneFallback(TEST_HOME_ID, TEST_ZONE_ID, 3);
        expect(pushedCommands.length).toBe(2);
        const probed = pushedCommands.map(p => p.deviceId);
        expect(probed).toContain(TEST_VA_SERIAL);
        expect(probed).toContain(TEST_RU_SERIAL);
    });

    test('onZoneFallback clears record when fallback reaches 0', async () => {
        const key = `${TEST_HOME_ID}:${TEST_ZONE_ID}`;
        await meshRecovery.onZoneFallback(TEST_HOME_ID, TEST_ZONE_ID, 3);
        expect(meshRecovery._activeFallbacks.has(key)).toBe(true);

        await meshRecovery.onZoneFallback(TEST_HOME_ID, TEST_ZONE_ID, 0);
        expect(meshRecovery._activeFallbacks.has(key)).toBe(false);
    });

    test('onDeviceError triggers probe on 0x80 link loss', async () => {
        await meshRecovery.onDeviceError(TEST_HOME_ID, TEST_VA_SERIAL, 0x80);
        expect(pushedCommands.length).toBe(1);
        expect(pushedCommands[0].deviceId).toBe(TEST_VA_SERIAL);
        expect(meshRecovery._deviceLinkLossMap.has(TEST_VA_SERIAL)).toBe(true);

        // Clears on 0
        await meshRecovery.onDeviceError(TEST_HOME_ID, TEST_VA_SERIAL, 0);
        expect(meshRecovery._deviceLinkLossMap.has(TEST_VA_SERIAL)).toBe(false);
    });

    test('checkFallbackEscalation escalates to reboot after 2 failed probes', async () => {
        const key = `${TEST_HOME_ID}:${TEST_ZONE_ID}`;
        await meshRecovery.onZoneFallback(TEST_HOME_ID, TEST_ZONE_ID, 3);
        const rec = meshRecovery._activeFallbacks.get(key);
        rec.probeAttempts = 2; // Simulate 2 probes failed

        await meshRecovery.checkFallbackEscalation();
        expect(rebootedDevices).toContain(TEST_VA_SERIAL);
    });

    test('runProactiveKeepAlive probes inactive devices > 12 minutes', async () => {
        await meshRecovery.runProactiveKeepAlive();
        expect(pushedCommands.length).toBe(1);
        expect(pushedCommands[0].deviceId).toBe(TEST_VA_SERIAL);
    });
});
