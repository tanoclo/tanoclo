/**
 * @file test/test_unit_wsbridge.test.js
 * @brief Vitest testing suite validating server modules.
 */

'use strict';

/**
 * Unit Tests for lib/ws-bridge.js
 *
 * Run: node ws-server/test/test_unit_wsbridge.js
 */

const wsBridge = require('../lib/ws-bridge');



test('legacy test suite runs successfully', async () => {
  let passed = 0;
  let failed = 0;
  
  function test(name, condition, detail = '') {
      if (condition) { passed++; console.log(`  ✓ ${name}`); }
      else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
  }
  function section(title) { console.log(`\n══ ${title} ══`); }
  function bufEq(a, b) { return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b); }
  
  // ═══════════════════════════════════════════
  // 1. ipv6FromBytes / ipv6ToBytes round-trip
  // ═══════════════════════════════════════════
  section('1. IPv6 conversion');
  
  // Standard address
  const ipv6Str1 = 'fe80:0:0:0:2:1bc5:731:36e3';
  const ipv6Bytes1 = wsBridge.ipv6ToBytes(ipv6Str1);
  test('ipv6ToBytes: returns 16 bytes', ipv6Bytes1.length === 16);
  const ipv6Back1 = wsBridge.ipv6FromBytes(ipv6Bytes1);
  test('ipv6FromBytes round-trip', ipv6Back1 === ipv6Str1);
  
  // Loopback (::1)
  const ipv6Bytes2 = wsBridge.ipv6ToBytes('::1');
  test('ipv6ToBytes ::1: 16 bytes', ipv6Bytes2.length === 16);
  const ipv6Back2 = wsBridge.ipv6FromBytes(ipv6Bytes2);
  test('ipv6FromBytes ::1: last group = 1', ipv6Back2.endsWith(':1'));
  
  // Verify all-zeros except last
  for (let i = 0; i < 14; i++) {
      if (ipv6Bytes2[i] !== 0) { test('::1 prefix zeros', false, `byte ${i} = ${ipv6Bytes2[i]}`); break; }
  }
  test('::1 last word = 1', ipv6Bytes2.readUInt16BE(14) === 1);
  
  // All zeros (::)
  const ipv6Bytes3 = wsBridge.ipv6ToBytes('::');
  test('ipv6ToBytes ::: all zeros', ipv6Bytes3.every(b => b === 0));
  
  // Full address without shorthand
  const fullAddr = '2001:db8:85a3:0:0:8a2e:370:7334';
  const fullBytes = wsBridge.ipv6ToBytes(fullAddr);
  const fullBack = wsBridge.ipv6FromBytes(fullBytes);
  test('Full address round-trip', fullBack === fullAddr);
  
  // ═══════════════════════════════════════════
  // 2. build / parse round-trip
  // ═══════════════════════════════════════════
  section('2. build / parse round-trip');
  
  const coapPayload = Buffer.from([0x40, 0x01, 0x00, 0x01]); // Minimal CoAP GET
  
  // Client-to-server
  const frame1 = wsBridge.build({
      direction: 'client_to_server',
      ipv6: 'fe80:0:0:0:2:1bc5:731:36e3',
      coapBytes: coapPayload,
      fieldA: 0x0B00,
      fieldB: 0x04,
      udpPort: 0x1633,
      fieldC: 0x0005
  });
  test('build c2s: returns buffer', Buffer.isBuffer(frame1));
  test('build c2s: length = 28 + 4', frame1.length === 32);
  
  const parsed1 = wsBridge.parse(frame1);
  test('parse c2s: ok = true', parsed1.ok === true);
  test('parse c2s: direction = client_to_server', parsed1.direction === 'client_to_server');
  test('parse c2s: directionU16 = 0x0001', parsed1.directionU16 === 0x0001);
  test('parse c2s: ipv6', parsed1.ipv6 === 'fe80:0:0:0:2:1bc5:731:36e3');
  test('parse c2s: fieldA = 0x0B00', parsed1.fieldA === 0x0B00);
  test('parse c2s: fieldB = 0x04', parsed1.fieldB === 0x04);
  test('parse c2s: udpPort = 0x1633', parsed1.udpPort === 0x1633);
  test('parse c2s: fieldC = 0x0005', parsed1.fieldC === 0x0005);
  test('parse c2s: coapLen = 4', parsed1.coapLen === 4);
  test('parse c2s: coapBytes match', bufEq(parsed1.coapBytes, coapPayload));
  
  // Server-to-client
  const frame2 = wsBridge.build({
      direction: 'server_to_client',
      ipv6: '::1',
      coapBytes: coapPayload,
      fieldA: 0,
      fieldB: 0,
      udpPort: 5683,
      fieldC: 0
  });
  const parsed2 = wsBridge.parse(frame2);
  test('parse s2c: direction = server_to_client', parsed2.direction === 'server_to_client');
  test('parse s2c: directionU16 = 0x0002', parsed2.directionU16 === 0x0002);
  test('parse s2c: udpPort = 5683', parsed2.udpPort === 5683);
  
  // ═══════════════════════════════════════════
  // 3. Edge cases
  // ═══════════════════════════════════════════
  section('3. Edge cases');
  
  // Too short
  const tooShort = wsBridge.parse(Buffer.alloc(10));
  test('parse too short (10 bytes): ok = false', !tooShort.ok);
  test('parse too short: has error', typeof tooShort.err === 'string');
  
  // Wrong IPv6 length byte
  const badFrame = Buffer.alloc(32);
  badFrame.writeUInt16BE(0x0001, 0);    // direction
  badFrame[2] = 0x08;                    // wrong ipv6 len (should be 0x10)
  const badParsed = wsBridge.parse(badFrame);
  test('parse bad ipv6 len: ok = false', !badParsed.ok);
  test('parse bad ipv6 len: error mentions length', badParsed.err.includes('IPv6'));
  
  // CoAP length exceeds frame
  const overflowFrame = Buffer.alloc(30);
  overflowFrame.writeUInt16BE(0x0001, 0);
  overflowFrame[2] = 0x10;
  overflowFrame.writeUInt16BE(9999, 26); // coapLen = 9999, but only 2 bytes remain
  const overflowParsed = wsBridge.parse(overflowFrame);
  test('parse overflow coapLen: ok = false', !overflowParsed.ok);
  test('parse overflow: error msg', overflowParsed.err.includes('exceeds'));
  
  // Empty CoAP payload (just header)
  const emptyCoap = wsBridge.build({
      direction: 'client_to_server',
      ipv6: '::',
      coapBytes: Buffer.alloc(0)
  });
  const emptyParsed = wsBridge.parse(emptyCoap);
  test('parse zero-length coap: ok = true', emptyParsed.ok === true);
  test('parse zero-length coap: coapLen = 0', emptyParsed.coapLen === 0);
  
  // Unknown direction
  const unknownDir = Buffer.alloc(28);
  unknownDir.writeUInt16BE(0x0099, 0); // not 0x0001 or 0x0002
  unknownDir[2] = 0x10;
  unknownDir.writeUInt16BE(0, 26); // coapLen = 0
  const unknownParsed = wsBridge.parse(unknownDir);
  test('parse unknown direction: ok = true', unknownParsed.ok === true);
  test('parse unknown direction: direction = unknown', unknownParsed.direction === 'unknown');
  
  // ═══════════════════════════════════════════
  // 4. Direction constants
  // ═══════════════════════════════════════════
  section('4. Direction constants');
  test('DIR_CLIENT_TO_SERVER = 0x0001', wsBridge.DIR_CLIENT_TO_SERVER === 0x0001);
  test('DIR_SERVER_TO_CLIENT = 0x0002', wsBridge.DIR_SERVER_TO_CLIENT === 0x0002);
  
  // ═══════════════════════════════════════════
  // 5. Large CoAP payload
  // ═══════════════════════════════════════════
  section('5. Large payload');
  
  const largePayload = Buffer.alloc(500, 0xAB);
  const largeFrame = wsBridge.build({
      direction: 'server_to_client',
      ipv6: 'fe80::1',
      coapBytes: largePayload
  });
  const largeParsed = wsBridge.parse(largeFrame);
  test('large payload: ok = true', largeParsed.ok === true);
  test('large payload: coapLen = 500', largeParsed.coapLen === 500);
  test('large payload: bytes match', bufEq(largeParsed.coapBytes, largePayload));
  
  // ═══════════════════════════════════════════
  // 6. Field defaults
  // ═══════════════════════════════════════════
  section('6. Field defaults');
  
  const defaultFrame = wsBridge.build({
      direction: 'client_to_server',
      ipv6: '::',
      coapBytes: Buffer.from([0x01])
      // no fieldA, fieldB, udpPort, fieldC — should default to 0
  });
  const defaultParsed = wsBridge.parse(defaultFrame);
  test('default fieldA = 0', defaultParsed.fieldA === 0);
  test('default fieldB = 0', defaultParsed.fieldB === 0);
  test('default udpPort = 0', defaultParsed.udpPort === 0);
  test('default fieldC = 0', defaultParsed.fieldC === 0);
  
  // ═══════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════
  section('RESULTS');
  const total = passed + failed;
  console.log(`  Total: ${total} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`  ${failed === 0 ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'}\n`);
  if (failed > 0) throw new Error('Some tests failed');
  
});