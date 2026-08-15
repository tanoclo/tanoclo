/**
 * @file lib/message-cache.js
 * @brief Temporary cache to deduplicate duplicate request messages.
 */

'use strict';

/**
 * Message Cache — full-decode, request-pairing, and JSON-persisted message log.
 *
 * Every cached message is decoded through the full pipeline:
 *   WS Bridge Frame → CoAP Header/Options → TLV or Time-Protobuf payload
 *
 * Server-to-client responses are automatically paired with the original
 * client-to-server request (matched by ipv6:mid key).
 *
 * Persisted to daily JSON files in the log directory with 7-day retention.
 */

const fs = require('fs');
const path = require('path');
const wsBridge = require('./ws-bridge');
const coap = require('./coap');
const tlv = require('./tlv');

const MAX_ENTRIES_PER_PATH = 10;
const MAX_MISMATCHES_PER_PATH = 50;
const RETENTION_DAYS = 7;
const SAVE_DEBOUNCE_MS = 2000;
const REQUEST_TTL_MS = 30000;

const COAP_TYPE_NAMES = { 0: 'CON', 1: 'NON', 2: 'ACK', 3: 'RST' };

let _logDir = null;
let _cache = {};           // deviceId → path → source → [entries]
let _requestStore = new Map(); // `${ipv6}:${mid}` → { hex, decoded, timestamp }
let _ipv6Resolver = null;  // optional (ipv6) => deviceId
let _currentDate = null;
let _saveTimer = null;
let _log = console.log;

// ─── Initialization ────────────────────────────────────────────────

function init({ logDir, log, ipv6Resolver }) {
    _logDir = logDir;
    if (log) _log = log;
    if (ipv6Resolver) _ipv6Resolver = ipv6Resolver;
    _currentDate = todayStr();
    loadFromFile();
    cleanOldFiles();
}

// ─── Date helpers ──────────────────────────────────────────────────

function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

function getFilePath(dateStr) {
    return path.join(_logDir, `message_cache.${dateStr}.json`);
}

// ─── File I/O ──────────────────────────────────────────────────────

function loadFromFile() {
    try {
        const fp = getFilePath(_currentDate);
        if (fs.existsSync(fp)) {
            const raw = fs.readFileSync(fp, 'utf-8');
            _cache = JSON.parse(raw);
            _log('debug', `[msg-cache] Loaded ${fp}`);
        }
    } catch (e) {
        _log('error', `[msg-cache] Failed to load cache file: ${e.message}`);
        _cache = {};
    }
}

function saveToFile() {
    try {
        checkDateRollover();
        const fp = getFilePath(_currentDate);
        const tmpFp = `${fp}.tmp`;

        // Stringify first into memory to ensure it's valid before we touch the file system
        const json = JSON.stringify(_cache, null, 2);

        // Write to temporary file
        fs.writeFileSync(tmpFp, json, 'utf-8');

        // Atomically rename temporary file to destination
        fs.renameSync(tmpFp, fp);

        // _log('debug', `[msg-cache] Saved ${fp} (atomic)`);
    } catch (e) {
        _log('error', `[msg-cache] Failed to save cache file: ${e.message}`);
    }
}

function scheduleSave() {
    if (_saveTimer) return;
    _saveTimer = setTimeout(() => {
        _saveTimer = null;
        saveToFile();
    }, SAVE_DEBOUNCE_MS);
}

function checkDateRollover() {
    const today = todayStr();
    if (today !== _currentDate) {
        _currentDate = today;
        _cache = {};
        cleanOldFiles();
    }
}

function cleanOldFiles() {
    try {
        const files = fs.readdirSync(_logDir);
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

        for (const file of files) {
            if (!file.startsWith('message_cache.') || !file.endsWith('.json')) continue;
            const dateMatch = file.match(/message_cache\.(\d{4}-\d{2}-\d{2})\.json/);
            if (!dateMatch) continue;
            const fileDate = new Date(dateMatch[1] + 'T00:00:00Z');
            if (fileDate < cutoff) {
                fs.unlinkSync(path.join(_logDir, file));
                _log('debug', `[msg-cache] Cleaned old file: ${file}`);
            }
        }
    } catch (e) {
        _log('error', `[msg-cache] Failed to clean old files: ${e.message}`);
    }
}

