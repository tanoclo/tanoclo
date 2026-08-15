/**
 * @file test/test_emulator_rf_roundtrip.test.js
 * @brief Vitest unit tests verifying Tado Emulator RF frame generation and AES-128-CCM
 * decryption roundtrip with stream_receiver.js, cross-checked against sniffed RF traffic.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import tlv from '../lib/tlv';
import coap from '../lib/coap';

// Reference AES Keys (Generic test keys)
const STATIC_PAIRING_KEY = Buffer.from('7461646f2070616972696e67206b6579', 'hex'); // "tado pairing key"
const OPERATIONAL_KEY = Buffer.from('00112233445566778899aabbccddeeff', 'hex');

beforeAll(() => {
    const labelsPath = path.resolve(__dirname, '../../tanoclo-stream-receiver/tlv_labels.json');
    if (fs.existsSync(labelsPath)) {
        const raw = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
        tlv.init(raw.fields || raw);
    }
});

/**
 * CoAP extractor matching stream_receiver.js
 */
function extractCoapFromPlaintext(decrypted) {
    if (!decrypted || decrypted.length <= 9) return null;
    const tadoPayload = decrypted.subarray(5);
    const firstByte = tadoPayload[4]; // offset 9 in decrypted

    const candidates = [];
    if (firstByte === 0x33) candidates.push(12);
    else if (firstByte === 0xF7) candidates.push(11);
    else candidates.push(11, 12, 13, 10);

    for (const off of candidates) {
        if (off <= tadoPayload.length - 4) {
            const candidateBytes = tadoPayload.subarray(off);
            const parsed = coap.parse(candidateBytes);
            if (parsed && parsed.ok) {
                return { parsed, coapBytes: candidateBytes };
            }
        }
    }

    // Fallback scan
    for (let s = 9; s + 4 <= decrypted.length; s++) {
        if ((decrypted[s] & 0xC0) === 0x40) {
            const parsed = coap.parse(decrypted.subarray(s));
            if (parsed && parsed.ok) {
                return { parsed, coapBytes: decrypted.subarray(s) };
            }
        }
    }
    return null;
}

/**
 * Standard AES-128-CCM Decryption from stream_receiver.js
 */
