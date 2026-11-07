/**
 * @file lib/config-block2.js
 * @brief Bounded Block2 reassembly for configuration capture, not wire forwarding.
 */

'use strict';

// Capture should not retain unbounded data when transfers never finish.
const MAX_SESSIONS = 100;
const MAX_BYTES = 128 * 1024;
const TTL_MS = 120_000;

/**
 * @typedef {{ num: number, more: 0|1, szx: number, blockSize: number }} Block2
 * @typedef {{ etag: Buffer|null, parts: Map<number, Buffer>, length: number, expiresAt: number }} CaptureSession
 * @typedef {{ payload: Buffer, etag: Buffer|null }} CompleteConfig
 */

/**
 * Remove expired capture sessions during periodic maintenance or capacity pressure.
 *
 * @param {Map<string, CaptureSession>} sessions Capture-only state, never outbound sessions.
 * @param {number} [now=Date.now()] Millisecond clock, injectable for expiry tests.
 */
function clearExpiredConfigBlock2Sessions(sessions, now = Date.now()) {
    for (const [key, session] of sessions) {
        if (session.expiresAt <= now) sessions.delete(key);
    }
}

/**
 * Collect one configuration response without exposing partial data to a decoder.
 * Tokens correlate individual exchanges, not the representation across blocks.
 * Compare ETags whenever supplied and retain the first available one for storage.
 * Without ETags, continuity is best-effort by device/resource and byte offset.
 *
 * @param {Map<string, CaptureSession>} sessions Incomplete capture transfers by resource.
 * @param {string} key Stable device and resource identity.
 * @param {{ payload: Buffer, block: Block2|null, etag: Buffer|null }} part
 * @param {number} [now=Date.now()] Millisecond clock, injectable for expiry tests.
 * @returns {CompleteConfig|null} Complete data and metadata, or null for an incomplete or rejected transfer.
 */
function collectConfigBlock2(sessions, key, part, now = Date.now()) {
    let session = sessions.get(key);
    if (session && session.expiresAt <= now) {
        sessions.delete(key);
        session = null;
    }

    const { payload, block, etag } = part;
    const receivedEtag = etag?.length ? Buffer.from(etag) : null;
    const reject = () => {
        sessions.delete(key);
        return null;
    };

    if (!Buffer.isBuffer(payload) || payload.length === 0 || payload.length > MAX_BYTES) {
        return reject();
    }
    if (block === null) {
        sessions.delete(key);
        return { payload: Buffer.from(payload), etag: receivedEtag };
    }
    if (!Number.isInteger(block.num) || block.num < 0 || block.num > 0xfffff ||
        !Number.isInteger(block.szx) || block.szx < 0 || block.szx > 6 ||
        block.blockSize !== 2 ** (block.szx + 4) ||
        (block.more !== 0 && block.more !== 1) ||
        payload.length > block.blockSize ||
        (block.more === 1 && payload.length !== block.blockSize)) {
        return reject();
    }

    const offset = block.num * block.blockSize;
    if (offset + payload.length > MAX_BYTES) return reject();
    if (offset === 0 && block.more === 0) {
        sessions.delete(key);
        // The Block2 option is valid even when the entire body fits in one reply.
        return { payload: Buffer.from(payload), etag: receivedEtag };
    }

    if (offset === 0) {
        const differentEtag = session?.etag && receivedEtag && !session.etag.equals(receivedEtag);
        const newlyVersioned = session && !session.etag && receivedEtag;
        // Repeated first blocks must not discard later blocks already received.
        // A changed first block or newly identified representation starts afresh.
        if (!session || differentEtag || newlyVersioned || !session.parts.get(0)?.equals(payload)) {
            if (!sessions.has(key) && sessions.size >= MAX_SESSIONS) {
                clearExpiredConfigBlock2Sessions(sessions, now);
                if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
            }
            session = { etag: receivedEtag, parts: new Map(), length: 0, expiresAt: now + TTL_MS };
            sessions.set(key, session);
        }
    }

    if (!session) return reject();
    if (session.etag && receivedEtag && !session.etag.equals(receivedEtag)) return reject();
    if (!session.etag && receivedEtag) session.etag = receivedEtag;
    session.expiresAt = now + TTL_MS;
    if (offset < session.length) {
        return session.parts.get(offset)?.equals(payload) ? null : reject();
    }
    // Accept only contiguous bytes, including when the negotiated block size changes.
    if (offset !== session.length) return reject();

    session.parts.set(offset, Buffer.from(payload));
    session.length += payload.length;
    if (block.more === 1) return null;

    // Accepted offsets strictly increase. Map insertion order therefore already
    // matches byte order, and retransmissions never reinsert an earlier offset.
    const result = { payload: Buffer.concat([...session.parts.values()], session.length), etag: session.etag };
    sessions.delete(key);
    return result;
}

module.exports = { collectConfigBlock2, clearExpiredConfigBlock2Sessions };
