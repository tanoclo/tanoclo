/**
 * @file api/routes/setup/emulated.js
 * @brief Admin Setup Portal endpoints for ESP32 hardware nodes and emulated Tado devices.
 * Features secure HMAC-SHA256 request signing and API key authentication.
 */

const express = require('express');
const crypto = require('crypto');
const http = require('http');
const router = express.Router();
const dbDevices = require('../../../lib/db-devices');
const db = require('../../../lib/db');
const commandApi = require('../../../lib/command-api');

/**
 * Generate a Tado-ecosystem compliant IPv6 address from serial or random MAC.
 * Format: fe80::21b:c507:31XX:XXXX
 */
function generateTadoIpv6(serialNo) {
    const hash = crypto.createHash('sha256').update(serialNo || Date.now().toString()).digest();
    const b4 = (hash[0] & 0x0F).toString(16).padStart(2, '0');
    const b5 = hash[1].toString(16).padStart(2, '0');
    const b6 = hash[2].toString(16).padStart(2, '0');
    const b7 = hash[3].toString(16).padStart(2, '0');
    return `fe80::21b:c507:31${b4}:${b5}${b6}`;
}

/**
 * Computes HMAC-SHA256 signature for API request verification.
 */
function computeHmacSignature(apiKey, timestamp, bodyStr) {
    return crypto.createHmac('sha256', apiKey || '')
        .update(`${timestamp}.${bodyStr}`)
        .digest('hex');
}

/**
 * Helper to issue secure HTTP JSON POST requests to ESP32 hardware nodes with HMAC signatures.
 */
function sendEsp32Command(ip, port, apiKey, commandPayload) {
    return new Promise((resolve, reject) => {
        const rawJson = JSON.stringify(commandPayload);
        const postData = 'plain=' + encodeURIComponent(rawJson);
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const signature = apiKey ? computeHmacSignature(apiKey, timestamp, rawJson) : '';

        const headers = {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
            'X-Timestamp': timestamp
        };

        if (apiKey) {
            headers['X-ESP-API-Key'] = apiKey;
            headers['X-Signature'] = signature;
        }

        const req = http.request({
            hostname: ip,
            port: port || 80,
            path: '/api/cmd',
            method: 'POST',
            headers,
            timeout: 5000
        }, (res) => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    resolve(parsed);
                } catch (e) {
                    resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, raw: body });
                }
            });
        });

        req.on('error', (err) => {
            reject(err);
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('ESP32 command timeout'));
        });

        req.write(postData);
        req.end();
    });
}

async function probeNodeStatus(ip, port) {
    return new Promise((resolve) => {
        const req = http.get({
            hostname: ip,
            port: port || 80,
            path: '/api/status',
            timeout: 2000
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                resolve(res.statusCode === 200 ? 'ONLINE' : 'ERROR');
            });
        });
        req.on('error', () => resolve('OFFLINE'));
        req.on('timeout', () => { req.destroy(); resolve('OFFLINE'); });
    });
}

// ---------------------------------------------------------------------------
// ESP32 Hardware Node Management
// ---------------------------------------------------------------------------

