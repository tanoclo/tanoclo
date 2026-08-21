/**
 * @file lib/db-devices.js
 * @brief Physical devices database access queries.
 */

'use strict';
/**
 * @module db-devices
 * 
 * Device-related DB operations.
 * Handles device status, firmware updates, display/mounting settings, config merging, and ETag storage.
 */
const { getPool, _log, safeJsonParse, extractShortSerial, mapOrientation, unmapOrientation, mapMountState, generateEtag, tlvNameToHex, cleanFriendlyConfig } = require('./db-base');

async function getDeviceBySerial(shortSerial) {
    const p = getPool();
    const [rows] = await p.execute(
        `SELECT d.*, ed.mode AS emulated_mode, (ed.serial_no IS NOT NULL) AS is_emulated 
         FROM devices d 
         LEFT JOIN emulated_devices ed ON d.serial_no = ed.serial_no 
         WHERE d.serial_no = ? OR d.serial_no LIKE CONCAT(?, "%") LIMIT 1`,
        [shortSerial, shortSerial]
    );
    return rows.length > 0 ? rows[0] : null;
}

async function getDeviceByFullSerial(fullSerial) {
    const p = getPool();
    const [rows] = await p.execute(
        `SELECT d.*, ed.mode AS emulated_mode, (ed.serial_no IS NOT NULL) AS is_emulated 
         FROM devices d 
         LEFT JOIN emulated_devices ed ON d.serial_no = ed.serial_no 
         WHERE d.serial_no = ? LIMIT 1`,
        [fullSerial]
    );
    return rows.length > 0 ? rows[0] : null;
}

async function getDevicesForHome(homeId) {
    const p = getPool();
    const [rows] = await p.execute(
        `SELECT d.*, ed.mode AS emulated_mode, (ed.serial_no IS NOT NULL) AS is_emulated 
         FROM devices d 
         LEFT JOIN emulated_devices ed ON d.serial_no = ed.serial_no 
         WHERE d.home_id = ?`,
        [homeId]
    );
    return rows;
}

async function getDevicesInZone(homeId, zoneId) {
    const p = getPool();
    const [rows] = await p.execute(
        `SELECT d.*, ed.mode AS emulated_mode, (ed.serial_no IS NOT NULL) AS is_emulated 
         FROM devices d 
         LEFT JOIN emulated_devices ed ON d.serial_no = ed.serial_no 
         WHERE d.home_id = ? AND d.zone_id = ?`,
        [homeId, zoneId]
    );
    return rows;
}

async function updateDeviceConnectionState(shortSerial, isConnected, batteryState = null, batteryPercent = null) {
    const p = getPool();
    const now = new Date().toISOString();
    const ts = now.replace('T', ' ').replace(/\.\d+Z$/, '');
    let query = 'UPDATE devices SET connection_state = ?, last_contact = ?, connection_state_timestamp = ?';
    const params = [isConnected ? 1 : 0, now, ts];

    if (batteryState !== null) {
        query += ', battery_state = ?';
        params.push(batteryState);
    }
    if (batteryPercent !== null) {
        query += ', battery_percent = ?';
        params.push(batteryPercent);
    }
    query += ' WHERE serial_no = ?';
    params.push(shortSerial);
    await p.execute(query, params);

    if (isConnected) {
        try {
            await p.execute('UPDATE emulated_devices SET pairing_state = "PAIRED" WHERE serial_no = ? AND pairing_state = "PAIRING_RF"', [shortSerial]);
            await p.execute('UPDATE devices SET in_pairing_mode = 0 WHERE serial_no = ? AND in_pairing_mode = 1', [shortSerial]);
        } catch (_) { }
    }
}

async function updateDeviceIPv6(deviceId, ipv6) {
    const p = getPool();
    const now = new Date().toISOString();
    const ts = now.replace('T', ' ').replace(/\.\d+Z$/, '');
    await p.execute(
        'UPDATE devices SET ipv6_address = ?, last_contact = ?, connection_state = 1, connection_state_timestamp = ? WHERE serial_no = ?',
        [ipv6, now, ts, deviceId]
    );
}

async function getDeviceByIPv6(ipv6) {
    const p = getPool();
    const [rows] = await p.execute('SELECT serial_no FROM devices WHERE ipv6_address = ? LIMIT 1', [ipv6]);
    return rows.length > 0 ? rows[0].serial_no : null;
}

