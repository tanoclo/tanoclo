/**
 * @file lib/config-capture.js
 * @brief Configuration capturing coordinator during setups.
 */

'use strict';

/**
 * Config Capture — Permanent log of real Tado config payloads received via proxy.
 *
 * This file is an append-only, permanent log. Unlike message_cache (which rotates
 * daily and trims entries), config_capture is NEVER deleted or overwritten.
 *
 * Each entry contains:
 *   - Timestamp
 *   - CoAP path (e.g. d/VA0123456789/config, h/999999/z/12/config)
 *   - Device ID
 *   - CoAP response code
 *   - CoAP ETag (Option 4) from the response
 *   - Full raw payload hex
 *   - Fully decoded TLV items with FID, name, type, raw hex, and interpreted value
 *
 * Storage: One JSONL file per device, never rotated.
 *   log/config_capture/{deviceId}.jsonl
 *
 * In-memory index: Tracks which device+path combos have been captured,
 * so ETag stripping checks are O(1) without file I/O on the hot path.
 */

const fs = require('fs');
const path = require('path');

let _captureDir = null;
let _log = console.log;

// In-memory index: Set of "deviceId|path" strings we've already captured.
// Populated from disk on init, updated on each new capture.
const _capturedPaths = new Set();
const _deviceLocks = new Map();

function init({ logDir, log }) {
    _captureDir = path.join(logDir, 'config_capture');
    if (log) _log = log;

    // Ensure capture directory exists
    try {
        if (!fs.existsSync(_captureDir)) {
            fs.mkdirSync(_captureDir, { recursive: true });
        }
    } catch (e) {
        _log('error', `[config-capture] Failed to create capture dir: ${e.message}`);
    }

    // Build in-memory index from existing captures on disk
    _buildIndex();
}

/**
 * Deduplicate a capture file. Only keeps the newest/latest entry for each
 * unique combination of path + coapCode + sorted TLV/FID keys.
 */
function deduplicateFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return;
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        const entries = [];
        for (const line of lines) {
            try {
                entries.push(JSON.parse(line));
            } catch { /* skip malformed */ }
        }

        let modified = false;
        const seen = new Map(); // key -> entry (keep the latest one)

        for (const entry of entries) {
            if (!entry.path) continue;
            const fidsKey = (entry.tlvItems || []).map(item => item.fid).sort().join(',');
            const key = `${entry.path}|${entry.coapCode || ''}|${fidsKey}`;

            if (seen.has(key)) {
                modified = true;
            }
            seen.set(key, entry);
        }

        if (modified) {
            const uniqueEntries = Array.from(seen.values());
            const newContent = uniqueEntries.map(e => JSON.stringify(e)).join('\n') + '\n';
            fs.writeFileSync(filePath, newContent, 'utf-8');
        }
    } catch (e) {
        _log('error', `[config-capture] Failed to deduplicate file ${filePath}: ${e.message}`);
    }
}

/**
 * Build the in-memory index from all existing JSONL files on disk.
 * Called once at startup.
 */
function _buildIndex() {
    try {
        if (!_captureDir || !fs.existsSync(_captureDir)) return;

        const files = fs.readdirSync(_captureDir).filter(f => f.endsWith('.jsonl'));
        let totalEntries = 0;

        for (const file of files) {
            const deviceId = file.replace('.jsonl', '');
            const filePath = path.join(_captureDir, file);
            deduplicateFile(filePath);
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const lines = content.split('\n').filter(l => l.trim());
                for (const line of lines) {
                    try {
                        const entry = JSON.parse(line);
                        if (entry.path) {
                            _capturedPaths.add(`${deviceId}|${entry.path}`);
                            totalEntries++;
                        }
                    } catch { /* skip malformed lines */ }
                }
            } catch { /* skip unreadable files */ }
        }

        _log('info', `[config-capture] Loaded index: ${_capturedPaths.size} unique device+path combos from ${files.length} devices (${totalEntries} entries)`);
    } catch (e) {
        _log('error', `[config-capture] Failed to build index: ${e.message}`);
    }
}

