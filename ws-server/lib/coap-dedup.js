/**
 * @file lib/coap-dedup.js
 * @brief Inbound CoAP Confirmable (CON) request message deduplication cache (RFC 7252 §4.5).
 */

'use strict';

const DEFAULT_TTL_MS = 60000; // 60 seconds (CoAP EXCHANGE_LIFETIME)
const MAX_ENTRIES = 2000;

class CoapDedupCache {
    constructor(ttlMs = DEFAULT_TTL_MS, maxEntries = MAX_ENTRIES) {
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
        this.cache = new Map(); // key: `${endpoint}:${mid}` -> timestamp
    }

    _makeKey(endpoint, mid) {
        if (!endpoint || mid == null) return null;
        return `${String(endpoint).toUpperCase()}:${Number(mid)}`;
    }

    _cleanup(now) {
        for (const [key, ts] of this.cache.entries()) {
            if (now - ts > this.ttlMs) {
                this.cache.delete(key);
            } else {
                // Map maintains insertion order; once we hit a non-expired entry, earlier ones are done
                break;
            }
        }
    }

    /**
     * Check if request was already processed within the TTL window.
     * @param {string} endpoint - Device serial or IPv6
     * @param {number} mid - CoAP Message ID (16-bit)
     * @returns {boolean}
     */
    isDuplicate(endpoint, mid) {
        const key = this._makeKey(endpoint, mid);
        if (!key) return false;

        const now = Date.now();
        const ts = this.cache.get(key);
        if (ts !== undefined) {
            if (now - ts <= this.ttlMs) {
                return true;
            }
            this.cache.delete(key);
        }
        return false;
    }

    /**
     * Record request MID as processed.
     * @param {string} endpoint - Device serial or IPv6
     * @param {number} mid - CoAP Message ID (16-bit)
     */
    record(endpoint, mid) {
        const key = this._makeKey(endpoint, mid);
        if (!key) return;

        const now = Date.now();
        this._cleanup(now);

        if (this.cache.size >= this.maxEntries) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey) this.cache.delete(oldestKey);
        }

        // Refresh position in Map for LRU behavior
        this.cache.delete(key);
        this.cache.set(key, now);
    }

    clear() {
        this.cache.clear();
    }

    size() {
        return this.cache.size;
    }
}

const defaultInstance = new CoapDedupCache();

module.exports = defaultInstance;
module.exports.CoapDedupCache = CoapDedupCache;