async function updateDeviceActuator(serial, fields) {
    const p = getPool();
    const updates = [];
    const params = [];

    if (fields['0x0265'] !== undefined) { updates.push('field_0265=?'); params.push(fields['0x0265']); }
    if (fields['0x0266'] !== undefined || fields['0x0294'] !== undefined) {
        updates.push('field_0266=?');
        params.push(fields['0x0266'] !== undefined ? fields['0x0266'] : fields['0x0294']);
    }
    if (fields['0x0273'] !== undefined) { updates.push('field_0273=?'); params.push(fields['0x0273']); }
    if (fields['0x027c'] !== undefined) { updates.push('field_027c=?'); params.push(fields['0x027c']); }
    if (fields['0x0280'] !== undefined) { updates.push('field_0280=?'); params.push(fields['0x0280']); }
    if (fields['0x0283'] !== undefined || fields['0x028d'] !== undefined) {
        updates.push('field_0283=?');
        params.push(fields['0x0283'] !== undefined ? fields['0x0283'] : fields['0x028d']);
    }
    if (fields['0x028c'] !== undefined) { updates.push('field_028c=?'); params.push(fields['0x028c']); }
    if (fields['0x01fc'] !== undefined) { updates.push('in_pairing_mode=?'); params.push(fields['0x01fc'] ? 1 : 0); }

    if (updates.length === 0) return;

    // Deterministic ETag from the actual field values
    const etagSrc = Buffer.from(params.join(':'));
    const etag = generateEtag(etagSrc);
    updates.push('act_etag=?');
    params.push(etag);

    params.push(serial);
    await p.execute(`UPDATE devices SET ${updates.join(', ')} WHERE serial_no = ?`, params);
}

async function updateDeviceErrorFlags(serial, errorFlags) {
    const p = getPool();
    await p.execute('UPDATE devices SET field_01a3 = ? WHERE serial_no = ?', [errorFlags, serial]);
}

function formatFirmwareVersion(value) {
    if (typeof value !== 'number') return value;
    const major = value >> 6;
    const minor = value & 0x3F;
    return `${major}.${minor}`;
}

async function updateDeviceFirmware(serial, fields) {
    const p = getPool();
    const dbDev = await getDeviceByFullSerial(serial) || await getDeviceBySerial(serial);
    if (!dbDev) return;
    const targetSerial = dbDev.serial_no;

    const updates = [];
    const params = [];

    if (fields['0x003a'] !== undefined) { updates.push('current_fw_version=?'); params.push(formatFirmwareVersion(fields['0x003a'])); }
    if (fields['0x0035'] !== undefined) { updates.push('field_0035=?'); params.push(formatFirmwareVersion(fields['0x0035'])); }
    if (fields['0x0039'] !== undefined) { updates.push('field_0039=?'); params.push(formatFirmwareVersion(fields['0x0039'])); }
    if (fields['0x0210'] !== undefined) { updates.push('fw_build_id=?'); params.push(fields['0x0210']); }
    if (fields['0x01a0'] !== undefined) { updates.push('field_01a0=?'); params.push(fields['0x01a0']); }
    if (fields['0x003b'] !== undefined) { updates.push('field_003b=?'); params.push(fields['0x003b']); }
    if (fields['0x0180'] !== undefined) { updates.push('field_0180=?'); params.push(fields['0x0180']); }
    if (fields['0x014c'] !== undefined) { updates.push('field_014c=?'); params.push(fields['0x014c']); }
    if (fields['0x0036'] !== undefined) { updates.push('field_0036=?'); params.push(fields['0x0036']); }
    if (fields['0x003c'] !== undefined) { updates.push('field_003c=?'); params.push(fields['0x003c']); }

    if (updates.length === 0) return;
    params.push(targetSerial);
    await p.execute(`UPDATE devices SET ${updates.join(', ')} WHERE serial_no = ?`, params);
}

async function updateDeviceMount(serial, fields) {
    const p = getPool();
    const updates = [];
    const params = [];

    const rawMountState = fields['0x016a'] !== undefined ? fields['0x016a'] : fields['0x01b8'];
    if (rawMountState !== undefined) {
        updates.push('field_016a=?');
        params.push(mapMountState(rawMountState));
    }
    if (fields['0x01fa'] !== undefined) { updates.push('field_01fa=?'); params.push(fields['0x01fa']); }
    if (fields['0x01fb'] !== undefined) { updates.push('field_01fb=?'); params.push(fields['0x01fb']); }
    if (fields['0x01b5'] !== undefined) { updates.push('field_01b5=?'); params.push(fields['0x01b5']); }
    if (fields['0x01b6'] !== undefined) { updates.push('field_01b6=?'); params.push(fields['0x01b6']); }

    if (updates.length === 0) return;
    params.push(serial);
    await p.execute(`UPDATE devices SET ${updates.join(', ')} WHERE serial_no = ?`, params);
}