/**
 * Fast O(1) check: do we already have at least one capture for this device+path?
 * Used by ETag stripping logic to avoid file I/O on the hot path.
 *
 * @param {string} deviceId
 * @param {string} coapPath
 * @returns {boolean}
 */
function hasCapture(deviceId, coapPath) {
    return _capturedPaths.has(`${deviceId}|${coapPath}`);
}

/**
 * Capture a proxied config response with full TLV decode.
 *
 * @param {Object} opts
 * @param {string} opts.deviceId    - Device serial (e.g. VA0123456789)
 * @param {string} opts.path        - CoAP path (e.g. d/VA0123456789/config)
 * @param {string} opts.coapCode    - Response code string (e.g. "2.05")
 * @param {Buffer|null} opts.coapEtag - CoAP ETag option value (raw bytes)
 * @param {Buffer} opts.payload     - Raw TLV payload bytes
 * @param {Object} opts.tlvDecoded  - Result from tlv.decode() — { ok, fields, items }
 */
async function capture({ deviceId, path: coapPath, coapCode, coapEtag, payload, tlvDecoded }) {
    if (!_captureDir) {
        _log('warn', '[config-capture] Not initialized, skipping capture');
        return;
    }

    // Acquire lock for this device to prevent race conditions during isDuplicate and write
    while (_deviceLocks.has(deviceId)) {
        await _deviceLocks.get(deviceId);
    }

    let resolveLock;
    const lockPromise = new Promise(resolve => { resolveLock = resolve; });
    _deviceLocks.set(deviceId, lockPromise);

    try {
        const entry = {
            timestamp: new Date().toISOString(),
            deviceId,
            path: coapPath,
            coapCode,
            coapEtag: coapEtag ? (Buffer.isBuffer(coapEtag) ? coapEtag.toString('hex') : coapEtag) : null,
            payloadHex: payload ? (Buffer.isBuffer(payload) ? payload.toString('hex') : payload) : null,
            payloadLength: payload ? payload.length : 0,
            tlvItems: [],
        };

        // Build comprehensive TLV field list
        if (tlvDecoded && tlvDecoded.ok && tlvDecoded.items) {
            entry.tlvItems = tlvDecoded.items.map(item => ({
                fid: item.fid,
                name: item.name,
                type: item.type,
                len: item.len,
                rawHex: item.rawHex,
                value: item.value,
            }));
        }

        // Also store the flat fields map for easy lookup
        if (tlvDecoded && tlvDecoded.fields) {
            entry.fields = {};
            for (const [key, val] of Object.entries(tlvDecoded.fields)) {
                // Serialize values safely (Buffers become hex strings)
                if (Buffer.isBuffer(val)) {
                    entry.fields[key] = val.toString('hex');
                } else {
                    entry.fields[key] = val;
                }
            }
        }

        // Determine file path — one file per device, append-only
        const filePath = getFilePath(deviceId);

        // Check if this exact entry already exists (dedup by path + payload)
        const dup = await isDuplicate(filePath, coapPath, entry.payloadHex);
        if (dup) {
            _log('debug', `[config-capture] Skipping duplicate for ${deviceId} at ${coapPath}`);
            return;
        }

        // Load all existing captures for this device
        const captures = await getCaptures(deviceId);

        // Find if there is an existing entry with the same path, coapCode, and TLV keys
        const entryKeys = entry.tlvItems.map(item => item.fid).sort().join(',');

        let replaced = false;
        const updatedCaptures = captures.map(existing => {
            if (existing.path === coapPath && existing.coapCode === coapCode) {
                const existingKeys = (existing.tlvItems || []).map(item => item.fid).sort().join(',');
                if (existingKeys === entryKeys) {
                    replaced = true;
                    return entry; // Replace with the new entry
                }
            }
            return existing;
        });

        if (replaced) {
            // Overwrite the file with the updated captures
            const content = updatedCaptures.map(c => JSON.stringify(c)).join('\n') + '\n';
            await fs.promises.writeFile(filePath, content, 'utf-8');
            _log('debug', `[config-capture] ✓ Updated (overwrote) ${coapPath} for ${deviceId} (${entry.tlvItems.length} TLV fields, ETag: ${entry.coapEtag || 'none'})`);
        } else {
            // Append as JSONL (one JSON object per line)
            const line = JSON.stringify(entry) + '\n';
            await fs.promises.appendFile(filePath, line, 'utf-8');
            _log('debug', `[config-capture] ✓ Captured ${coapPath} for ${deviceId} (${entry.tlvItems.length} TLV fields, ETag: ${entry.coapEtag || 'none'})`);
        }

        // Update in-memory index
        _capturedPaths.add(`${deviceId}|${coapPath}`);
    } catch (e) {
        _log('error', `[config-capture] Failed to capture: ${e.message}`);
    } finally {
        _deviceLocks.delete(deviceId);
        resolveLock();
    }
}

