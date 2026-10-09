'use strict';

const assert = require('assert');
const { mapDevice } = require('../lib/mappers');
const { applyDeviceConfigOverrides } = require('../lib/commands/device');
const api = require('../lib/command-api');

test('mapDevice - valveSensitivity mapping for VA devices', () => {
    const mockVaRow = {
        serial_no: 'VA1234567890',
        device_type: 'VA02',
        home_id: 1,
        valve_sensitivity: 85
    };
    const mapped = mapDevice(mockVaRow);
    assert.strictEqual(mapped.valveSensitivity, 85);

    const mockVaDefault = {
        serial_no: 'VA1234567891',
        device_type: 'VA01',
        home_id: 1,
        valve_sensitivity: null
    };
    const mappedDefault = mapDevice(mockVaDefault);
    assert.strictEqual(mappedDefault.valveSensitivity, 100);

    const mockRu = {
        serial_no: 'RU1234567890',
        device_type: 'RU02',
        home_id: 1,
        valve_sensitivity: 70
    };
    const mappedRu = mapDevice(mockRu);
    assert.strictEqual(mappedRu.valveSensitivity, undefined);
});

test('applyDeviceConfigOverrides - sets 0x4160 for VA devices', async () => {
    // Mock api._db methods
    const originalGetDevice = api._db.getDeviceByFullSerial;
    const originalGetZoneBindings = api._db.getZoneBindingsForDevice;
    const originalCalcETag = api._db.calculateVADeviceETag;

    try {
        api._db.getDeviceByFullSerial = async (serial) => ({
            serial_no: serial,
            device_type: 'VA02',
            valve_sensitivity: 75,
            home_id: 1
        });
        api._db.getZoneBindingsForDevice = async () => [];
        api._db.calculateVADeviceETag = () => 0x1234;

        const fields = {};
        await applyDeviceConfigOverrides('VA1234567890', fields);

        // Should include 0x4160
        assert.strictEqual(fields['0x4160'], 75);

        // With explicit update override
        const fieldsOverride = {};
        await applyDeviceConfigOverrides('VA1234567890', fieldsOverride, { valve_sensitivity: 50 });
        assert.strictEqual(fieldsOverride['0x4160'], 50);

        // Values out of range (< 50 or > 100) are not applied
        const fieldsInvalid = {};
        await applyDeviceConfigOverrides('VA1234567890', fieldsInvalid, { valve_sensitivity: 40 });
        // Falls back to DB value or not applied
        assert.strictEqual(fieldsInvalid['0x4160'], 75);
    } finally {
        api._db.getDeviceByFullSerial = originalGetDevice;
        api._db.getZoneBindingsForDevice = originalGetZoneBindings;
        api._db.calculateVADeviceETag = originalCalcETag;
    }
});