async function updateDeviceLock(serial, enabled) {
    const p = getPool();
    const lockVal = enabled ? 1 : 0;
    const etag = generateEtag(Buffer.from(`lock:${lockVal}`));
    await p.execute('UPDATE devices SET child_lock_enabled=?, lock_etag=? WHERE serial_no=?', [lockVal, etag, serial]);
}

async function updateDeviceConfig(serial, fields, fullConfigJson) {
    const p = getPool();
    const dbDev = await getDeviceByFullSerial(serial);
    if (!dbDev) return;

    let mergedConfig = cleanFriendlyConfig(safeJsonParse(dbDev.last_config_json));

    // Convert fullConfigJson to hex keys if any exist
    if (fullConfigJson) {
        for (const [k, v] of Object.entries(fullConfigJson)) {
            const hexKey = k.startsWith('0x') ? k : tlvNameToHex(k);
            if (hexKey) {
                mergedConfig[hexKey] = v;
            }
        }
    }

    // Merge incoming fields
    for (const [k, v] of Object.entries(fields)) {
        if (k.startsWith('0x') && v !== undefined) {
            mergedConfig[k] = v;
        }
    }

    mergedConfig = cleanFriendlyConfig(mergedConfig);

    const updates = ['last_config_json=?'];
    const params = [JSON.stringify(mergedConfig)];

    if (fields['0x0140'] !== undefined) { updates.push('field_0140=?'); params.push(fields['0x0140']); }
    if (fields['0x0149'] !== undefined) {
        updates.push('field_0149=?');
        params.push(mapOrientation(fields['0x0149']));
    }
    if (fields['0x015e'] !== undefined) {
        const pairStr = Array.isArray(fields['0x015e']) ? JSON.stringify(fields['0x015e']) : String(fields['0x015e']);
        updates.push('field_015e=?'); params.push(pairStr);
    }
    if (fields['0x0158'] !== undefined) { updates.push('field_0158=?'); params.push(fields['0x0158']); }
    if (fields['0x015a'] !== undefined) { updates.push('field_015a=?'); params.push(fields['0x015a']); }
    if (fields['0x019e'] !== undefined) { updates.push('field_019e=?'); params.push(fields['0x019e']); }
    if (fields['0x019d'] !== undefined) { updates.push('field_019d=?'); params.push(fields['0x019d']); }
    if (fields['0x02b2'] !== undefined) { updates.push('field_02b2=?'); params.push(fields['0x02b2']); }

    // Always generate a new ETag when config changes
    const etag = generateEtag();
    updates.push('config_etag=?');
    params.push(etag);

    params.push(serial);
    await p.execute(`UPDATE devices SET ${updates.join(', ')} WHERE serial_no = ?`, params);
}

async function updateDeviceClientNonce(serial, nonce) {
    const p = getPool();
    await p.execute('UPDATE devices SET field_0007=? WHERE serial_no=?', [nonce, serial]);
}

async function updateDeviceRfKey(serial, key) {
    const p = getPool();
    await p.execute('UPDATE devices SET field_0155=? WHERE serial_no=?', [key, serial]);
}

async function updateDeviceSelftest(serial, supplyMv) {
    const p = getPool();
    await p.execute('UPDATE devices SET field_0168=? WHERE serial_no=?', [supplyMv, serial]);
}

async function updateDeviceSessionToken(serial, token) {
    const p = getPool();
    await p.execute('UPDATE devices SET field_025e=? WHERE serial_no=?', [token, serial]);
}

async function getDeviceBatteryConfig(shortSerial) {
    const p = getPool();
    const [rows] = await p.execute(
        'SELECT battery_type FROM devices WHERE serial_no = ? OR serial_no LIKE CONCAT(?, "%") LIMIT 1',
        [shortSerial, shortSerial]
    );
    return rows.length > 0 ? rows[0].battery_type : 'alkaline';
}

