/**
 * @file vitest.config.js
 * @brief Vitest testing framework configuration.
 * 
 * Configures test run parameters such as extended timeouts for DB calls, disabling parallelism
 * to avoid resource locks/deadlocks, and mapping node environment profiles.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        testTimeout: 60000, // Increase timeout to 60s for slow DB queries on some environments
        fileParallelism: false, // Run test files sequentially to prevent database locks/deadlocks
        pool: 'forks',
        maxWorkers: 1,
        include: ['test/**/*.test.js'],
        environment: 'node',
    },
});
