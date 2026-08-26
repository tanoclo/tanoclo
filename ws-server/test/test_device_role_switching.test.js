'use strict';
require('./test_config');

const dbBase = require('../lib/db-base');
const { mapDevice } = require('../lib/mappers');
const { getZoneBindingsForDevice } = require('../lib/db-zones/state');

describe('RU Device Role & Zone Bindings', () => {
    let mockDev = null;

    beforeEach(() => {
        mockDev = null;
        const p = dbBase.getPool();
        p.execute = vi.fn().mockImplementation(async (sql, params) => {
            if (sql.includes('FROM devices') && mockDev) {
                return [[mockDev]];
            }
            return [[]];
        });
    });

    it('mapDevice outputs field_015d and deviceRole correctly for Wired vs Wireless Sensor', () => {
        const wiredRu = {
            serial_no: 'RU1234567890',
            device_type: 'RU02',
            home_id: 1,
            field_015d: 71,
            is_emulated: 0
        };
        const mappedWired = mapDevice(wiredRu);
        expect(mappedWired.field_015d).toBe(71);
        expect(mappedWired.deviceRole).toBe('WIRED_THERMOSTAT');

        const wirelessRu = {
            serial_no: 'RU1234567890',
            device_type: 'RU02',
            home_id: 1,
            field_015d: 200,
            is_emulated: 0
        };
        const mappedWireless = mapDevice(wirelessRu);
        expect(mappedWireless.field_015d).toBe(200);
        expect(mappedWireless.deviceRole).toBe('WIRELESS_SENSOR');

        const emulatedRu = {
            serial_no: 'RU9999999999',
            device_type: 'RU02',
            home_id: 1,
            field_015d: null,
            is_emulated: 1
        };
        const mappedEmulated = mapDevice(emulatedRu);
        expect(mappedEmulated.field_015d).toBe(200);
        expect(mappedEmulated.deviceRole).toBe('WIRELESS_SENSOR');
        expect(mappedEmulated.isEmulated).toBe(true);
    });

    it('getZoneBindingsForDevice returns role 0x09 single pair for wireless sensor RU', async () => {
        mockDev = {
            serial_no: 'RU0000000001',
            device_type: 'RU02',
            home_id: 1,
            zone_id: 4,
            field_015d: 200,
            is_emulated: 0
        };

        const pairs = await getZoneBindingsForDevice('RU0000000001');
        expect(pairs).toEqual(['0904']);
    });

    it('getZoneBindingsForDevice returns role 0x09 for emulated RU even if field_015d is unset', async () => {
        mockDev = {
            serial_no: 'RU0000000002',
            device_type: 'RU02',
            home_id: 1,
            zone_id: 6,
            field_015d: null,
            is_emulated: 1
        };

        const pairs = await getZoneBindingsForDevice('RU0000000002');
        expect(pairs).toEqual(['0906']);
    });
});