async function upsertDeviceNeighbors(serial, homeId, neighborData) {
    const p = getPool();
    const etag = generateEtag();

    const dataToSave = {
        ...neighborData,
        updated_at: new Date().toISOString()
    };

    try {
        await p.execute(
            'UPDATE devices SET neighbor_data = ?, sen_etag = ? WHERE serial_no = ?',
            [JSON.stringify(dataToSave), etag, serial]
        );
    } catch (e) {
        _log('error', `Failed to save neighbor_data for ${serial}: ${e.message}`);
    }
}

async function getDeviceEtags(serial) {
    const p = getPool();
    const [rows] = await p.execute('SELECT sen_etag, act_etag, lock_etag, config_etag, config_etag_real, lock_etag_real FROM devices WHERE serial_no = ?', [serial]);
    if (rows.length === 0) return null;
    return {
        sen: rows[0].sen_etag,
        act: rows[0].act_etag,
        lock: rows[0].lock_etag,
        config: rows[0].config_etag,
        config_real: rows[0].config_etag_real,
        lock_real: rows[0].lock_etag_real
    };
}

async function storeRealEtag(serial, resource, etag) {
    let col;
    switch (resource) {
        case 'lock':   col = 'lock_etag_real'; break;
        case 'config': col = 'config_etag_real'; break;
        case 'sen':    col = 'sen_etag_real'; break;
        case 'act':    col = 'act_etag_real'; break;
        default: throw new Error(`Invalid ETag resource: ${resource}`);
    }
    const p = getPool();
    await p.execute(`UPDATE devices SET ${col}=? WHERE serial_no=?`, [etag, serial]);
}

async function isDeviceAlive(serial) {
    const p = getPool();
    const twentyMinsAgo = new Date(Date.now() - 20 * 60000).toISOString();
    const [rows] = await p.execute(
        'SELECT serial_no FROM devices WHERE serial_no = ? AND last_contact >= ? LIMIT 1',
        [serial, twentyMinsAgo]
    );
    return rows.length > 0;
}

async function getZoneForDevice(shortSerial) {
    const p = getPool();
    const [rows] = await p.execute(
        `SELECT d.zone_id, d.home_id, z.measuring_device_serial 
         FROM devices d
         LEFT JOIN zones z ON d.zone_id = z.id AND d.home_id = z.home_id
         WHERE d.serial_no = ? OR d.serial_no LIKE CONCAT(?, "%") LIMIT 1`,
        [shortSerial, shortSerial]
    );
    if (rows.length > 0 && rows[0].zone_id) {
        return {
            zoneId: rows[0].zone_id,
            homeId: rows[0].home_id,
            measuringSerial: rows[0].measuring_device_serial
        };
    }
    return null;
}

async function getHomeForDevice(shortSerial) {
    const p = getPool();
    const [rows] = await p.execute(
        'SELECT home_id FROM devices WHERE serial_no = ? OR serial_no LIKE CONCAT(?, "%") LIMIT 1',
        [shortSerial, shortSerial]
    );
    return rows.length > 0 ? rows[0].home_id : null;
}

async function updateDeviceFallback(serial, value) {
    const p = getPool();
    await p.execute('UPDATE devices SET field_0182=? WHERE serial_no=?', [value, serial]);
}

async function getAllDevices() {
    const p = getPool();
    const [rows] = await p.execute('SELECT * FROM devices');
    return rows;
}

// ---------------------------------------------------------------------------
// ESP32 Hardware Nodes & Emulated Devices
// ---------------------------------------------------------------------------

async function getAllEsp32Nodes() {
    const p = getPool();
    const [rows] = await p.execute('SELECT * FROM esp32_nodes ORDER BY id DESC');
    return rows;
}

async function getEsp32NodeById(id) {
    const p = getPool();
    const [rows] = await p.execute('SELECT * FROM esp32_nodes WHERE id = ? LIMIT 1', [id]);
    return rows[0] || null;
}

async function createEsp32Node({ name, ip_address, api_port = 80, api_key = null, status = 'UNKNOWN' }) {
    const p = getPool();
    const [result] = await p.execute(
        'INSERT INTO esp32_nodes (name, ip_address, api_port, api_key, status, last_seen) VALUES (?, ?, ?, ?, ?, ?)',
        [name, ip_address, api_port, api_key, status, new Date().toISOString()]
    );
    return getEsp32NodeById(result.insertId);
}

