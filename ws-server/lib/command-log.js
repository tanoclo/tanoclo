/**
 * @file lib/command-log.js
 * @brief Persistent audit log tracker for hardware commands.
 */

'use strict';

/**
 * Command Log — Dedicated log file for TaNoClo-originated commands.
 *
 * When proxy mode is active, this logger captures:
 *   1. API layer: POST/PUT/DELETE requests from frontend → backend (method, URL, JSON body)
 *   2. WS layer:  CoAP messages sent from backend → IB (path, TLV fields, raw hex)
 *
 * Output: ws-server/log/commands.log (daily rotation, 7-day retention)
 */

const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '../log');
let LOG_PREFIX = 'commands';
const RETENTION_DAYS = 7;
const FLUSH_INTERVAL_MS = 100;

let _enabled = false;
let _logBuffer = [];
let _currentDate = new Date().toISOString().split('T')[0];

// Resolve references lazily to avoid circular deps
let _coap = null;
let _tlv = null;
let _wsBridge = null;

function getLogFile(dateStr) {
    return path.join(logDir, `${LOG_PREFIX}.${dateStr || _currentDate}.log`);
}

function init({ coap, tlv, wsBridge } = {}) {
    _coap = coap;
    _tlv = tlv;
    _wsBridge = wsBridge;

    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }

    try {
        fs.appendFileSync(getLogFile(), '');
    } catch (e) {
        if (e.code === 'EPERM' || e.code === 'EACCES') {
            LOG_PREFIX = 'commands.local';
        }
    }

    // Check if current file is from a previous day
    const currentFile = getLogFile(_currentDate);
    if (fs.existsSync(currentFile)) {
        try {
            const stats = fs.statSync(currentFile);
            const mtimeDate = stats.mtime.toISOString().split('T')[0];
            if (mtimeDate !== _currentDate) {
                // Will be handled by date rollover
            }
        } catch (e) { /* ignore */ }
    }

    cleanOldFiles();
}

function setEnabled(enabled) {
    _enabled = !!enabled;
}

function isEnabled() {
    return _enabled;
}

// ─── Writing ───────────────────────────────────────────────────────

function write(category, message) {
    if (!_enabled) return;

    const now = new Date();
    const ts = now.toISOString();
    const dateStr = ts.split('T')[0];

    // Date rollover
    if (dateStr !== _currentDate) {
        flush().catch(() => {});
        _currentDate = dateStr;
        cleanOldFiles().catch(() => {});
    }

    const line = `[${ts}] [${category}] ${message}`;
    _logBuffer.push(line);

    // Also echo to console for visibility
    console.log(`\x1b[36m${line}\x1b[0m`); // cyan for command log

    if (_logBuffer.length > 50) flush().catch(() => {});
}

let _isFlushing = false;
async function flush() {
    if (_logBuffer.length === 0 || _isFlushing) return;
    _isFlushing = true;
    const data = _logBuffer.join('\n') + '\n';
    _logBuffer = [];
    try {
        await fs.promises.appendFile(getLogFile(), data, 'utf-8');
    } catch (e) {
        console.error(`[cmd-log] Write error: ${e.message}`);
    } finally {
        _isFlushing = false;
    }
}

// Periodic flush
const flushInterval = setInterval(() => {
    flush().catch(() => {});
}, FLUSH_INTERVAL_MS);
if (flushInterval.unref) {
    flushInterval.unref();
}

// Node exit handler has to be sync, so we keep a fallback here using Sync
process.on('exit', () => {
    if (_logBuffer.length === 0) return;
    const data = _logBuffer.join('\n') + '\n';
    _logBuffer = [];
    try {
        fs.appendFileSync(getLogFile(), data, 'utf-8');
    } catch (e) {
        console.error(`[cmd-log] Sync exit write error: ${e.message}`);
    }
});

async function cleanOldFiles() {
    try {
        const files = await fs.promises.readdir(logDir);
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

        for (const file of files) {
            if (!file.startsWith(`${LOG_PREFIX}.`) || !file.endsWith('.log')) continue;
            const escapedPrefix = LOG_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const dateMatch = file.match(new RegExp(`${escapedPrefix}\\.(\\d{4}-\\d{2}-\\d{2})\\.log`));
            if (!dateMatch) continue;
            const fileDate = new Date(dateMatch[1] + 'T00:00:00Z');
            if (fileDate < cutoff) {
                await fs.promises.unlink(path.join(logDir, file)).catch(() => {});
            }
        }
    } catch (e) { /* ignore */ }
}

