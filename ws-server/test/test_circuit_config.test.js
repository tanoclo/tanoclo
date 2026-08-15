/**
 * @file test/test_circuit_config.test.js
 * @brief Vitest testing suite validating server modules.
 */

'use strict';
require('./test_config');


const db = require('../lib/db');
const tlv = require('../lib/tlv');



test('legacy test suite runs successfully', async () => {
  async function testCircuitConfig() {
      const homeId = 999999;
      const circuitNumber = 1;
      try {
          console.log('--- Testing Circuit Config Building & Parsing ---');
  
          // Initialize TLV labels from database
          const p = db.getPool();
          const [rows] = await p.execute('SELECT hex_id, name, type, unit, scale FROM tlv_labels');
          const labels = {};
          for (const row of rows) {
              labels[row.hex_id] = { name: row.name, type: row.type, unit: row.unit, scale: row.scale };
          }
          tlv.init(labels);
  
          console.log('\n1. Testing updateCircuitConfig...');
          const testMaxTemp = 55.0;
          await db.updateCircuitConfig(homeId, circuitNumber, { circuit_dhw_max_flow_temperature: testMaxTemp }, { circuit_dhw_max_flow_temperature: testMaxTemp });
  
          // Retrieve config
          const etags = await db.getCircuitEtags(homeId, circuitNumber);
          if (!etags || !etags.config) {
              throw new Error('Config ETag was not generated or retrieved!');
          }
          const configHex = Buffer.isBuffer(etags.config) ? etags.config.toString('hex') : etags.config;
          console.log(`SUCCESS: Generated ETag is ${configHex}`);
  
          console.log('\n2. Testing buildCircuitConfigTLV...');
          const payload = await db.buildCircuitConfigTLV(homeId, circuitNumber);
          console.log('Raw Payload Hex:', payload.toString('hex'));
  
          const decoded = tlv.decode(payload);
          console.log('Decoded Fields:', decoded.fields);
  
          if (decoded.fields['0x2040'] === testMaxTemp) {
              console.log(`SUCCESS: Decoded 0x2040 matches expected ${testMaxTemp}`);
          } else {
              throw new Error(`Mismatch: expected ${testMaxTemp}, got ${decoded.fields['0x2040']}`);
          }
  
          console.log('\n3. Testing storeRealCircuitEtag...');
          const realEtag = Buffer.from('1e38286d77c0c25c', 'hex');
          await db.storeRealCircuitEtag(homeId, circuitNumber, realEtag);
          const etagsAfterStore = await db.getCircuitEtags(homeId, circuitNumber);
          const configRealHex = Buffer.isBuffer(etagsAfterStore.config_real) ? etagsAfterStore.config_real.toString('hex') : etagsAfterStore.config_real;
          if (configRealHex === '1e38286d77c0c25c') {
              console.log('SUCCESS: Real captured ETag correctly retrieved.');
          } else {
              throw new Error(`Mismatch: expected 1e38286d77c0c25c, got ${configRealHex}`);
          }
  
          console.log('\nAll Circuit Config Tests Passed!');
      } catch (err) {
          console.error('FAIL: Test Error:', err);
          process.exitCode = 1;
      } finally {
          try {
              await db.getPool().execute('DELETE FROM heating_circuits WHERE home_id = ? AND number = ?', [homeId, circuitNumber]);
              console.log('Cleanup: deleted mock circuit config from DB.');
          } catch (cleanupErr) {
              console.error('Cleanup failed:', cleanupErr.message);
          }
          try {
              await db.close();
          } catch (dbErr) {
              console.error('Failed to close DB:', dbErr.message);
          }
          if (process.exitCode) throw new Error('Some tests failed');
      }
  }
  
  await testCircuitConfig();
  
});