// ─── Full message decoder ──────────────────────────────────────────

/**
 * Decode a raw WS binary message into a structured object.
 * Pipeline: WS Bridge Frame → CoAP Header/Options → TLV / time-protobuf payload.
 *
 * @param {Buffer|string} rawData - Raw binary or hex string
 * @returns {Object|null} Decoded structure or null on failure
 */
function decodeMessage(rawData) {
    if (!rawData) return null;
    const data = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData, 'hex');

    const frame = wsBridge.parse(data);
    if (!frame.ok) return null;

    const coapMsg = coap.parse(frame.coapBytes);
    if (!coapMsg.ok) return null;

    const uriPathStr = coap.uriPath(coapMsg);
    const codeStr = coap.codeStr(coapMsg.code);
    const isReq = coap.isRequest(coapMsg.code);

    // Decode options into readable form
    const options = coapMsg.options.map(opt => {
        const entry = { num: opt.num, hex: opt.value.toString('hex') };
        switch (opt.num) {
            case coap.OPT_URI_PATH:
                entry.uri_path = opt.value.toString('utf-8'); break;
            case coap.OPT_URI_QUERY:
                entry.uri_query = opt.value.toString('utf-8'); break;
            case coap.OPT_CONTENT_FORMAT:
                entry.content_format = coap.decOptUint(opt.value); break;
            case coap.OPT_ETAG:
                entry.etag = opt.value.toString('hex'); break;
            case coap.OPT_BLOCK1:
            case coap.OPT_BLOCK2: {
                const block = coap.decodeBlock(opt.value);
                if (block) entry.block = block;
                break;
            }
        }
        return entry;
    });

    // Decode payload
    let payload = null;
    if (coapMsg.payload.length > 0) {
        // Try time protobuf first (5 bytes, tag 0x0D)
        if (coapMsg.payload.length === 5 && coapMsg.payload[0] === 0x0D) {
            const timeResult = coap.decodeTimeProtobuf(coapMsg.payload);
            if (timeResult.ok) {
                payload = {
                    type: 'time_protobuf',
                    hex: coapMsg.payload.toString('hex'),
                    unix_s: timeResult.unix_s,
                    utc: timeResult.utc,
                };
            }
        }

        // Try TLV
        if (!payload && coapMsg.payload.length >= 3) {
            const decoded = tlv.decode(coapMsg.payload);
            if (decoded && decoded.ok && decoded.items.length > 0) {
                payload = {
                    type: 'tlv',
                    hex: coapMsg.payload.toString('hex'),
                    fields: decoded.fields,
                    items: decoded.items,
                };
            }
        }

        // Fallback: raw hex
        if (!payload) {
            payload = {
                type: 'raw',
                hex: coapMsg.payload.toString('hex'),
            };
        }
    }

    return {
        bridge: {
            direction: frame.direction,
            ipv6: frame.ipv6,
            fieldA: frame.fieldA,
            fieldB: frame.fieldB,
            udpPort: frame.udpPort,
            fieldC: frame.fieldC,
        },
        coap: {
            type: COAP_TYPE_NAMES[coapMsg.type] || `UNKNOWN(${coapMsg.type})`,
            code: codeStr,
            codeRaw: coapMsg.code,
            mid: coapMsg.mid,
            token: coapMsg.token.toString('hex'),
            isRequest: isReq,
            path: uriPathStr || null,
            options,
        },
        payload,
    };
}

/**
 * Deep compare two decoded CoAP messages, ignoring transient fields (MID, token, timestamps).
 */
