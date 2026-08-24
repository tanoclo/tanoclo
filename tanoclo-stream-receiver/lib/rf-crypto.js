/**
 * @file lib/rf-crypto.js
 * @brief RF frame parsing, address reconstruction, and AES-128-CCM decryption.
 */

'use strict';

const crypto = require('crypto');

// Standard static Tado bootstrap pairing key
const PAIRING_KEY_HEX = '7461646f2070616972696e67206b6579';

/**
 * Extract PAN ID from raw packet if available.
 * @param {Buffer} rawBytes 
 * @returns {number|null}
 */
function getPanId(rawBytes) {
    if (!rawBytes || rawBytes.length < 6) return null;
    const rxLen = rawBytes[0];
    if (rxLen < 15 || rxLen > rawBytes.length - 1) return null;

    const frame = rawBytes.subarray(1, 1 + rxLen);
    // Security enabled Data Frame check (FCF low 4 bits = 0x09)
    if ((frame[0] & 0x0F) !== 0x09) return null;

    return frame.readUInt16LE(3);
}

/**
 * AES-128-CCM Decryption according to IEEE 802.15.4 security spec.
 * Nonce = frame[0..12] (13 bytes)
 * AAD = frame[0..15] (16 bytes, whole MAC header)
 * Tag = last 4 bytes of ciphertext
 * @param {Buffer} frame - IEEE 802.15.4 frame
 * @param {Buffer} key - 16-byte key buffer
 * @returns {Buffer|null} Decrypted plaintext or null on auth failure
 */
function decryptCCM(frame, key) {
    if (!frame || frame.length < 21 || !key || key.length !== 16) return null;
    const nonce = frame.subarray(0, 13);
    const aad = frame.subarray(0, 16);
    const ciphertextWithMic = frame.subarray(16);
    const ciphertext = ciphertextWithMic.subarray(0, -4);
    const tag = ciphertextWithMic.subarray(-4);

    try {
        const decipher = crypto.createDecipheriv('aes-128-ccm', key, nonce, {
            authTagLength: 4
        });
        decipher.setAAD(aad, { plaintextLength: ciphertext.length });
        decipher.setAuthTag(tag);
        let decrypted = decipher.update(ciphertext);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted;
    } catch (err) {
        return null;
    }
}

/**
 * Decrypts AES-128-ECB block (used in special key payloads).
 * @param {Buffer} ciphertext 
 * @param {Buffer} key 
 * @returns {Buffer|null}
 */
function decryptAES128ECB(ciphertext, key) {
    try {
        const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
        decipher.setAutoPadding(false);
        let decrypted = decipher.update(ciphertext);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted;
    } catch (err) {
        return null;
    }
}

/**
 * Decode MAC layer addresses and determine device direction / tags.
 * Reconstructs 64-bit Extended MAC addresses and 16-bit short addresses.
 * 
 * @param {Buffer} frame - IEEE 802.15.4 raw frame
 * @param {Buffer|null} decrypted - Decrypted payload (for src MAC 3-byte prefix)
 * @returns {object} Decoded MAC info
 */
