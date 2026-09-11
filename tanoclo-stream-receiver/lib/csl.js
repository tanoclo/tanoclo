/**
 * @file lib/csl.js
 * @brief CSL (Coordinated Sampled Listening) beacon parser and builder for Tado RF network.
 *
 * Implements:
 * - IEEE 802.15.4e CSL Multipurpose Beacons (FCF starting with 0x25, 12 bytes total)
 * - IEEE 802.15.4e Extended MAC Coordination Frames (FCF 0xEE42 / 0x6E42)
 */

'use strict';

/**
 * Checks if an unencrypted frame is a CSL Multipurpose wake-up beacon.
 * @param {Buffer} frame
 * @returns {boolean}
 */
function isCSLBeacon(frame) {
    if (!frame || frame.length < 10) return false;
    return frame[0] === 0x25 || (frame[0] === 0x0C && frame[1] === 0x25);
}

/**
 * Checks if an unencrypted frame is an Extended MAC / CSL Coordination frame.
 * @param {Buffer} frame
 * @returns {boolean}
 */
function isMACCoordinationFrame(frame) {
    if (!frame || frame.length < 19) return false;
    const fcf = frame.readUInt16LE(0);
    return fcf === 0xEE42 || fcf === 0x6E42;
}

/**
 * Parses an IEEE 802.15.4e CSL Multipurpose wake-up beacon burst frame.
 * Structure (12 bytes):
 * - Optional Byte 0: Length prefix (0x0C)
 * - Byte 0 (or 1):    FCF (0x25: Multipurpose, short dst, uncompressed)
 * - Byte 1 (or 2):    Sequence number
 * - Bytes 2..3: 16-bit PAN ID (Little-Endian)
 * - Bytes 4..5: 16-bit Destination Short Address (or 0xFFFF broadcast)
 * - Bytes 6..7: CSL Phase / Time to sample window
 * - Bytes 8..9: CSL Countdown (decrements towards 0 in burst)
 * - Bytes 10..11: CSL Period (e.g. 0x3F80)
 *
 * @param {Buffer} frame
 * @returns {object|null}
 */
function parseCSLBeacon(frame) {
    if (!frame || frame.length < 10) return null;

    const off = (frame[0] === 0x0C) ? 1 : 0;
    if (frame.length < off + 10) return null;
    if (frame[off] !== 0x25) return null;

    const seq = frame[off + 1];
    const panId = frame.readUInt16LE(off + 2);
    const dstShort = frame.readUInt16LE(off + 4);
    const isBroadcast = dstShort === 0xFFFF;
    const phase = frame.length >= off + 8 ? frame.readUInt16LE(off + 6) : 0;
    const countdown = frame.length >= off + 10 ? frame.readUInt16LE(off + 8) : 0;
    const period = frame.length >= off + 12 ? frame.readUInt16LE(off + 10) : 0;

    return {
        type: 'CSL_BEACON',
        fcf: 0x25,
        seq,
        panId,
        dstShort: '0x' + dstShort.toString(16).padStart(4, '0'),
        isBroadcast,
        phase,
        countdown,
        period
    };
}

/**
 * Parses an unencrypted Extended MAC / CSL coordination frame (FCF 0xEE42 / 0x6E42).
 *
 * @param {Buffer} frame
 * @returns {object|null}
 */
function parseMACCoordinationFrame(frame) {
    if (!frame || frame.length < 19) return null;

    const fcf = frame.readUInt16LE(0);
    const seq = frame[2];
    const dstMacBuf = frame.subarray(3, 11); // 8-byte full EUI-64 MAC LE
    const srcMacBuf = frame.subarray(11, 19); // 8-byte full EUI-64 MAC LE

    const dstMac = Array.from(dstMacBuf).reverse().map(b => b.toString(16).padStart(2, '0')).join(':');
    const srcMac = Array.from(srcMacBuf).reverse().map(b => b.toString(16).padStart(2, '0')).join(':');
    const payload = frame.subarray(19);

    return {
        type: 'MAC_COORDINATION',
        fcf,
        seq,
        dstMac,
        srcMac,
        payload
    };
}

/**
 * Builds an IEEE 802.15.4e CSL Multipurpose wake-up beacon.
 *
 * @param {object} opts
 * @param {number} opts.seq
 * @param {number} opts.panId
 * @param {number} opts.dstShort
 * @param {number} opts.countdown
 * @param {number} opts.period
 * @returns {Buffer}
 */
function buildCSLBeacon({ seq, panId = 0xABCD, dstShort = 0xFFFF, countdown = 0, period = 0x3F80 }) {
    const buf = Buffer.alloc(12);
    buf[0] = 0x25;
    buf[1] = seq & 0xFF;
    buf.writeUInt16LE(panId & 0xFFFF, 2);
    buf.writeUInt16LE(dstShort & 0xFFFF, 4);
    buf.writeUInt16LE(countdown & 0xFFFF, 6);
    buf.writeUInt16LE(countdown & 0xFFFF, 8);
    buf.writeUInt16LE(period & 0xFFFF, 10);
    return buf;
}

module.exports = {
    isCSLBeacon,
    isMACCoordinationFrame,
    parseCSLBeacon,
    parseMACCoordinationFrame,
    buildCSLBeacon
};