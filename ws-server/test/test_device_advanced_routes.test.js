'use strict';

const assert = require('assert');
const { mapDevice } = require('../lib/mappers');

test('mapDevice - Actuator Limits and Diagnostics non-inverted mapping', () => {
    const mockDbRow = {
        serial_no: 'VA1234567890',
        device_type: 'VA02',
        home_id: 999999,
        zone_id: 6,
        current_fw_version: '215.1',
        connection_state: 1,
        battery_state: 'NORMAL',
        field_0140: '0.0',
        child_lock_enabled: 1,
        field_0149: 'HORIZONTAL',
        field_016a: 'CALIBRATING',
        field_0265: 1897,
        field_0266: 1894,
        field_0273: 2403,
        field_027c: 2244,
        field_0280: 1786,
        field_0283: 3,
        field_028c: 1,
        field_01fa: 2,    // va_mount_mode
        field_01fb: 0,    // va_mount_flags
        field_01b5: 205,  // va_mount_reference_steps
        field_01b6: 1894, // va_mount_seatpoint_steps
        field_019e: 112,
        field_019d: 128,
        field_02b2: 0
    };

    const mapped = mapDevice(mockDbRow);

    assert.strictEqual(mapped.serialNo, 'VA1234567890');
    assert.strictEqual(mapped.deviceType, 'VA02');
    assert.strictEqual(mapped.orientation, 'HORIZONTAL');
    assert.strictEqual(mapped.childLockEnabled, true);
    assert.strictEqual(mapped.displayBrightness, 112);
    assert.strictEqual(mapped.displayContrast, 128);
    assert.strictEqual(mapped.displayActiveTimeout, 0);

    assert.ok(mapped.actuatorLimits);
    assert.strictEqual(mapped.actuatorLimits.lowSteps, 2403);
    assert.strictEqual(mapped.actuatorLimits.highSteps, 2244);
    assert.strictEqual(mapped.actuatorLimits.driveConstant, 1786);
    assert.strictEqual(mapped.actuatorLimits.position1, 1897);
    assert.strictEqual(mapped.actuatorLimits.position2, 1894);
    assert.strictEqual(mapped.actuatorLimits.active, 1);
    assert.strictEqual(mapped.actuatorLimits.mountingState, 'CALIBRATING');

    // Verify correct non-inverted diagnostic mapping
    assert.strictEqual(mapped.actuatorLimits.seatPoint, 1894);    // field_01b6
    assert.strictEqual(mapped.actuatorLimits.referencePoint, 205); // field_01b5
    assert.strictEqual(mapped.actuatorLimits.mode, 2);             // field_01fa
    assert.strictEqual(mapped.actuatorLimits.flags, 0);            // field_01fb
    assert.strictEqual(mapped.actuatorLimits.deviation, 3);        // field_0283
});
