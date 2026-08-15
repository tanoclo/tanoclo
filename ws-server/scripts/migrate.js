/**
 * @file scripts/migrate.js
 * @brief Command line database migrations manager.
 * 
 * Orchestrates schema status checks and migrations executions. Runs pending JavaScript migration
 * files inside the migrations/ folder and inserts execution records to track migration history.
 */

const fs = require('fs');
const path = require('path');

// Load environment configuration if available (e.g. test_config.json)
try {
    require('../test/test_config');
} catch (e) {}

const db = require('../lib/db');
const dbMigrate = require('../lib/db-migrate');

async function main() {
    const args = process.argv.slice(2);
    const command = args[0] || 'up';

    if (command === 'status') {
        console.log('Checking migration status...');
        const pool = db.getPool();
        
        // Ensure table exists
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version VARCHAR(255) PRIMARY KEY,
                run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        const [rows] = await pool.execute('SELECT version, run_at FROM schema_migrations ORDER BY version ASC');
        const executed = new Map(rows.map(r => [r.version, r.run_at]));

        const migrationsDir = path.join(__dirname, '..', 'migrations');
        if (!fs.existsSync(migrationsDir)) {
            fs.mkdirSync(migrationsDir, { recursive: true });
        }
        
        const files = fs.readdirSync(migrationsDir)
            .filter(f => f.endsWith('.js'))
            .sort();

        console.log('\nMigration History:');
        console.log('--------------------------------------------------');
        for (const file of files) {
            if (executed.has(file)) {
                console.log(`[ X ] ${file} (Run at: ${executed.get(file)})`);
            } else {
                console.log(`[   ] ${file} (PENDING)`);
            }
        }
        console.log('--------------------------------------------------\n');
        
        await db.getPool().end();
        process.exit(0);
    } else if (command === 'up') {
        const pool = db.getPool();
        try {
            await dbMigrate.runPending(pool, (...args) => console.log(...args));
            console.log('Migrations completed successfully.');
            await db.getPool().end();
            process.exit(0);
        } catch (err) {
            console.error('Migration failed:', err);
            await db.getPool().end();
            process.exit(1);
        }
    } else {
        console.log('Usage: node scripts/migrate.js [up|status]');
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
