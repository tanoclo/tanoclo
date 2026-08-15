/**
 * @file lib/coap.js
 * @brief Low-level CoAP protocol parser and serializer utilities.
 */

'use strict';

/**
 * CoAP (RFC 7252) message parser and serializer.
 * 
 * Header format (4 bytes):
 *   [ver:2][type:2][tkl:4] [code:8] [message_id:16]
 *   [token: tkl bytes]
 *   [options...]
 *   [0xFF payload_marker] [payload...]
 */

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
const CODE_CREATED = 0x41;  // 2.01
const CODE_DELETED = 0x42;  // 2.02
const CODE_VALID = 0x43;  // 2.03
const CODE_CHANGED = 0x44;  // 2.04
const CODE_CONTENT = 0x45;  // 2.05
const CODE_CONTINUE = 0x5F; // 2.31
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
 * Format a CoAP code byte as "C.DD" string
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
    if (val <= 0xFFFF) { const b = Buffer.alloc(2); b.writeUInt16BE(val); return b; }
    if (val <= 0xFFFFFF) { const b = Buffer.alloc(3); b[0] = (val >> 16) & 0xFF; b.writeUInt16BE(val & 0xFFFF, 1); return b; }
    const b = Buffer.alloc(4); b.writeUInt32BE(val); return b;
}

/**
 * Decode a CoAP option value as unsigned integer
 */
function decOptUint(buf) {
    if (buf.length === 0) return 0;
    if (buf.length === 1) return buf[0];
    if (buf.length === 2) return buf.readUInt16BE(0);
    if (buf.length === 3) return (buf[0] << 16) | buf.readUInt16BE(1);
    if (buf.length === 4) return buf.readUInt32BE(0);
    return 0;
}

/**
 * Parse a CoAP message from binary data
 * @param {Buffer} data - Raw CoAP bytes
 * @returns {Object} Parsed CoAP message
 */
function parse(data) {
    if (!Buffer.isBuffer(data)) data = Buffer.from(data);

    if (data.length < 4) {
        return { ok: false, err: `CoAP message too short: ${data.length}` };
    }

    const byte0 = data[0];
    const ver = (byte0 >> 6) & 0x3;
    const type = (byte0 >> 4) & 0x3;
    const tkl = byte0 & 0x0F;
    const code = data[1];
    const mid = data.readUInt16BE(2);

    let cur = 4;

    // Token
    if (cur + tkl > data.length) {
        return { ok: false, err: `Token length ${tkl} exceeds data` };
    }
    const token = data.subarray(cur, cur + tkl);
    cur += tkl;

    // Options
    const options = [];
    let optNum = 0;

    while (cur < data.length) {
        if (data[cur] === 0xFF) {
            cur++; // payload marker
            break;
        }

        const delta4 = (data[cur] >> 4) & 0x0F;
        const len4 = data[cur] & 0x0F;
        cur++;

        // RFC 7252: nibble 15 is reserved. Tado sometimes uses options with
        // reserved nibbles. Instead of failing, scan forward for 0xFF payload marker.
        if (delta4 === 15 || len4 === 15) {
            // Scan for 0xFF payload marker from current position
            let found = false;
            for (let j = cur; j < data.length; j++) {
                if (data[j] === 0xFF) {
                    cur = j + 1;
                    found = true;
                    break;
                }
            }
            if (!found) cur = data.length; // no payload marker found
            break;
        }

        let delta, optLen;

        // Delta
        if (delta4 < 13) {
            delta = delta4;
        } else if (delta4 === 13) {
            if (cur >= data.length) break;
            delta = data[cur++] + 13;
        } else if (delta4 === 14) {
            if (cur + 1 >= data.length) break;
            delta = data.readUInt16BE(cur) + 269;
            cur += 2;
        } else {
            break;
        }

        // Length
        if (len4 < 13) {
            optLen = len4;
        } else if (len4 === 13) {
            if (cur >= data.length) break;
            optLen = data[cur++] + 13;
        } else if (len4 === 14) {
            if (cur + 1 >= data.length) break;
            optLen = data.readUInt16BE(cur) + 269;
            cur += 2;
        } else {
            break;
        }

        optNum += delta;

        if (cur + optLen > data.length) break;

        const optValue = Buffer.from(data.subarray(cur, cur + optLen));
        cur += optLen;

        options.push({ num: optNum, value: optValue });
    }

    // Payload
    const payload = cur < data.length ? Buffer.from(data.subarray(cur)) : Buffer.alloc(0);

    return {
        ok: true,
        ver,
        type,
        tkl,
        code,
        mid,
        token: Buffer.from(token),
        options,
        payload,
    };
}

/**
 * Get the URI path from parsed CoAP options
 */
function uriPath(coap) {
    const segments = coap.options
        .filter(o => o.num === OPT_URI_PATH)
        .map(o => o.value.toString('utf-8'));
    return segments.join('/');
}