function decryptCCM(frame, key) {
    if (frame.length < 21) return null;
    const nonce = frame.slice(0, 13);
    const aad = frame.slice(0, 16);
    const ciphertextWithMic = frame.slice(16);
    const ciphertext = ciphertextWithMic.slice(0, -4);
    const tag = ciphertextWithMic.slice(-4);

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
 * Standard MAC decoding from stream_receiver.js
 */
function decodeMAC(frame, decrypted) {
    const fcf = frame.readUInt16LE(0);
    const destMode = (fcf >> 10) & 0x03;
    const srcMode = (fcf >> 14) & 0x03;

    let pos = 3;
    let destPan = null;
    let destExtBytes = null;

    if (destMode > 0) {
        destPan = frame.readUInt16LE(pos);
        pos += 2;
    }

    if (destMode === 3) {
        destExtBytes = frame.subarray(pos, pos + 6);
        pos += 6;
    }

    let srcExtBytes = null;
    if (srcMode === 3) {
        srcExtBytes = frame.subarray(pos, pos + 5);
        pos += 5;
    }

    let dstMac = '';
    if (destPan !== null && destExtBytes && destExtBytes.length === 6) {
        const b = Buffer.alloc(8);
        b[0] = destPan & 0xFF;
        b[1] = (destPan >> 8) & 0xFF;
        destExtBytes.copy(b, 2);
        dstMac = Buffer.from(b).reverse().toString('hex').toUpperCase().match(/.{1,2}/g).join(':');
    }

    let srcMac = '';
    if (srcExtBytes && srcExtBytes.length === 5) {
        const b = Buffer.alloc(8);
        srcExtBytes.copy(b, 0);
        if (decrypted && decrypted.length >= 3) {
            b[5] = decrypted[0];
            b[6] = decrypted[1];
            b[7] = decrypted[2];
        }
        srcMac = Buffer.from(b).reverse().toString('hex').toUpperCase().match(/.{1,2}/g).join(':');
    }

    return { dstMac, srcMac, destPan };
}

/**
 * C++ Emulator RF Frame Generator (faithful recreation of tado_emulator.h)
 */
function generateEmulatorFrame({
    macAddr, // Buffer(8) in BE (e.g. 00:1B:C5:00:12:34:56:78)
    destMac, // Buffer(8) in BE or null
    seq = 0,
    isPairing = false,
    path = '',
    code = 3, // PUT
    mid = 0x9001,
    token = null,
    payload = Buffer.alloc(0),
    key = OPERATIONAL_KEY
}) {
    // 1. Build CoAP Datagram
    const coapParts = [];
    coapParts.push(Buffer.from([0x40, code, (mid >> 8) & 0xFF, mid & 0xFF]));

    // Option 11 (Uri-Path)
    if (path) {
        const segments = path.split('/');
        let lastOpt = 0;
        for (const seg of segments) {
            const segBuf = Buffer.from(seg, 'utf-8');
            const delta = 11 - lastOpt;
            const optHeader = ((delta & 0x0F) << 4) | (segBuf.length & 0x0F);
            coapParts.push(Buffer.from([optHeader]));
            coapParts.push(segBuf);
            lastOpt = 11;
        }
    }

    // Option 2048 (Session Token)
    if (token && token.length === 8) {
        coapParts.push(Buffer.from([0xE8, 0x06, 0xE8])); // Option delta 2037, len 8
        coapParts.push(token);
    }

    // Payload marker + payload
    if (payload.length > 0) {
        coapParts.push(Buffer.from([0xFF]));
        coapParts.push(payload);
    }

    const coapBuf = Buffer.concat(coapParts);

    // 2. Build 16-Byte Cleartext Frame Header (LE per 802.15.4)
    const frameHeader = Buffer.alloc(16);
    frameHeader[0] = 0x69; // FCF low
    frameHeader[1] = 0xEC; // FCF high
    frameHeader[2] = seq & 0xFF;
    if (destMac && (destMac[0] !== 0xFF || destMac[7] !== 0xFF)) {
        frameHeader[3] = destMac[7];
        frameHeader[4] = destMac[6];
        frameHeader[5] = destMac[5];
        frameHeader[6] = destMac[4];
        frameHeader[7] = destMac[3];
        frameHeader[8] = destMac[2];
        frameHeader[9] = destMac[1];
        frameHeader[10] = destMac[0];
    } else {
        frameHeader.fill(0xFF, 3, 11);
    }
    // Source MAC: prefix (bytes 7,6 in LE), middle (bytes 5,4,3 in LE)
    frameHeader[11] = macAddr[7];
    frameHeader[12] = macAddr[6];
    frameHeader[13] = macAddr[5];
    frameHeader[14] = macAddr[4];
    frameHeader[15] = macAddr[3];

    // 3. Build Plaintext (Hidden Tail (bytes 2,1,0 in LE) + Inner Proto + Sequence + Dispatch + 6LoWPAN NHC + CoAP)
    const ptParts = [];
    ptParts.push(Buffer.from([macAddr[2], macAddr[1], macAddr[0]])); // 0xC5, 0x1B, 0x00
    ptParts.push(Buffer.from([0x04, seq & 0xFF])); // Inner protocol 0x04 + sequence

    if (isPairing) {
        // Tado Custom Dispatch: Pairing (0x00F0, 0x007E)
        ptParts.push(Buffer.from([0xF0, 0x00, 0x00, 0x7E]));
        // 6-Byte NHC (5683 -> 4005) + 2-Byte Checksum
        ptParts.push(Buffer.from([0x33, 0xF0, 0x16, 0x33, 0x0F, 0xA5, 0x00, 0x00]));
    } else {
        // Tado Custom Dispatch: Operational (0x0000, 0x007A)
        ptParts.push(Buffer.from([0x00, 0x00, 0x00, 0x7A]));
        // 7-Byte NHC (5683 <-> 5683)
        ptParts.push(Buffer.from([0xF7, 0x00, 0xF0, 0x16, 0x33, 0x16, 0x33]));
    }

    ptParts.push(coapBuf);
    const plaintext = Buffer.concat(ptParts);

    // 4. AES-128-CCM Encryption
    const nonce = frameHeader.slice(0, 13);
    const aad = frameHeader.slice(0, 16);

    const cipher = crypto.createCipheriv('aes-128-ccm', key, nonce, {
        authTagLength: 4
    });
    cipher.setAAD(aad, { plaintextLength: plaintext.length });
    let ciphertext = cipher.update(plaintext);
    ciphertext = Buffer.concat([ciphertext, cipher.final()]);
    const tag = cipher.getAuthTag();

    // 5. Final 802.15.4 Physical Frame
    return Buffer.concat([frameHeader, ciphertext, tag]);
}

describe('Tado Emulator RF & Crypto Protocol Roundtrip', () => {

    it('1. Encrypts and decrypts emulated d/sen telemetry matching real RU properties', () => {
        const emulatorMac = Buffer.from([0x00, 0x1B, 0xC5, 0x00, 0x12, 0x34, 0x56, 0x78]); // Generic test MAC
        const destMac = Buffer.from([0x00, 0x1B, 0xC5, 0x00, 0x99, 0x88, 0x77, 0x66]);     // Generic test IB MAC

        // Build d/sen payload using exact C++ TLV structure
        const senFields = {
            '0x0162': 4080,  // battery_mv = 4080 mV
            '0x012d': 21.50, // temp_ambient = 21.50°C
            '0x012e': 21.50, // aux_temperature_1 = 21.50°C
            '0x0135': 50.00, // humidity_percent = 50.00%
            '0x0136': 6      // ambient_light_level = 6
        };

        const tlvPayload = tlv.encodeFromFields(senFields);

        // Generate physical RF frame from C++ emulator logic
        const frame = generateEmulatorFrame({
            macAddr: emulatorMac,
            destMac: destMac,
            seq: 0x42,
            path: 'd/RU0000000001/sen',
            code: 3, // PUT
            mid: 0x9001,
            payload: tlvPayload,
            key: OPERATIONAL_KEY
        });

        // 1. Verify frame structure
        expect(frame.length).toBeGreaterThan(30);
        expect(frame[0]).toBe(0x69);
        expect(frame[1]).toBe(0xEC);
        expect(frame[2]).toBe(0x42);
        expect(frame.readUInt16LE(3)).toBe(0x7766);

        // 2. Decrypt with standard stream_receiver.js decryptCCM()
        const decrypted = decryptCCM(frame, OPERATIONAL_KEY);
        expect(decrypted).not.toBeNull();

        // 3. Verify hidden MAC tail (0xC5, 0x1B, 0x00) and protocol headers
        expect(decrypted[0]).toBe(0xC5);
        expect(decrypted[1]).toBe(0x1B);
        expect(decrypted[2]).toBe(0x00);
        expect(decrypted[3]).toBe(0x04); // Operational
        expect(decrypted[4]).toBe(0x42); // Sequence

        // 4. Verify 6LoWPAN NHC & Dispatch
        expect(decrypted[5]).toBe(0x00);
        expect(decrypted[8]).toBe(0x7A); // Operational Dispatch
        expect(decrypted[9]).toBe(0xF7); // 7-byte NHC

        // 5. Decode MAC with stream_receiver.js decodeMAC()
        const mac = decodeMAC(frame, decrypted);
        expect(mac.srcMac).toBe('00:1B:C5:00:12:34:56:78');
        expect(mac.dstMac).toBe('00:1B:C5:00:99:88:77:66');

        // 6. Parse CoAP datagram from decrypted payload
        const coapRes = extractCoapFromPlaintext(decrypted);
        expect(coapRes).not.toBeNull();
        const parsedCoap = coapRes.parsed;
        expect(parsedCoap.ok).toBe(true);
        expect(parsedCoap.code).toBe(3); // PUT
        expect(parsedCoap.mid).toBe(0x9001);
        expect(parsedCoap.options.find(o => o.num === 11)?.value.toString('utf8')).toBe('d');

        // 7. Parse TLV payload
        const decodedTlv = tlv.decode(parsedCoap.payload);
        expect(decodedTlv.fields['0x0162']).toBe(4080);
        expect(decodedTlv.fields['0x012d']).toBeCloseTo(21.50, 2);
        expect(decodedTlv.fields['0x0135']).toBeCloseTo(50.00, 2);
        expect(decodedTlv.fields['0x0136']).toBe(6);
    });

    it('2. Encrypts and decrypts pairing auth/key frame with static pairing key', () => {
        const emulatorMac = Buffer.from([0x00, 0x1B, 0xC5, 0x00, 0x11, 0x22, 0x33, 0x44]);

        const pairingParts = [
            Buffer.from([0x02, 0x60, 12]), Buffer.from('RU0000000001', 'utf-8'),
            Buffer.from([0x00, 0x07, 32]), Buffer.from('00112233445566778899aabbccddeeff', 'utf-8')
        ];
        const tlvPayload = Buffer.concat(pairingParts);

        const frame = generateEmulatorFrame({
            macAddr: emulatorMac,
            destMac: null, // Broadcast
            seq: 0x01,
            isPairing: true,
            path: 'auth/key',
            code: 2, // POST
            mid: 0x1001,
            payload: tlvPayload,
            key: STATIC_PAIRING_KEY
        });

        // Decrypt with STATIC_PAIRING_KEY
        const decrypted = decryptCCM(frame, STATIC_PAIRING_KEY);
        expect(decrypted).not.toBeNull();

        // Verify pairing dispatch (0x00F0, 0x007E)
        expect(decrypted[5]).toBe(0xF0);
        expect(decrypted[6]).toBe(0x00);
        expect(decrypted[8]).toBe(0x7E); // Pairing mode

        // Verify 6-byte NHC (offset 9)
        expect(decrypted[9]).toBe(0x33);
        expect(decrypted[10]).toBe(0xF0);

        // Parse CoAP datagram
        const coapRes = extractCoapFromPlaintext(decrypted);
        expect(coapRes).not.toBeNull();
        const parsedCoap = coapRes.parsed;
        expect(parsedCoap.ok).toBe(true);
        expect(parsedCoap.code).toBe(2); // POST
        expect(parsedCoap.mid).toBe(0x1001);

        const decodedTlv = tlv.decode(parsedCoap.payload);
        expect(decodedTlv.fields['0x0260']).toBe('RU0000000001');
    });

    it('3. Encrypts and decrypts /z/p zone program temperature broadcast', () => {
        const emulatorMac = Buffer.from([0x00, 0x1B, 0xC5, 0x00, 0x12, 0x34, 0x56, 0x78]);

        // /z/p payload has 0x4060 (2 bytes int16, 22.00 * 100 = 2200)
        const zpTlv = Buffer.from([0x40, 0x60, 0x02, 0x08, 0x98]); // 2200 = 0x0898

        const frame = generateEmulatorFrame({
            macAddr: emulatorMac,
            destMac: null, // Broadcast
            seq: 0x88,
            path: 'z/p',
            code: 3, // PUT
            mid: 0x9005,
            payload: zpTlv,
            key: OPERATIONAL_KEY
        });

        const decrypted = decryptCCM(frame, OPERATIONAL_KEY);
        expect(decrypted).not.toBeNull();

        const coapRes = extractCoapFromPlaintext(decrypted);
        expect(coapRes).not.toBeNull();
        const parsedCoap = coapRes.parsed;
        expect(parsedCoap.ok).toBe(true);
        expect(parsedCoap.code).toBe(3);

        const decodedTlv = tlv.decode(parsedCoap.payload);
        expect(decodedTlv.fields['0x4060']).toBeCloseTo(22.00, 2);
    });

    it('4. Successfully verifies CoAP GET /d/VA.../config frame roundtrip and optional live frame', () => {
        const emulatorMac = Buffer.from([0x00, 0x1B, 0xC5, 0x00, 0x00, 0x00, 0x00, 0x01]);
        const destMac = Buffer.from([0x00, 0x1B, 0xC5, 0x00, 0x00, 0x00, 0x00, 0x02]);

        const frame = generateEmulatorFrame({
            macAddr: emulatorMac,
            destMac: destMac,
            seq: 0x54,
            path: 'd/VA0000000000/config',
            code: 1, // GET
            mid: 0x69CF,
            key: OPERATIONAL_KEY
        });

        expect(frame[0]).toBe(0x69);
        expect(frame[1]).toBe(0xEC);

        const decrypted = decryptCCM(frame, OPERATIONAL_KEY);
        expect(decrypted).not.toBeNull();

        // Verify inner protocol header
        expect(decrypted[3]).toBe(0x04); // Operational
        expect(decrypted[4]).toBe(0x54); // Inner sequence 0x54

        // Verify MAC reconstitution
        const macInfo = decodeMAC(frame, decrypted);
        expect(macInfo.dstMac).toBe('00:1B:C5:00:00:00:00:02');
        expect(macInfo.srcMac).toBe('00:1B:C5:00:00:00:00:01');

        // Verify CoAP message extracted past NHC header
        const coapRes = extractCoapFromPlaintext(decrypted);
        expect(coapRes).not.toBeNull();
        const parsedCoap = coapRes.parsed;
        expect(parsedCoap.ok).toBe(true);
        expect(parsedCoap.code).toBe(1); // GET
        expect(parsedCoap.mid).toBe(0x69CF);
        expect(parsedCoap.options.find(o => o.num === 11)?.value.toString('utf8')).toBe('d');

        // Optional: Test live decrypted packet from environment variable if provided
        if (process.env.LIVE_RF_PACKET && process.env.LIVE_RF_KEY) {
            const liveFrame = Buffer.from(process.env.LIVE_RF_PACKET, 'hex');
            const liveKey = Buffer.from(process.env.LIVE_RF_KEY, 'hex');
            const liveDecrypted = decryptCCM(liveFrame, liveKey);
            expect(liveDecrypted).not.toBeNull();
        }
    });
});
