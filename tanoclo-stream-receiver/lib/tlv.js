/**
 * @file lib/tlv.js
 * @brief Parses Type-Length-Value (TLV) dynamic configurations and telemetry properties.
 */

'use strict';

let _labels = {};

const BUILTIN_LABELS = {
    '0x015e': { name: 'zone_role_and_id', type: 'role_zone' },
    '0x8400': { name: 'zone_peer_uri_p', type: 'string_ascii' },
    '0x8200': { name: 'zone_peer_uri_c', type: 'string_ascii' },
    '0x8000': { name: 'zone_peer_uri_s', type: 'string_ascii' },
    '0x63a0': { name: 'zone_peer_uri_alt', type: 'string_ascii' },
    '0x6040': { name: 'zone_peer_uri_cpe', type: 'string_ascii' },
    '0x01d4': { name: 'zone_peer_uri_1d4', type: 'string_ascii' },
    '0x01d5': { name: 'zone_peer_uri_1d5', type: 'string_ascii' },
    '0x0210': { name: 'fw_build_id', type: 'string_ascii' },
    '0x003a': { name: 'fw_version', type: 'u16be' },
    '0x0035': { name: 'fw_other_slot', type: 'u16be' },
    '0x0180': { name: 'slot_num', type: 'u8' },
    '0x0036': { name: 'dev_type_code', type: 'u8' }
};

/**
 * Initialize TLV decoder with labels from database/JSON
 */
function init(labels) {
    _labels = labels || {};
}

function getLabels() {
    return _labels;
}

function getLabel(fid) {
    if (fid === null || fid === undefined) return null;
    const key = '0x' + fid.toString(16).toLowerCase().padStart(4, '0');
    return _labels[key] || BUILTIN_LABELS[key] || null;
}

function decodeZoneRole(code) {
    if (code === null || code === undefined) return 'UNKNOWN';
    const num = Number(code);
    switch (num) {
        case 0x09: return 'WTS_MEASURING_LEADER';
        case 0x0B: return 'RU_LEADER_CONTROLLER';
        case 0x0D: return 'BRIDGE_HW_LEADER';
        case 0x05: return 'VA_ZONE_MEMBER';
        case 0x03: return 'RU_ZONE_FOLLOWER';
        case 0x02: return 'REMOTE_ZONE';
        default: return `ROLE_0x${num.toString(16).toUpperCase()}`;
    }
}

/**
 * Decode STM32 RCC CSR reset reason flags.
 */
function decodeResetReason(code) {
    if (code === null || code === undefined) return null;
    const val = Number(code);
    if (isNaN(val) || val === 0) return 'None';
    const parts = [];
    if (val & 1) parts.push('PIN');
    if (val & 2) parts.push('POR/PDR');
    if (val & 4) parts.push('Software');
    if (val & 8) parts.push('IWDG');
    if (val & 16) parts.push('WWDG');
    if (val & 32) parts.push('Low-Power');
    return parts.length > 0 ? parts.join('+') : 'None';
}

/**
 * Decode Room Unit / Valve Actuator hardware error flags.
 */
function decodeErrorFlags(flags) {
    if (flags === null || flags === undefined) return 'None';
    const val = Number(flags);
    if (isNaN(val) || val === 0) return 'None';
    const parts = [];
    if (val & 0x2) parts.push('Orphaned/No Route');
    if (val & 0x4) parts.push('NVM Write Fault');
    if (val & 0x8) parts.push('NVM Verification Fault');
    if (val & 0x80) parts.push('Link Loss/Offline');
    if (val & 0x800) parts.push('Motor Blocked');
    if (val & 0x1000) parts.push('Valve Travel Too Short');
    if (val & 0x2000) parts.push('Calibration Fault');
    if (val & 0x4000) parts.push('Mount/Contact Fault');
    if (val & 0x100000) parts.push('Low Battery');
    if (val & 0x200000) parts.push('Hardware Reset');

    const remaining = val & ~(0x2 | 0x4 | 0x8 | 0x80 | 0x800 | 0x1000 | 0x2000 | 0x4000 | 0x100000 | 0x200000);
    if (remaining > 0) {
        parts.push(`RAW_0x${remaining.toString(16).toUpperCase()}`);
    }
    return parts.length > 0 ? parts.join(', ') : 'None';
}

/**
 * Calculates valve position percentage.
 */
function calculateValvePositionPct(current, limitLow, limitHigh) {
    if (current == null || limitLow == null || limitHigh == null) return null;
    const cur = Number(current);
    const low = Number(limitLow);
    const high = Number(limitHigh);
    const range = low - high;
    if (range === 0) return 0;
    const pct = ((low - cur) / range) * 100;
    return Math.round(Math.max(0, Math.min(100, pct)));
}

