/**
 * @file lib/decrypt-stats.js
 * @brief Per-source decryption outcome counters for diagnosing decrypt failures.
 *
 * Buckets each secured-frame decrypt attempt by plaintext source address and
 * frame shape (FCF + length), and keeps a few raw samples of failing shapes.
 * Counts are cumulative from process start. Every map is capped: sources,
 * shapes and PANs past their cap share an overflow key, and the first ones
 * seen keep their slots.
 */

'use strict';

const MAX_SOURCES = 64;
const MAX_SAMPLES_PER_SHAPE = 3;
const MAX_SAMPLE_SHAPES = 32;
const MAX_SHAPES_PER_SOURCE = 16;
const MAX_EXCLUDED_PANS = 64;
const OVERFLOW_SOURCE = 'OTHER';
const OVERFLOW_KEY = 'other';

let sources = new Map();
let failSamples = new Map();
let excludedByPan = new Map();
let totals = { ok: 0, fail: 0, excluded: 0 };

function frameShape(frame) {
    const fcf = frame.length >= 2 ? frame.subarray(0, 2).toString('hex') : 'none';
    return `${fcf}/${frame.length}`;
}

function sourceEntry(src) {
    let key = src || 'UNKNOWN';
    if (!sources.has(key) && sources.size >= MAX_SOURCES) key = OVERFLOW_SOURCE;
    let entry = sources.get(key);
    if (!entry) {
        entry = { ok: 0, fail: 0, rssiOkSum: 0, rssiFailSum: 0, shapes: new Map() };
        sources.set(key, entry);
    }
    return entry;
}

/**
 * @param {boolean} ok - Whether decryption succeeded with any configured key
 * @param {Buffer} frame - IEEE 802.15.4 frame (without length byte)
 * @param {string} src - Source address as decoded from the plaintext header
 * @param {number} rssi
 * @param {string} rawHex
 */
function recordAttempt(ok, frame, src, rssi, rawHex) {
    const entry = sourceEntry(src);
    let shape = frameShape(frame);
    if (!entry.shapes.has(shape) && entry.shapes.size >= MAX_SHAPES_PER_SOURCE) shape = OVERFLOW_KEY;
    let shapeCounts = entry.shapes.get(shape);
    if (!shapeCounts) {
        shapeCounts = { ok: 0, fail: 0 };
        entry.shapes.set(shape, shapeCounts);
    }

    if (ok) {
        totals.ok++;
        entry.ok++;
        entry.rssiOkSum += rssi;
        shapeCounts.ok++;
        return;
    }

    totals.fail++;
    entry.fail++;
    entry.rssiFailSum += rssi;
    shapeCounts.fail++;

    let samples = failSamples.get(shape);
    if (!samples && failSamples.size < MAX_SAMPLE_SHAPES) {
        samples = [];
        failSamples.set(shape, samples);
    }
    if (samples && samples.length < MAX_SAMPLES_PER_SHAPE) {
        samples.push({ src, rssi, hex: rawHex });
    }
}

function recordExcluded(pan) {
    totals.excluded++;
    let key = `0x${pan.toString(16).toUpperCase().padStart(4, '0')}`;
    if (!excludedByPan.has(key) && excludedByPan.size >= MAX_EXCLUDED_PANS) key = OVERFLOW_KEY;
    excludedByPan.set(key, (excludedByPan.get(key) || 0) + 1);
}

function rate(fail, ok) {
    const n = fail + ok;
    return n === 0 ? null : Math.round((fail / n) * 1000) / 1000;
}

function avg(sum, n) {
    return n === 0 ? null : Math.round((sum / n) * 10) / 10;
}

function snapshot() {
    const sourceList = [...sources.entries()].map(([src, e]) => ({
        src,
        ok: e.ok,
        fail: e.fail,
        fail_rate: rate(e.fail, e.ok),
        rssi_ok_avg: avg(e.rssiOkSum, e.ok),
        rssi_fail_avg: avg(e.rssiFailSum, e.fail),
        shapes: Object.fromEntries(e.shapes)
    })).sort((a, b) => b.fail - a.fail || b.ok - a.ok);

    return {
        ok: totals.ok,
        fail: totals.fail,
        fail_rate: rate(totals.fail, totals.ok),
        excluded_drops: totals.excluded,
        excluded_by_pan: Object.fromEntries(excludedByPan),
        sources: sourceList,
        fail_samples: Object.fromEntries(failSamples)
    };
}

function getExcludedCount() {
    return totals.excluded;
}

function getSuccessCount() {
    return totals.ok;
}

function reset() {
    sources = new Map();
    failSamples = new Map();
    excludedByPan = new Map();
    totals = { ok: 0, fail: 0, excluded: 0 };
}

module.exports = {
    recordAttempt,
    recordExcluded,
    snapshot,
    getExcludedCount,
    getSuccessCount,
    reset
};
