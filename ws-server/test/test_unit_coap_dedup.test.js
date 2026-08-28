/**
 * @file test/test_unit_coap_dedup.test.js
 * @brief Unit tests for CoAP request deduplication cache (RFC 7252 §4.5).
 */

import { describe, it, expect, beforeEach } from 'vitest';
const coapDedup = require('../lib/coap-dedup');
const { CoapDedupCache } = coapDedup;

describe('CoapDedupCache', () => {
    let dedup;

    beforeEach(() => {
        dedup = new CoapDedupCache(1000, 5); // 1000ms TTL, max 5 entries for test
    });

    it('identifies new request as not duplicate and records it', () => {
        expect(dedup.isDuplicate('RU0000000001', 0x909F)).toBe(false);
        dedup.record('RU0000000001', 0x909F);
        expect(dedup.isDuplicate('RU0000000001', 0x909F)).toBe(true);
    });

    it('distinguishes different MIDs from same device', () => {
        dedup.record('RU0000000001', 0x909F);
        expect(dedup.isDuplicate('RU0000000001', 0x90A0)).toBe(false);
        dedup.record('RU0000000001', 0x90A0);
        expect(dedup.isDuplicate('RU0000000001', 0x90A0)).toBe(true);
        expect(dedup.isDuplicate('RU0000000001', 0x909F)).toBe(true);
    });

    it('distinguishes same MID from different devices', () => {
        dedup.record('RU0000000001', 0x909F);
        expect(dedup.isDuplicate('RU0000000002', 0x909F)).toBe(false);
        dedup.record('RU0000000002', 0x909F);
        expect(dedup.isDuplicate('RU0000000002', 0x909F)).toBe(true);
    });

    it('is case-insensitive for device serials / endpoints', () => {
        dedup.record('ru0000000001', 0x909F);
        expect(dedup.isDuplicate('RU0000000001', 0x909F)).toBe(true);
    });

    it('expires entries after TTL', async () => {
        const shortDedup = new CoapDedupCache(50, 10);
        shortDedup.record('RU0000000001', 0x909F);
        expect(shortDedup.isDuplicate('RU0000000001', 0x909F)).toBe(true);

        await new Promise(r => setTimeout(r, 70));
        expect(shortDedup.isDuplicate('RU0000000001', 0x909F)).toBe(false);
    });

    it('evicts oldest entries when maxEntries is exceeded', () => {
        for (let i = 1; i <= 5; i++) {
            dedup.record('RU0000000001', i);
        }
        expect(dedup.size()).toBe(5);
        expect(dedup.isDuplicate('RU0000000001', 1)).toBe(true);

        // Add 6th item -> should evict item 1
        dedup.record('RU0000000001', 6);
        expect(dedup.size()).toBe(5);
        expect(dedup.isDuplicate('RU0000000001', 1)).toBe(false);
        expect(dedup.isDuplicate('RU0000000001', 6)).toBe(true);
    });

    it('handles null/undefined inputs gracefully', () => {
        expect(dedup.isDuplicate(null, 123)).toBe(false);
        expect(dedup.isDuplicate('RU0000000001', null)).toBe(false);
        expect(() => dedup.record(null, 123)).not.toThrow();
        expect(() => dedup.record('RU0000000001', null)).not.toThrow();
    });
});
