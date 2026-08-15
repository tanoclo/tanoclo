/**
 * @file test/test_tlv_roundtrip.test.js
 * @brief Vitest testing suite validating server modules.
 */

'use strict';

require('./test_config');


const db = require('../lib/db');
const tlv = require('../lib/tlv');



test('legacy test suite runs successfully', async () => {
  let passed = 0;
  let failed = 0;
  
  function test(name, condition, detail = '') {
      if (condition) {
          passed++;
          console.log(`  ✓ ${name}`);
      } else {
          failed++;
          console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
      }
  }
  
  async function run() {
      console.log('Connecting to database and fetching TLV labels...');
      try {
          const labels = await db.getTlvLabels();
          tlv.init(labels.fields);
          console.log(`Loaded ${Object.keys(labels.fields).length} labels successfully.`);
      } catch (err) {
          console.error('Failed to load TLV labels from DB:', err);
          throw new Error('Test failed');
      }
  
      console.log('\n══ Running Round-trip Tests ══');
  
      // 1. VA9999999999 L273 payload
      // 014301000140020000015d020070015c040000000102b30100021a02000001490100015e0205010158020000
      const rawVAConfigHex = '014301000140020000015d020070015c040000000102b30100021a02000001490100015e0205010158020000';
      const rawVAConfigBuf = Buffer.from(rawVAConfigHex, 'hex');
  
      const decodedVA = tlv.decode(rawVAConfigBuf);
      test('VA Config: Decode succeeded', decodedVA.ok === true);
      
      // Verify fields are present
      console.log('Decoded VA fields:', JSON.stringify(decodedVA.fields, null, 2));
  
      const reencodedVABuf = tlv.encodeFromFields(decodedVA.fields);
      test('VA Config: Re-encoded buffer equals original', reencodedVABuf.equals(rawVAConfigBuf), 
          `Expected: ${rawVAConfigHex}\n  Got:      ${reencodedVABuf.toString('hex')}`);
  
      // 2. Circuit config payload from c/1/config L2
      // 2040021770
      const rawCircuitConfigHex = '2040021770';
      const rawCircuitConfigBuf = Buffer.from(rawCircuitConfigHex, 'hex');
  
      const decodedCircuit = tlv.decode(rawCircuitConfigBuf);
      test('Circuit Config: Decode succeeded', decodedCircuit.ok === true);
      console.log('Decoded Circuit fields:', JSON.stringify(decodedCircuit.fields, null, 2));
  
      const reencodedCircuitBuf = tlv.encodeFromFields(decodedCircuit.fields);
      test('Circuit Config: Re-encoded buffer equals original', reencodedCircuitBuf.equals(rawCircuitConfigBuf),
          `Expected: ${rawCircuitConfigHex}\n  Got:      ${reencodedCircuitBuf.toString('hex')}`);
  
      // Clean up
      await db.close();
  
      console.log('\n══ RESULTS ══');
      console.log(`  Passed: ${passed} | Failed: ${failed}`);
      if (failed > 0) throw new Error('Some tests failed');
  }
  
  run().catch(err => {
      console.error('Unhandled rejection:', err);
      throw new Error('Test failed');
  });
  
});