/**
 * @file lib/coap.js
 * @brief RFC 7252 CoAP parser and serializer with Tado protocol customizations.
 */

'use strict';

// CoAP types
const TYPE_CON = 0; // Confirmable
const TYPE_NON = 1; // Non-confirmable
const TYPE_ACK = 2; // Acknowledgement
const TYPE_RST = 3; // Reset

// CoAP request codes
const CODE_GET = 1;
const CODE_POST = 2;
const CODE_PUT = 3;
const CODE_DELETE = 4;

// CoAP response codes
const CODE_CREATED = 0x41;         // 2.01
const CODE_DELETED = 0x42;         // 2.02
const CODE_VALID = 0x43;           // 2.03
const CODE_CHANGED = 0x44;         // 2.04
const CODE_CONTENT = 0x45;         // 2.05
const CODE_CONTINUE = 0x5F;        // 2.31
const CODE_BAD_REQUEST = 0x80;     // 4.00
const CODE_UNAUTHORIZED = 0x81;    // 4.01
const CODE_BAD_OPTION = 0x82;      // 4.02
const CODE_FORBIDDEN = 0x83;       // 4.03
const CODE_NOT_FOUND = 0x84;       // 4.04
const CODE_METHOD_NOT_ALLOWED = 0x85; // 4.05
const CODE_GATEWAY_TIMEOUT = 0xA4; // 5.04

// Option numbers
const OPT_IF_MATCH = 1;
const OPT_MAX_AGE = 2;
const OPT_URI_HOST = 3;
const OPT_ETAG = 4;
const OPT_LOCATION_PATH = 7;
const OPT_URI_PATH = 11;
const OPT_CONTENT_FORMAT = 12;
const OPT_URI_QUERY = 15;
const OPT_ACCEPT = 17;
const OPT_BLOCK2 = 23;
const OPT_BLOCK1 = 27;
const OPT_VENDOR_2048 = 2048;

/**
 * Format a CoAP code byte as "C.DD" string or METHOD name.
 */
function codeStr(code) {
    if (code >= 1 && code <= 4) {
        return ['GET', 'POST', 'PUT', 'DELETE'][code - 1];
    }
    const cls = (code >> 5) & 0x7;
    const detail = code & 0x1F;
    return `${cls}.${detail.toString().padStart(2, '0')}`;
}

/**
 * Check if a code is a request (1-4)
 */
function isRequest(code) {
    return code >= 1 && code <= 4;
}

/**
 * Encode an unsigned integer as CoAP option value bytes (variable length)
 */
function encOptUint(val) {
    if (val === 0) return Buffer.alloc(0);
    if (val <= 0xFF) return Buffer.from([val]);
    if (val <= 0xFFFF) {
        const b = Buffer.alloc(2);
        b.writeUInt16BE(val);
        return b;
    }
    if (val <= 0xFFFFFF) {
        const b = Buffer.alloc(3);
        b[0] = (val >> 16) & 0xFF;
        b.writeUInt16BE(val & 0xFFFF, 1);
        return b;
    }
    const b = Buffer.alloc(4);
    b.writeUInt32BE(val);
    return b;
}

/**
 * Decode a CoAP option value as unsigned integer
 */
function decOptUint(buf) {
    if (!buf || buf.length === 0) return 0;
    if (buf.length === 1) return buf[0];
    if (buf.length === 2) return buf.readUInt16BE(0);
    if (buf.length === 3) return (buf[0] << 16) | buf.readUInt16BE(1);
    if (buf.length === 4) return buf.readUInt32BE(0);
    return 0;
}

/**
 * Validates whether a parsed CoAP struct is semantically valid according to RFC 7252.
 */
