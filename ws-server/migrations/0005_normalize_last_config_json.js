/**
 * @file migrations/0005_normalize_last_config_json.js
 * @brief Migration to normalize last_config_json in DB to canonical hex FIDs (0xXXXX) only.
 */

'use strict';

const { cleanFriendlyConfig, safeJsonParse } = require('../lib/db-base');
const tlv = require('../lib/tlv');

module.exports = {
    async up(connection) {
        // 1. Initialize TLV labels from database
        const [labelRows] = await connection.execute('SELECT * FROM tlv_labels');
        const fields = {};
        for (const row of labelRows) {
            const entry = { name: row.name };
            if (row.type) entry.type = row.type;
            if (row.unit) entry.unit = row.unit;
            if (row.scale != null) entry.scale = row.scale;
            fields[row.hex_id] = entry;
        }
        tlv.init(fields);

        // 2. Devices
        const [devices] = await connection.execute('SELECT serial_no, last_config_json FROM devices WHERE last_config_json IS NOT NULL AND last_config_json != ""');
        let deviceCount = 0;
        for (const dev of devices) {
            const raw = safeJsonParse(dev.last_config_json);
            const cleaned = cleanFriendlyConfig(raw);
            const strCleaned = JSON.stringify(cleaned);
            if (strCleaned !== dev.last_config_json) {
                await connection.execute('UPDATE devices SET last_config_json = ? WHERE serial_no = ?', [strCleaned, dev.serial_no]);
                deviceCount++;
            }
        }
        console.log(`[MIGRATION] Normalized last_config_json for ${deviceCount} devices`);

        // 3. Zones
        const [zones] = await connection.execute('SELECT id, home_id, last_config_json FROM zones WHERE last_config_json IS NOT NULL AND last_config_json != ""');
        let zoneCount = 0;
        for (const z of zones) {
            const raw = safeJsonParse(z.last_config_json);
            const cleaned = cleanFriendlyConfig(raw);
            const strCleaned = JSON.stringify(cleaned);
            if (strCleaned !== z.last_config_json) {
                await connection.execute('UPDATE zones SET last_config_json = ? WHERE id = ? AND home_id = ?', [strCleaned, z.id, z.home_id]);
                zoneCount++;
            }
        }
        console.log(`[MIGRATION] Normalized last_config_json for ${zoneCount} zones`);

        // 4. Heating Systems
        const [systems] = await connection.execute('SELECT home_id, last_config_json FROM heating_systems WHERE last_config_json IS NOT NULL AND last_config_json != ""');
        let systemCount = 0;
        for (const hs of systems) {
            const raw = safeJsonParse(hs.last_config_json);
            const cleaned = cleanFriendlyConfig(raw);
            const strCleaned = JSON.stringify(cleaned);
            if (strCleaned !== hs.last_config_json) {
                await connection.execute('UPDATE heating_systems SET last_config_json = ? WHERE home_id = ?', [strCleaned, hs.home_id]);
                systemCount++;
            }
        }
        console.log(`[MIGRATION] Normalized last_config_json for ${systemCount} heating systems`);

        // 5. Heating Circuits
        const [circuits] = await connection.execute('SELECT home_id, number, last_config_json FROM heating_circuits WHERE last_config_json IS NOT NULL AND last_config_json != ""');
        let circuitCount = 0;
        for (const hc of circuits) {
            const raw = safeJsonParse(hc.last_config_json);
            const cleaned = cleanFriendlyConfig(raw);
            const strCleaned = JSON.stringify(cleaned);
            if (strCleaned !== hc.last_config_json) {
                await connection.execute('UPDATE heating_circuits SET last_config_json = ? WHERE home_id = ? AND number = ?', [strCleaned, hc.home_id, hc.number]);
                circuitCount++;
            }
        }
        console.log(`[MIGRATION] Normalized last_config_json for ${circuitCount} heating circuits`);
    }
};