router.get('/nodes', async (req, res) => {
    try {
        const nodes = await dbDevices.getAllEsp32Nodes();
        // Concurrently probe all nodes to refresh live status
        await Promise.all(nodes.map(async (node) => {
            const liveStatus = await probeNodeStatus(node.ip_address, node.api_port);
            if (node.status !== liveStatus) {
                node.status = liveStatus;
                await dbDevices.updateEsp32NodeStatus(node.id, liveStatus).catch(() => {});
            }
        }));
        res.json({ success: true, nodes });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/nodes', async (req, res) => {
    try {
        const { name, ip_address, api_port = 80, api_key } = req.body;
        if (!name || !ip_address) {
            return res.status(400).json({ success: false, error: 'Name and IP address are required' });
        }
        // Auto-generate 256-bit API key if not provided
        const nodeApiKey = api_key || crypto.randomBytes(32).toString('hex');
        const initialStatus = await probeNodeStatus(ip_address, api_port);
        const node = await dbDevices.createEsp32Node({ name, ip_address, api_port, api_key: nodeApiKey, status: initialStatus });
        res.json({
            success: true,
            node,
            warning: initialStatus !== 'ONLINE' ? `Node registered in DB, but failed to connect to ${ip_address}:${api_port} (${initialStatus})` : null
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.delete('/nodes/:id', async (req, res) => {
    try {
        await dbDevices.deleteEsp32Node(req.params.id);
        res.json({ success: true, message: 'ESP32 node deleted' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ---------------------------------------------------------------------------
// Emulated Device Management & Automated Pairing / Unassociation
// ---------------------------------------------------------------------------

router.get('/devices', async (req, res) => {
    try {
        const devices = await dbDevices.getAllEmulatedDevices();
        res.json({ success: true, devices });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/devices', async (req, res) => {
    try {
        const { esp32_node_id, serial_no, home_id, zone_id } = req.body;
        if (!esp32_node_id || !home_id) {
            return res.status(400).json({ success: false, error: 'esp32_node_id and home_id are required' });
        }

        const espNode = await dbDevices.getEsp32NodeById(esp32_node_id);
        if (!espNode) {
            return res.status(404).json({ success: false, error: 'ESP32 node not found' });
        }

        // Generate serial if not provided (RU format)
        const targetSerial = serial_no || `RU${Math.floor(1000000000 + Math.random() * 9000000000)}`;
        const ipv6 = generateTadoIpv6(targetSerial);

        // 1. Generate a 16-byte device factory key (Slot 2 key) for secure pairing
        const factoryKey = crypto.randomBytes(16).toString('hex');

        // 2. Create DB records in devices & emulated_devices tables
        const emulatedDevice = await dbDevices.createEmulatedDevice({
            serial_no: targetSerial,
            esp32_node_id,
            device_type: 'RU02',
            mode: 'WIRELESS_SENSOR',
            home_id: parseInt(home_id, 10),
            zone_id: null,
            ipv6_address: ipv6,
            pairing_state: 'PAIRING_IB',
            factory_key: factoryKey
        });

        // 3. Enable pairing mode on the Internet Bridge (IB) connected to this home
        let ibPairingStarted = false;
        try {
            let bridgeId = null;
            const bridge = commandApi.findBridgeForHome(parseInt(home_id, 10));
            if (bridge && bridge.bridgeId) {
                bridgeId = bridge.bridgeId;
            } else {
                const devs = await dbDevices.getDevicesForHome(parseInt(home_id, 10));
                const dbBridge = (devs || []).find(d => d.device_type === 'IB01' || d.serial_no.startsWith('IB'));
                if (dbBridge) bridgeId = dbBridge.serial_no;
            }
            if (bridgeId) {
                commandApi.pushDevicePair(bridgeId, true).catch(err => {
                    console.warn(`[Emulated] Warning pushing pairing to bridge: ${err.message}`);
                });
                ibPairingStarted = true;
            }
        } catch (ibErr) {
            console.warn(`[Emulated] Warning enabling IB pairing mode: ${ibErr.message}`);
        }

        // 4. Trigger JSON pair command on ESP32 node with HMAC authentication and factory key
        let espRes = null;
        let espError = null;
        try {
            const devs = await dbDevices.getDevicesForHome(parseInt(home_id, 10));
            const dbBridge = (devs || []).find(d => d.device_type === 'IB01' || d.serial_no.startsWith('IB'));
            const ibIpv6 = dbBridge ? dbBridge.ipv6_address : null;

            espRes = await sendEsp32Command(espNode.ip_address, espNode.api_port, espNode.api_key, {
                cmd: 'pair',
                api_key: espNode.api_key,
                serial: targetSerial,
                ipv6: ipv6,
                ib_ipv6: ibIpv6,
                factory_key: factoryKey,
                home_id: parseInt(home_id, 10),
                zone_id: 0
            });
            await dbDevices.updateEmulatedDevicePairingState(targetSerial, 'PAIRING_RF');
        } catch (espErr) {
            espError = espErr.message;
            console.error(`[Emulated] Error sending pair command to ESP32: ${espErr.message}`);
        }

        res.json({
            success: true,
            device: emulatedDevice,
            ibPairingStarted,
            esp32Response: espRes,
            esp32Error: espError,
            warning: espError ? `Device created in DB but failed to reach ESP32 node (${espError})` : null
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.delete('/devices/:serialNo', async (req, res) => {
    try {
        const serialNo = req.params.serialNo;
        const emulatedList = await dbDevices.getAllEmulatedDevices();
        const emDev = emulatedList.find(d => d.serial_no === serialNo);
        const dbDev = await dbDevices.getDeviceByFullSerial(serialNo) || await dbDevices.getDeviceBySerial(serialNo);
        const homeId = (emDev && emDev.home_id) || (dbDev && dbDev.home_id);
        
        let unassociateTriggered = false;
        if (homeId) {
            try {
                await commandApi.pushDeviceUnassociation(homeId, serialNo);
                unassociateTriggered = true;
            } catch (unassocErr) {
                console.warn(`[Emulated] Warning sending unassociation to IB: ${unassocErr.message}`);
            }
        }

        // Notify assigned ESP32 hardware node to erase device from NVRAM
        let espRemoved = false;
        try {
            if (emDev && emDev.esp32_node_id) {
                const node = await dbDevices.getEsp32NodeById(emDev.esp32_node_id);
                if (node && node.ip_address) {
                    await sendEsp32Command(node.ip_address, node.api_port, node.api_key, {
                        cmd: 'remove',
                        serial: serialNo
                    }).catch(e => console.warn(`[Emulated] ESP32 remove RPC warning: ${e.message}`));
                    espRemoved = true;
                }
            }
        } catch (espErr) {
            console.warn(`[Emulated] Warning notifying ESP32 on deletion: ${espErr.message}`);
        }

        // Clean up DB records
        await dbDevices.deleteEmulatedDevice(serialNo);
        res.json({ success: true, message: 'Emulated device deletion completed', unassociateTriggered, espRemoved });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Authenticated Webhook endpoint called by ESP32 after NVRAM erasure
router.post('/notify-removed', async (req, res) => {
    try {
        const { serial } = req.body;
        const apiKey = req.headers['x-esp-api-key'];
        const timestamp = req.headers['x-timestamp'];
        const signature = req.headers['x-signature'];

        if (!serial) {
            return res.status(400).json({ success: false, error: 'Serial is required' });
        }

        // Verify HMAC signature if API key header is provided
        if (apiKey && timestamp && signature) {
            const nowSec = Math.floor(Date.now() / 1000);
            if (Math.abs(nowSec - parseInt(timestamp, 10)) > 60) {
                return res.status(401).json({ success: false, error: 'Request timestamp expired' });
            }
            const expectedSig = computeHmacSignature(apiKey, timestamp, JSON.stringify(req.body));
            if (signature !== expectedSig) {
                return res.status(401).json({ success: false, error: 'Invalid HMAC signature' });
            }
        }

        await dbDevices.deleteEmulatedDevice(serial);
        console.log(`[Emulated Webhook] Authenticated NVRAM removal confirmation for device ${serial}`);
        res.json({ success: true, message: 'Device records removed from database' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Trigger telemetry push command to ESP32 (HMAC authenticated)
router.post('/devices/:serialNo/telemetry', async (req, res) => {
    try {
        const serialNo = req.params.serialNo;
        const { temp_celsius = 20.5, humidity_percent = 50.0, battery_mv = 3000 } = req.body;
        
        const emulatedList = await dbDevices.getAllEmulatedDevices();
        const dev = emulatedList.find(d => d.serial_no === serialNo);
        if (!dev) {
            return res.status(404).json({ success: false, error: 'Emulated device not found' });
        }

        const espRes = await sendEsp32Command(dev.esp32_ip, dev.esp32_port, dev.api_key, {
            cmd: 'send_telemetry',
            serial: serialNo,
            params: { temp_celsius, humidity_percent, battery_mv }
        });

        res.json({ success: true, esp32Response: espRes });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get real latest registered sensor state for emulated device bootup sync
router.get('/devices/:serialNo/state', async (req, res) => {
    try {
        const serialNo = req.params.serialNo;
        const mqttCommands = require('../../../lib/mqtt-commands');
        let tempC = 21.5;
        let humidity = 50.0;
        let batteryMv = 4500;
        let foundMeasurement = false;

        // 1. Check latest historical measurement from device_measurements table
        try {
            if (db && db.getPool) {
                const [measRows] = await db.getPool().execute(
                    'SELECT field_012d, field_0135, field_0162 FROM device_measurements WHERE device_serial = ? AND (field_012d IS NOT NULL OR field_0135 IS NOT NULL) ORDER BY id DESC LIMIT 1',
                    [serialNo]
                );
                if (measRows && measRows.length > 0) {
                    const m = measRows[0];
                    if (m.field_012d != null) { tempC = parseFloat(m.field_012d); foundMeasurement = true; }
                    if (m.field_0135 != null) { humidity = parseFloat(m.field_0135); foundMeasurement = true; }
                    if (m.field_0162 != null && m.field_0162 > 0) batteryMv = parseInt(m.field_0162, 10);
                }
            }
        } catch (dbErr) {
            console.warn(`[Emulated] Warning querying device_measurements for ${serialNo}: ${dbErr.message}`);
        }

        // 2. Check cached in-memory MQTT commands state (user HA slider overrides)
        if (mqttCommands && mqttCommands.getEmulatedState) {
            const cached = mqttCommands.getEmulatedState(serialNo);
            if (cached) {
                if (!foundMeasurement) {
                    if (cached.temp_celsius !== undefined) tempC = cached.temp_celsius;
                    if (cached.humidity_percent !== undefined) humidity = cached.humidity_percent;
                    if (cached.battery_mv !== undefined) batteryMv = cached.battery_mv;
                }
            }
        }

        let zoneId = null;
        let peers = [];
        const dbDev = await dbDevices.getDeviceByFullSerial(serialNo) || await dbDevices.getDeviceBySerial(serialNo);
        if (dbDev && dbDev.zone_id) {
            zoneId = parseInt(dbDev.zone_id, 10);
            try {
                if (db && db.getPool) {
                    const [peerRows] = await db.getPool().execute(
                        "SELECT serial_no, ipv6_address FROM devices WHERE home_id = ? AND zone_id = ? AND serial_no != ? AND (device_type LIKE 'VA%' OR device_type LIKE 'RU%' OR device_type LIKE 'WR%')",
                        [dbDev.home_id, dbDev.zone_id, serialNo]
                    );
                    if (peerRows && peerRows.length > 0) {
                        for (const row of peerRows) {
                            if (row.ipv6_address) {
                                let ip = row.ipv6_address;
                                if (!ip.startsWith('coap://')) ip = `coap://[${ip}]/z/p`;
                                peers.push(ip);
                            }
                        }
                    }
                }
            } catch (pErr) {
                console.warn(`[Emulated] Error querying peers for ${serialNo}: ${pErr.message}`);
            }
        }

        res.json({
            success: true,
            serial: serialNo,
            temp_celsius: tempC,
            humidity_percent: humidity,
            battery_mv: batteryMv,
            zone_id: zoneId,
            peers: peers
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