function isValidCoap(parsed) {
    if (!parsed || !parsed.ok) return false;
    if (parsed.ver !== 1) return false;

    // Type must be 0-3 (CON, NON, ACK, RST)
    if (parsed.type < 0 || parsed.type > 3) return false;

    // Code class must be 0 (Request), 2 (Success), 4 (Client Error), or 5 (Server Error)
    const cls = (parsed.code >> 5) & 0x07;
    if (cls !== 0 && cls !== 2 && cls !== 4 && cls !== 5) return false;

    // Empty message validation
    if (parsed.code === 0) {
        // Empty message MUST have type ACK (2) or RST (3)
        if (parsed.type !== 2 && parsed.type !== 3) return false;
        // Empty message MUST NOT have a token
        if (parsed.tkl !== 0) return false;
        // Empty message MUST NOT have options
        if (parsed.options && parsed.options.length > 0) return false;
        // Empty message MUST NOT have payload
        if (parsed.payload && parsed.payload.length > 0) return false;
    } else {
        // Non-empty message MUST NOT be type RST (3)
        if (parsed.type === 3) return false;
    }

    // Reject false positive matches on random/checksum bytes:
    // RFC 7252: Error responses (4.xx / 5.xx) on ACKs without valid options or payload with TKL >= 4 are invalid.
    if (parsed.code >= 0x80 && (!parsed.options || parsed.options.length === 0) && (!parsed.payload || parsed.payload.length === 0) && parsed.tkl >= 4) {
        return false;
    }

    return true;
}

/**
 * Deterministically locates the start offset of a CoAP message within an inner UDP payload.
 * Correctly decodes 6LoWPAN dispatch & NHC headers to prevent false positives from UDP checksum bytes.
 */
function findCoapOffset(payload) {
    if (!payload || payload.length <= 4) return -1;

    const candidates = [];

    // 1. Unicast operational frames with 8-byte prefix (3B MAC tail + 1B Proto + 4B Seq)
    if (payload.length > 8 && payload[3] === 0x04) {
        const dispatch = payload[8];
        if (dispatch === 0x7E) {
            // 0x7E = Tado custom 6LoWPAN UDP
            if (payload.length > 10 && payload[9] === 0x33 && (payload[10] & 0xF0) === 0xF0) {
                const portsComp = payload[10] & 0x03;
                if (portsComp === 0) candidates.push(17); // 8 + 1(0x7E) + 2(0x33,0xF0) + 2(src) + 2(dst) + 2(csum) = 17
                else if (portsComp === 1 || portsComp === 2) candidates.push(16);
                else if (portsComp === 3) candidates.push(14);
            } else if (payload.length > 9 && (payload[9] & 0xF8) === 0xF0) {
                const portsComp = payload[9] & 0x03;
                if (portsComp === 0) candidates.push(15);
                else if (portsComp === 1 || portsComp === 2) candidates.push(14);
                else if (portsComp === 3) candidates.push(12);
            }
            candidates.push(17, 15, 14, 12);
        } else if ((dispatch & 0xF8) === 0xF0) {
            const portsComp = dispatch & 0x03;
            if (portsComp === 0) candidates.push(15);
            else if (portsComp === 3) candidates.push(12);
            candidates.push(15, 14, 12);
        }
    }

    // 2. Broadcast / stripped headers (e.g. 0x00 0x00 0x7E or direct 0x33/0xF0)
    if (payload.length > 2 && payload[0] === 0x00 && payload[1] === 0x00 && payload[2] === 0x7E) {
        candidates.push(11, 9, 8);
    }
    if (payload.length > 2 && payload[0] === 0x33 && payload[1] === 0xF0) {
        candidates.push(8);
    }
    if (payload.length > 1 && (payload[0] & 0xF8) === 0xF0) {
        candidates.push((payload[0] & 0x03) === 3 ? 4 : 7);
    }

    // Add common fallback candidate offsets
    candidates.push(17, 15, 14, 13, 12, 11, 8, 4);

    const checked = new Set();
    for (const offset of candidates) {
        if (offset > 0 && offset <= payload.length - 4 && !checked.has(offset)) {
            checked.add(offset);
            const parsed = parse(payload.subarray(offset));
            if (isValidCoap(parsed)) {
                return offset;
            }
        }
    }

    // 3. Fallback scan starting at offset 10 to avoid matching on outer headers
    for (let i = 10; i <= payload.length - 4; i++) {
        if (!checked.has(i)) {
            const parsed = parse(payload.subarray(i));
            if (isValidCoap(parsed)) {
                return i;
            }
        }
    }
    return -1;
}

