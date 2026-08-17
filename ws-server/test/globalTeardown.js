/**
 * @file test/globalTeardown.js
 * @brief Global teardown for Vitest test suite.
 */

'use strict';

const db = require('../lib/db');

export default async function teardown() {
    try {
        await db.close();
    } catch (e) {
        // ignore
    }
}