/**
 * Get all values for a specific option number
 */
function optionValues(coap, optNum) {
    return coap.options.filter(o => o.num === optNum).map(o => o.value);
}

/**
 * Get the first value for a specific option as uint
 */
function optionUint(coap, optNum) {
    const vals = optionValues(coap, optNum);
    if (vals.length === 0) return null;
    return decOptUint(vals[0]);
}

/**
 * Get the first raw value for a specific option
 */
function optionFirst(coap, optNum) {
    const vals = optionValues(coap, optNum);
    return vals.length > 0 ? vals[0] : null;
}

/**
 * Get the Vendor 2048 (Session Token) option value
 */
function getOptionVendor2048(coap) {
    return optionFirst(coap, OPT_VENDOR_2048);
}

/**
 * Serialize a CoAP message to binary
 * @param {Object} msg - {ver, type, code, mid, token, options: [{num, value}], payload}
 * @returns {Buffer}
 */
function serialize(msg) {
    const token = msg.token || Buffer.alloc(0);
    const tkl = token.length;
    const payload = msg.payload || Buffer.alloc(0);

    // Sort options by number
    const sortedOpts = [...(msg.options || [])].sort((a, b) => a.num - b.num);

    // Calculate option bytes
    const optBufs = [];
    let prevNum = 0;

    for (const opt of sortedOpts) {
        let delta = opt.num - prevNum;
        prevNum = opt.num;
        const value = opt.value || Buffer.alloc(0);
        const vLen = value.length;

        // Encode delta
        let deltaField, deltaExt;
        if (delta < 13) {
            deltaField = delta;
            deltaExt = Buffer.alloc(0);
        } else if (delta < 269) {
            deltaField = 13;
            deltaExt = Buffer.from([delta - 13]);
        } else {
            deltaField = 14;
            deltaExt = Buffer.alloc(2);
            deltaExt.writeUInt16BE(delta - 269);
        }

        // Encode length
        let lenField, lenExt;
        if (vLen < 13) {
            lenField = vLen;
            lenExt = Buffer.alloc(0);
        } else if (vLen < 269) {
            lenField = 13;
            lenExt = Buffer.from([vLen - 13]);
        } else {
            lenField = 14;
            lenExt = Buffer.alloc(2);
            lenExt.writeUInt16BE(vLen - 269);
        }

        const header = Buffer.from([(deltaField << 4) | lenField]);
        optBufs.push(header, deltaExt, lenExt, value);
    }

    const optBytes = Buffer.concat(optBufs);

    // Header (4 bytes) + token + options + optional payload marker + payload
    const hasPayload = payload.length > 0;
    const totalLen = 4 + tkl + optBytes.length + (hasPayload ? 1 + payload.length : 0);
    const buf = Buffer.alloc(totalLen);
    let off = 0;

    buf[off++] = ((msg.ver ?? 1) << 6) | (((msg.type != null ? msg.type : TYPE_ACK)) << 4) | tkl;

    let code = msg.code;
    if (typeof code === 'string') {
        if (code.includes('.')) {
            const [c, d] = code.split('.').map(Number);
            code = (c << 5) | d;
        } else {
            code = Number(code);
        }
    }
    buf[off++] = code;
    buf.writeUInt16BE(msg.mid, off); off += 2;
    token.copy(buf, off); off += tkl;
    optBytes.copy(buf, off); off += optBytes.length;

    if (hasPayload) {
        buf[off++] = 0xFF;
        payload.copy(buf, off);
    }

    return buf;
}

/**
 * Build a simple CoAP ACK response (2.04 Changed, no payload)
 */
function buildAck(requestCoap, responseCode = CODE_CHANGED) {
    return serialize({
        ver: 1,
        type: TYPE_ACK,
        code: responseCode,
        mid: requestCoap.mid,
        token: requestCoap.token,
        options: [],
        payload: Buffer.alloc(0),
    });
}

/**
 * Build a CoAP ACK response with TLV payload
 */
function buildAckWithPayload(requestCoap, responseCode, payload) {
    return serialize({
        ver: 1,
        type: TYPE_ACK,
        code: responseCode,
        mid: requestCoap.mid,
        token: requestCoap.token,
        options: [],
        payload,
    });
}

/**
 * Build a CoAP ACK response with custom options and optional payload.
 * Used for GET responses that need ETag, Block2, Content-Format, etc.
 */
function buildAckWithOptions(requestCoap, responseCode, options = [], payload = Buffer.alloc(0)) {
    return serialize({
        ver: 1,
        type: TYPE_ACK,
        code: responseCode,
        mid: requestCoap.mid,
        token: requestCoap.token,
        options,
        payload,
    });
}

/**
 * Build a CoAP response message (not tied to an incoming request MID).
 */
function buildResponse({ code, token, mid, type = TYPE_NON, payload = Buffer.alloc(0), options = [] }) {
    return serialize({
        ver: 1,
        type,
        code,
        mid: mid || 0,
        token: token || Buffer.alloc(0),
        options,
        payload: payload || Buffer.alloc(0),
    });
}

