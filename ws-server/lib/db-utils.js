/**
 * @file lib/db-utils.js
 * @brief Database transactions and connection helper utilities.
 */

'use strict';
/**
 * @module db-utils
 * 
 * Database utility and helper operations.
 * Handles configuration sorting, TLV labels retrieval, and building TLV configs for devices.
 */
const { getPool, _log, cleanFriendlyConfig, safeJsonParse, unmapOrientation, calculateVADeviceETag } = require('./db-base');
const { getDeviceByFullSerial, getDeviceBySerial } = require('./db-devices');
const { getZoneBindingsForDevice } = require('./db-zones');
const tlv = require('./tlv');
const crypto = require('crypto');

// Canonical order of config FIDs for d/config TLV payloads.
// Single source of truth — imported by command-api.js and coap-transport.js.
// Note: Unknown HVAC FIDs (0x046c, 0x046d, 0x0471, 0x0481) stripped from device config;
const CONFIG_FIDS_ORDER = [
    0x0143, 0x0140, 0x015d, 0x015c, 0x019d, 0x019e, 0x02b2, 0x02b3, 0x021a, 0x0149, 0x015e, 0x0158, 0x4160, 0x015a, 0x0155
];

function sortConfigFields(fields) {

    const getFid = (key) => {
        if (key.startsWith('0x')) {
            return parseInt(key, 16);
        }
        return tlv.getFidByLabelName(key);
    };

    const keysWithFids = Object.keys(fields).map(key => ({
        key,
        fid: getFid(key)
    })).filter(entry => entry.fid !== null && CONFIG_FIDS_ORDER.includes(entry.fid));

    keysWithFids.sort((a, b) => {
        const idxA = CONFIG_FIDS_ORDER.indexOf(a.fid);
        const idxB = CONFIG_FIDS_ORDER.indexOf(b.fid);
        return idxA - idxB;
    });

    const sortedFields = {};
    for (const entry of keysWithFids) {
        sortedFields[entry.key] = fields[entry.key];
    }
    return sortedFields;
}

async function getTlvLabels() {
    const p = getPool();
    const [rows] = await p.execute('SELECT * FROM tlv_labels');
    const fields = {};
    for (const row of rows) {
        const entry = { name: row.name };
        if (row.type) entry.type = row.type;
        if (row.unit) entry.unit = row.unit;
        if (row.scale != null) entry.scale = row.scale;
        if (row.decimals != null) entry.decimals = row.decimals;
        if (row.round != null) entry.round = row.round;
        if (row.notes) entry.notes = row.notes;
        if (row.parse) entry.parse = row.parse;
        // Fallback: merge remaining json_data keys (e.g. enum, enum_role_u8)
        if (row.json_data) {
            try {
                const extra = JSON.parse(row.json_data.toString());
                for (const [k, v] of Object.entries(extra)) {
                    if (entry[k] === undefined) entry[k] = v;
                }
            } catch (e) {
                _log('debug', `Failed to parse json_data for TLV label ${row.hex_id}: ${e.message}`);
            }
        }
        fields[row.hex_id] = entry;
    }
    return { fields };
}

