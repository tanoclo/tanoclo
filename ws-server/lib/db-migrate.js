/**
 * @file lib/db-migrate.js
 * @brief Core database schema migrations runner.
 */

'use strict';

/**
 * Database Migration Runner
 */

const fs = require('fs');
const path = require('path');

async function runPending(pool, log = console.log) {
    log('info', '[MIGRATION] Checking for pending database migrations...');

    // 1. Ensure schema_migrations table exists
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version VARCHAR(255) PRIMARY KEY,
            run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 2. Read executed migrations from DB
    const [rows] = await pool.execute('SELECT version FROM schema_migrations');
    const executed = new Set(rows.map(r => r.version));

    // 3. Read migration files from directory
    const migrationsDir = path.join(__dirname, '..', 'migrations');
    if (!fs.existsSync(migrationsDir)) {
        fs.mkdirSync(migrationsDir, { recursive: true });
    }

    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.js'))
        .sort();

    let ranAny = false;

    // 4. Run pending migrations in sequence
    for (const file of files) {
        if (executed.has(file)) {
            continue;
        }

        log('info', `[MIGRATION] Running pending migration: ${file}`);
        const migration = require(path.join(migrationsDir, file));

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            
            // Execute the migration
            await migration.up(connection);

            // Record execution
            await connection.execute(
                'INSERT INTO schema_migrations (version) VALUES (?)',
                [file]
            );

            await connection.commit();
            log('info', `[MIGRATION] Completed migration: ${file}`);
            ranAny = true;
        } catch (err) {
            await connection.rollback();
            log('error', `[MIGRATION] Failed migration ${file}: ${err.message}`);
            throw err;
        } finally {
            connection.release();
        }
    }

    if (!ranAny) {
        log('info', '[MIGRATION] Database is up to date. No migrations pending.');
    }
}

module.exports = {
    runPending
};