/**
 * Build a CoAP request message
 */
function buildRequest({ code, path, token, mid, type = TYPE_NON, payload, contentFormat, query, extraOptions = [] }) {
    const options = [];

    const [cleanPath, pathQuery] = path.split('?');
    const segments = cleanPath.replace(/^\/+/, '').split('/').filter(Boolean);
    for (const seg of segments) {
        options.push({ num: OPT_URI_PATH, value: Buffer.from(seg, 'utf-8') });
    }

    const fullQueryParts = [];
    if (pathQuery) fullQueryParts.push(pathQuery);
    if (query != null) fullQueryParts.push(query);

    if (fullQueryParts.length > 0) {
        const queryParams = fullQueryParts.join('&').split('&').filter(Boolean);
        for (const q of queryParams) {
            options.push({ num: OPT_URI_QUERY, value: Buffer.from(q, 'utf-8') });
        }
    }

    if (contentFormat != null) {
        options.push({ num: OPT_CONTENT_FORMAT, value: encOptUint(contentFormat) });
    }

    for (const opt of extraOptions) {
        options.push(opt);
    }

    return serialize({
        ver: 1,
        type,
        code,
        mid: mid || 0,
        token: token || Buffer.alloc(0),
        options,
        payload: payload || Buffer.alloc(0),
    });
}

/**
 * Encode a Block2 option value.
 * @param {number} num - Block number
 * @param {number} more - More flag (0 or 1)
 * @param {number} szx - Size exponent (block size = 2^(szx+4))
 * @returns {Buffer}
 */
function encodeBlock2(num, more, szx) {
    const val = (num << 4) | ((more & 1) << 3) | (szx & 0x7);
    return encOptUint(val);
}

/**
 * Decode a Block option (Block1 or Block2) value.
 * @param {Buffer} buf - Raw option value bytes
 * @returns {{ num: number, more: number, szx: number, blockSize: number } | null}
 */
function decodeBlock(buf) {
    if (!buf || buf.length === 0 || buf.length > 3) return null;
    const x = decOptUint(buf);
    const szx = x & 0x7;
    const more = (x >> 3) & 0x1;
    const num = x >> 4;
    if (szx === 7) return null;
    return { num, more, szx, blockSize: 1 << (szx + 4) };
}

/**
 * Decode a protobuf-encoded time payload (for /time endpoint).
 * Format: 0x0D tag (protobuf field 1, wire type 5 = fixed32) + LE u32 unix timestamp.
 *
 * @param {Buffer} payload - 5-byte protobuf time payload
 * @returns {{ ok: boolean, unix_s?: number, utc?: string, err?: string }}
 */
function decodeTimeProtobuf(payload) {
    if (!payload || payload.length !== 5) {
        return { ok: false, err: 'expected 5 bytes' };
    }
    if (payload[0] !== 0x0D) {
        return { ok: false, err: `expected tag 0x0D, got 0x${payload[0].toString(16)}` };
    }
    const unix_s = payload.readUInt32LE(1);
    const utc = new Date(unix_s * 1000).toISOString().replace('.000Z', 'Z');
    return { ok: true, unix_s, utc };
}

/**
 * Encode a Unix timestamp as a protobuf time payload (for /time endpoint).
 * @param {number} unixSeconds - Unix timestamp in seconds
 * @returns {Buffer} 5-byte protobuf payload
 */
function encodeTimeProtobuf(unixSeconds) {
    const buf = Buffer.alloc(5);
    buf[0] = 0x0D; // protobuf tag: field 1, wire type 5 (fixed32)
    buf.writeUInt32LE(unixSeconds >>> 0, 1);
    return buf;
}

module.exports = {
    parse, serialize, uriPath, optionValues, optionUint, optionFirst,
    codeStr, isRequest, encOptUint, decOptUint,
    buildAck, buildAckWithPayload, buildAckWithOptions, buildResponse, buildRequest,
    encodeBlock2, decodeBlock,
    decodeTimeProtobuf, encodeTimeProtobuf,
    getOptionVendor2048,
    TYPE_CON, TYPE_NON, TYPE_ACK, TYPE_RST,
    CODE_GET, CODE_POST, CODE_PUT, CODE_DELETE,
    CODE_CREATED, CODE_DELETED, CODE_VALID, CODE_CHANGED, CODE_CONTENT, CODE_CONTINUE, CODE_GATEWAY_TIMEOUT,
    OPT_IF_MATCH, OPT_MAX_AGE, OPT_URI_HOST, OPT_LOCATION_PATH,
    OPT_URI_PATH, OPT_CONTENT_FORMAT, OPT_URI_QUERY, OPT_ACCEPT,
    OPT_BLOCK1, OPT_BLOCK2, OPT_ETAG, OPT_VENDOR_2048,
};
