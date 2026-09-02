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
    // Multipurpose frame (Frame Type = 5 in low 3 bits -> byte 0 has 0x05 or 0x25)
    return frame[0] === 0x25;
}

/**
 * Checks if an unencrypted frame is an Extended MAC / CSL Coordination frame.
 * @param {Buffer} frame
 * @returns {boolean}
 */
function isMACCoordinationFrame(frame) {
    if (!frame || frame.length < 16) return false;
    const fcf = frame.readUInt16LE(0);
    return fcf === 0xEE42 || fcf === 0x6E42;
}

/**
 * Parses an IEEE 802.15.4e CSL Multipurpose wake-up beacon burst frame.
 * Structure (12 bytes):
 * - Byte 0:    FCF (0x25: Multipurpose, short dst, uncompressed)
 * - Byte 1:    Sequence number
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

    if (frame[0] !== 0x25) return null;

    const seq = frame[1];
    const panId = frame.readUInt16LE(2);
    const dstShort = frame.readUInt16LE(4);
    const isBroadcast = dstShort === 0xFFFF;
    const phase = frame.length >= 8 ? frame.readUInt16LE(6) : 0;
    const countdown = frame.length >= 10 ? frame.readUInt16LE(8) : 0;
    const period = frame.length >= 12 ? frame.readUInt16LE(10) : 0;

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
    if (!frame || frame.length < 18) return null;

    const fcf = frame.readUInt16LE(0);
    const seq = frame[2];
    const panId = frame.readUInt16LE(3);
    const dstMacBuf = frame.subarray(5, 11); // 6-byte compressed MAC prefix
    const srcMacBuf = frame.subarray(11, 19); // 8-byte full EUI-64 MAC

    const dstMac = Array.from(dstMacBuf).reverse().map(b => b.toString(16).padStart(2, '0')).join(':') + ':c5:1b:00';
    const srcMac = Array.from(srcMacBuf).reverse().map(b => b.toString(16).padStart(2, '0')).join(':');
    const payload = frame.subarray(19);

    return {
        type: 'MAC_COORDINATION',
        fcf,
        seq,
        panId,
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