async function updateEsp32NodeStatus(id, status) {
    const p = getPool();
    await p.execute('UPDATE esp32_nodes SET status = ?, last_seen = ? WHERE id = ?', [status, new Date().toISOString(), id]);
}

async function deleteEsp32Node(id) {
    const p = getPool();
    await p.execute('DELETE FROM esp32_nodes WHERE id = ?', [id]);
}

async function getAllEmulatedDevices() {
    const p = getPool();
    const [rows] = await p.execute(`
        SELECT ed.*, en.name AS esp32_name, en.ip_address AS esp32_ip, en.api_port AS esp32_port
        FROM emulated_devices ed
        JOIN esp32_nodes en ON ed.esp32_node_id = en.id
        ORDER BY ed.created_at DESC
    `);
    return rows;
}

async function createEmulatedDevice({ serial_no, esp32_node_id, device_type = 'RU02', mode = 'WIRELESS_SENSOR', home_id, zone_id = null, ipv6_address, pairing_state = 'PAIRING_IB', factory_key = null }) {
    const p = getPool();
    const now = new Date().toISOString();

    // 1. Insert into standard devices table so frontend-new displays it as a regular device
    await p.execute(`
        INSERT INTO devices (
            serial_no, device_type, home_id, zone_id, current_fw_version,
            connection_state, connection_state_timestamp, ipv6_address, in_pairing_mode, factory_key
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 1, ?)
        ON DUPLICATE KEY UPDATE
            home_id = VALUES(home_id),
            zone_id = VALUES(zone_id),
            ipv6_address = VALUES(ipv6_address),
            factory_key = VALUES(factory_key),
            in_pairing_mode = 1
    `, [serial_no, device_type, home_id, zone_id, '95.1', now, ipv6_address, factory_key]);

    // 2. Insert into emulated_devices tracking table
    await p.execute(`
        INSERT INTO emulated_devices (
            serial_no, esp32_node_id, device_type, mode, home_id, zone_id, ipv6_address, pairing_state, factory_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            esp32_node_id = VALUES(esp32_node_id),
            mode = VALUES(mode),
            home_id = VALUES(home_id),
            zone_id = VALUES(zone_id),
            ipv6_address = VALUES(ipv6_address),
            pairing_state = VALUES(pairing_state),
            factory_key = VALUES(factory_key)
    `, [serial_no, esp32_node_id, device_type, mode, home_id, zone_id, ipv6_address, pairing_state, factory_key]);

    const [rows] = await p.execute('SELECT * FROM emulated_devices WHERE serial_no = ? LIMIT 1', [serial_no]);
    return rows[0] || null;
}

async function updateEmulatedDevicePairingState(serialNo, pairingState) {
    const p = getPool();
    await p.execute('UPDATE emulated_devices SET pairing_state = ? WHERE serial_no = ?', [pairingState, serialNo]);
    if (pairingState === 'PAIRED') {
        await p.execute('UPDATE devices SET in_pairing_mode = 0, connection_state = 1 WHERE serial_no = ?', [serialNo]);
    }
}

async function deleteEmulatedDevice(serialNo) {
    const p = getPool();
    await p.execute('DELETE FROM emulated_devices WHERE serial_no = ?', [serialNo]);
    await p.execute('DELETE FROM devices WHERE serial_no = ?', [serialNo]);
}

module.exports = {
    getDeviceBySerial,
    getDeviceByFullSerial,
    getDevicesForHome,
    getDevicesInZone,
    updateDeviceConnectionState,
    updateDeviceIPv6,
    getDeviceByIPv6,
    updateDeviceActuator,
    updateDeviceErrorFlags,
    updateDeviceFirmware,
    updateDeviceMount,
    updateDeviceLock,
    updateDeviceConfig,
    updateDeviceClientNonce,
    updateDeviceRfKey,
    updateDeviceSelftest,
    updateDeviceSessionToken,
    getDeviceBatteryConfig,
    upsertDeviceNeighbors,
    getDeviceEtags,
    storeRealEtag,
    isDeviceAlive,
    getZoneForDevice,
    getHomeForDevice,
    updateDeviceFallback,
    getAllDevices,
    getAllEsp32Nodes,
    getEsp32NodeById,
    createEsp32Node,
    updateEsp32NodeStatus,
    deleteEsp32Node,
    getAllEmulatedDevices,
    createEmulatedDevice,
    updateEmulatedDevicePairingState,
    deleteEmulatedDevice
};
