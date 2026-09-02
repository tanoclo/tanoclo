/**
 * @file lib/icmpv6.js
 * @brief RFC 6282 6LoWPAN IPHC & RFC 4443 / 4861 ICMPv6 parser and builder for Tado.
 *
 * Implements deterministic 6LoWPAN IPHC header decoding without heuristic search:
 * - RFC 6282: 6LoWPAN IP Header Compression (IPHC) dispatch decoding
 * - RFC 4443: ICMPv6 (Echo Request 128, Echo Reply 129, Destination Unreachable 1)
 * - RFC 4861: Neighbor Discovery for IPv6 (RS 133, RA 134, NS 135, NA 136)
 */

'use strict';

const ICMPv6Type = {
    DEST_UNREACHABLE: 1,
    PACKET_TOO_BIG: 2,
    TIME_EXCEEDED: 3,
    PARAM_PROBLEM: 4,
    ECHO_REQUEST: 128,
    ECHO_REPLY: 129,
    ROUTER_SOLICITATION: 133,
    ROUTER_ADVERTISEMENT: 134,
    NEIGHBOR_SOLICITATION: 135,
    NEIGHBOR_ADVERTISEMENT: 136
};

const ICMPv6TypeName = {
    [ICMPv6Type.DEST_UNREACHABLE]: 'Destination Unreachable',
    [ICMPv6Type.ECHO_REQUEST]: 'Echo Request (Ping)',
    [ICMPv6Type.ECHO_REPLY]: 'Echo Reply (Pong)',
    [ICMPv6Type.ROUTER_SOLICITATION]: 'Router Solicitation (RS)',
    [ICMPv6Type.ROUTER_ADVERTISEMENT]: 'Router Advertisement (RA)',
    [ICMPv6Type.NEIGHBOR_SOLICITATION]: 'Neighbor Solicitation (NS)',
    [ICMPv6Type.NEIGHBOR_ADVERTISEMENT]: 'Neighbor Advertisement (NA)'
};

/**
 * Deterministically parses an ICMPv6 packet from a decrypted 6LoWPAN frame buffer
 * following the RFC 6282 IPHC specification used in Tado devices.
 *
 * @param {Buffer} buf - Decrypted plaintext payload (including MAC tail and Tado dispatch)
 * @returns {object|null} Parsed ICMPv6 message
 */