/**
 * Internal parser for CoAP binary bytes.
 */
function parseInternal(data) {
    if (data.length < 4) {
        return { ok: false, error: 'CoAP message too short (< 4 bytes)' };
    }

    const byte0 = data[0];
    const ver = (byte0 >> 6) & 0x3;
    const type = (byte0 >> 4) & 0x3;
    const tkl = byte0 & 0xF;

    if (ver !== 1) {
        return { ok: false, error: `Unsupported CoAP version: ${ver}` };
    }

    const code = data[1];
    const mid = data.readUInt16BE(2);

    if (4 + tkl > data.length) {
        return { ok: false, error: 'Token length exceeds message size' };
    }

    const token = data.subarray(4, 4 + tkl);
    let offset = 4 + tkl;

    const options = [];
    let currentOptNum = 0;

    while (offset < data.length) {
        if (data[offset] === 0xFF) {
            offset++; // skip payload marker
            break;
        }

        const optByte = data[offset++];
        let delta = (optByte >> 4) & 0xF;
        let length = optByte & 0xF;

        // Defensive Tado firmware workaround: if nibbles hit reserved 15, seek 0xFF payload marker
        if (delta === 15 || length === 15) {
            const markerIdx = data.indexOf(0xFF, offset);
            if (markerIdx !== -1) {
                offset = markerIdx + 1;
            } else {
                offset = data.length;
            }
            break;
        }

        if (delta === 13) {
            if (offset >= data.length) return { ok: false, error: 'Truncated option delta (1 byte)' };
            delta = data[offset++] + 13;
        } else if (delta === 14) {
            if (offset + 1 >= data.length) return { ok: false, error: 'Truncated option delta (2 bytes)' };
            delta = data.readUInt16BE(offset) + 269;
            offset += 2;
        }

        if (length === 13) {
            if (offset >= data.length) return { ok: false, error: 'Truncated option length (1 byte)' };
            length = data[offset++] + 13;
        } else if (length === 14) {
            if (offset + 1 >= data.length) return { ok: false, error: 'Truncated option length (2 bytes)' };
            length = data.readUInt16BE(offset) + 269;
            offset += 2;
        }

        if (offset + length > data.length) {
            return { ok: false, error: 'Option value exceeds message size' };
        }

        currentOptNum += delta;
        options.push({
            num: currentOptNum,
            name: getOptionName(currentOptNum),
            value: data.subarray(offset, offset + length)
        });
        offset += length;
    }

    const payload = offset < data.length ? data.subarray(offset) : Buffer.alloc(0);

    return {
        ok: true,
        ver,
        type,
        tkl,
        code,
        mid,
        token,
        options,
        payload
    };
}

/**
 * Parse a CoAP message from binary data with trailing 802.15.4 Kermit CRC16 fallback.
 * @param {Buffer} data - Raw CoAP bytes
 * @returns {object} Parsed CoAP object
 */
function parse(data) {
    if (!Buffer.isBuffer(data)) data = Buffer.from(data);

    let res = parseInternal(data);
    if (!res.ok && data.length > 6 && !data.includes(0xFF)) {
        // If parsing failed due to trailing 2-byte frame CRC, try without the trailing 2 bytes
        const resNoCrc = parseInternal(data.subarray(0, -2));
        if (resNoCrc.ok) return resNoCrc;
    }
    return res;
}

/**
 * Serialize a CoAP message into binary Buffer.
 * @param {object} msg - CoAP message descriptor
 * @returns {Buffer} Serialized CoAP bytes
 */