/**
 * Decode mount state.
 */
function decodeMountState(val) {
    if (val === null || val === undefined) return 'UNKNOWN';
    if (typeof val === 'string') return val;
    const num = Number(val);
    switch (num) {
        case 0: return 'UNMOUNTED';
        case 1: return 'CALIBRATING';
        case 2: return 'MOUNTED';
        case 3: return 'FAULT';
        default: return `STATE_${num}`;
    }
}

/**
 * Decode display orientation.
 */
function decodeOrientation(val) {
    if (val === 1 || val === '1' || val === 'HORIZONTAL') return 'HORIZONTAL';
    return 'VERTICAL';
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
        case 'role_zone':
            value = valueBuf.length >= 2 ? {
                role: valueBuf[0],
                zoneId: valueBuf[1],
                roleName: decodeZoneRole(valueBuf[0])
            } : valueBuf.toString('hex');
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
 * Decode a TLV payload buffer into named items and fields.
 * Format per entry: [FID: 2 bytes Big-Endian][Length: 1 byte][Value: Length bytes]
 * 
 * @param {Buffer} payload - Raw TLV bytes
 * @returns {{ ok: boolean, fields: object, items: Array }}
 */
function decode(payload) {
    if (!Buffer.isBuffer(payload)) payload = Buffer.from(payload);

    const items = [];
    const fields = {};
    let cur = 0;

    while (cur + 3 <= payload.length) {
        const fid = payload.readUInt16BE(cur);
        const len = payload[cur + 2];
        cur += 3;

        if (cur + len > payload.length) {
            return { ok: false, error: 'TLV field length exceeds payload boundary', items, fields };
        }

        const valueBuf = payload.subarray(cur, cur + len);
        cur += len;

        const hexId = '0x' + fid.toString(16).toLowerCase().padStart(4, '0');
        const label = getLabel(fid);
        const interpreted = interpretValue(valueBuf, label);

        const name = label && label.name ? label.name : hexId;
        const entry = {
            fid: hexId,
            name,
            type: label ? label.type : 'bytes',
            value: interpreted.value,
            raw: interpreted.raw,
            length: len
        };

        items.push(entry);
        fields[hexId] = interpreted.value;
        if (label && label.name) {
            fields[label.name] = interpreted.value;
        }
    }

    return { ok: true, fields, items };
}

/**
 * Encode an array of field objects into a binary TLV Buffer.
 * @param {Array<{fid: number|string, type: string, value: any, scale?: number}>} entries
 * @returns {Buffer}
 */
function encode(entries) {
    const buffers = [];
    for (const item of entries) {
        let fidNum;
        if (typeof item.fid === 'string') {
            fidNum = parseInt(item.fid.replace(/^0x/i, ''), 16);
        } else {
            fidNum = item.fid;
        }

        let valBuf;
        const t = item.type || 'bytes';
        let v = item.value;

        if (item.scale != null && typeof v === 'number') {
            v = Math.round(v / item.scale);
        }

        switch (t) {
            case 'u8':
                valBuf = Buffer.from([v & 0xFF]);
                break;
            case 'u16':
            case 'u16be':
                valBuf = Buffer.alloc(2);
                valBuf.writeUInt16BE(v & 0xFFFF, 0);
                break;
            case 'u32be':
                valBuf = Buffer.alloc(4);
                valBuf.writeUInt32BE(v >>> 0, 0);
                break;
            case 's16':
            case 's16be':
                valBuf = Buffer.alloc(2);
                valBuf.writeInt16BE(v, 0);
                break;
            case 's32be':
                valBuf = Buffer.alloc(4);
                valBuf.writeInt32BE(v, 0);
                break;
            case 'string':
            case 'string_ascii':
                valBuf = Buffer.from(String(v), 'utf-8');
                break;
            case 'bool':
            case 'flag':
                valBuf = Buffer.from([v ? 1 : 0]);
                break;
            case 'empty':
                valBuf = Buffer.alloc(0);
                break;
            case 'bytes':
            default:
                if (Buffer.isBuffer(v)) {
                    valBuf = v;
                } else if (typeof v === 'string') {
                    valBuf = Buffer.from(v.replace(/\s+/g, ''), 'hex');
                } else {
                    valBuf = Buffer.alloc(0);
                }
                break;
        }

        const header = Buffer.alloc(3);
        header.writeUInt16BE(fidNum, 0);
        header[2] = valBuf.length;
        buffers.push(header, valBuf);
    }
    return Buffer.concat(buffers);
}

module.exports = {
    init,
    getLabels,
    getLabel,
    interpretValue,
    decode,
    encode,
    decodeResetReason,
    decodeErrorFlags,
    calculateValvePositionPct,
    decodeMountState,
    decodeOrientation
};
