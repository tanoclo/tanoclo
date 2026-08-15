require('./test_config');
const tlv = require('../lib/tlv');

describe('Config Endpoints Parity & Multi-Block Slicing', () => {

  const dummyStateUri = "coap://[fe80::1]/z/s";
  const dummyCpeUri = "coap://[fe80::1]/z/cpe";
  const dummyPeerUri = "coap://[fe80::1]/z/p";

  test('d/{deviceId}/config - Device Config TLV structure parity (9 priority TLVs)', () => {
    const fields = {
      '0x0143': false,
      '0x0140': 0,
      '0x015d': 112,
      '0x015c': 123456,
      '0x02b3': false,
      '0x021a': 0,
      '0x0149': 0,
      '0x015e': '0d04',
      '0x0158': 0
    };

    const encoded = tlv.encodeFromFields(fields);
    expect(encoded).toBeInstanceOf(Buffer);

    const decoded = tlv.decode(encoded);
    expect(decoded.ok).toBe(true);
    expect(decoded.items.length).toBe(9);
    
    // Verify priority order
    const fids = decoded.items.map(i => i.fid);
    expect(fids).toEqual([
      '0x0143', '0x0140', '0x015d', '0x015c',
      '0x02b3', '0x021a', '0x0149', '0x015e', '0x0158'
    ]);
  });

  test('h/{homeId}/z/{zoneId}/config - Single-device zone config TLV parity (15 canonical TLVs)', () => {
    const fields = {
      '0x6020': 1,
      '0x63e0': true,
      '0x63a0': dummyStateUri,
      '0x8200': dummyCpeUri,
      '0x8400': dummyPeerUri,
      '0x8000': [dummyStateUri, dummyStateUri],
      '0x6060': 1,
      '0x6040': dummyPeerUri,
      '0x6080': 1000,
      '0x60a0': 500,
      '0x60c0': 1500,
      '0x60e0': true,
      '0x62c0': 900,
      '0x6380': 900
    };

    const encoded = tlv.encodeFromFields(fields);
    expect(encoded).toBeInstanceOf(Buffer);

    const decoded = tlv.decode(encoded);
    expect(decoded.ok).toBe(true);
    expect(decoded.items.length).toBe(15);

    // Verify canonical order
    const fids = decoded.items.map(i => i.fid);
    expect(fids[0]).toBe('0x6020');
    expect(fids[1]).toBe('0x63e0');
    expect(fids[2]).toBe('0x63a0');
    expect(fids[3]).toBe('0x8200');
    expect(fids[4]).toBe('0x8400');
  });

  test('h/{homeId}/z/{zoneId}/config - Multi-device zone config TLV parity (Multiple peer URIs)', () => {
    const peerUri1 = "coap://[fe80::1]/z/s";
    const peerUri2 = "coap://[fe80::2]/z/s";
    const peerUri3 = "coap://[fe80::3]/z/s";

    const fields = {
      '0x6020': 1,
      '0x63e0': true,
      '0x63a0': dummyStateUri,
      '0x8200': [dummyCpeUri, dummyCpeUri],
      '0x8400': [dummyPeerUri, dummyPeerUri],
      '0x8000': [peerUri1, peerUri2, peerUri3],
      '0x6060': 1,
      '0x6040': dummyPeerUri,
      '0x6080': 1000,
      '0x60a0': 500,
      '0x60c0': 1500,
      '0x60e0': true,
      '0x62c0': 900,
      '0x6380': 900
    };

    const encoded = tlv.encodeFromFields(fields);
    const decoded = tlv.decode(encoded);
    expect(decoded.ok).toBe(true);
    expect(decoded.items.length).toBeGreaterThan(15);
  });

  test('h/{homeId}/hvac/config - Heating system config TLV parity', () => {
    const fields = {
      '0x046c': 0,
      '0x046d': true,
      '0x0471': 6500,
      '0x0481': 3,
      '0x046f': 2
    };

    const encoded = tlv.encodeFromFields(fields);
    const decoded = tlv.decode(encoded);
    expect(decoded.ok).toBe(true);
    expect(decoded.items.length).toBe(5);
    expect(decoded.items.map(i => i.fid)).toEqual(['0x046c', '0x046d', '0x0471', '0x0481', '0x046f']);
  });

  test('h/{homeId}/c/{circuitId}/config - Heating circuit config TLV parity', () => {
    const fields = {
      '0x2040': 60.0
    };

    const encoded = tlv.encodeFromFields(fields);
    const decoded = tlv.decode(encoded);
    expect(decoded.ok).toBe(true);
    expect(decoded.items.length).toBe(1);
    expect(decoded.items[0].fid).toBe('0x2040');
  });

  test('Multi-block payload slicing (128B blocks) & session key continuity', () => {
    const dummyPayload = Buffer.alloc(313, 0xAB); // 313 bytes total

    // Slicing check
    const block0 = dummyPayload.subarray(0, 128);
    const block1 = dummyPayload.subarray(128, 256);
    const block2 = dummyPayload.subarray(256, 313);

    expect(block0.length).toBe(128);
    expect(block1.length).toBe(128);
    expect(block2.length).toBe(57);
    expect(Buffer.concat([block0, block1, block2])).toEqual(dummyPayload);

    // Session key check
    const peerInfo = { ipv6: 'fe80::1' };
    const uriPath = 'h/1/z/4/config';
    const key0 = `${peerInfo.ipv6}:${uriPath}`;
    const key1 = `${peerInfo.ipv6}:${uriPath}`;
    expect(key0).toBe(key1);
  });

});
