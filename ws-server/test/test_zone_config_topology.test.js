/**
 * @file test/test_zone_config_topology.test.js
 * @brief Vitest testing suite validating dynamic zone config topology synthesis.
 */

'use strict';
require('./test_config');

import { test, expect } from 'vitest';
const dbUtils = require('../lib/db-utils');
const tlv = require('../lib/tlv');
const db = require('../lib/db');

test('Dynamic Zone Config Topology Synthesis', async () => {
  await tlv.init();
  const pool = db.getPool();

  const [homes] = await pool.execute('SELECT id FROM homes LIMIT 1');
  if (homes.length === 0) return;
  const homeId = homes[0].id;

  const [zones] = await pool.execute('SELECT id, measuring_device_serial FROM zones WHERE home_id = ?', [homeId]);
  for (const z of zones) {
    const encoded = await dbUtils.buildZoneConfigTLV(homeId, z.id);
    if (!encoded) continue;
    const decoded = tlv.decode(encoded);
    expect(decoded.ok).toBe(true);

    if (decoded.fields['0x63a0']) {
      const stateUri = Buffer.from(decoded.fields['0x63a0'], 'hex').toString('utf8');
      expect(stateUri).toMatch(/^coap:\/\/\[fe80:[0-9a-f:]+\]\/z\/s$/);
    }

    if (decoded.fields['0x8000']) {
      const listeners = (Array.isArray(decoded.fields['0x8000']) ? decoded.fields['0x8000'] : [decoded.fields['0x8000']])
        .map(h => Buffer.from(h, 'hex').toString('utf8'));
      expect(listeners.length).toBeGreaterThan(0);
      for (const uri of listeners) {
        expect(uri).toMatch(/^coap:\/\/\[fe80:[0-9a-f:]+\]\/z\/s$/);
      }
    }
  }
});