const SENSITIVE_KEYS = [
    'password', 'jwt_secret', 'jwtsecret', 'client_secret', 'secret',
    'totp', 'code_verifier', 'token', 'access_token', 'refresh_token',
    'sessiontoken', 'session_token', 'totp_secret', 'totpsecret', 'code'
];

function sanitizeUrl(urlStr) {
    if (!urlStr) return urlStr;
    try {
        const parsedUrl = new URL(urlStr, 'http://localhost');
        let changed = false;
        for (const [key] of parsedUrl.searchParams.entries()) {
            const lowerKey = key.toLowerCase();
            if (SENSITIVE_KEYS.some(sKey => lowerKey.includes(sKey))) {
                parsedUrl.searchParams.set(key, '[REDACTED]');
                changed = true;
            }
        }
        if (changed) {
            const hasLeadingSlash = urlStr.startsWith('/');
            let result = parsedUrl.pathname + parsedUrl.search;
            if (!hasLeadingSlash && result.startsWith('/')) {
                result = result.substring(1);
            }
            return result;
        }
        return urlStr;
    } catch (e) {
        return urlStr;
    }
}

function sanitizeBody(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) {
        return obj.map(sanitizeBody);
    }
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
        const lowerKey = key.toLowerCase();
        if (SENSITIVE_KEYS.some(sKey => lowerKey.includes(sKey))) {
            sanitized[key] = '[REDACTED]';
        } else if (typeof value === 'object') {
            sanitized[key] = sanitizeBody(value);
        } else {
            sanitized[key] = value;
        }
    }
    return sanitized;
}

// ─── API Layer Logging ─────────────────────────────────────────────

/**
 * Log an API request from the frontend.
 *
 * @param {string} method - HTTP method (POST, PUT, DELETE)
 * @param {string} url    - Request URL
 * @param {object} body   - Parsed JSON body
 * @param {object} [params] - Express route params (homeId, zoneId, etc.)
 */
function logApiRequest(method, url, body, params) {
    const sanitizedUrl = sanitizeUrl(url);
    const sanitizedBody = sanitizeBody(body);
    const paramStr = params && Object.keys(params).length > 0
        ? ` params=${JSON.stringify(params)}`
        : '';
    const bodyStr = sanitizedBody && Object.keys(sanitizedBody).length > 0
        ? `\n    └─ Body: ${JSON.stringify(sanitizedBody)}`
        : '';
    write('API', `${method} ${sanitizedUrl}${paramStr}${bodyStr}`);
}

// ─── WS Layer Logging ──────────────────────────────────────────────

/**
 * Log a CoAP message being sent to the IB over WebSocket.
 *
 * @param {string} deviceId    - Target device serial
 * @param {string} commandLabel - Human-readable command label
 * @param {string} coapPath    - CoAP URI path
 * @param {Buffer} coapBytes   - Raw CoAP message bytes
 * @param {Buffer} wsFrame     - Full WS bridge frame bytes
 */
function logWsCommand(deviceId, commandLabel, coapPath, coapBytes, wsFrame) {
    let tlvStr = '';

    // Try to decode TLV payload from CoAP bytes
    if (_coap && _tlv && coapBytes && coapBytes.length > 4) {
        try {
            const parsed = _coap.parse(coapBytes);
            if (parsed.ok && parsed.payload.length >= 3) {
                const decoded = _tlv.decode(parsed.payload);
                if (decoded && decoded.ok) {
                    tlvStr = `\n    └─ TLV: ${JSON.stringify(decoded.fields)}`;
                }
            }
            const codeStr = _coap.codeStr(parsed.code);
            const mid = parsed.mid;
            write('WS-TX', `→ ${deviceId} | ${codeStr} /${coapPath} | MID=${mid} | label=${commandLabel}` +
                `\n    └─ CoAP hex: ${coapBytes.toString('hex')}` +
                (wsFrame ? `\n    └─ Frame hex: ${wsFrame.toString('hex')}` : '') +
                tlvStr);
            return;
        } catch (e) { /* fall through to basic log */ }
    }

    // Basic fallback
    write('WS-TX', `→ ${deviceId} | /${coapPath} | label=${commandLabel}` +
        (coapBytes ? `\n    └─ CoAP hex: ${coapBytes.toString('hex')}` : ''));
}

/**
 * Log an ACK received from a device.
 *
 * @param {number} mid       - CoAP Message ID
 * @param {number} latencyMs - Delivery latency in milliseconds
 * @param {string} status    - 'delivered' or 'failed'
 */
function logAck(mid, latencyMs, status) {
    write('WS-ACK', `MID=${mid} | status=${status} | latency=${latencyMs}ms`);
}

module.exports = { init, setEnabled, isEnabled, logApiRequest, logWsCommand, logAck, flush };