function serialize(msg) {
    const ver = msg.ver !== undefined ? msg.ver : 1;
    const type = msg.type || 0;
    const code = msg.code || 0;
    const mid = msg.mid || 0;
    const token = msg.token || Buffer.alloc(0);
    const tkl = token.length;

    const sortedOptions = (msg.options || []).slice().sort((a, b) => a.num - b.num);

    const optionBufs = [];
    let prevNum = 0;

    for (const opt of sortedOptions) {
        const delta = opt.num - prevNum;
        prevNum = opt.num;

        const val = opt.value || Buffer.alloc(0);
        const len = val.length;

        let deltaNibble, deltaExt = [];
        if (delta < 13) {
            deltaNibble = delta;
        } else if (delta < 269) {
            deltaNibble = 13;
            deltaExt = [delta - 13];
        } else {
            deltaNibble = 14;
            const diff = delta - 269;
            deltaExt = [(diff >> 8) & 0xFF, diff & 0xFF];
        }

        let lenNibble, lenExt = [];
        if (len < 13) {
            lenNibble = len;
        } else if (len < 269) {
            lenNibble = 13;
            lenExt = [len - 13];
        } else {
            lenNibble = 14;
            const diff = len - 269;
            lenExt = [(diff >> 8) & 0xFF, diff & 0xFF];
        }

        const optHeader = (deltaNibble << 4) | lenNibble;
        optionBufs.push(Buffer.from([optHeader, ...deltaExt, ...lenExt]));
        optionBufs.push(val);
    }

    const header = Buffer.alloc(4);
    header[0] = ((ver & 0x3) << 6) | ((type & 0x3) << 4) | (tkl & 0xF);
    header[1] = code;
    header.writeUInt16BE(mid, 2);

    const parts = [header, token, ...optionBufs];
    if (msg.payload && msg.payload.length > 0) {
        parts.push(Buffer.from([0xFF])); // payload marker
        parts.push(msg.payload);
    }

    return Buffer.concat(parts);
}

function getOptionName(num) {
    switch (num) {
        case OPT_IF_MATCH: return 'If-Match';
        case OPT_MAX_AGE: return 'Max-Age';
        case OPT_URI_HOST: return 'Uri-Host';
        case OPT_ETAG: return 'ETag';
        case OPT_LOCATION_PATH: return 'Location-Path';
        case OPT_URI_PATH: return 'Uri-Path';
        case OPT_CONTENT_FORMAT: return 'Content-Format';
        case OPT_URI_QUERY: return 'Uri-Query';
        case OPT_ACCEPT: return 'Accept';
        case OPT_BLOCK2: return 'Block2';
        case OPT_BLOCK1: return 'Block1';
        case OPT_VENDOR_2048: return 'Tado-Token-2048';
        default: return `Option-${num}`;
    }
}

module.exports = {
    TYPE_CON,
    TYPE_NON,
    TYPE_ACK,
    TYPE_RST,
    CODE_GET,
    CODE_POST,
    CODE_PUT,
    CODE_DELETE,
    CODE_CREATED,
    CODE_DELETED,
    CODE_VALID,
    CODE_CHANGED,
    CODE_CONTENT,
    CODE_CONTINUE,
    CODE_BAD_REQUEST,
    CODE_UNAUTHORIZED,
    CODE_BAD_OPTION,
    CODE_FORBIDDEN,
    CODE_NOT_FOUND,
    CODE_METHOD_NOT_ALLOWED,
    CODE_GATEWAY_TIMEOUT,
    OPT_IF_MATCH,
    OPT_MAX_AGE,
    OPT_URI_HOST,
    OPT_ETAG,
    OPT_LOCATION_PATH,
    OPT_URI_PATH,
    OPT_CONTENT_FORMAT,
    OPT_URI_QUERY,
    OPT_ACCEPT,
    OPT_BLOCK2,
    OPT_BLOCK1,
    OPT_VENDOR_2048,
    codeStr,
    isRequest,
    encOptUint,
    decOptUint,
    isValidCoap,
    findCoapOffset,
    parse,
    serialize
};
