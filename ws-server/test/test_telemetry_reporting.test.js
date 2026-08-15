/**
 * @file test/test_telemetry_reporting.test.js
 * @brief Vitest testing suite validating server modules.
 */

'use strict';

/**
 * Unit Tests for reset reason and error flags decoding helpers in lib/mqtt-publisher.js
 */

const { getFriendlyResetReason, getFriendlyErrorFlags } = require('../lib/mqtt-publisher');



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
  
  console.log('══ Unit Tests: Telemetry Reporting Helpers ══\n');
  
  // 1. Test getFriendlyResetReason
  console.log('-- Testing getFriendlyResetReason --');
  test('Null/Undefined input returns null', getFriendlyResetReason(null) === null && getFriendlyResetReason(undefined) === null);
  test('Code 0 returns None', getFriendlyResetReason(0) === 'None');
  test('Code 2 returns POR/PDR', getFriendlyResetReason(2) === 'POR/PDR');
  test('Code 8 returns IWDG', getFriendlyResetReason(8) === 'IWDG');
  test('Code 10 (2 + 8) returns POR/PDR+IWDG', getFriendlyResetReason(10) === 'POR/PDR+IWDG');
  test('Code 12 (4 + 8) returns Software+IWDG', getFriendlyResetReason(12) === 'Software+IWDG');
  test('Code 63 (all bits) returns PIN+POR/PDR+Software+IWDG+WWDG+Low-Power', 
       getFriendlyResetReason(63) === 'PIN+POR/PDR+Software+IWDG+WWDG+Low-Power');
  
  // 2. Test getFriendlyErrorFlags
  console.log('\n-- Testing getFriendlyErrorFlags --');
  test('Null/Undefined/0 returns NONE', 
       getFriendlyErrorFlags(null) === 'None' && 
       getFriendlyErrorFlags(undefined) === 'None' && 
       getFriendlyErrorFlags(0) === 'None');
  test('Mount/Contact Fault (bit 14 / 16384 / 0x4000) is parsed', getFriendlyErrorFlags(0x4000) === 'Mount/Contact Fault');
  test('NVM Write Fault (bit 2 / 0x4) is parsed', getFriendlyErrorFlags(0x4) === 'NVM Write Fault');
  test('NVM Verification Fault (bit 3 / 0x8) is parsed', getFriendlyErrorFlags(0x8) === 'NVM Verification Fault');
  test('Error 12 combination (0x4 | 0x8) is parsed', getFriendlyErrorFlags(12) === 'NVM Write Fault, NVM Verification Fault');
  test('Other raw flags are parsed with prefix', getFriendlyErrorFlags(0x0001) === 'RAW_0x1');
  test('Multiple flags combined', getFriendlyErrorFlags(0x4002) === 'Orphaned/No Route, Mount/Contact Fault');
  
  console.log('\n══ RESULTS ══');
  const total = passed + failed;
  console.log(`  Total: ${total} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`  ${failed === 0 ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'}\n`);
  
  if (failed > 0) throw new Error('Some tests failed');
  
});