async function buildDeviceConfigTLV(deviceId, existingDbDev = null) {
    const tlv = require('./tlv');
    _log('debug', `Building Config TLV for ${deviceId}...`);
    let dbDev = existingDbDev;
    if (!dbDev) {
        dbDev = await getDeviceByFullSerial(deviceId);
        if (!dbDev) dbDev = await getDeviceBySerial(deviceId);
    }
    if (!dbDev) {
        _log('warn', `Device ${deviceId} not found!`);
        return null;
    }

    const isIB = deviceId.startsWith('IB');
    const isRU = deviceId.startsWith('RU') || deviceId.startsWith('WR') || deviceId.startsWith('SU') || deviceId.startsWith('BP') || deviceId.startsWith('BR');

    const zoneId = dbDev.zone_id || 1;
    const p = getPool();
    const [zoneRows] = await p.execute('SELECT dazzle_enabled, offline_schedule_enabled FROM zones WHERE id = ? AND home_id = ?', [zoneId, dbDev.home_id]);
    const dazzleEnabled = zoneRows.length > 0 ? zoneRows[0].dazzle_enabled : 1;
    const offlineScheduleEnabled = zoneRows.length > 0 ? zoneRows[0].offline_schedule_enabled : 0;
    _log('debug', `Building device config from DB columns...`);
    let fields = {};
    let defaultTzOffset = 0;
    try {
        const [homeRows] = await p.execute('SELECT date_time_zone FROM homes WHERE id = ? LIMIT 1', [dbDev.home_id]);
        const tz = (homeRows.length > 0 && homeRows[0].date_time_zone) ? homeRows[0].date_time_zone : 'Europe/Berlin';
        const formatter = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' });
        const parts = formatter.formatToParts(new Date());
        const tzPart = parts.find(part => part.type === 'timeZoneName')?.value;
        if (tzPart && tzPart !== 'GMT' && tzPart !== 'UTC') {
            const match = tzPart.match(/GMT([+-])(\d+)(?::(\d+))?/);
            if (match) {
                const sign = match[1] === '-' ? -1 : 1;
                const hours = parseInt(match[2], 10);
                const minutes = parseInt(match[3] || '0', 10);
                defaultTzOffset = sign * (hours * 60 + minutes);
            }
        }
    } catch (e) {
        defaultTzOffset = 0;
    }

    // Use strictly hex keys
    fields['0x0140'] = parseFloat(dbDev.field_0140) || 0; // field_0140 (temperature offset)
    if (!isRU) {
        // Omit display brightness, contrast, orientation, and aux 0x021a for RU
        fields['0x019e'] = dbDev.field_019e !== null && dbDev.field_019e !== undefined ? dbDev.field_019e : 112; // display_brightness
        fields['0x019d'] = dbDev.field_019d !== null && dbDev.field_019d !== undefined ? dbDev.field_019d : 128; // display_contrast
        fields['0x0149'] = unmapOrientation(dbDev.field_0149); // display_orientation
    }
    // 0x02b2: Device UTC offset in minutes applied to RTC epoch (RU and VA firmware)
    fields['0x02b2'] = dbDev.field_02b2 !== null && dbDev.field_02b2 !== undefined ? Number(dbDev.field_02b2) : defaultTzOffset;
    if (deviceId.startsWith('VA')) {
        fields['0x021a'] = dbDev.field_021a !== null && dbDev.field_021a !== undefined ? Number(dbDev.field_021a) : 0;
    }
    if (dbDev.field_016a !== null && dbDev.field_016a !== undefined) {
        fields['0x016a'] = Number(dbDev.field_016a);
    }
    fields['0x0158'] = dazzleEnabled ? 0x0200 : 0x0000; // field_0158
    fields['0x0143'] = false; // device_flag_0143 (child lock available)

    // Metadata: Include home_id (0x015c)
    fields['0x015c'] = dbDev.home_id;
    _log('debug', `Checking for boilers in home ${dbDev.home_id}...`);
    const [boilerRows] = await p.execute("SELECT serial_no FROM devices WHERE home_id = ? AND (device_type LIKE 'RU%' OR device_type LIKE 'BU%') LIMIT 1", [dbDev.home_id]);
    _log('debug', `Found ${boilerRows.length} boilers.`);
    const homeHasBoiler = boilerRows.length > 0;

    const pairs = await getZoneBindingsForDevice(deviceId);

    if (pairs.length > 0) {
        fields['0x015e'] = pairs;
    }

    if (deviceId.startsWith('VA')) {
        const sensitivity = dbDev.valve_sensitivity !== null && dbDev.valve_sensitivity !== undefined ? Number(dbDev.valve_sensitivity) : 100;
        if (sensitivity >= 25 && sensitivity <= 100) {
            fields['0x4160'] = sensitivity;
        }
    }

    // Dynamic ETag Generation for Valve Actuators
    if (deviceId.startsWith('VA')) {
        const hash = calculateVADeviceETag(fields);
        let suffix = crypto.createHash('sha256').update(deviceId).digest('hex').substring(0, 12);
        if (dbDev.config_etag_real && dbDev.config_etag_real.length === 8) {
            suffix = dbDev.config_etag_real.slice(2).toString('hex');
        } else if (dbDev.config_etag && dbDev.config_etag.length === 8) {
            suffix = dbDev.config_etag.slice(2).toString('hex');
        } else if (dbDev.field_015a && dbDev.field_015a.length === 16) {
            suffix = dbDev.field_015a.substring(4);
        }
        const etag8 = hash.toString(16).padStart(4, '0') + suffix;
        fields['0x015a'] = etag8;

        // Generate a deterministic 8-byte ETag for the CoAP header
        // Tado uses the hash as the first 2 bytes, followed by a 6-byte suffix.
        await p.execute('UPDATE devices SET config_etag = ? WHERE serial_no = ?', [Buffer.from(etag8, 'hex'), deviceId]);
        _log('debug', `Generated and stored stable VA ETag: ${etag8} (hash: 0x${hash.toString(16).padStart(4, '0')})`);
    } else if (!isRU && dbDev.field_015a) {
        // ETag (0x015a) stripped for RU devices.
        fields['0x015a'] = dbDev.field_015a;
    }

    // Ensure hvac_diagnostic_015d (0x015d) is present
    if (isRU) {
        if (dbDev.is_emulated || dbDev.emulated_mode) {
            fields['0x015d'] = 200;
        } else if (dbDev.field_015d !== null && dbDev.field_015d !== undefined) {
            fields['0x015d'] = Number(dbDev.field_015d);
        } else {
            const [hsRows] = await p.execute('SELECT field_015d FROM heating_systems WHERE home_id = ? LIMIT 1', [dbDev.home_id]);
            fields['0x015d'] = (hsRows.length > 0 && hsRows[0].field_015d != null) ? Number(hsRows[0].field_015d) : 71;
        }
    } else if (isIB && homeHasBoiler) {
        const [hsRows] = await p.execute('SELECT field_015d FROM heating_systems WHERE home_id = ? LIMIT 1', [dbDev.home_id]);
        const hsField015d = hsRows.length > 0 ? hsRows[0].field_015d : null;
        if (hsField015d != null) {
            fields['0x015d'] = Number(hsField015d);
        } else if (dbDev.field_015d != null) {
            fields['0x015d'] = Number(dbDev.field_015d);
        } else {
            fields['0x015d'] = 71; // 0x47
        }
    } else {
        if (dbDev.field_015d) {
            fields['0x015d'] = Number(dbDev.field_015d);
        } else {
            fields['0x015d'] = 112; // 0x70
        }
    }

    if (dbDev.field_0155 && dbDev.in_pairing_mode !== 1) {
        fields['0x0155'] = dbDev.field_0155;
    }

    fields = cleanFriendlyConfig(fields);
    _log('debug', `Final fields for TLV:`, Object.keys(fields).join(', '));
    if (fields['0x015d'] === undefined) _log('warn', `WARNING: 0x015d is missing from fields!`);

    fields['0x02b3'] = offlineScheduleEnabled ? 1 : 0;

    const sortedFields = sortConfigFields(fields);

    _log('debug', `Re-encoding TLV payload...`);
    try {
        const result = tlv.encodeFromFields(sortedFields);
        _log('debug', `TLV built successfully: ${result.length} bytes`);
        return result;
    } catch (e) {
        _log('error', `TLV encoding failed: ${e.message}`, e.stack);
        throw e;
    }
}