/**
 * Get the capture file path for a device.
 */
function getFilePath(deviceId) {
    const dir = _captureDir || path.join(__dirname, '..', 'log', 'config_capture');
    return path.join(dir, `${deviceId}.jsonl`);
}

/**
 * Check if we already have an identical capture for this path + payload.
 * Reads the last N lines to avoid re-storing the same unchanged config.
 */
async function isDuplicate(filePath, coapPath, payloadHex) {
    try {
        try {
            await fs.promises.access(filePath);
        } catch {
            return false;
        }

        // Read last 4KB of the file (should cover recent entries)
        const stat = await fs.promises.stat(filePath);
        const readSize = Math.min(stat.size, 4096);
        const fileHandle = await fs.promises.open(filePath, 'r');
        const buf = Buffer.alloc(readSize);
        await fileHandle.read(buf, 0, readSize, stat.size - readSize);
        await fileHandle.close();

        const tail = buf.toString('utf-8');
        const lines = tail.split('\n').filter(l => l.trim());

        for (const line of lines) {
            try {
                const existing = JSON.parse(line);
                if (existing.path === coapPath && existing.payloadHex === payloadHex) {
                    return true;
                }
            } catch { /* partial line from read boundary, ignore */ }
        }
    } catch { /* file read error, allow capture */ }

    return false;
}

/**
 * Read all captured configs for a device.
 * @param {string} deviceId
 * @returns {Array<Object>} Array of capture entries
 */
async function getCaptures(deviceId) {
    try {
        const filePath = getFilePath(deviceId);
        try {
            await fs.promises.access(filePath);
        } catch {
            return [];
        }

        const content = await fs.promises.readFile(filePath, 'utf-8');
        return content.split('\n')
            .filter(l => l.trim())
            .map(l => { try { return JSON.parse(l); } catch { return null; } })
            .filter(Boolean);
    } catch (e) {
        _log('error', `[config-capture] Failed to read captures for ${deviceId}: ${e.message}`);
        return [];
    }
}

/**
 * List all devices that have captured configs.
 * @returns {Array<{deviceId: string, entries: number, lastCapture: string}>}
 */
async function listDevices() {
    try {
        const dir = _captureDir || path.join(__dirname, '..', 'log', 'config_capture');
        try {
            await fs.promises.access(dir);
        } catch {
            return [];
        }

        const files = await fs.promises.readdir(dir);
        const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
        const results = [];

        for (const f of jsonlFiles) {
            const deviceId = f.replace('.jsonl', '');
            const filePath = path.join(dir, f);
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const lines = content.split('\n').filter(l => l.trim());
            let lastCapture = null;
            if (lines.length > 0) {
                try {
                    const last = JSON.parse(lines[lines.length - 1]);
                    lastCapture = last.timestamp;
                } catch { /* ignore */ }
            }
            results.push({ deviceId, entries: lines.length, lastCapture });
        }
        return results;
    } catch (e) {
        _log('error', `[config-capture] Failed to list devices: ${e.message}`);
        return [];
    }
}

module.exports = { init, capture, hasCapture, getCaptures, listDevices };
