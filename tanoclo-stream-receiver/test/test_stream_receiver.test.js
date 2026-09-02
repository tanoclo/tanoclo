/**
 * @file test/test_stream_receiver.test.js
 * @brief Comprehensive test suite for tanoclo-stream-receiver.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import rfCrypto from '../lib/rf-crypto.js';
import SixLoWPANReassembler from '../lib/reassembler.js';
import * as coapParser from '../lib/coap.js';
import * as tlvDecoder from '../lib/tlv.js';
import deviceRegistry from '../lib/device-registry.js';
import * as haDiscovery from '../lib/ha-discovery.js';
import * as messageProcessor from '../lib/message-processor.js';
import * as mqttPublisher from '../lib/mqtt-publisher.js';
import * as csl from '../lib/csl.js';
import * as icmpv6 from '../lib/icmpv6.js';

describe('rf-crypto module', () => {
    const testKey = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');

    it('extracts PAN ID correctly from 802.15.4 frame', () => {
        // [length: 1B][FCF: 2B (0xEC69 -> 0x69 0xEC)][Seq: 1B][PAN: 2B (0x1234 -> 0x34 0x12)]...
        const frame = Buffer.from([0x12, 0x69, 0xEC, 0x01, 0x34, 0x12, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
        const pan = rfCrypto.getPanId(frame);
        expect(pan).toBe(0x1234);
    });

    it('performs AES-128-CCM encryption and decryption roundtrip', () => {
        // 16-byte MAC header (0..12 is nonce, 0..15 is AAD)
        const macHeader = Buffer.from('69ec013412aabbccddeeff0011223344', 'hex');
        const plaintext = Buffer.from('001bc504010000007e33f016330fb7000040011234', 'hex');

        const nonce = macHeader.subarray(0, 13);
        const cipher = crypto.createCipheriv('aes-128-ccm', testKey, nonce, { authTagLength: 4 });
        cipher.setAAD(macHeader, { plaintextLength: plaintext.length });
        let encrypted = cipher.update(plaintext);
        encrypted = Buffer.concat([encrypted, cipher.final()]);
        const tag = cipher.getAuthTag();

        const fullFrame = Buffer.concat([macHeader, encrypted, tag]);
        const decrypted = rfCrypto.decryptCCM(fullFrame, testKey);

        expect(decrypted).not.toBeNull();
        expect(decrypted.toString('hex')).toBe(plaintext.toString('hex'));
    });

    it('reconstructs MAC addresses and identifies direction', () => {
        // Short addressing: FCF=0x8869 (dest short, src short, security, pan compress)
        // Dest short = 0x0000 (IB coordinator), Src short = 0x1234 (VA end device)
        const frame = Buffer.from([0x69, 0x88, 0x01, 0x34, 0x12, 0x00, 0x00, 0x34, 0x12]);
        const macInfo = rfCrypto.decodeMAC(frame, null);

        expect(macInfo.dstMac).toBeDefined();
        expect(macInfo.srcMac).toBeDefined();
        expect(macInfo.isDstIb).toBe(true);
        expect(macInfo.isSrcVa).toBe(true);
        expect(macInfo.direction).toBe('CLIENT_TO_SERVER');
    });
});

describe('6LoWPAN Reassembler module', () => {
    it('reassembles FRAG1 and FRAGN fragments into complete datagram', () => {
        const reassembler = new SixLoWPANReassembler();
        const tag = 0x55AA;
        const totalSize = 100; // total uncompressed datagram size

        // FRAG1 header: [0xC0 | (size >> 8)][size & 0xFF][tag >> 8][tag & 0xFF]
        const frag1Hdr = Buffer.from([0xC0 | ((totalSize >> 8) & 0x07), totalSize & 0xFF, (tag >> 8) & 0xFF, tag & 0xFF]);
        const frag1Payload = Buffer.alloc(24, 0xAA); // 24 bytes + 40 expansion = 64 uncompressed bytes (8 * 8)
        const frag1Packet = Buffer.concat([
            Buffer.from([0x12, 0x34, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00]), // 8-byte prefix
            frag1Hdr,
            frag1Payload
        ]);

        const res1 = reassembler.process(frag1Packet, '12:00:00');
        expect(res1.type).toBe('incomplete');
        expect(res1.tag).toBe(tag);

        // FRAGN header: [0xE0 | (size >> 8)][size & 0xFF][tag >> 8][tag & 0xFF][offset / 8]
        // Uncompressed offset = 64 (offset / 8 = 8)
        const offsetChunk = 8;
        const fragnHdr = Buffer.from([0xE0 | ((totalSize >> 8) & 0x07), totalSize & 0xFF, (tag >> 8) & 0xFF, tag & 0xFF, offsetChunk]);
        const fragnPayload = Buffer.alloc(36, 0xBB); // 24 + 36 = 60 bytes, reaching compressed target size (100 - 40 = 60)
        const fragnPacket = Buffer.concat([
            Buffer.from([0x12, 0x34, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00]),
            fragnHdr,
            fragnPayload
        ]);

        const res2 = reassembler.process(fragnPacket, '12:00:01');
        expect(res2.type).toBe('complete');
        expect(res2.tag).toBe(tag);
        expect(res2.data).toBeDefined();
    });
});

describe('CoAP parser & serializer', () => {
    it('serializes and parses CoAP CON PUT request with options', () => {
        const msg = {
            ver: 1,
            type: coapParser.TYPE_CON,
            code: coapParser.CODE_PUT,
            mid: 0x4321,
            token: Buffer.from('aabb', 'hex'),
            options: [
                { num: coapParser.OPT_URI_PATH, value: Buffer.from('d') },
                { num: coapParser.OPT_URI_PATH, value: Buffer.from('VA0000000001') },
                { num: coapParser.OPT_URI_PATH, value: Buffer.from('sen') },
                { num: coapParser.OPT_CONTENT_FORMAT, value: Buffer.from([42]) },
                { num: coapParser.OPT_VENDOR_2048, value: Buffer.from('0102030405060708', 'hex') }
            ],
            payload: Buffer.from('012d020834', 'hex')
        };

        const raw = coapParser.serialize(msg);
        const parsed = coapParser.parse(raw);

        expect(parsed.ok).toBe(true);
        expect(parsed.type).toBe(coapParser.TYPE_CON);
        expect(parsed.code).toBe(coapParser.CODE_PUT);
        expect(parsed.mid).toBe(0x4321);
        expect(parsed.token.toString('hex')).toBe('aabb');
        expect(parsed.options.length).toBe(5);
        expect(parsed.payload.toString('hex')).toBe('012d020834');
    });

    it('safely parses malformed option with nibble 15 fallback', () => {
        // [Ver:1, Type:CON, TKL:0][Code: PUT][MID: 0x1111][Malformed Option 0xF0][0xFF Payload marker][01 02]
        const raw = Buffer.from([0x40, 0x03, 0x11, 0x11, 0xF0, 0xFF, 0x01, 0x02]);
        const parsed = coapParser.parse(raw);
        expect(parsed.ok).toBe(true);
        expect(parsed.payload.toString('hex')).toBe('0102');
    });
});

describe('TLV decoder & transformers', () => {
    beforeEach(() => {
        tlvDecoder.init({
            '0x012d': { name: 'temperature_ambient', type: 's16be', scale: 0.01 },
            '0x0135': { name: 'humidity_percent', type: 'u16be', scale: 0.01 },
            '0x021c': { name: 'battery_mv', type: 'u16be', scale: 1 },
            '0x0265': { name: 'va_act_position_steps', type: 's16be', scale: 1 }
        });
    });

    it('decodes TLV binary payload into named fields', () => {
        // [0x012D, len 2, 21.00°C = 2100 = 0x0834][0x0135, len 2, 50.00% = 5000 = 0x1388][0x021C, len 2, 3000mV = 0x0BB8]
        const payload = Buffer.from('012d0208340135021388021c020bb8', 'hex');
        const decoded = tlvDecoder.decode(payload);

        expect(decoded.ok).toBe(true);
        expect(decoded.fields.temperature_ambient).toBe(21.00);
        expect(decoded.fields.humidity_percent).toBe(50.00);
        expect(decoded.fields.battery_mv).toBe(3000);
    });

    it('decodes reset reasons and error flags bitmasks', () => {
        expect(tlvDecoder.decodeResetReason(1)).toBe('PIN');
        expect(tlvDecoder.decodeResetReason(2)).toBe('POR/PDR');
        expect(tlvDecoder.decodeResetReason(3)).toBe('PIN+POR/PDR');
        expect(tlvDecoder.decodeResetReason(0)).toBe('None');

        expect(tlvDecoder.decodeErrorFlags(0x80)).toBe('Link Loss/Offline');
        expect(tlvDecoder.decodeErrorFlags(0x800)).toBe('Motor Blocked');
        expect(tlvDecoder.decodeErrorFlags(0)).toBe('None');
    });

    it('calculates valve percentage correctly', () => {
        // low = 1000 (closed, 0%), high = 500 (open, 100%)
        expect(tlvDecoder.calculateValvePositionPct(1000, 1000, 500)).toBe(0);
        expect(tlvDecoder.calculateValvePositionPct(500, 1000, 500)).toBe(100);
        expect(tlvDecoder.calculateValvePositionPct(750, 1000, 500)).toBe(50);
    });
});

describe('Device Registry & Message Processor', () => {
    it('binds MAC to serial and registers state updates', () => {
        const mac = '00:1B:C5:07:31:56:AB:CD';
        const serial = 'VA0000000001';

        deviceRegistry.bindMacToSerial(mac, serial, 'VA02');
        const dev = deviceRegistry.getDevice(serial);

        expect(dev).not.toBeNull();
        expect(dev.serial).toBe(serial);
        expect(dev.deviceType).toBe('VA02');
        expect(dev.mac).toBe(mac);

        deviceRegistry.updateState(serial, {
            temperature: 22.5,
            humidity: 48.0
        });

        expect(dev.state.temperature).toBe(22.5);
        expect(dev.state.humidity).toBe(48.0);
    });

    it('detects emulated device personality', () => {
        const mac = '00:1B:C5:07:31:56:11:22';
        const serial = 'RU0000000001';

        deviceRegistry.bindMacToSerial(mac, serial, 'RU02');
        const dev = deviceRegistry.updateState(serial, {}, {
            fwVersion: '13762',
            hardwareRevision: 4
        });

        expect(dev.isEmulated).toBe(true);
    });
});

describe('Home Assistant Passive Discovery constraints', () => {
    it('ensures all generated entities are read-only and prefixed with tanoclo_sniffer_', () => {
        const published = [];
        const mockClient = {
            connected: true,
            publish: (topic, payload, opts) => {
                published.push({ topic, payload: JSON.parse(payload) });
            }
        };

        mqttPublisher.setClient(mockClient);
        haDiscovery.setMqttClient(mockClient);
        haDiscovery.init({ mqtt: { enabled: true, haPath: 'homeassistant' } });
        haDiscovery.clearCache();

        const testDev = {
            serial: 'VA0000000001',
            cleanMac: '001BC5073156ABCD',
            deviceType: 'VA02',
            friendlyName: 'Living Room Radiator',
            isEmulated: false,
            fwVersion: '54.20'
        };

        haDiscovery.publishDeviceDiscovery(testDev);

        expect(published.length).toBeGreaterThan(5);

        for (const pub of published) {
            // 1. Topic must start with homeassistant/
            expect(pub.topic.startsWith('homeassistant/')).toBe(true);

            // 2. Unique ID must use tanoclo_sniffer_ prefix
            expect(pub.payload.unique_id.startsWith('tanoclo_sniffer_VA0000000001_')).toBe(true);

            // 3. Device identifier must be tanoclo_sniffer_dev_VA0000000001
            expect(pub.payload.device.identifiers[0]).toBe('tanoclo_sniffer_dev_VA0000000001');

            // 4. Must NOT contain command_topic (strict passive sniffing requirement)
            expect(pub.payload.command_topic).toBeUndefined();

            // 5. Must NOT be an active control domain (switch, number, select, button)
            const domain = pub.topic.split('/')[1];
            expect(['sensor', 'binary_sensor']).toContain(domain);
        }

        mqttPublisher.setClient(null);
    });
});

describe('CSL & MAC Coordination module', () => {
    it('identifies and parses CSL Multipurpose wake-up beacon (0x25)', () => {
        // 12-byte CSL beacon: 25 [seq] [panId: 2B LE] [dstShort: 2B LE] [phase: 2B LE] [countdown: 2B LE] [period: 2B LE]
        const beaconBuf = csl.buildCSLBeacon({
            seq: 0x42,
            panId: 0xFA93,
            dstShort: 0x1234,
            countdown: 5,
            period: 0x3F80
        });

        expect(csl.isCSLBeacon(beaconBuf)).toBe(true);
        const parsed = csl.parseCSLBeacon(beaconBuf);
        expect(parsed).not.toBeNull();
        expect(parsed.fcf).toBe(0x25);
        expect(parsed.seq).toBe(0x42);
        expect(parsed.panId).toBe(0xFA93);
        expect(parsed.dstShort).toBe('0x1234');
        expect(parsed.isBroadcast).toBe(false);
        expect(parsed.period).toBe(0x3F80);
    });

    it('identifies and parses Extended MAC Coordination Frame (0xEE42)', () => {
        const frame = Buffer.from('42ee0193fa010203040506010203040506070800', 'hex');
        expect(csl.isMACCoordinationFrame(frame)).toBe(true);
        const parsed = csl.parseMACCoordinationFrame(frame);
        expect(parsed).not.toBeNull();
        expect(parsed.fcf).toBe(0xEE42);
        expect(parsed.seq).toBe(1);
        expect(parsed.panId).toBe(0xFA93);
    });
});

describe('ICMPv6 deterministic RFC 6282 parser', () => {
    it('parses Echo Request (128) with 0x04 operational framing', () => {
        // Mode 0x7A, 0x33, NH=0x3A, Echo Req type=128 code=0 csum=0x1234 id=0x0001 seq=0x0002
        const echoReq = Buffer.from('001bc504010000007a333a8000123400010002', 'hex');
        const parsed = icmpv6.parseICMPv6(echoReq);
        expect(parsed).not.toBeNull();
        expect(parsed.type).toBe(128);
        expect(parsed.identifier).toBe(1);
        expect(parsed.sequence).toBe(2);
    });

    it('parses Neighbor Solicitation (135) with 0x39 framing', () => {
        // 00 00 7b 39 3a 02 01 ff 0d 95 30 87 00 c9 b4 + 20-byte NS body
        const nsBuf = Buffer.from('00007b393a0201ff0d95308700c9b400000000fe80000000000000001bc5073156abcd', 'hex');
        const parsed = icmpv6.parseICMPv6(nsBuf);
        expect(parsed).not.toBeNull();
        expect(parsed.type).toBe(135);
        expect(parsed.typeName).toContain('Neighbor Solicitation');
        expect(parsed.targetIp).toBe('fe80:0:0:0:1b:c507:3156:abcd');
    });

    it('builds valid Echo Reply (129)', () => {
        const reply = icmpv6.buildEchoReply(0x0042, 0x0001);
        expect(reply[0]).toBe(129); // Type 129
        expect(reply[1]).toBe(0);   // Code 0
        expect(reply.readUInt16BE(4)).toBe(0x0042); // ID
        expect(reply.readUInt16BE(6)).toBe(0x0001); // Seq
    });
});

describe('Deterministic CoAP offset and CRC16 stripping', () => {
    it('parses empty CoAP ACK with trailing 2-byte Kermit CRC-16', () => {
        // ACK 2.04 MID=0x1234 Option 12 (0xC1 0x2A) + 2-byte CRC (0x12 0x34)
        const ackWithCrc = Buffer.from('60441234c12a1234', 'hex');
        const parsed = coapParser.parse(ackWithCrc);
        expect(parsed.ok).toBe(true);
        expect(parsed.type).toBe(2); // ACK
        expect(parsed.code).toBe(0x44); // 2.04 Changed
        expect(parsed.mid).toBe(0x1234);
    });

    it('deterministically finds CoAP offset across IPHC 0x33 and mode 0x7C 0xD7', () => {
        // Mode 0x7E + 0x33 + NHC 0xF0 + ports (4B) + csum (2B) + CoAP header (4B)
        const frame7E = Buffer.from('04010000007e33f016331633000040011234', 'hex');
        expect(coapParser.findCoapOffset(frame7E)).toBe(14);

        // Mode 0x7C + 0xD7 + NHC 0xF0 + ports (4B) + csum (2B) + CoAP header (4B)
        const frame7C = Buffer.alloc(30);
        frame7C[0] = 0x04;
        frame7C[5] = 0x7C;
        frame7C[6] = 0xD7;
        frame7C[17] = 0xF0;
        frame7C[24] = 0x40; // CoAP ver 1 at offset 24 (17 + 1 + 4 + 2)
        expect(coapParser.findCoapOffset(frame7C)).toBe(24);
    });
});