async function buildDeviceSensorTLV(deviceId) {
    const tlv = require('./tlv');
    const p = getPool();

    // Resolve the device
    let dbDev = await getDeviceByFullSerial(deviceId);
    if (!dbDev) dbDev = await getDeviceBySerial(deviceId);
    if (!dbDev) return null;

    // Fetch the latest device measurement for raw sensor values
    const [mRows] = await p.execute(
        'SELECT * FROM device_measurements WHERE device_serial = ? ORDER BY timestamp DESC LIMIT 1',
        [dbDev.serial_no]
    );

    const m = mRows.length > 0 ? mRows[0] : {};
    const fields = {};

    if (m.field_012d != null) fields['0x012d'] = parseFloat(m.field_012d);
    if (m.field_012e != null) fields['0x012e'] = parseFloat(m.field_012e);
    if (m.field_01c8 != null) fields['0x01c8'] = parseFloat(m.field_01c8);
    if (m.field_0135 != null) fields['0x0135'] = parseFloat(m.field_0135);
    if (m.field_0162 != null) fields['0x0162'] = parseInt(m.field_0162, 10);
    if (m.field_0136 != null) fields['0x0136'] = parseInt(m.field_0136, 10);
    if (m.field_027a != null) fields['0x027a'] = parseInt(m.field_027a, 10);
    if (m.field_0137 != null) fields['0x0137'] = parseInt(m.field_0137, 10);
    if (m.field_0161 != null) fields['0x0161'] = parseInt(m.field_0161, 10);
    if (m.field_0160 != null) fields['0x0160'] = parseInt(m.field_0160, 10);

    if (Object.keys(fields).length === 0) return null;

    return tlv.encodeFromFields(fields);
}

