/**
 * @file test/test_unit_log_redaction.test.js
 * @brief Vitest testing suite validating server modules.
 */

'use strict';

const assert = require('assert');
const commandLog = require('../lib/command-log');



test('legacy test suite runs successfully', async () => {
  console.log('Running log redaction tests...');
  
  // Mock fs to prevent write permission issues during testing
  const fs = require('fs');
  const originalAppendFileSync = fs.appendFileSync;
  fs.appendFileSync = () => {};
  
  const captured = [];
  const originalConsoleLog = console.log;
  console.log = (msg) => {
      captured.push(msg);
  };
  
  try {
      // Enable command log to ensure write is actually called
      commandLog.setEnabled(true);
  
      // Test case 1: Redaction of plain body
      commandLog.logApiRequest('POST', '/setup/login', {
          username: 'admin',
          password: 'supersecretpassword123',
          totp: '123456'
      });
  
      // Test case 2: Redaction of nested body
      commandLog.logApiRequest('POST', '/api/oauth', {
          client_id: 'tado-app',
          credentials: {
              client_secret: 'secret-key-abc',
              password: 'nestedpassword'
          },
          tokens: ['token1', 'token2']
      });
  
      // Test case 3: Redaction of URL query string
      commandLog.logApiRequest('POST', '/oauth2/authorize?code=abc123code&state=ok', {
          foo: 'bar'
      });
  
      // Restore original console log
      console.log = originalConsoleLog;
  
      console.log('Captured outputs:');
      captured.forEach((c, idx) => console.log(`[${idx}]: ${c}`));
  
      // Verify logs
      assert.strictEqual(captured.length, 3);
  
      // Verify Case 1
      assert.ok(captured[0].includes('POST /setup/login'));
      assert.ok(captured[0].includes('"username":"admin"'));
      assert.ok(captured[0].includes('"password":"[REDACTED]"'));
      assert.ok(captured[0].includes('"totp":"[REDACTED]"'));
      assert.ok(!captured[0].includes('supersecretpassword123'));
  
      // Verify Case 2
      assert.ok(captured[1].includes('POST /api/oauth'));
      assert.ok(captured[1].includes('"client_secret":"[REDACTED]"'));
      assert.ok(captured[1].includes('"password":"[REDACTED]"'));
      assert.ok(captured[1].includes('"tokens":"[REDACTED]"')); // tokens matches token, so the whole array is redacted!
      assert.ok(!captured[1].includes('secret-key-abc'));
  
      // Verify Case 3
      assert.ok(captured[2].includes('/oauth2/authorize?code=%5BREDACTED%5D&state=ok') || captured[2].includes('/oauth2/authorize?code=[REDACTED]&state=ok'));
      assert.ok(!captured[2].includes('abc123code'));
  
      // Restore original fs
      fs.appendFileSync = originalAppendFileSync;
  
      console.log('\x1b[32m✔ Log redaction tests passed successfully!\x1b[0m');
      // process.exit(0);
  } catch (err) {
      console.log = originalConsoleLog;
      fs.appendFileSync = originalAppendFileSync;
      console.error('FAIL: Log redaction tests failed!');
      console.error(err);
      throw new Error('Test failed');
  }
  
});