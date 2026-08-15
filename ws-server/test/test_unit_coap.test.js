/**
 * @file test/test_unit_coap.test.js
 * @brief Vitest testing suite validating server modules.
 */

'use strict';

/**
 * Unit Tests for lib/coap.js
 *
 * Run: node ws-server/test/test_unit_coap.js
 */

const coap = require('../lib/coap');



test('legacy test suite runs successfully', async () => {
  let passed = 0;
  let failed = 0;
  
  function test(name, condition, detail = '') {
      if (condition) { passed++; console.log(`  ✓ ${name}`); }
      else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
  }
  function section(title) { console.log(`\n══ ${title} ══`); }
  function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function bufEq(a, b) { return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b); }
  
  // ═══════════════════════════════════════════
  // 1. codeStr
  // ═══════════════════════════════════════════
  section('1. codeStr');
  test('GET = GET', coap.codeStr(1) === 'GET');
  test('POST = POST', coap.codeStr(2) === 'POST');
  test('PUT = PUT', coap.codeStr(3) === 'PUT');
  test('DELETE = DELETE', coap.codeStr(4) === 'DELETE');
  test('2.04 Changed', coap.codeStr(0x44) === '2.04');
  test('2.05 Content', coap.codeStr(0x45) === '2.05');
  test('2.03 Valid', coap.codeStr(0x43) === '2.03');
  test('2.31 Continue', coap.codeStr(0x5F) === '2.31');
  test('4.01 Unauthorized', coap.codeStr(0x81) === '4.01');
  test('Empty code', coap.codeStr(0) === '0.00');
  
  // ═══════════════════════════════════════════
  // 2. isRequest
  // ═══════════════════════════════════════════
  section('2. isRequest');
  test('GET is request', coap.isRequest(1) === true);
  test('POST is request', coap.isRequest(2) === true);
  test('PUT is request', coap.isRequest(3) === true);
  test('DELETE is request', coap.isRequest(4) === true);
  test('2.04 is not request', coap.isRequest(0x44) === false);
  test('2.05 is not request', coap.isRequest(0x45) === false);
  test('Empty is not request', coap.isRequest(0) === false);
  
  // ═══════════════════════════════════════════
  // 3. encOptUint / decOptUint
  // ═══════════════════════════════════════════
  section('3. encOptUint / decOptUint round-trip');
  for (const val of [0, 1, 127, 128, 255, 256, 0xFFFF, 0x10000, 0xFFFFFF, 0x01234567]) {
      const encoded = coap.encOptUint(val);
      const decoded = coap.decOptUint(encoded);
      test(`Round-trip ${val}`, decoded === val, `got ${decoded}`);
  }
  test('decOptUint empty buffer = 0', coap.decOptUint(Buffer.alloc(0)) === 0);
  
  // ═══════════════════════════════════════════
  // 4. parse + serialize round-trip
  // ═══════════════════════════════════════════
  section('4. parse / serialize round-trip');
  
  // Build a CON GET with options and no payload
  const req1 = coap.buildRequest({
      code: coap.CODE_GET,
      path: 'd/IB001/config',
      token: Buffer.from([0xAA, 0xBB]),
      mid: 0x1234,
      type: coap.TYPE_CON
  });
  const parsed1 = coap.parse(req1);
  test('parse GET: ok = true', parsed1.ok === true);
  test('parse GET: type = CON (0)', parsed1.type === coap.TYPE_CON);
  test('parse GET: code = GET (1)', parsed1.code === coap.CODE_GET);
  test('parse GET: mid = 0x1234', parsed1.mid === 0x1234);
  test('parse GET: token length = 2', parsed1.tkl === 2);
  test('parse GET: token matches', bufEq(parsed1.token, Buffer.from([0xAA, 0xBB])));
  test('parse GET: uri-path = d/IB001/config', coap.uriPath(parsed1) === 'd/IB001/config');
  test('parse GET: empty payload', parsed1.payload.length === 0);
  
  // Re-serialize and compare
  const reserialized = coap.serialize({
      ver: parsed1.ver,
      type: parsed1.type,
      code: parsed1.code,
      mid: parsed1.mid,
      token: parsed1.token,
      options: parsed1.options,
      payload: parsed1.payload
  });
  test('serialize round-trip produces same bytes', bufEq(req1, reserialized));
  
  // Build a CON POST with payload
  const payload2 = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
  const req2 = coap.buildRequest({
      code: coap.CODE_POST,
      path: 'auth/token',
      token: Buffer.from([0xCC]),
      mid: 0x5678,
      type: coap.TYPE_CON,
      payload: payload2
  });
  const parsed2 = coap.parse(req2);
  test('parse POST: ok = true', parsed2.ok === true);
  test('parse POST: code = POST (2)', parsed2.code === coap.CODE_POST);
  test('parse POST: mid = 0x5678', parsed2.mid === 0x5678);
  test('parse POST: payload matches', bufEq(parsed2.payload, payload2));
  
  // ═══════════════════════════════════════════
  // 5. buildAck / buildAckWithPayload / buildAckWithOptions
  // ═══════════════════════════════════════════
  section('5. buildAck variants');
  
  const ack1 = coap.buildAck(parsed1);
  const parsedAck1 = coap.parse(ack1);
  test('buildAck: type = ACK (2)', parsedAck1.type === coap.TYPE_ACK);
  test('buildAck: code = 2.04 (Changed)', parsedAck1.code === coap.CODE_CHANGED);
  test('buildAck: mid echoed', parsedAck1.mid === parsed1.mid);
  test('buildAck: token echoed', bufEq(parsedAck1.token, parsed1.token));
  test('buildAck: empty payload', parsedAck1.payload.length === 0);
  
  const ackPayload = Buffer.from('hello');
  const ack2 = coap.buildAckWithPayload(parsed2, coap.CODE_CONTENT, ackPayload);
  const parsedAck2 = coap.parse(ack2);
  test('buildAckWithPayload: code = 2.05 Content', parsedAck2.code === coap.CODE_CONTENT);
  test('buildAckWithPayload: payload matches', bufEq(parsedAck2.payload, ackPayload));
  test('buildAckWithPayload: mid echoed', parsedAck2.mid === parsed2.mid);
  
  const etagValue = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
  const block2Value = coap.encodeBlock2(0, 0, 3);
  const ack3 = coap.buildAckWithOptions(parsed1, coap.CODE_VALID, [
      { num: coap.OPT_ETAG, value: etagValue },
      { num: coap.OPT_BLOCK2, value: block2Value }
  ]);
  const parsedAck3 = coap.parse(ack3);
  test('buildAckWithOptions: code = 2.03 Valid', parsedAck3.code === coap.CODE_VALID);
  test('buildAckWithOptions: has ETag option', coap.optionFirst(parsedAck3, coap.OPT_ETAG) !== null);
  test('buildAckWithOptions: ETag value matches', bufEq(coap.optionFirst(parsedAck3, coap.OPT_ETAG), etagValue));
  test('buildAckWithOptions: has Block2 option', coap.optionFirst(parsedAck3, coap.OPT_BLOCK2) !== null);
  
  // ═══════════════════════════════════════════
  // 6. buildResponse / buildRequest
  // ═══════════════════════════════════════════
  section('6. buildResponse / buildRequest');
  
  const resp1 = coap.buildResponse({
      code: coap.CODE_CONTENT,
      payload: Buffer.from('time_data'),
      token: Buffer.alloc(0),
      mid: 0x7001,
      type: coap.TYPE_NON
  });
  const parsedResp1 = coap.parse(resp1);
  test('buildResponse: type = NON', parsedResp1.type === coap.TYPE_NON);
  test('buildResponse: code = 2.05', parsedResp1.code === coap.CODE_CONTENT);
  test('buildResponse: mid = 0x7001', parsedResp1.mid === 0x7001);
  test('buildResponse: payload = time_data', parsedResp1.payload.toString() === 'time_data');
  
  // buildRequest with query and content-format
  const req3 = coap.buildRequest({
      code: coap.CODE_GET,
      path: 'z/1/state',
      token: Buffer.from([0x01]),
      mid: 0x9999,
      type: coap.TYPE_CON,
      query: 'foo=bar',
      contentFormat: 60
  });
  const parsed3 = coap.parse(req3);
  test('buildRequest with query: uri-path correct', coap.uriPath(parsed3) === 'z/1/state');
  const uriQuery = coap.optionValues(parsed3, coap.OPT_URI_QUERY);
  test('buildRequest with query: has URI-Query', uriQuery.length > 0);
  test('buildRequest with query: query = foo=bar', uriQuery[0].toString() === 'foo=bar');
  const cf = coap.optionUint(parsed3, coap.OPT_CONTENT_FORMAT);
  test('buildRequest with contentFormat: = 60', cf === 60);
  
  // ═══════════════════════════════════════════
  // 7. Block2 encode/decode
  // ═══════════════════════════════════════════
  section('7. Block2 encode/decode');
  
  for (const [num, more, szx] of [[0, 0, 3], [0, 1, 3], [5, 0, 2], [15, 1, 6], [100, 0, 5]]) {
      const encoded = coap.encodeBlock2(num, more, szx);
      const decoded = coap.decodeBlock(encoded);
      test(`Block2(${num},${more},${szx}): num`, decoded.num === num);
      test(`Block2(${num},${more},${szx}): more`, decoded.more === more);
      test(`Block2(${num},${more},${szx}): szx`, decoded.szx === szx);
      test(`Block2(${num},${more},${szx}): blockSize`, decoded.blockSize === (1 << (szx + 4)));
  }
  
  test('decodeBlock null for empty', coap.decodeBlock(Buffer.alloc(0)) === null);
  
  // ═══════════════════════════════════════════
  // 8. Time Protobuf encode/decode
  // ═══════════════════════════════════════════
  section('8. Time Protobuf');
  
  const now = Math.floor(Date.now() / 1000);
  const timeBuf = coap.encodeTimeProtobuf(now);
  test('encodeTimeProtobuf: returns 5 bytes', timeBuf.length === 5);
  test('encodeTimeProtobuf: starts with 0x0D tag', timeBuf[0] === 0x0D);
  
  const timeDecoded = coap.decodeTimeProtobuf(timeBuf);
  test('decodeTimeProtobuf: ok = true', timeDecoded.ok === true);
  test('decodeTimeProtobuf: unix_s matches', timeDecoded.unix_s === now);
  
  // Edge case: timestamp 0
  const t0 = coap.encodeTimeProtobuf(0);
  const d0 = coap.decodeTimeProtobuf(t0);
  test('Time 0: round-trip ok', d0.ok && d0.unix_s === 0);
  
  // Edge case: max u32
  const tMax = coap.encodeTimeProtobuf(0xFFFFFFFF);
  const dMax = coap.decodeTimeProtobuf(tMax);
  test('Time max u32: round-trip ok', dMax.ok && dMax.unix_s === 0xFFFFFFFF);
  
  // Invalid payload
  const tBad = coap.decodeTimeProtobuf(Buffer.from([0x01]));
  test('decodeTimeProtobuf: too short → error', !tBad.ok);
  
  const tBadTag = coap.decodeTimeProtobuf(Buffer.from([0x00, 0, 0, 0, 0]));
  test('decodeTimeProtobuf: wrong tag → error', !tBadTag.ok);
  
  // ═══════════════════════════════════════════
  // 9. Edge cases
  // ═══════════════════════════════════════════
  section('9. Edge cases');
  
  // Truncated message (too short for header)
  const shortMsg = coap.parse(Buffer.from([0x40]));
  test('parse truncated: ok = false', !shortMsg.ok);
  
  // Empty buffer
  const emptyMsg = coap.parse(Buffer.alloc(0));
  test('parse empty: ok = false', !emptyMsg.ok);
  
  // Minimal valid message (4 bytes, no options, no payload)
  const minimal = Buffer.from([0x40, 0x01, 0x00, 0x01]); // CON GET mid=1
  const parsedMinimal = coap.parse(minimal);
  test('parse minimal: ok = true', parsedMinimal.ok === true);
  test('parse minimal: type = CON', parsedMinimal.type === 0);
  test('parse minimal: code = GET', parsedMinimal.code === 1);
  test('parse minimal: mid = 1', parsedMinimal.mid === 1);
  test('parse minimal: no options', parsedMinimal.options.length === 0);
  test('parse minimal: empty payload', parsedMinimal.payload.length === 0);
  
  // ═══════════════════════════════════════════
  // 10. optionValues / optionUint / optionFirst
  // ═══════════════════════════════════════════
  section('10. Option helpers');
  
  const withOpts = coap.buildRequest({
      code: coap.CODE_GET,
      path: 'a/b/c',
      token: Buffer.from([0x01]),
      mid: 1,
      type: coap.TYPE_CON,
      extraOptions: [
          { num: coap.OPT_ACCEPT, value: coap.encOptUint(60) }
      ]
  });
  const parsedOpts = coap.parse(withOpts);
  test('optionValues: returns array', Array.isArray(coap.optionValues(parsedOpts, coap.OPT_ACCEPT)));
  test('optionUint: Accept = 60', coap.optionUint(parsedOpts, coap.OPT_ACCEPT) === 60);
  test('optionFirst: returns buffer', Buffer.isBuffer(coap.optionFirst(parsedOpts, coap.OPT_ACCEPT)));
  test('optionUint: missing option = null', coap.optionUint(parsedOpts, coap.OPT_BLOCK1) === null);
  test('optionFirst: missing option = null', coap.optionFirst(parsedOpts, coap.OPT_BLOCK1) === null);
  
  // URI-Path with multiple segments
  const pathVals = coap.optionValues(parsedOpts, coap.OPT_URI_PATH);
  test('optionValues: 3 URI-Path segments', pathVals.length === 3);
  test('optionValues: path[0] = a', pathVals[0].toString() === 'a');
  test('optionValues: path[1] = b', pathVals[1].toString() === 'b');
  test('optionValues: path[2] = c', pathVals[2].toString() === 'c');
  
  // ═══════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════
  section('RESULTS');
  const total = passed + failed;
  console.log(`  Total: ${total} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`  ${failed === 0 ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'}\n`);
  if (failed > 0) throw new Error('Some tests failed');
  
});