/**
 * @file lib/tlv.js
 * @brief Low-level Type-Length-Value encoder and decoder.
 */

'use strict';

let _labels = {};

/**
 * Initialize TLV decoder with labels from the database
 */
function init(labels) {
    _labels = labels || {};
}

/**
 * Get the loaded labels
 */
function getLabels() {
    return _labels;
}

/**
 * Get the label info for a field ID
 */
function getLabel(fid) {
    if (fid === null || fid === undefined) return null;
    const key = '0x' + fid.toString(16).toLowerCase().padStart(4, '0');
    return _labels[key] || null;
}

/**
 * Interpret a raw value buffer according to its type and scale
 */
function interpretValue(valueBuf, label) {
    if (!label) {
        return { raw: valueBuf.toString('hex'), value: valueBuf.toString('hex') };
    }

    const t = label.type || 'bytes';
    const scale = label.scale;
    let value;

    switch (t) {
        case 'u8':
            value = valueBuf.length >= 1 ? valueBuf[0] : 0;
            break;
        case 'u16':
        case 'u16be':
            value = valueBuf.length >= 2 ? valueBuf.readUInt16BE(0) : (valueBuf.length === 1 ? valueBuf[0] : 0);
            break;
        case 'u32be':
            value = valueBuf.length >= 4 ? valueBuf.readUInt32BE(0) : (valueBuf.length >= 2 ? valueBuf.readUInt16BE(0) : 0);
            break;
        case 's16':
        case 's16be':
            value = valueBuf.length >= 2 ? valueBuf.readInt16BE(0) : 0;
            break;
        case 's32be':
            value = valueBuf.length >= 4 ? valueBuf.readInt32BE(0) : 0;
            break;
        case 'string':
        case 'string_ascii':
            value = valueBuf.toString('utf-8');
            break;
        case 'bool':
        case 'flag':
            value = valueBuf.length > 0 ? valueBuf[0] !== 0 : false;
            break;
        case 'empty':
            value = null;
            break;
        case 'bytes':
        default:
            value = valueBuf.toString('hex');
            break;
    }

    if (scale != null && typeof value === 'number') {
        value = value * scale;
        value = Math.round(value * 10000) / 10000;
    }

    return { raw: valueBuf.toString('hex'), value };
}

/**
 * Decode a TLV payload buffer into an array of named fields
 * @param {Buffer} payload - Raw TLV bytes
 * @returns {{ ok: boolean, fields: Object, items: Array }}
 */
function decode(payload) {
    if (!Buffer.isBuffer(payload)) payload = Buffer.from(payload);

    const items = [];
    const fields = {};
    let cur = 0;

    while (cur + 3 <= payload.length) {
        const fid = payload.readUInt16BE(cur); cur += 2;
        const len = payload[cur]; cur += 1;

        if (cur + len > payload.length) {
            break;
        }

        const valueBuf = Buffer.from(payload.subarray(cur, cur + len));
        cur += len;

        const fidHex = '0x' + (fid ? fid.toString(16).toLowerCase().padStart(4, '0') : '0000');
        const label = getLabel(fid);
        const interpreted = interpretValue(valueBuf, label);

        const item = {
            fid: fidHex,
            fidNum: fid,
            name: label ? label.name : fidHex,
            type: label ? label.type : 'bytes',
            unit: label ? (label.unit || null) : null,
            rawHex: valueBuf.toString('hex'),
            len,
            value: interpreted.value,
        };

        items.push(item);

        const key = fidHex;
        if (fields[key] !== undefined) {
            if (!Array.isArray(fields[key])) {
                fields[key] = [fields[key]];
            }
            fields[key].push(item.value);
        } else {
            fields[key] = item.value;
        }
    }

    return { ok: true, fields, items };
}

/**
 * Encode a set of TLV fields into a binary payload
 * @param {Array<{fid: number, value: Buffer}>} entries 
 * @returns {Buffer}
 */
function encode(entries) {
    const bufs = [];
    for (const entry of entries) {
        const fid = entry.fid;
        const val = Buffer.isBuffer(entry.value) ? entry.value : Buffer.from(entry.value);
        const hdr = Buffer.alloc(3);
        hdr.writeUInt16BE(fid, 0);
        hdr[2] = val.length;
        bufs.push(hdr, val);
    }
    return Buffer.concat(bufs);
}

/**
 * Encode a single field value based on its type
 */