function isMismatched(d1, d2) {
    if (!d1 || !d2) return false;

    // Helper to strip transient fields for comparison
    const strip = (obj) => {
        const clone = JSON.parse(JSON.stringify(obj));
        if (clone.bridge) delete clone.bridge.ipv6; // IPv6 might differ if proxying
        if (clone.coap) {
            delete clone.coap.mid;
            delete clone.coap.token;
        }
        if (clone.payload && clone.payload.unix_s) {
            delete clone.payload.unix_s;
            delete clone.payload.utc;
            delete clone.payload.hex; // Hex contains the encoded timestamp
        }
        return JSON.stringify(clone);
    };

    return strip(d1) !== strip(d2);
}

// ─── Request store (for request ↔ response pairing) ────────────────

/**
 * Store a client-to-server request so it can be paired with its response later.
 * Entries auto-expire after REQUEST_TTL_MS.
 *
 * @param {string} ipv6 - Source IPv6 from WS bridge frame
 * @param {number} mid  - CoAP Message ID
 * @param {Buffer} rawData - Full WS frame (raw binary)
 */
function storeRequest(ipv6, mid, rawData) {
    const key = `${ipv6}:${mid}`;
    const hex = Buffer.isBuffer(rawData) ? rawData.toString('hex') : rawData;
    const decoded = decodeMessage(rawData);

    // Clear any existing timeout for this key to prevent a stale timer
    // from deleting a freshly re-stored entry
    const existing = _requestStore.get(key);
    if (existing && existing._timer) {
        clearTimeout(existing._timer);
    }

    const entry = { hex, decoded, timestamp: new Date().toISOString() };
    entry._timer = setTimeout(() => _requestStore.delete(key), REQUEST_TTL_MS);
    _requestStore.set(key, entry);
}

/**
 * Retrieve a previously stored request.
 */
function getRequest(ipv6, mid) {
    return _requestStore.get(`${ipv6}:${mid}`) || null;
}

// ─── Device ID resolution ──────────────────────────────────────────

/**
 * Try to extract a specific sub-device ID from a CoAP path (e.g. d/{serial}),
 * then fall back to IPv6 resolver, then to the caller-provided fallback.
 */
function resolveDeviceId(decoded, fallbackDeviceId) {
    // 1. Try path-based extraction
    if (decoded && decoded.coap && decoded.coap.path) {
        const parts = decoded.coap.path.split('/').filter(p => p.length > 0);
        const dIdx = parts.indexOf('d');
        if (dIdx >= 0 && dIdx + 1 < parts.length) {
            const candidate = parts[dIdx + 1];
            // Blacklist common methods that appear in d/{method} paths
            const isMethod = /^(identify|rfkey|sen|config|time|info|status|reboot|reset|sen_v\d+|sen2)$/i.test(candidate);

            // Only accept if it looks like a serial (alphanumeric, length >= 5) and isn't a method
            if (candidate && candidate.length >= 5 && /^[A-Za-z0-9]+$/.test(candidate) && !isMethod) {
                return candidate;
            }
        }
    }

    // 2. Try IPv6 resolver
    if (decoded && decoded.bridge && decoded.bridge.ipv6 && _ipv6Resolver) {
        const resolved = _ipv6Resolver(decoded.bridge.ipv6);
        if (resolved) return resolved;
    }

    // 3. Fallback
    return fallbackDeviceId;
}

// ─── Main cache function ───────────────────────────────────────────

/**
 * Cache a server-to-client message with full decode and optional request pairing.
 *
 * @param {string} fallbackDeviceId - Caller-resolved device ID (may be bridge ID)
 * @param {Buffer|string} rawData   - Full WS frame binary data
 * @param {string} source           - 'real' or 'recreated'
 * @param {Buffer|string|null} requestRawData - Optional explicit request to pair
 */