async function buildDeviceActuatorTLV(deviceId) {
    const tlv = require('./tlv');

    let dbDev = await getDeviceByFullSerial(deviceId);
    if (!dbDev) dbDev = await getDeviceBySerial(deviceId);
    if (!dbDev) return null;

    const fields = {};

    if (dbDev.field_0265 != null) fields['0x0265'] = parseInt(dbDev.field_0265, 10);
    if (dbDev.field_0266 != null) fields['0x0294'] = parseInt(dbDev.field_0266, 10);
    if (dbDev.field_0273 != null) fields['0x0273'] = parseInt(dbDev.field_0273, 10);
    if (dbDev.field_027c != null) fields['0x027c'] = parseInt(dbDev.field_027c, 10);
    if (dbDev.field_0280 != null) fields['0x0280'] = parseInt(dbDev.field_0280, 10);
    if (dbDev.field_0283 != null) fields['0x028d'] = parseInt(dbDev.field_0283, 10);
    if (dbDev.field_028c != null) fields['0x028c'] = parseInt(dbDev.field_028c, 10);

    if (Object.keys(fields).length === 0) return null;

    return tlv.encodeFromFields(fields);
}

function sortZoneConfigFields(fields) {
    const ZONE_CONFIG_FIDS_ORDER = [
        '0x6020', '0x63e0', '0x63a0', '0x8200', '0x8400', '0x8000', '0x6060', '0x6040', '0x6080', '0x60a0', '0x60c0', '0x60e0', '0x62c0', '0x6340', '0x6380'
    ];

    const sorted = {};
    for (const fid of ZONE_CONFIG_FIDS_ORDER) {
        if (fields[fid] !== undefined) {
            sorted[fid] = fields[fid];
        }
    }
    return sorted;
}

