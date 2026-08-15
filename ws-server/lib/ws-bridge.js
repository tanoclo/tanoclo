/**
 * @file lib/ws-bridge.js
 * @brief Low-level WebSocket framing parser for bridge transport packages.
 */

'use strict';

/**
 * WS Bridge Frame parser/builder
 * 
 * Every binary WebSocket message wraps a CoAP message in a 28-byte bridge frame:
 *   [direction u16] [ipv6_len u8=0x10] [ipv6 16B] [field_a u16] [field_b u8] 
 *   [udp_port u16] [field_c u16] [coap_len u16] [coap_bytes ...]
 *
 * Total header: 2 + 1 + 16 + 2 + 1 + 2 + 2 + 2 = 28 bytes
 */

const DIR_CLIENT_TO_SERVER = 0x0001;
const DIR_SERVER_TO_CLIENT = 0x0002;

/**
 * Format 16 raw IPv6 bytes into a normalized lowercase string
 */
function ipv6FromBytes(buf, offset = 0) {
    const groups = [];
    for (let i = 0; i < 8; i++) {
        groups.push(buf.readUInt16BE(offset + i * 2).toString(16));
    }
    return groups.join(':');
}

/**
 * Write an IPv6 string into a 16-byte buffer
 */
function ipv6ToBytes(ipv6Str) {
    const buf = Buffer.alloc(16);
    let full = ipv6Str;

    // Expand :: shorthand
    if (full.includes('::')) {
        const parts = full.split('::');
        const left = parts[0] ? parts[0].split(':') : [];
        const right = parts[1] ? parts[1].split(':') : [];
        const missing = 8 - left.length - right.length;
        const mid = Array(missing).fill('0');
        full = [...left, ...mid, ...right].join(':');
    }

    const groups = full.split(':');
    for (let i = 0; i < 8; i++) {
        const val = parseInt(groups[i] || '0', 16);
        buf.writeUInt16BE(val, i * 2);
    }
    return buf;
}

/**
 * Parse a WS Bridge Frame from raw binary data.
 * @param {Buffer} data - Raw websocket binary message
 * @returns {Object} Parsed frame or {ok: false, err: string}
 */
function parse(data) {
    if (!Buffer.isBuffer(data)) data = Buffer.from(data);

    if (data.length < 28) {
        return { ok: false, err: `Frame too short: ${data.length} < 28` };
    }

    const directionU16 = data.readUInt16BE(0);
    const ipv6Len = data[2];

    if (ipv6Len !== 0x10) {
        return { ok: false, err: `Unexpected IPv6 length byte: 0x${ipv6Len.toString(16)}` };
    }

    const ipv6 = ipv6FromBytes(data, 3);
    let cur = 19;

    // Field layout matches Python reference decoder exactly
    const fieldA = data.readUInt16BE(cur); cur += 2;    // bytes 19-20 (u16)
    const fieldB = data[cur++];                          // byte 21 (u8)
    const udpPort = data.readUInt16BE(cur); cur += 2;    // bytes 22-23 (u16)
    const fieldC = data.readUInt16BE(cur); cur += 2;     // bytes 24-25 (u16)
    const coapLen = data.readUInt16BE(cur); cur += 2;    // bytes 26-27 (u16)

    if (cur + coapLen > data.length) {
        return { ok: false, err: `CoAP length ${coapLen} exceeds remaining data ${data.length - cur}` };
    }

    const coapBytes = data.subarray(cur, cur + coapLen);

    const direction = directionU16 === DIR_CLIENT_TO_SERVER ? 'client_to_server' :
        directionU16 === DIR_SERVER_TO_CLIENT ? 'server_to_client' : 'unknown';

    return {
        ok: true,
        directionU16,
        direction,
        ipv6,
        ipv6Len,
        fieldA,
        fieldB,
        udpPort,
        fieldC,
        coapLen,
        coapBytes: Buffer.from(coapBytes),
    };
}

/**
 * Build a WS Bridge Frame wrapping CoAP bytes
 */
function build({ direction, ipv6, coapBytes, fieldA = 0, fieldB = 0, udpPort = 0, fieldC = 0 }) {
    const dirU16 = direction === 'client_to_server' ? DIR_CLIENT_TO_SERVER : DIR_SERVER_TO_CLIENT;
    const ipv6Buf = ipv6ToBytes(ipv6);

    const buf = Buffer.alloc(28 + coapBytes.length);
    let off = 0;

    buf.writeUInt16BE(dirU16, off); off += 2;
    buf[off++] = 0x10;
    ipv6Buf.copy(buf, off); off += 16;
    buf.writeUInt16BE(fieldA, off); off += 2;
    buf[off++] = fieldB;
    buf.writeUInt16BE(udpPort, off); off += 2;
    buf.writeUInt16BE(fieldC, off); off += 2;
    buf.writeUInt16BE(coapBytes.length, off); off += 2;
    coapBytes.copy(buf, off);

    return buf;
}

module.exports = { parse, build, DIR_CLIENT_TO_SERVER, DIR_SERVER_TO_CLIENT, ipv6FromBytes, ipv6ToBytes };