function parseICMPv6(buf) {
    if (!buf || buf.length < 8) return null;

    let offset = -1;

    // Case 1: Tado standard unicast framing (pt[3] == 0x04)
    // Modes 0x7A, 0x7B
    if (buf[3] === 0x04 && buf.length >= 13 && (buf[8] === 0x7A || buf[8] === 0x7B)) {
        if (buf[9] === 0x33 && buf[10] === 0x3A) {
            offset = 11;
        } else if ((buf[9] === 0xF7 || buf[9] === 0xF3) && buf[11] === 0x3A) {
            offset = 12;
        }
    }
    // Case 2: Direct 6LoWPAN 0x3B (RA: Router Advertisement, RS: Router Solicitation)
    // buf[3] = 0x3B, buf[4] = 0x3A (Next Header), buf[5] = hop limit -> ICMPv6 starts at offset 6
    else if (buf.length >= 10 && buf[3] === 0x3B && buf[4] === 0x3A) {
        offset = 6;
    }
    // Case 3: Direct 6LoWPAN 0x39 (NS: Neighbor Solicitation)
    // 00 00 7b 39 3a 02 01 ff 0d 95 30 87 00 c9 b4 ...
    // buf[3] = 0x39, buf[4] = 0x3A, hop limit (1B), addr compress flags (2B), 3B suffix -> ICMPv6 starts at offset 11
    else if (buf.length >= 15 && buf[3] === 0x39 && buf[4] === 0x3A) {
        offset = 11;
    }
    // Case 4: Direct 6LoWPAN 0xF9 (NS: Neighbor Solicitation with full hop limit byte)
    // 00 00 7b f9 00 3a 02 01 ff 3a dd 0f 87 00 ... -> ICMPv6 starts at offset 12
    else if (buf.length >= 16 && buf[3] === 0xF9 && buf[5] === 0x3A) {
        offset = 12;
    }

    if (offset === -1 || offset + 4 > buf.length) return null;

    // Extract standard RFC 4443 ICMPv6 Header (Type, Code, Checksum)
    const type = buf[offset];
    const code = buf[offset + 1];
    const checksum = buf.readUInt16BE(offset + 2);
    const body = buf.subarray(offset + 4);

    const parsed = {
        type,
        typeName: ICMPv6TypeName[type] || `Type ${type}`,
        code,
        checksum,
        body
    };

    // Protocol-specific payload decoding
    if (type === ICMPv6Type.ECHO_REQUEST || type === ICMPv6Type.ECHO_REPLY) {
        if (body.length >= 4) {
            parsed.identifier = body.readUInt16BE(0);
            parsed.sequence = body.readUInt16BE(2);
        } else if (body.length >= 2) {
            parsed.identifier = body.readUInt16BE(0);
            parsed.sequence = 0;
        }
    } else if (type === ICMPv6Type.NEIGHBOR_SOLICITATION) {
        if (body.length >= 20) {
            parsed.reserved = body.readUInt32BE(0);
            parsed.targetIp = formatIPv6(body.subarray(4, 20));
        }
    } else if (type === ICMPv6Type.NEIGHBOR_ADVERTISEMENT) {
        if (body.length >= 20) {
            const flagsByte = body[0];
            parsed.isRouter = (flagsByte & 0x80) !== 0;
            parsed.isSolicited = (flagsByte & 0x40) !== 0;
            parsed.isOverride = (flagsByte & 0x20) !== 0;
            parsed.targetIp = formatIPv6(body.subarray(4, 20));
        }
    } else if (type === ICMPv6Type.ROUTER_SOLICITATION) {
        parsed.reserved = body.length >= 4 ? body.readUInt32BE(0) : 0;
    } else if (type === ICMPv6Type.ROUTER_ADVERTISEMENT) {
        if (body.length >= 12) {
            parsed.curHopLimit = body[0];
            parsed.flags = body[1];
            parsed.routerLifetime = body.readUInt16BE(2);
            parsed.reachableTime = body.readUInt32BE(4);
            parsed.retransTimer = body.readUInt32BE(8);
        }
    }

    return parsed;
}

/**
 * Builds an ICMPv6 Echo Reply given an Echo Request.
 *
 * @param {number} identifier
 * @param {number} sequence
 * @param {Buffer} payload
 * @returns {Buffer}
 */
function buildEchoReply(identifier, sequence = 0, payload = Buffer.alloc(0)) {
    const header = Buffer.alloc(8);
    header[0] = ICMPv6Type.ECHO_REPLY;
    header[1] = 0; // Code 0
    header.writeUInt16BE(0, 2); // Checksum placeholder
    header.writeUInt16BE(identifier, 4);
    header.writeUInt16BE(sequence, 6);

    const packet = Buffer.concat([header, payload]);
    let sum = 0;
    for (let i = 0; i < packet.length - 1; i += 2) {
        sum += packet.readUInt16BE(i);
    }
    if (packet.length % 2 !== 0) {
        sum += packet[packet.length - 1] << 8;
    }
    while (sum > 0xFFFF) {
        sum = (sum & 0xFFFF) + (sum >> 16);
    }
    packet.writeUInt16BE(~sum & 0xFFFF, 2);

    return packet;
}

function formatIPv6(buf) {
    if (!buf || buf.length !== 16) return '';
    const parts = [];
    for (let i = 0; i < 16; i += 2) {
        parts.push(buf.readUInt16BE(i).toString(16));
    }
    return parts.join(':');
}

module.exports = {
    ICMPv6Type,
    ICMPv6TypeName,
    parseICMPv6,
    buildEchoReply
};
