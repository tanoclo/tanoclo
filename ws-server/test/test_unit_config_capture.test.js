/**
 * @file test/test_unit_config_capture.test.js
 * @brief Vitest testing suite validating server modules.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const configCapture = require('../lib/config-capture');

test('config capture overwrite and deduplication', async () => {
    const tmpLogDir = path.join(__dirname, 'tmp_config_capture_test');
    if (!fs.existsSync(tmpLogDir)) fs.mkdirSync(tmpLogDir, { recursive: true });

    // Clean up any old files from previous runs
    const capDir = path.join(tmpLogDir, 'config_capture');
    if (fs.existsSync(capDir)) {
        const files = fs.readdirSync(capDir);
        for (const file of files) {
            fs.unlinkSync(path.join(capDir, file));
        }
        fs.rmdirSync(capDir);
    }

    // Initialize config capture with temp directory
    configCapture.init({
        logDir: tmpLogDir,
        log: () => {} // suppress logging
    });

    const deviceId = 'VA1234567890';
    const filePath = path.join(capDir, `${deviceId}.jsonl`);

    // Test 1: Initial capture
    await configCapture.capture({
        deviceId,
        path: 'd/VA1234567890/config',
        coapCode: '2.05',
        coapEtag: Buffer.from([0x01, 0x02]),
        payload: Buffer.from([0x10, 0x20]),
        tlvDecoded: {
            ok: true,
            fields: { temp: 21.5 },
            items: [{ fid: 1, name: 'temp', type: 'float', len: 4, value: 21.5 }]
        }
    });

    let captures = await configCapture.getCaptures(deviceId);
    expect(captures.length).toBe(1);
    expect(captures[0].fields.temp).toBe(21.5);
    expect(captures[0].path).toBe('d/VA1234567890/config');

    // Test 2: Capture duplicate payload -> should skip
    await configCapture.capture({
        deviceId,
        path: 'd/VA1234567890/config',
        coapCode: '2.05',
        coapEtag: Buffer.from([0x01, 0x02]),
        payload: Buffer.from([0x10, 0x20]),
        tlvDecoded: {
            ok: true,
            fields: { temp: 21.5 },
            items: [{ fid: 1, name: 'temp', type: 'float', len: 4, value: 21.5 }]
        }
    });

    captures = await configCapture.getCaptures(deviceId);
    expect(captures.length).toBe(1); // Still 1 because it's a duplicate

    // Test 3: Capture new payload with same keys -> should OVERWRITE
    await configCapture.capture({
        deviceId,
        path: 'd/VA1234567890/config',
        coapCode: '2.05',
        coapEtag: Buffer.from([0x03, 0x04]),
        payload: Buffer.from([0x10, 0x30]), // different payload hex
        tlvDecoded: {
            ok: true,
            fields: { temp: 22.0 }, // different value
            items: [{ fid: 1, name: 'temp', type: 'float', len: 4, value: 22.0 }] // same FID/key
        }
    });

    captures = await configCapture.getCaptures(deviceId);
    expect(captures.length).toBe(1); // Overwritten! Still 1
    expect(captures[0].fields.temp).toBe(22.0); // Updated value
    expect(captures[0].coapEtag).toBe('0304');

    // Test 4: Capture new path -> should append
    await configCapture.capture({
        deviceId,
        path: 'd/VA1234567890/hvac',
        coapCode: '2.05',
        coapEtag: Buffer.from([0x05]),
        payload: Buffer.from([0x40]),
        tlvDecoded: {
            ok: true,
            fields: { mode: 1 },
            items: [{ fid: 2, name: 'mode', type: 'u8', len: 1, value: 1 }]
        }
    });

    captures = await configCapture.getCaptures(deviceId);
    expect(captures.length).toBe(2);

    // Test 5: Capture same path, same coapCode, but DIFFERENT keys -> should append
    await configCapture.capture({
        deviceId,
        path: 'd/VA1234567890/config',
        coapCode: '2.05',
        coapEtag: Buffer.from([0x06]),
        payload: Buffer.from([0x50]),
        tlvDecoded: {
            ok: true,
            fields: { temp: 22.0, battery: 99 },
            items: [
                { fid: 1, name: 'temp', type: 'float', len: 4, value: 22.0 },
                { fid: 3, name: 'battery', type: 'u8', len: 1, value: 99 } // different set of keys
            ]
        }
    });

    captures = await configCapture.getCaptures(deviceId);
    expect(captures.length).toBe(3);

    // Test 6: Verify startup deduplication / cleaning of existing files
    // Let's manually append a duplicate line to the file
    const duplicateEntry = {
        timestamp: new Date().toISOString(),
        deviceId,
        path: 'd/VA1234567890/config',
        coapCode: '2.05',
        coapEtag: '0707',
        payloadHex: '9999',
        payloadLength: 2,
        tlvItems: [{ fid: 1, name: 'temp', type: 'float', len: 4, value: 25.0 }],
        fields: { temp: 25.0 }
    };
    fs.appendFileSync(filePath, JSON.stringify(duplicateEntry) + '\n', 'utf-8');

    // Currently on disk it has 4 entries (3 original + 1 manually appended duplicate)
    let rawContent = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    expect(rawContent.length).toBe(4);

    // Re-initialize to trigger the startup cleanup
    configCapture.init({
        logDir: tmpLogDir,
        log: () => {}
    });

    // The duplicateEntry (with fid 1 only) should have overwritten the previous entry with fid 1 only (which had temp: 22.0)
    captures = await configCapture.getCaptures(deviceId);
    expect(captures.length).toBe(3); // Deduplicated! Back to 3

    // Find the entry for path 'd/VA1234567890/config' and fid 1 (not the one with fid 1 & 3)
    const entryFid1 = captures.find(c => c.path === 'd/VA1234567890/config' && c.tlvItems.length === 1);
    expect(entryFid1.fields.temp).toBe(25.0); // Kept the latest one

    // Clean up test files with retry for Windows file handle release
    try {
        if (fs.existsSync(tmpLogDir)) {
            fs.rmSync(tmpLogDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    } catch (err) {
        // ignore cleanup error
    }
});
