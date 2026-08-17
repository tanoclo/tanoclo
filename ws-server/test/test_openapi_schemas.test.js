/**
 * @file test/test_openapi_schemas.test.js
 * @brief Vitest testing suite validating server modules.
 */

'use strict';

require('./test_config');
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const db = require('../lib/db');
const dbHelper = require('./test_db_helper');
const { app, setupCommandRoutes } = require('../api/server');

// Load OpenAPI spec


test('legacy test suite runs successfully', async () => {
  const openapiSpecPath = path.join(__dirname, '../api/openapi.yaml');
  let openapiDoc;
  try {
      openapiDoc = yaml.parse(fs.readFileSync(openapiSpecPath, 'utf8'));
  } catch (e) {
      console.error('Failed to parse openapi.yaml:', e.message);
      throw new Error('Test failed');
  }
  
  // Helper to resolve OpenAPI references
  function resolveRef(schema) {
      if (!schema || !schema.$ref) return schema;
      const parts = schema.$ref.split('/');
      let current = openapiDoc;
      for (let i = 1; i < parts.length; i++) {
          current = current[parts[i]];
      }
      return resolveRef(current);
  }
  
  // Recursive mock payload generator based on OpenAPI schemas
  function generateMockPayload(schema) {
      if (!schema) return null;
      schema = resolveRef(schema);
      
      if (schema.example) return schema.example;
      if (schema.default !== undefined) return schema.default;
  
      if (schema.type === 'object') {
          const obj = {};
          if (schema.properties) {
              for (const [propName, propSchema] of Object.entries(schema.properties)) {
                  obj[propName] = generateMockPayload(propSchema);
              }
          }
          return obj;
      } else if (schema.type === 'array') {
          return [generateMockPayload(schema.items)];
      } else if (schema.type === 'string') {
          if (schema.enum) return schema.enum[0];
          return 'test';
      } else if (schema.type === 'number' || schema.type === 'integer') {
          return 1;
      } else if (schema.type === 'boolean') {
          return true;
      }
      return null;
  }
  
  // Recursive schema validator
  function validateSchema(data, schema, pathStr = 'response', isRequired = false) {
      if (!schema) return;
      
      const isNullable = schema.nullable === true;
      schema = resolveRef(schema);
      const schemaNullable = isNullable || (schema && schema.nullable === true);
  
      if (data === null || data === undefined) {
          if (schemaNullable || !isRequired) {
              return;
          }
          assert.fail(`${pathStr} is null/undefined but schema is required and does not declare nullable: true`);
      }
  
      if (schema.type === 'object') {
          assert.strictEqual(typeof data, 'object', `${pathStr} should be an object`);
          assert.notStrictEqual(data, null, `${pathStr} should not be null`);
  
          if (schema.required) {
              for (const reqProp of schema.required) {
                  assert.ok(reqProp in data, `${pathStr} is missing required property: "${reqProp}"`);
              }
          }
  
          if (schema.properties) {
              const requiredProps = schema.required || [];
              for (const [propName, propSchema] of Object.entries(schema.properties)) {
                  if (propName in data) {
                      const req = requiredProps.includes(propName);
                      validateSchema(data[propName], propSchema, `${pathStr}.${propName}`, req);
                  }
              }
          }
      } else if (schema.type === 'array') {
          assert.ok(Array.isArray(data), `${pathStr} should be an array`);
          if (schema.items) {
              data.forEach((item, idx) => {
                  validateSchema(item, schema.items, `${pathStr}[${idx}]`);
              });
          }
      } else if (schema.type === 'string') {
          assert.strictEqual(typeof data, 'string', `${pathStr} should be a string`);
      } else if (schema.type === 'number' || schema.type === 'integer') {
          assert.strictEqual(typeof data, 'number', `${pathStr} should be a number`);
      } else if (schema.type === 'boolean') {
          assert.strictEqual(typeof data, 'boolean', `${pathStr} should be a boolean`);
      }
  }
  
  // Helper to make HTTP requests
  function makeRequest(port, options, postData = null) {
      return new Promise((resolve, reject) => {
          const reqOpts = {
              hostname: '127.0.0.1',
              port: port,
              path: options.path,
              method: options.method || 'GET',
              headers: options.headers || {}
          };
  
          if (postData) {
              reqOpts.headers['Content-Length'] = Buffer.byteLength(postData);
          }
  
          const req = http.request(reqOpts, (res) => {
              let data = '';
              res.on('data', chunk => data += chunk);
              res.on('end', () => {
                  let json = null;
                  try {
                      if (data) json = JSON.parse(data);
                  } catch (e) {}
                  resolve({
                      statusCode: res.statusCode,
                      body: json !== null ? json : data
                  });
              });
          });
  
          req.on('error', reject);
          if (postData) req.write(postData);
          req.end();
      });
  }
  
  async function runTests() {
      console.log('═══ Running Dynamic OpenAPI Schema Crawler (ALL Methods) ═══\n');
  
      const pool = db.getPool();
      const testHomeId = 999999;
      const testDeviceId = 'IB0000000001';
      let server;
      let passed = 0;
      let failed = 0;
  
      try {
          const [homeRows] = await pool.execute('SELECT id FROM homes LIMIT 1');
          const sourceHomeId = homeRows.length > 0 ? homeRows[0].id : null;
  
          const [deviceRows] = await pool.execute('SELECT serial_no FROM devices LIMIT 1');
          const sourceDeviceId = deviceRows.length > 0 ? deviceRows[0].serial_no : null;
  
          const testZoneId = 1;
          const testUser = 'admin_test_api';
          const testPass = 'admin123_test_api';
  
          await dbHelper.setupTestFixtures(pool, testDeviceId, testHomeId, testZoneId, testUser, testPass, sourceHomeId, sourceDeviceId);
  
          // Explicitly insert a mock bridge device to support /bridges and /homeByBridge tests
          await pool.execute('DELETE FROM devices WHERE serial_no = ?', [testDeviceId]);
          await pool.execute(`
              INSERT INTO devices (
                  serial_no, device_type, home_id, current_fw_version, connection_state, 
                  in_pairing_mode, connection_state_timestamp, config_etag, config_etag_real
              ) VALUES (?, 'IB01', ?, '92.1', 1, 0, '2026-07-01 00:00:00', 'configetag123456', 'configetag123456')
          `, [testDeviceId, testHomeId]);
  
          // Retrieve inserted bridge auth key (stored in config_etag column)
          const [devRows] = await pool.execute('SELECT * FROM devices WHERE home_id = ?', [testHomeId]);
          
          let bridgeAuthKey = '';
          let bridgeDevSerial = testDeviceId;
          if (devRows.length > 0) {
              const bridgeDev = devRows.find(d => d.serial_no.startsWith('IB')) || devRows[0];
              const rawKey = bridgeDev.config_etag;
              bridgeAuthKey = Buffer.isBuffer(rawKey) ? rawKey.toString('utf8') : String(rawKey);
              bridgeDevSerial = bridgeDev.serial_no;
          }
  
          setupCommandRoutes({
              clients: new Map(),
              sendToDevice: async () => {},
              broadcastTime: () => {},
              log: () => {},
              messageCache: { getCache: async () => ({}) }
          });
  
          server = app.listen(0, () => {});
          const port = server.address().port;
  
          async function test(name, fn) {
              try {
                  await fn();
                  console.log(`  ✓ ${name}`);
                  passed++;
              } catch (e) {
                  console.error(`  ✗ ${name} — FAILED:`, e.stack || e.message);
                  failed++;
              }
          }
  
          // 1. Authenticate to get OAuth Token
          let accessToken = null;
          await test('POST /oauth/token (Authenticate)', async () => {
              const payload = JSON.stringify({
                  grant_type: 'password',
                  username: testUser,
                  password: testPass,
                  client_id: 'tado-web-app'
              });
  
              const res = await makeRequest(port, {
                  path: '/oauth/token',
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' }
              }, payload);
  
              assert.strictEqual(res.statusCode, 200);
              assert.ok(res.body.access_token, 'Response missing access_token');
              accessToken = res.body.access_token;
          });
  
          const headers = { 'Authorization': `Bearer ${accessToken}` };
  
          // 2. Gather all operations defined in the OpenAPI spec
          const operations = [];
          for (const [rawPath, pathObj] of Object.entries(openapiDoc.paths)) {
              for (const [method, opObj] of Object.entries(pathObj)) {
                  if (!['get', 'post', 'put', 'delete'].includes(method)) continue;
                  
                  // Skip EventSource/SSE streams, custom docs, and resend endpoints that generate noise
                  if (rawPath.includes('/events') || rawPath.includes('/docs')) continue;
                  
                  operations.push({
                      rawPath,
                      method: method.toUpperCase(),
                      opObj
                  });
              }
          }
  
          // Sort operations: GET (reads) -> POST/PUT (writes) -> DELETE (cleanups)
          const methodPriority = { 'GET': 1, 'POST': 2, 'PUT': 2, 'DELETE': 3 };
          operations.sort((a, b) => methodPriority[a.method] - methodPriority[b.method]);
  
          // 3. Iterate and validate all gathered operations
          for (const op of operations) {
              const { rawPath, method, opObj } = op;
  
              // Reconstruct path with test parameters
              let targetPath = rawPath;
              const replacements = {
                  '{homeId}': String(testHomeId),
                  '{zoneId}': String(testZoneId),
                  '{deviceId}': bridgeDevSerial,
                  '{bridgeId}': bridgeDevSerial,
                  '{serial}': bridgeDevSerial,
                  '{mobileDeviceId}': '1',
                  '{userId}': '1',
                  '{invitationToken}': 'test_token',
                  '{token}': 'test_token',
                  '{timetableTypeId}': '0',
                  '{timetableId}': '0',
                  '{dayType}': 'MONDAY_TO_SUNDAY',
                  '{installationId}': '1'
              };
  
              for (const [k, v] of Object.entries(replacements)) {
                  targetPath = targetPath.replace(k, v);
              }
  
              // Determine if base route is prefixed with /api/v2 or root
              let requestPath = targetPath;
              const opServers = opObj.servers;
              const useRoot = opServers && opServers.some(s => s.url === '/');
              if (!useRoot && !requestPath.startsWith('/api/v2') && !requestPath.startsWith('/api/health') && !requestPath.startsWith('/api/public/health') && !requestPath.startsWith('/oauth/token')) {
                  requestPath = '/api/v2' + requestPath;
              }
  
              // Append authKey query parameters for bridges and homeByBridge routes
              if (rawPath.includes('/bridges') || rawPath.includes('/homeByBridge')) {
                  const sep = requestPath.includes('?') ? '&' : '?';
                  requestPath += `${sep}authKey=${encodeURIComponent(bridgeAuthKey)}`;
              }
  
              // Construct Request Headers and Payload Body
              const reqHeaders = { ...headers };
              let requestBody = null;
              
              if (opObj.requestBody) {
                  const resolvedBody = resolveRef(opObj.requestBody);
                  const content = resolvedBody.content;
                  const mediaType = content ? Object.keys(content)[0] : null;
                  if (mediaType) {
                      reqHeaders['Content-Type'] = mediaType;
                      const schema = content[mediaType].schema;
                      const rawPayload = generateMockPayload(schema);
                      if (rawPayload) {
                          if (mediaType === 'application/x-www-form-urlencoded') {
                              requestBody = Object.entries(rawPayload)
                                  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
                                  .join('&');
                          } else {
                              requestBody = JSON.stringify(rawPayload);
                          }
                      }
                  }
              }
  
              await test(`${method} ${requestPath} (validates ${rawPath})`, async () => {
                  const res = await makeRequest(port, {
                      path: requestPath,
                      method: method,
                      headers: reqHeaders
                  }, requestBody);
  
                  // Allow common/acceptable status codes based on mock context limitations
                  const acceptableCodes = [200, 201, 204, 303, 400, 403, 404, 422];
                  if (!acceptableCodes.includes(res.statusCode)) {
                      assert.fail(`Request returned unexpected status code: ${res.statusCode} (body: ${JSON.stringify(res.body)})`);
                  }
  
                  // If status code matches a documented response, validate schema strictly!
                  const documentedResponse = opObj.responses[String(res.statusCode)];
                  if (documentedResponse) {
                      const resolvedRes = resolveRef(documentedResponse);
                      const schema = resolvedRes.content?.['application/json']?.schema;
                      if (schema && res.body && typeof res.body === 'object') {
                          validateSchema(res.body, schema, `${rawPath} [${res.statusCode}]`);
                      }
                  }
              });
          }
  
          // Clean up test database records
          await dbHelper.cleanupTestFixtures(pool, testHomeId, testDeviceId);
  
      } catch (e) {
          console.error('Setup failed:', e);
          failed = 1;
      } finally {
          if (server) server.close();
          try {
              if (!process.env.VITEST) await db.close();
          } catch (dbErr) {
              console.error('Failed to close DB:', dbErr.message);
          }
          console.log(`\nVerification finished: Passed ${passed}, Failed ${failed}`);
          if (failed > 0) throw new Error('Some tests failed');
      }
  }
  
  await runTests();
  
});