async function buildZoneConfigFields(homeId, zoneId) {
    if (!homeId) throw new Error('homeId is required for buildZoneConfigFields');
    const p = getPool();
    const [rows] = await p.execute(
        'SELECT type, dazzle_enabled, open_window_enabled, open_window_timeout, field_60a0, field_6080, field_6340, field_60c0, measuring_device_serial, heating_circuit FROM zones WHERE id = ? AND home_id = ?',
        [zoneId, homeId]
    );
    if (rows.length === 0) return null;

    const row = rows[0];
    let fields = {};

    // Query active devices in this zone with IPv6
    const [zoneDevs] = await p.execute(
        'SELECT serial_no, device_type, ipv6_address FROM devices WHERE zone_id = ? AND home_id = ? AND ipv6_address IS NOT NULL',
        [zoneId, homeId]
    );

    // Query heating circuit driver / zone controller (RU/WR/BU/EK)
    let circuitDriverIpv6 = null;
    const circuitNum = row.heating_circuit || 1;
    const [circRows] = await p.execute(
        'SELECT driver_serial_no FROM heating_circuits WHERE home_id = ? AND number = ? LIMIT 1',
        [homeId, circuitNum]
    );
    if (circRows.length > 0 && circRows[0].driver_serial_no) {
        const [driverDev] = await p.execute(
            'SELECT ipv6_address FROM devices WHERE serial_no = ? AND home_id = ? LIMIT 1',
            [circRows[0].driver_serial_no, homeId]
        );
        if (driverDev.length > 0 && driverDev[0].ipv6_address) {
            circuitDriverIpv6 = driverDev[0].ipv6_address;
        }
    }
    if (!circuitDriverIpv6) {
        const [zcDevs] = await p.execute(
            "SELECT ipv6_address FROM devices WHERE home_id = ? AND (device_type LIKE 'RU%' OR device_type LIKE 'WR%' OR device_type LIKE 'BU%' OR device_type LIKE 'EK%') AND ipv6_address IS NOT NULL LIMIT 1",
            [homeId]
        );
        if (zcDevs.length > 0) circuitDriverIpv6 = zcDevs[0].ipv6_address;
    }

    if (row.type === 'HOT_WATER') {
        fields['0x6020'] = 2;
        fields['0x63e0'] = true;
        const leaderSerial = row.measuring_device_serial;
        const leaderDev = zoneDevs.find(d => d.serial_no === leaderSerial) || zoneDevs[0];
        const targetIpv6 = leaderDev?.ipv6_address || circuitDriverIpv6;
        if (targetIpv6) {
            fields['0x63a0'] = `coap://[${targetIpv6}]/z/s`;
            fields['0x8400'] = `coap://[${targetIpv6}]/z/p`;
        }
        fields['0x60a0'] = row.field_60a0 != null ? parseFloat(row.field_60a0) : 500;
        fields['0x60c0'] = row.field_60c0 != null ? parseFloat(row.field_60c0) : 1500;
        fields['0x6080'] = row.field_6080 != null ? parseFloat(row.field_6080) : 1000;
        return cleanFriendlyConfig(fields);
    }

    // Standard HEATING zone
    fields['0x6020'] = 1;
    fields['0x63e0'] = true;
    fields['0x6380'] = 15;

    // Active timetable check for 0x6060
    const [ttRows] = await p.execute(
        'SELECT id FROM zone_timetables WHERE home_id = ? AND zone_id = ? AND is_active = 1 LIMIT 1',
        [homeId, zoneId]
    );
    if (ttRows.length > 0) {
        fields['0x6060'] = 1;
    }

    if (zoneDevs.length > 0) {
        const measuringSerial = row.measuring_device_serial;
        const leaderDev = zoneDevs.find(d => d.serial_no === measuringSerial) || zoneDevs[0];
        const vaDevs = zoneDevs.filter(d => d.device_type && d.device_type.startsWith('VA'));

        // 1. 0x63a0: Zone State URI (points to measuring leader's /z/s)
        if (leaderDev && leaderDev.ipv6_address) {
            fields['0x63a0'] = `coap://[${leaderDev.ipv6_address}]/z/s`;
        }

        // 2. 0x8000: Zone Listeners (distinct /z/s endpoints for all member devices + circuit driver)
        const listeners = new Set();
        if (circuitDriverIpv6) listeners.add(`coap://[${circuitDriverIpv6}]/z/s`);
        for (const d of zoneDevs) {
            if (d.ipv6_address) listeners.add(`coap://[${d.ipv6_address}]/z/s`);
        }
        if (listeners.size > 0) {
            fields['0x8000'] = Array.from(listeners);
        }

        // 3. 0x8200: Control Peer Endpoint (CPE) for all VAs in zone (or leader if no VAs)
        if (vaDevs.length > 0) {
            const cpes = vaDevs.filter(d => d.ipv6_address).map(d => `coap://[${d.ipv6_address}]/z/cpe`);
            if (cpes.length > 0) fields['0x8200'] = cpes.length === 1 ? cpes[0] : cpes;
        } else if (leaderDev && leaderDev.ipv6_address) {
            fields['0x8200'] = `coap://[${leaderDev.ipv6_address}]/z/cpe`;
        }

        // 4. 0x8400: Zone Parameter URLs (/z/p) for all VAs in zone + leader if not already in list
        if (vaDevs.length > 0) {
            const zps = vaDevs.filter(d => d.ipv6_address).map(d => `coap://[${d.ipv6_address}]/z/p`);
            if (leaderDev && leaderDev.ipv6_address && !vaDevs.some(d => d.serial_no === leaderDev.serial_no)) {
                zps.push(`coap://[${leaderDev.ipv6_address}]/z/p`);
            }
            if (zps.length > 0) fields['0x8400'] = zps.length === 1 ? zps[0] : zps;
        } else if (leaderDev && leaderDev.ipv6_address) {
            fields['0x8400'] = `coap://[${leaderDev.ipv6_address}]/z/p`;
        }

        // 5. 0x6040: Zone Driver URI (primary valve /z/p, or leader /z/p if no valves)
        if (vaDevs.length > 0 && vaDevs[0].ipv6_address) {
            fields['0x6040'] = `coap://[${vaDevs[0].ipv6_address}]/z/p`;
        } else if (leaderDev && leaderDev.ipv6_address) {
            fields['0x6040'] = `coap://[${leaderDev.ipv6_address}]/z/p`;
        }
    }

    // DB Overrides
    if (row.open_window_enabled !== undefined && row.open_window_enabled !== null) {
        fields['0x60e0'] = row.open_window_enabled ? 1 : 0;
    }
    if (row.open_window_timeout !== undefined && row.open_window_timeout !== null) {
        fields['0x62c0'] = row.open_window_timeout / 60;
    }
    if (row.field_60a0 !== null && row.field_60a0 !== undefined) {
        fields['0x60a0'] = parseFloat(row.field_60a0);
    } else {
        fields['0x60a0'] = 5;
    }
    if (row.field_60c0 !== null && row.field_60c0 !== undefined) {
        fields['0x60c0'] = parseFloat(row.field_60c0);
    } else {
        fields['0x60c0'] = 15;
    }
    if (row.field_6080 !== null && row.field_6080 !== undefined) {
        fields['0x6080'] = parseFloat(row.field_6080);
    } else {
        fields['0x6080'] = 10;
    }
    if (row.field_6340 !== null && row.field_6340 !== undefined) {
        fields['0x6340'] = parseInt(row.field_6340, 10);
    } else {
        fields['0x6340'] = 1;
    }

    return cleanFriendlyConfig(fields);
}