function cacheMessage(fallbackDeviceId, rawData, source, requestRawData) {
    if (!rawData || !fallbackDeviceId) return;

    try {
        const data = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData, 'hex');
        const hex = data.toString('hex');
        const decoded = decodeMessage(data);
        if (!decoded) return;

        // Resolve the best device ID
        const deviceId = resolveDeviceId(decoded, fallbackDeviceId);

        // Determine path (for responses/ACKs, try to get from paired request)
        let msgPath = decoded.coap.path;
        let request = null;

        if (requestRawData) {
            // Explicit request data provided by caller
            const reqData = Buffer.isBuffer(requestRawData) ? requestRawData : Buffer.from(requestRawData, 'hex');
            request = {
                hex: reqData.toString('hex'),
                decoded: decodeMessage(reqData),
            };
            if (!msgPath && request.decoded) {
                msgPath = request.decoded.coap.path;
            }
        } else if (!decoded.coap.isRequest && decoded.bridge.ipv6) {
            // Auto-lookup stored request by ipv6:mid
            const storedReq = getRequest(decoded.bridge.ipv6, decoded.coap.mid);
            if (storedReq) {
                request = {
                    hex: storedReq.hex,
                    decoded: storedReq.decoded,
                };
                if (!msgPath && storedReq.decoded) {
                    msgPath = storedReq.decoded.coap.path;
                }
            }
        }

        if (!msgPath) msgPath = '(ACK/RESP)';

        const entry = {
            timestamp: new Date().toISOString(),
            direction: decoded.bridge.direction,
            hex,
            decoded,
            request,
        };

        // Insert into cache structure: device → path → source → [entries]
        checkDateRollover();

        if (!_cache[deviceId]) _cache[deviceId] = {};
        if (!_cache[deviceId][msgPath]) _cache[deviceId][msgPath] = {};
        if (!_cache[deviceId][msgPath][source]) _cache[deviceId][msgPath][source] = [];

        const arr = _cache[deviceId][msgPath][source];
        arr.push(entry);

        // --- Mismatch Detection ---
        const otherSource = (source === 'real' ? 'recreated' : 'real');
        const otherArr = _cache[deviceId][msgPath]?.[otherSource] || [];

        // Find counterpart by MID (for responses) or by path (for commands)
        const myMid = decoded.coap.mid;
        const counterpart = otherArr.find(other => other.decoded.coap.mid === myMid);

        if (counterpart) {
            if (isMismatched(entry.decoded, counterpart.decoded)) {
                entry.mismatch = true;
                counterpart.mismatch = true;
                //_log('info', `[msg-cache] !!! MISMATCH !!! detected for ${deviceId} /${msgPath} (MID: ${myMid})`);
            }
        }

        // --- Selective Trimming ---
        // Normal entries are trimmed at 10. Mismatched entries kept until 50.
        let normalEntries = arr.filter(e => !e.mismatch);
        let mismatchedEntries = arr.filter(e => e.mismatch);

        if (normalEntries.length > MAX_ENTRIES_PER_PATH) {
            // Find the index of the first normal entry to shift out
            const idx = arr.findIndex(e => !e.mismatch);
            if (idx !== -1) arr.splice(idx, 1);
        }

        if (mismatchedEntries.length > MAX_MISMATCHES_PER_PATH) {
            // Trim oldest mismatch if we hit the hard limit
            const idx = arr.findIndex(e => e.mismatch);
            if (idx !== -1) arr.splice(idx, 1);
        }

        scheduleSave();
        _log('debug', `[msg-cache] Cached ${source} for ${deviceId} at /${msgPath} (${data.length}B)`);
    } catch (e) {
        _log('error', `[msg-cache] Failed to cache: ${e.message}`);
    }
}

/**
 * Return the in-memory cache (for API access / debugging).
 */
function getCache() {
    return _cache;
}

module.exports = { init, decodeMessage, storeRequest, getRequest, cacheMessage, getCache, shutdown };

/**
 * Clear all pending TTL timers to allow clean process exit.
 */
function shutdown() {
    for (const [key, entry] of _requestStore) {
        if (entry._timer) clearTimeout(entry._timer);
    }
    _requestStore.clear();
}
