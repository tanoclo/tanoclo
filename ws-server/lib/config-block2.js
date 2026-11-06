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
 * @typedef {{ version: string, parts: Map<number, Buffer>, length: number, expiresAt: number }} CaptureSession
 */

/**
 * Collect one configuration response without exposing partial data to a decoder.
 * The router also cleans this shared map using each session's expiresAt value.
 *
 * @param {Map<string, CaptureSession>} sessions Incomplete transfers by resource.
 * @param {string} key Stable device and resource identity.
 * @param {{ payload: Buffer, block: Block2|null, etag: Buffer|null, token: Buffer|null }} part
 * @param {number} [now=Date.now()] Millisecond clock, injectable for expiry tests.
 * @returns {Buffer|null} A complete representation, or null for an incomplete or rejected transfer.
 */
function collectConfigBlock2(sessions, key, part, now = Date.now()) {
    for (const [id, session] of sessions) {
        if (session.expiresAt <= now) sessions.delete(id);
    }

    const { payload, block, etag, token } = part;
    const reject = () => {
        sessions.delete(key);
        return null;
    };

    if (!Buffer.isBuffer(payload) || payload.length === 0 || payload.length > MAX_BYTES) {
        return reject();
    }
    if (block === null) {
        sessions.delete(key);
        return Buffer.from(payload);
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
        return Buffer.from(payload);
    }

    // ETag identifies a representation across block requests. Use the request
    // token only when no ETag is available. Never splice different versions.
    const version = etag?.length
        ? 'etag:' + etag.toString('hex')
        : 'token:' + (token?.toString('hex') || '');
    let session = sessions.get(key);

    if (offset === 0) {
        // Repeated first blocks must not discard later blocks already received.
        // A different first block or representation starts a fresh assembly.
        if (!session || session.version !== version || !session.parts.get(0)?.equals(payload)) {
            if (!sessions.has(key) && sessions.size >= MAX_SESSIONS) {
                sessions.delete(sessions.keys().next().value);
            }
            session = { version, parts: new Map(), length: 0, expiresAt: now + TTL_MS };
            sessions.set(key, session);
        }
    }

    if (!session || session.version !== version) return reject();
    session.expiresAt = now + TTL_MS;
    if (offset < session.length) {
        return session.parts.get(offset)?.equals(payload) ? null : reject();
    }
    // Accept only contiguous bytes, including when the negotiated block size changes.
    if (offset !== session.length) return reject();

    session.parts.set(offset, Buffer.from(payload));
    session.length += payload.length;
    if (block.more === 1) return null;

    const result = Buffer.concat([...session.parts.values()], session.length);
    sessions.delete(key);
    return result;
}

module.exports = { collectConfigBlock2 };
