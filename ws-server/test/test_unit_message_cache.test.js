/**
 * @file test/test_unit_message_cache.test.js
 * @brief Vitest testing suite validating server modules.
 */

'use strict';

/**
 * Unit Tests for lib/message-cache.js
 *
 * Run: node test/test_unit_message_cache.js
 */

const fs = require('fs');
const path = require('path');

// Initialize TLV with some basic labels so decodes work
const tlv = require('../lib/tlv');


test('legacy test suite runs successfully', async () => {
  tlv.init({
      '0x025e': { name: 'session_token', type: 'bytes' },
      '0x025f': { name: 'session_validity_minutes', type: 'u16be' },
      '0x6160': { name: 'home_away', type: 'u8' },
      '0x6200': { name: 'schedule_target_temperature', type: 'u16be', scale: 0.01 },
      '0x6240': { name: 'overlay_mode', type: 'u8' },
  });
  
  const messageCache = require('../lib/message-cache');
  const wsBridge = require('../lib/ws-bridge');
  const coap = require('../lib/coap');
  
  let passed = 0;
  let failed = 0;
  
  function test(name, condition, detail = '') {
      if (condition) { passed++; console.log(`  ✓ ${name}`); }
      else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
  }
  function section(title) { console.log(`\n══ ${title} ══`); }
  
  // ═══════════════════════════════════════════
  // Setup: temp log directory
  // ═══════════════════════════════════════════
  
  const tmpLogDir = path.join(__dirname);
  if (!fs.existsSync(tmpLogDir)) fs.mkdirSync(tmpLogDir, { recursive: true });
  
  // Clean up any previous test files
  const oldFiles = fs.readdirSync(tmpLogDir).filter(f => f.startsWith('message_cache.'));
  for (const f of oldFiles) fs.unlinkSync(path.join(tmpLogDir, f));
  
  messageCache.init({
      logDir: tmpLogDir,
      log: () => {},  // suppress output during tests
      ipv6Resolver: (ipv6) => {
          if (ipv6 === 'fe80:0:0:0:2:1bc5:731:36e3') return 'GK04TEST01';
          return null;
      },
  });
  
  // ═══════════════════════════════════════════
  // Helper: build a test WS frame with CoAP inside
  // ═══════════════════════════════════════════
  
  function buildTestFrame({ direction, ipv6, code, mid, token, uriPath: uPath, payload, type, fieldA, fieldB, fieldC, udpPort }) {
      const coapOpts = [];
      if (uPath) {
          for (const seg of uPath.split('/').filter(Boolean)) {
              coapOpts.push({ num: 11, value: Buffer.from(seg, 'utf-8') });
          }
      }
  
      const coapBytes = coap.serialize({
          ver: 1,
          type: type ?? (code <= 4 ? coap.TYPE_CON : coap.TYPE_ACK),
          code: code || coap.CODE_GET,
          mid: mid || 0x1234,
          token: token || Buffer.from([0xAB, 0xCD]),
          options: coapOpts,
          payload: payload || Buffer.alloc(0),
      });
  
      return wsBridge.build({
          direction: direction || 'client_to_server',
          ipv6: ipv6 || 'fe80:0:0:0:2:1bc5:731:36e3',
          coapBytes,
          fieldA: fieldA ?? 3,
          fieldB: fieldB ?? 7,
          udpPort: udpPort ?? 5683,
          fieldC: fieldC ?? 5,
      });
  }
  
  // ═══════════════════════════════════════════
  // 1. decodeMessage — basic CoAP request
  // ═══════════════════════════════════════════
  section('1. decodeMessage — CoAP request');
  
  const reqFrame = buildTestFrame({ code: coap.CODE_PUT, uriPath: 'h/12345/d/GK04TEST01/sen', mid: 0x5678 });
  const decoded = messageCache.decodeMessage(reqFrame);
  
  test('decoded is not null', decoded !== null);
  test('bridge.direction = client_to_server', decoded.bridge.direction === 'client_to_server');
  test('bridge.ipv6 parsed', decoded.bridge.ipv6 === 'fe80:0:0:0:2:1bc5:731:36e3');
  test('bridge.fieldA = 3', decoded.bridge.fieldA === 3);
  test('coap.type = CON', decoded.coap.type === 'CON');
  test('coap.code = PUT', decoded.coap.code === 'PUT');
  test('coap.mid = 0x5678', decoded.coap.mid === 0x5678);
  test('coap.isRequest = true', decoded.coap.isRequest === true);
  test('coap.path = h/12345/d/GK04TEST01/sen', decoded.coap.path === 'h/12345/d/GK04TEST01/sen');
  test('coap.token hex', decoded.coap.token === 'abcd');
  test('payload is null (no payload)', decoded.payload === null);
  
  // ═══════════════════════════════════════════
  // 2. decodeMessage — TLV payload
  // ═══════════════════════════════════════════
  section('2. decodeMessage — TLV payload');
  
  const tlvPayload = tlv.encode([
      { fid: 0x6160, value: tlv.encodeValue(1, 'u8') },
      { fid: 0x6240, value: tlv.encodeValue(2, 'u8') },
  ]);
  const tlvFrame = buildTestFrame({ code: coap.CODE_PUT, uriPath: 'z/s', payload: tlvPayload });
  const tlvDecoded = messageCache.decodeMessage(tlvFrame);
  
  test('payload type = tlv', tlvDecoded.payload.type === 'tlv');
  test('payload.fields["0x6160"] = 1', tlvDecoded.payload.fields['0x6160'] === 1);
  test('payload.fields["0x6240"] = 2', tlvDecoded.payload.fields['0x6240'] === 2);
  test('payload.items.length = 2', tlvDecoded.payload.items.length === 2);
  test('payload.hex is set', typeof tlvDecoded.payload.hex === 'string' && tlvDecoded.payload.hex.length > 0);
  
  // ═══════════════════════════════════════════
  // 3. decodeMessage — time protobuf
  // ═══════════════════════════════════════════
  section('3. decodeMessage — time protobuf');
  
  const timePayload = coap.encodeTimeProtobuf(1711670400); // 2024-03-29 00:00:00 UTC
  const timeFrame = buildTestFrame({
      direction: 'server_to_client',
      code: coap.CODE_CONTENT, type: coap.TYPE_ACK,
      uriPath: 'time', payload: timePayload, fieldA: 4,
  });
  const timeDecoded = messageCache.decodeMessage(timeFrame);
  
  test('payload type = time_protobuf', timeDecoded.payload.type === 'time_protobuf');
  test('payload.unix_s = 1711670400', timeDecoded.payload.unix_s === 1711670400);
  test('payload.utc is ISO string', typeof timeDecoded.payload.utc === 'string');
  
  // ═══════════════════════════════════════════
  // 4. Request store & pairing
  // ═══════════════════════════════════════════
  section('4. Request store & pairing');
  
  const ipv6 = 'fe80:0:0:0:2:1bc5:731:36e3';
  const mid = 0xABC0;
  
  // Build and store a request
  const clientReq = buildTestFrame({ code: coap.CODE_GET, uriPath: 'time', mid, ipv6 });
  messageCache.storeRequest(ipv6, mid, clientReq);
  
  // Verify it's retrievable
  const stored = messageCache.getRequest(ipv6, mid);
  test('storeRequest: stored is not null', stored !== null);
  test('storeRequest: decoded path = time', stored.decoded.coap.path === 'time');
  test('storeRequest: has hex', typeof stored.hex === 'string');
  
  // Build a server response with same MID
  const serverResp = buildTestFrame({
      direction: 'server_to_client',
      code: coap.CODE_CONTENT, type: coap.TYPE_ACK,
      mid, ipv6, payload: timePayload, fieldA: 4,
  });
  
  // Cache it — should auto-pair with the request
  messageCache.cacheMessage('IB04TEST00', serverResp, 'recreated');
  
  const cache = messageCache.getCache();
  // The response has no uri-path, but the paired request has 'time'
  // So it should be cached under 'time'
  const timeEntries = cache['GK04TEST01'] && cache['GK04TEST01']['time']
      ? cache['GK04TEST01']['time']['recreated']
      : (cache['IB04TEST00'] && cache['IB04TEST00']['time']
          ? cache['IB04TEST00']['time']['recreated']
          : null);
  
  test('cacheMessage: entry exists', timeEntries !== null && timeEntries.length > 0);
  if (timeEntries && timeEntries.length > 0) {
      const entry = timeEntries[timeEntries.length - 1];
      test('cacheMessage: has timestamp', typeof entry.timestamp === 'string');
      test('cacheMessage: has hex', typeof entry.hex === 'string');
      test('cacheMessage: has decoded.coap', !!entry.decoded.coap);
      test('cacheMessage: request is paired', entry.request !== null);
      test('cacheMessage: request.decoded.coap.path = time', entry.request?.decoded?.coap?.path === 'time');
      test('cacheMessage: request.decoded.coap.code = GET', entry.request?.decoded?.coap?.code === 'GET');
  }
  
  // ═══════════════════════════════════════════
  // 5. Entry limit (max 10 per path per source)
  // ═══════════════════════════════════════════
  section('5. Entry limit');
  
  for (let i = 0; i < 15; i++) {
      const frame = buildTestFrame({
          direction: 'server_to_client',
          code: coap.CODE_CHANGED, type: coap.TYPE_ACK,
          uriPath: 'h/99/d/GK04LIMIT1/sen',
          mid: 0x1000 + i,
          fieldA: 4,
      });
      messageCache.cacheMessage('GK04LIMIT1', frame, 'real');
  }
  
  const limitCache = messageCache.getCache();
  const limitEntries = limitCache['GK04LIMIT1']?.['h/99/d/GK04LIMIT1/sen']?.['real'];
  test('limit: entries exist', !!limitEntries);
  test('limit: max 10 entries', limitEntries && limitEntries.length === 10, `got ${limitEntries ? limitEntries.length : 0}`);
  
  // ═══════════════════════════════════════════
  // 6. JSON file persistence
  // ═══════════════════════════════════════════
  section('6. JSON file persistence');
  
  // Force a save (wait for debounce)
  const today = new Date().toISOString().slice(0, 10);
  const expectedFile = path.join(tmpLogDir, `message_cache.${today}.json`);
  
  // Wait briefly for debounced save
  setTimeout(() => {
      test('JSON file exists', fs.existsSync(expectedFile));
  
      if (fs.existsSync(expectedFile)) {
          const fileData = JSON.parse(fs.readFileSync(expectedFile, 'utf-8'));
          test('JSON file: has device key', Object.keys(fileData).length > 0);
  
          // Check structure: device → path → source → [entries]
          const firstDevice = Object.keys(fileData)[0];
          const firstPath = Object.keys(fileData[firstDevice])[0];
          const firstSource = Object.keys(fileData[firstDevice][firstPath])[0];
          const entries = fileData[firstDevice][firstPath][firstSource];
          test('JSON file: entries is array', Array.isArray(entries));
          test('JSON file: entry has timestamp', entries.length > 0 && !!entries[0].timestamp);
          test('JSON file: entry has decoded', entries.length > 0 && !!entries[0].decoded);
      }
  
      // ═══════════════════════════════════════════
      // 7. Device ID resolution from path
      // ═══════════════════════════════════════════
      section('7. Device ID resolution');
  
      // When a bridge sends a frame FOR a specific device via path
      const specificFrame = buildTestFrame({
          direction: 'server_to_client',
          code: coap.CODE_CHANGED, type: coap.TYPE_ACK,
          uriPath: 'h/99/d/GK04PATHDEV/config',
          mid: 0x9999,
          fieldA: 4,
      });
      messageCache.cacheMessage('IB04BRIDGE0', specificFrame, 'recreated');
  
      const cache2 = messageCache.getCache();
      test('device resolution: keyed by path device not bridge',
          !!cache2['GK04PATHDEV'] && !!cache2['GK04PATHDEV']['h/99/d/GK04PATHDEV/config'],
          `keys: ${JSON.stringify(Object.keys(cache2))}`);
  
      // ═══════════════════════════════════════════
      // Cleanup
      // ═══════════════════════════════════════════
      const cleanFiles = fs.readdirSync(tmpLogDir).filter(f => f.startsWith('message_cache.'));
      for (const f of cleanFiles) fs.unlinkSync(path.join(tmpLogDir, f));
      try { fs.rmdirSync(tmpLogDir); } catch (e) { /* ignore */ }
  
      // ═══════════════════════════════════════════
      // Summary
      // ═══════════════════════════════════════════
      section('RESULTS');
      const total = passed + failed;
      console.log(`  Total: ${total} | Passed: ${passed} | Failed: ${failed}`);
      console.log(`  ${failed === 0 ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'}\n`);
      if (failed > 0) throw new Error('Some tests failed');
  }, 3000); // Wait for debounced save
  
});