async function buildZoneConfigTLV(homeId, zoneId) {
    if (!homeId) throw new Error('homeId is required for buildZoneConfigTLV');
    const tlv = require('./tlv');
    const fields = await buildZoneConfigFields(homeId, zoneId);
    if (!fields) return null;
    const sorted = sortZoneConfigFields(fields);
    return tlv.encodeFromFields(sorted);
}

async function buildHvacConfigTLV(homeId) {
    const tlv = require('./tlv');
    const p = getPool();
    const [rows] = await p.execute('SELECT * FROM heating_systems WHERE home_id = ?', [homeId]);
    if (rows.length === 0) return null;

    const r = rows[0];
    const fields = {};
    const mapping = {
        '0x044c': 'field_044c',
        '0x044d': 'field_044d',
        '0x044e': 'field_044e',
        '0x044f': 'field_044f',
        '0x0450': 'field_0450',
        '0x0458': 'field_0458',
        '0x0457': 'field_0457',
        '0x0452': 'field_0452',
        '0x045a': 'field_045a',
        '0x045e': 'field_045e',
        '0x0460': 'field_0460',
        '0x0462': 'field_0462',
        '0x015d': 'field_015d',
        '0x0471': 'field_0471',
        '0x046f': 'field_046f',
        '0x046c': 'field_046c',
        '0x046d': 'field_046d',
        '0x045b': 'field_045b',
        '0x0463': 'field_0463',
        '0x0466': 'field_0466',
        '0x0467': 'field_0467',
        '0x0468': 'field_0468',
        '0x0464': 'field_0464',
        '0x0465': 'field_0465',
        '0x0481': 'field_0481'
    };
    for (const [fid, col] of Object.entries(mapping)) {
        if (r[col] !== null && r[col] !== undefined) {
            fields[fid] = r[col];
        }
    }

    return tlv.encodeFromFields(cleanFriendlyConfig(fields));
}

