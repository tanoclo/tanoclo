'use strict';
// Capture-only reassembly: never rewrites or forwards a packet to hardware.
const MAX_SESSIONS = 100;
const MAX_BYTES = 128 * 1024;
const TTL_MS = 120_000;

/**
 * @typedef {{num:number, more:0|1, szx:number, blockSize:number}} Block2
 * @param {Map} sessions Existing router map; its cleanup uses expiresAt.
 * @param {string} key Device identity plus canonical resource path.
 * @param {{payload:Buffer, block:Block2|null, etag:Buffer|null, token:Buffer|null}} part
 * @returns {Buffer|null} A complete bounded representation, or no capture yet.
 */
function collectConfigBlock2(sessions, key, part, now = Date.now()) {
    for (const [id, session] of sessions) {
        if (session.expiresAt <= now) sessions.delete(id);
    }
    const {payload, block, etag, token} = part;
    const reject = () => { sessions.delete(key); return null; };
    if (!Buffer.isBuffer(payload) || payload.length === 0 || payload.length > MAX_BYTES) return reject();
    if (block === null) {
        sessions.delete(key);
        return Buffer.from(payload);
    }
    if (!Number.isInteger(block.num) || block.num < 0 || block.num > 0xfffff ||
        !Number.isInteger(block.szx) || block.szx < 0 || block.szx > 6 ||
        block.blockSize !== 2 ** (block.szx + 4) ||
        (block.more !== 0 && block.more !== 1) ||
        payload.length > block.blockSize ||
        (block.more === 1 && payload.length !== block.blockSize)) return reject();
    const offset = block.num * block.blockSize;
    if (offset + payload.length > MAX_BYTES) return reject();
    if (offset === 0 && block.more === 0) {
        sessions.delete(key);
        return Buffer.from(payload); // Block2 does not necessarily mean fragmented!
    }
    const version = etag?.length ? 'etag:' + etag.toString('hex') : 'token:' + (token?.toString('hex') || '');
    let session = sessions.get(key);
    if (offset === 0) {
        // A repeated first block of the same representation must not discard
        // later blocks already received. A new version always starts afresh.
        if (!session || session.version !== version || !session.parts.get(0)?.equals(payload)) {
            if (!sessions.has(key) && sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
            session = {version, parts: new Map(), length: 0, expiresAt: now + TTL_MS};
            sessions.set(key, session);
        }
    }
    if (!session || session.version !== version) return reject();
    session.expiresAt = now + TTL_MS;
    if (offset < session.length) {
        return session.parts.get(offset)?.equals(payload) ? null : reject();
    }
    if (offset !== session.length) return reject(); // Never decode a gapped representation.
    session.parts.set(offset, Buffer.from(payload));
    session.length += payload.length;
    if (block.more === 1) return null;
    const result = Buffer.concat([...session.parts.values()], session.length);
    sessions.delete(key);
    return result;
}

module.exports = {collectConfigBlock2};
