/**
 * @file test/test_unit_tlv.test.js
 * @brief Vitest testing suite validating server modules.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import tlv from '../lib/tlv';

const testLabels = {
    '0x012d': { name: 'temperature_ambient', type: 'u16be', scale: 0.01, unit: '°C' },
    '0x0135': { name: 'humidity_percent', type: 'u16be', scale: 0.1, unit: '%' },
    '0x012a': { name: 'battery_mv', type: 'u16be', unit: 'mV' },
    '0x0260': { name: 'device_id', type: 'string' },
    '0x025e': { name: 'session_token', type: 'bytes' },
    '0x025f': { name: 'token_validity_minutes', type: 'u16be' },
    '0x0290': { name: 'va_child_lock_enabled', type: 'bool' },
    '0x020a': { name: 'mount_state', type: 'u8' },
    '0x6280': { name: 'overlay_target_temperature', type: 'u16be', scale: 0.01, unit: '°C' },
    '0x0007': { name: 'client_nonce', type: 'bytes' },
    '0x0094': { name: 'temperature_offset', type: 's16be', scale: 0.01, unit: '°C' },
    '0x1234': { name: 'test_u32', type: 'u32be' },
    '0x1235': { name: 'test_s32', type: 's32be' },
    '0x1236': { name: 'test_empty', type: 'empty' },
    '0x1237': { name: 'test_flag', type: 'flag' },
};

beforeAll(() => {
    tlv.init(testLabels);
});

describe('1. init / getLabels / getLabel', () => {
    it('getLabels returns object', () => {
        expect(typeof tlv.getLabels()).toBe('object');
    });

    it('getLabels has expected keys', () => {
        expect('0x012d' in tlv.getLabels()).toBe(true);
    });

    it('getLabel by number: 0x012d', () => {
        expect(tlv.getLabel(0x012d)?.name).toBe('temperature_ambient');
    });

    it('getLabel by number: 0x0260', () => {
        expect(tlv.getLabel(0x0260)?.name).toBe('device_id');
    });

    it('getLabel unknown: returns null', () => {
        expect(tlv.getLabel(0xFFFF)).toBeNull();
    });
});

describe('2. getFidByLabelName', () => {
    it('getFidByLabelName temperature_ambient', () => {
        expect(tlv.getFidByLabelName('temperature_ambient')).toBe(0x012d);
    });

    it('getFidByLabelName device_id', () => {
        expect(tlv.getFidByLabelName('device_id')).toBe(0x0260);
    });

    it('getFidByLabelName nonexistent → null', () => {
        expect(tlv.getFidByLabelName('nonexistent')).toBeNull();
    });
});

describe('3. encodeValue', () => {
    it('encodeValue u8: 1 byte', () => {
        const u8 = tlv.encodeValue(42, 'u8');
        expect(u8.length).toBe(1);
        expect(u8[0]).toBe(42);
    });

    it('encodeValue u16be: 2 bytes', () => {
        const u16 = tlv.encodeValue(2150, 'u16be');
        expect(u16.length).toBe(2);
        expect(u16.readUInt16BE(0)).toBe(2150);
    });

    it('encodeValue u32be: 4 bytes', () => {
        const u32 = tlv.encodeValue(0x12345678, 'u32be');
        expect(u32.length).toBe(4);
        expect(u32.readUInt32BE(0)).toBe(0x12345678);
    });

    it('encodeValue s16be: 2 bytes', () => {
        const s16 = tlv.encodeValue(-100, 's16be');
        expect(s16.length).toBe(2);
        expect(s16.readInt16BE(0)).toBe(-100);
    });

    it('encodeValue s32be: 4 bytes', () => {
        const s32 = tlv.encodeValue(-123456, 's32be');
        expect(s32.length).toBe(4);
        expect(s32.readInt32BE(0)).toBe(-123456);
    });

    it('encodeValue string: matches', () => {
        const str = tlv.encodeValue('IB001', 'string');
        expect(str.toString()).toBe('IB001');
    });

    it('encodeValue bool true/false', () => {
        const boolTrue = tlv.encodeValue(true, 'bool');
        expect(boolTrue.length).toBe(1);
        expect(boolTrue[0]).toBe(1);

        const boolFalse = tlv.encodeValue(false, 'bool');
        expect(boolFalse.length).toBe(1);
        expect(boolFalse[0]).toBe(0);
    });

    it('encodeValue empty: 0 bytes', () => {
        const empty = tlv.encodeValue(null, 'empty');
        expect(empty.length).toBe(0);
    });

    it('encodeValue bytes hex: matches', () => {
        const bytes = tlv.encodeValue('deadbeef', 'bytes');
        expect(bytes.toString('hex')).toBe('deadbeef');
    });

    it('encodeValue bytes buffer: matches', () => {
        const bytesBuf = tlv.encodeValue(Buffer.from([1, 2, 3]), 'bytes');
        expect(bytesBuf.equals(Buffer.from([1, 2, 3]))).toBe(true);
    });
});

describe('4. interpretValue', () => {
    it('interpretValue u8: value = 42', () => {
        const iv_u8 = tlv.interpretValue(Buffer.from([42]), { type: 'u8' });
        expect(iv_u8.value).toBe(42);
    });

    it('interpretValue u16be: value = 2150', () => {
        const iv_u16 = tlv.interpretValue(Buffer.from([0x08, 0x66]), { type: 'u16be' });
        expect(iv_u16.value).toBe(2150);
    });

    it('interpretValue u16be scaled: value ≈ 21.50', () => {
        const iv_u16s = tlv.interpretValue(Buffer.from([0x08, 0x66]), { type: 'u16be', scale: 0.01 });
        expect(Math.abs(iv_u16s.value - 21.50)).toBeLessThan(0.001);
    });

    it('interpretValue s16be: value = -150', () => {
        const s16buf = Buffer.alloc(2);
        s16buf.writeInt16BE(-150, 0);
        const iv_s16 = tlv.interpretValue(s16buf, { type: 's16be' });
        expect(iv_s16.value).toBe(-150);
    });

    it('interpretValue s16be scaled: value ≈ -1.50', () => {
        const s16buf = Buffer.alloc(2);
        s16buf.writeInt16BE(-150, 0);
        const iv_s16s = tlv.interpretValue(s16buf, { type: 's16be', scale: 0.01 });
        expect(Math.abs(iv_s16s.value - (-1.50))).toBeLessThan(0.001);
    });

    it('interpretValue u32be: value = 0xDEADBEEF', () => {
        const u32buf = Buffer.alloc(4);
        u32buf.writeUInt32BE(0xDEADBEEF, 0);
        const iv_u32 = tlv.interpretValue(u32buf, { type: 'u32be' });
        expect(iv_u32.value).toBe(0xDEADBEEF);
    });

    it('interpretValue s32be: value = -999999', () => {
        const s32buf = Buffer.alloc(4);
        s32buf.writeInt32BE(-999999, 0);
        const iv_s32 = tlv.interpretValue(s32buf, { type: 's32be' });
        expect(iv_s32.value).toBe(-999999);
    });

    it('interpretValue string', () => {
        const iv_str = tlv.interpretValue(Buffer.from('hello'), { type: 'string' });
        expect(iv_str.value).toBe('hello');
    });

    it('interpretValue string_ascii', () => {
        const iv_ascii = tlv.interpretValue(Buffer.from('test'), { type: 'string_ascii' });
        expect(iv_ascii.value).toBe('test');
    });

    it('interpretValue bool true/false', () => {
        const iv_bool_t = tlv.interpretValue(Buffer.from([1]), { type: 'bool' });
        expect(iv_bool_t.value).toBe(true);
        const iv_bool_f = tlv.interpretValue(Buffer.from([0]), { type: 'bool' });
        expect(iv_bool_f.value).toBe(false);
    });

    it('interpretValue flag: value = true', () => {
        const iv_flag = tlv.interpretValue(Buffer.from([1]), { type: 'flag' });
        expect(iv_flag.value).toBe(true);
    });

    it('interpretValue empty: value = null', () => {
        const iv_empty = tlv.interpretValue(Buffer.alloc(0), { type: 'empty' });
        expect(iv_empty.value).toBeNull();
    });

    it('interpretValue bytes: value = hex', () => {
        const iv_bytes = tlv.interpretValue(Buffer.from([0xDE, 0xAD]), { type: 'bytes' });
        expect(iv_bytes.value).toBe('dead');
    });

    it('interpretValue no label: returns hex', () => {
        const iv_unknown = tlv.interpretValue(Buffer.from([0x01, 0x02]), null);
        expect(iv_unknown.value).toBe('0102');
    });
});

describe('5. encode / decode round-trip', () => {
    it('round-trips entries correctly', () => {
        const entries = [
            { fid: 0x012d, value: tlv.encodeValue(2150, 'u16be') },
            { fid: 0x0135, value: tlv.encodeValue(550, 'u16be') },
            { fid: 0x012a, value: tlv.encodeValue(2800, 'u16be') },
        ];
        const encoded = tlv.encode(entries);
        expect(Buffer.isBuffer(encoded)).toBe(true);
        expect(encoded.length).toBe(15);

        const decoded = tlv.decode(encoded);
        expect(decoded.ok).toBe(true);
        expect(decoded.items.length).toBe(3);
        expect('0x012d' in decoded.fields).toBe(true);
        expect('0x0135' in decoded.fields).toBe(true);
        expect('0x012a' in decoded.fields).toBe(true);

        expect(Math.abs(decoded.fields['0x012d'] - 21.50)).toBeLessThan(0.01);
        expect(Math.abs(decoded.fields['0x0135'] - 55.0)).toBeLessThan(0.1);
        expect(decoded.fields['0x012a']).toBe(2800);
    });

    it('decode string: device_id = IB001TEST', () => {
        const strEntries = [
            { fid: 0x0260, value: tlv.encodeValue('IB001TEST', 'string') },
        ];
        const strEncoded = tlv.encode(strEntries);
        const strDecoded = tlv.decode(strEncoded);
        expect(strDecoded.fields['0x0260']).toBe('IB001TEST');
    });

    it('decode bool: va_child_lock_enabled = true', () => {
        const boolEntries = [
            { fid: 0x0290, value: tlv.encodeValue(true, 'bool') },
        ];
        const boolEncoded = tlv.encode(boolEntries);
        const boolDecoded = tlv.decode(boolEncoded);
        expect(boolDecoded.fields['0x0290']).toBe(true);
    });
});

describe('6. Edge cases', () => {
    it('decode empty: ok = true', () => {
        const emptyDecoded = tlv.decode(Buffer.alloc(0));
        expect(emptyDecoded.ok).toBe(true);
        expect(emptyDecoded.items.length).toBe(0);
    });

    it('decode truncated: 0 items (truncated field)', () => {
        const truncated = Buffer.from([0x01, 0x2D, 0x02]);
        const truncDecoded = tlv.decode(truncated);
        expect(truncDecoded.items.length).toBe(0);
    });

    it('decode 1 byte: 0 items', () => {
        const tooShort = Buffer.from([0x01]);
        const tooShortDecoded = tlv.decode(tooShort);
        expect(tooShortDecoded.items.length).toBe(0);
    });

    it('decode unknown fid: ok = true', () => {
        const unknownEntry = [{ fid: 0xFFFF, value: Buffer.from([0x01, 0x02]) }];
        const unknownEncoded = tlv.encode(unknownEntry);
        const unknownDecoded = tlv.decode(unknownEncoded);
        expect(unknownDecoded.ok).toBe(true);
        expect(unknownDecoded.items[0].name).toBe('0xffff');
        expect(unknownDecoded.items[0].type).toBe('bytes');
    });

    it('decode repeated: value is array', () => {
        const repeatEntries = [
            { fid: 0x012d, value: tlv.encodeValue(2100, 'u16be') },
            { fid: 0x012d, value: tlv.encodeValue(2200, 'u16be') },
        ];
        const repeatEncoded = tlv.encode(repeatEntries);
        const repeatDecoded = tlv.decode(repeatEncoded);
        expect(Array.isArray(repeatDecoded.fields['0x012d'])).toBe(true);
        expect(repeatDecoded.fields['0x012d'].length).toBe(2);
    });
});