async function buildCircuitConfigTLV(homeId, circuitNumber) {
    const tlv = require('./tlv');
    const p = getPool();
    const [rows] = await p.execute('SELECT field_2040, field_2090 FROM heating_circuits WHERE home_id = ? AND number = ? LIMIT 1', [homeId, circuitNumber]);

    let fields = {};
    const field2040 = rows.length > 0 ? rows[0].field_2040 : null;
    const field2090 = rows.length > 0 && rows[0].field_2090 !== null && rows[0].field_2090 !== undefined
        ? parseInt(rows[0].field_2090, 10)
        : 1;

    // If circuit is in STANDBY (field_2090 === 0), suppress max flow temp to 0.0 to shut off RU OpenTherm burner
    if (field2090 === 0) {
        fields['0x2040'] = 0.0;
    } else {
        // Always query flow_temperature_settings to allow user override from TaNoClo frontend
        const [settingsRows] = await p.execute('SELECT max_flow_temperature FROM flow_temperature_settings WHERE home_id = ?', [homeId]);
        if (settingsRows.length > 0 && settingsRows[0].max_flow_temperature) {
            fields['0x2040'] = parseFloat(settingsRows[0].max_flow_temperature);
        } else if (field2040 !== null && field2040 !== undefined) {
            fields['0x2040'] = parseFloat(field2040);
        } else {
            fields['0x2040'] = 60.0;
        }
    }
    fields = cleanFriendlyConfig(fields);
    return tlv.encodeFromFields(fields);
}

async function syncZoneConfig(homeId, zoneId) {
    if (!homeId || !zoneId) return null;
    const p = getPool();
    const fields = await buildZoneConfigFields(homeId, zoneId);
    if (!fields) return null;
    const tlvBuf = await buildZoneConfigTLV(homeId, zoneId);
    const crypto = require('crypto');
    const newEtag = tlvBuf && tlvBuf.length > 0
        ? crypto.createHash('md5').update(tlvBuf).digest().subarray(0, 8)
        : crypto.randomBytes(8);
    await p.execute(
        'UPDATE zones SET config_etag = ?, config_etag_real = NULL WHERE id = ? AND home_id = ?',
        [newEtag, zoneId, homeId]
    );
    return newEtag;
}

module.exports = {
    CONFIG_FIDS_ORDER,
    sortConfigFields,
    getTlvLabels,
    buildDeviceConfigTLV,
    buildDeviceSensorTLV,
    buildDeviceActuatorTLV,
    buildZoneConfigFields,
    buildZoneConfigTLV,
    syncZoneConfig,
    buildHvacConfigTLV,
    buildCircuitConfigTLV
};