function decodeMAC(frame, decrypted) {
    if (!frame || frame.length < 3) {
        return {
            dst: '00:00:00:00:00:00:00:00',
            src: '00:00:00:00:00:00:00:00',
            dstClean: '0000000000000000',
            srcClean: '0000000000000000',
            dstShort: '',
            srcShort: '',
            isSrcIb: false,
            isDstIb: false,
            isSrcVa: false,
            isDstVa: false,
            direction: 'UNKNOWN'
        };
    }

    const fcf = frame.readUInt16LE(0);
    const frameType = fcf & 0x07;
    const destMode = (fcf >> 10) & 0x03;
    const srcMode = (fcf >> 14) & 0x03;

    let pos = 3; // after FCF (2) and Seq (1)
    let destPan = null;
    let destShort = null;
    let destExtBytes = null;

    if (destMode > 0 && pos + 2 <= frame.length) {
        destPan = frame.readUInt16LE(pos);
        pos += 2;
    }

    if (destMode === 2 && pos + 2 <= frame.length) {
        destShort = frame.readUInt16LE(pos);
        pos += 2;
    } else if (destMode === 3) {
        const isStandardData = (frameType === 1);
        const extLen = isStandardData ? 6 : 8;
        if (pos + extLen <= frame.length) {
            destExtBytes = frame.subarray(pos, pos + extLen);
            pos += extLen;
        }
    }

    let srcShort = null;
    let srcExtBytes = null;

    if (srcMode === 2 && pos + 2 <= frame.length) {
        srcShort = frame.readUInt16LE(pos);
        pos += 2;
    } else if (srcMode === 3) {
        const isStandardData = (frameType === 1);
        const extLen = isStandardData ? 5 : 8;
        if (pos + extLen <= frame.length) {
            srcExtBytes = frame.subarray(pos, pos + extLen);
            pos += extLen;
        }
    }

    // Format Destination MAC
    let dstMac = '00:00:00:00:00:00:00:00';
    const dstShortStr = destShort !== null ? destShort.toString(16).toUpperCase().padStart(4, '0') : '';
    if (destMode === 2) {
        if (destShort === 0xFFFF) {
            dstMac = '00:1B:C5:07:FF:FF:FF:FF';
        } else {
            const isIb = (destShort === 0x0000);
            const middle = isIb ? '31:55' : '31:56';
            dstMac = `00:1B:C5:07:${middle}:${dstShortStr.slice(0, 2)}:${dstShortStr.slice(2, 4)}`;
        }
    } else if (destMode === 3 && destExtBytes) {
        if (destExtBytes.length === 6 && destPan !== null) {
            const b = Buffer.alloc(8);
            b[0] = (destPan & 0xFF);
            b[1] = (destPan >> 8) & 0xFF;
            destExtBytes.copy(b, 2);
            dstMac = Buffer.from(b).reverse().toString('hex').toUpperCase().match(/.{1,2}/g).join(':');
        } else if (destExtBytes.length === 8) {
            dstMac = Buffer.from(destExtBytes).reverse().toString('hex').toUpperCase().match(/.{1,2}/g).join(':');
        }
    }

    // Format Source MAC
    let srcMac = '00:00:00:00:00:00:00:00';
    const srcShortStr = srcShort !== null ? srcShort.toString(16).toUpperCase().padStart(4, '0') : '';
    if (srcMode === 2) {
        const isIb = (srcShort === 0x0000);
        const middle = isIb ? '31:55' : '31:56';
        srcMac = `00:1B:C5:07:${middle}:${srcShortStr.slice(0, 2)}:${srcShortStr.slice(2, 4)}`;
    } else if (srcMode === 3 && srcExtBytes) {
        if (srcExtBytes.length === 5) {
            const b = Buffer.alloc(8);
            b[0] = srcExtBytes[0];
            b[1] = srcExtBytes[1];
            b[2] = srcExtBytes[2];
            b[3] = srcExtBytes[3];
            b[4] = srcExtBytes[4];
            if (decrypted && decrypted.length >= 3) {
                b[5] = decrypted[0];
                b[6] = decrypted[1];
                b[7] = decrypted[2];
            } else {
                b[5] = 0xC5;
                b[6] = 0x1B;
                b[7] = 0x00;
            }
            srcMac = Buffer.from(b).reverse().toString('hex').toUpperCase().match(/.{1,2}/g).join(':');
        } else if (srcExtBytes.length === 8) {
            srcMac = Buffer.from(srcExtBytes).reverse().toString('hex').toUpperCase().match(/.{1,2}/g).join(':');
        }
    }

    const isDstIb = dstMac.includes(':31:55:') || destShort === 0x0000;
    const isDstVa = dstMac.includes(':31:56:') || (destShort !== null && !isDstIb && destShort !== 0xFFFF);
    const isSrcIb = srcMac.includes(':31:55:') || srcShort === 0x0000;
    const isSrcVa = srcMac.includes(':31:56:') || (srcShort !== null && !isSrcIb);

    let direction = 'UNKNOWN';
    if (isSrcIb && !isDstIb) {
        direction = 'SERVER_TO_CLIENT'; // Downlink (Bridge to Device)
    } else if (!isSrcIb && isDstIb) {
        direction = 'CLIENT_TO_SERVER'; // Uplink (Device to Bridge)
    }

    const dstClean = dstMac.replace(/:/g, '').toUpperCase();
    const srcClean = srcMac.replace(/:/g, '').toUpperCase();

    const dstShortFinal = dstShortStr || (destMode === 3 && dstClean.length >= 4 ? dstClean.slice(12) : '');
    const srcShortFinal = srcShortStr || (srcMode === 3 && srcClean.length >= 4 ? srcClean.slice(12) : '');

    return {
        dst: dstMac + (isDstIb ? ' (IB)' : (isDstVa ? ' (VA/RU)' : '')),
        src: srcMac + (isSrcIb ? ' (IB)' : (isSrcVa ? ' (VA/RU)' : '')),
        dstMac,
        srcMac,
        dstClean,
        srcClean,
        dstShort: dstShortFinal,
        srcShort: srcShortFinal,
        isSrcIb,
        isDstIb,
        isSrcVa,
        isDstVa,
        direction
    };
}

/**
 * Validate CRC16-Kermit checksum over header + decrypted payload.
 * Polynomial: 0x1021, reflected 0x8408, init 0x0000.
 * @param {Buffer} frameHeader - 16-byte MAC frame header
 * @param {Buffer} plaintextWithTrailer - Plaintext ending with 2-byte CRC
 * @returns {boolean} True if checksum valid
 */
function verifyKermitCrc(frameHeader, plaintextWithTrailer) {
    if (!plaintextWithTrailer || plaintextWithTrailer.length < 2) return false;
    const dataLen = plaintextWithTrailer.length - 2;
    const expectedCrc = plaintextWithTrailer.readUInt16LE(dataLen);

    let crc = 0x0000;
    const updateCrc = (byte) => {
        let b = byte ^ (crc & 0xFF);
        for (let i = 0; i < 8; i++) {
            if (b & 1) {
                b = (b >> 1) ^ 0x8408;
            } else {
                b = b >> 1;
            }
        }
        crc = (crc >> 8) ^ b;
    };

    if (frameHeader) {
        for (let i = 0; i < frameHeader.length; i++) {
            updateCrc(frameHeader[i]);
        }
    }
    for (let i = 0; i < dataLen; i++) {
        updateCrc(plaintextWithTrailer[i]);
    }

    return (crc & 0xFFFF) === expectedCrc;
}

module.exports = {
    PAIRING_KEY_HEX,
    getPanId,
    decryptCCM,
    decryptAES128ECB,
    decodeMAC,
    verifyKermitCrc
};