function encodeValue(value, type) {
    switch (type) {
        case 'u8': {
            let val = value;
            if (typeof val === 'string') {
                const s = val.toUpperCase().trim();
                if (s === 'HORIZONTAL' || s === '0' || s === '00') val = 0;
                else if (s === 'VERTICAL' || s === '1' || s === '01') val = 1;
                else val = parseInt(s, 10) || 0;
            }
            const b = Buffer.alloc(1);
            b[0] = val & 0xFF;
            return b;
        }
        case 'u16be': {
            const b = Buffer.alloc(2);
            b.writeUInt16BE(value & 0xFFFF, 0);
            return b;
        }
        case 'u32be': {
            const b = Buffer.alloc(4);
            b.writeUInt32BE(value >>> 0, 0);
            return b;
        }
        case 's16be': {
            const b = Buffer.alloc(2);
            b.writeInt16BE(value, 0);
            return b;
        }
        case 's32be': {
            const b = Buffer.alloc(4);
            b.writeInt32BE(value, 0);
            return b;
        }
        case 'string':
            return Buffer.from(String(value), 'utf-8');
        case 'bool': {
            return Buffer.from([value ? 1 : 0]);
        }
        case 'empty':
            return Buffer.alloc(0);
        case 'bytes':
        default:
            if (typeof value === 'boolean') return Buffer.from([value ? 1 : 0]);
            if (typeof value === 'number') {
                // Defensive: encode numeric values as appropriately-sized integers
                if (value <= 0xFF) return Buffer.from([value & 0xFF]);
                if (value <= 0xFFFF) { const b = Buffer.alloc(2); b.writeUInt16BE(value & 0xFFFF, 0); return b; }
                const b = Buffer.alloc(4); b.writeUInt32BE(value >>> 0, 0); return b;
            }
            if (typeof value === 'string') return Buffer.from(value, 'hex');
            return Buffer.isBuffer(value) ? value : Buffer.from(value);
    }
}

/**
 * Find a field ID by its label name
 * @param {string} name 
 * @returns {number|null}
 */
function getFidByLabelName(name) {
    if (!name) return null;
    for (const [fid, info] of Object.entries(_labels)) {
        if (info.name === name) {
            return parseInt(fid, 16);
        }
    }
    // Fallback for field_xxxx or hvac_diagnostic_xxxx to prevent renaming regressions
    const match = name.match(/^(?:field|hvac_diagnostic)_([0-9a-fA-F]{4})$/i);
    if (match) {
        return parseInt(match[1], 16);
    }
    return null;
}

/**
 * Encode a nested fields object back into a binary TLV payload.
 * Supports both named fields and hex-prefixed field IDs.
 * @param {Object} fields 
 * @returns {Buffer}
 */
function encodeFromFields(fields) {
    const entries = [];
    const normalizedMap = new Map();

    for (const [key, val] of Object.entries(fields)) {
        if (val === null || val === undefined) continue;

        let fid;
        let type = 'bytes';
        let scale = null;

        if (key.startsWith('0x')) {
            fid = parseInt(key, 16);
            const label = getLabel(fid);
            if (label) {
                type = label.type || 'bytes';
                scale = label.scale;
            }
        } else {
            fid = getFidByLabelName(key);
            const label = getLabel(fid);
            if (label) {
                type = label.type;
                scale = label.scale;
            }
        }

        if (fid == null || isNaN(fid)) continue;

        const isHexKey = key.startsWith('0x');
        if (!normalizedMap.has(fid) || isHexKey) {
            normalizedMap.set(fid, { fid, val, type, scale, key });
        }
    }

    for (const { fid, val, type, scale, key } of normalizedMap.values()) {
        const valArray = Array.isArray(val) ? val : [val];

        for (const v of valArray) {
            let encodeVal = v;
            // Apply inverse scaling if needed
            if (scale != null && typeof v === 'number') {
                encodeVal = Math.round(v / scale);
            }
            try {
                entries.push({ fid, value: encodeValue(encodeVal, type) });
            } catch (err) {
                console.error(`[tlv] Error encoding key="${key}" fid=0x${fid.toString(16)} type="${type}" val=${v}:`, err.message);
                throw err;
            }
        }
    }
    return encode(entries);
}

module.exports = { init, getLabels, getLabel, getFidByLabelName, decode, encode, encodeValue, interpretValue, encodeFromFields };
