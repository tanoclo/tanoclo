/**
 * @file sync_tlv_labels.js
 * @brief Exports TLV metadata configuration properties from database into tlv_labels.json.
 * 
 * Interrogates database connection tables using mysql2 client libraries, serializes schema objects,
 * maps scaling parameters, and writes the output file parsed by the sniffer engine.
 */

const fs = require('fs');
const path = require('path');

// Dynamically locate mysql2 in sibling ws-server if not available locally
try {
    require.resolve('mysql2');
} catch (e) {
    const siblingNodeModules = path.resolve(__dirname, '../ws-server/node_modules');
    if (fs.existsSync(siblingNodeModules)) {
        module.paths.push(siblingNodeModules);
    }
}

let mysql;
try {
    mysql = require('mysql2/promise');
} catch (err) {
    console.error('Error: mysql2 package not found locally or in sibling ws-server.');
    console.error('Please run "npm install mysql2" in this directory, or run this script from the workspace root / ws-server directory.');
    process.exit(1);
}

const DB_HOST = process.env.DB_HOST;
const DB_NAME = process.env.DB_NAME || 'tanoclo';
const DB_USER = process.env.DB_USER;
const DB_PASS = process.env.DB_PASS;

if (!DB_HOST || !DB_USER || !DB_PASS) {
    console.error('Error: Database credentials not configured.');
    console.error('Set the following environment variables: DB_HOST, DB_USER, DB_PASS (optional: DB_NAME)');
    process.exit(1);
}

async function sync() {
    console.log(`Connecting to database at ${DB_HOST}...`);
    let connection;
    try {
        connection = await mysql.createConnection({
            host: DB_HOST,
            user: DB_USER,
            password: DB_PASS,
            database: DB_NAME,
            connectTimeout: 5000
        });
        console.log('Connected! Fetching TLV labels...');

        const [rows] = await connection.execute('SELECT * FROM tlv_labels');
        console.log(`Fetched ${rows.length} rows. Mapping fields...`);

        const fields = {};
        for (const row of rows) {
            const entry = { name: row.name };
            if (row.type) entry.type = row.type;
            if (row.unit) entry.unit = row.unit;
            if (row.scale != null) entry.scale = Number(row.scale);
            if (row.decimals != null) entry.decimals = Number(row.decimals);
            if (row.round != null) entry.round = Number(row.round);
            if (row.notes) entry.notes = row.notes;
            if (row.parse) entry.parse = row.parse;

            if (row.json_data) {
                try {
                    const extra = JSON.parse(row.json_data.toString());
                    for (const [k, v] of Object.entries(extra)) {
                        if (entry[k] === undefined) entry[k] = v;
                    }
                } catch (e) {
                    // Ignore JSON parse errors on invalid/empty columns
                }
            }
            fields[row.hex_id] = entry;
        }

        const output = { fields };
        const outputPath = path.join(__dirname, 'tlv_labels.json');
        fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf8');
        console.log(`Successfully synced and saved ${Object.keys(fields).length} labels to:`);
        console.log(`  ${outputPath}`);
    } catch (err) {
        console.error('Fatal Error during sync:', err.message);
        process.exit(1);
    } finally {
        if (connection) {
            await connection.end();
        }
    }
}

sync();
