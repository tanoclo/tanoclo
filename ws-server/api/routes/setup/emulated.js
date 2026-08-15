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
        const bodyData = JSON.stringify(commandPayload);
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const signature = apiKey ? computeHmacSignature(apiKey, timestamp, bodyData) : '';

        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyData),
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

        req.write(bodyData);
        req.end();
    });
}

// ---------------------------------------------------------------------------
// ESP32 Hardware Node Management
// ---------------------------------------------------------------------------

router.get('/nodes', async (req, res) => {
    try {
        const nodes = await dbDevices.getAllEsp32Nodes();
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
        const node = await dbDevices.createEsp32Node({ name, ip_address, api_port, api_key: nodeApiKey });
        res.json({ success: true, node });
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

        // 1. Create DB records in devices & emulated_devices tables
        const emulatedDevice = await dbDevices.createEmulatedDevice({
            serial_no: targetSerial,
            esp32_node_id,
            device_type: 'RU02',
            mode: 'WIRELESS_SENSOR',
            home_id: parseInt(home_id, 10),
            zone_id: zone_id ? parseInt(zone_id, 10) : null,
            ipv6_address: ipv6,
            pairing_state: 'PAIRING_IB'
        });

        // 2. Enable pairing mode on the Internet Bridge (IB) connected to this home
        let ibPairingStarted = false;
        try {
            const bridge = commandApi.findBridgeForHome(parseInt(home_id, 10));
            if (bridge && bridge.bridgeId) {
                await commandApi.pushDevicePair(bridge.bridgeId, true, bridge.bridgeId, 300);
                ibPairingStarted = true;
            }
        } catch (ibErr) {
            console.warn(`[Emulated] Warning enabling IB pairing mode: ${ibErr.message}`);
        }

        // 3. Trigger JSON pair command on ESP32 node with HMAC authentication
        let espRes = null;
        try {
            espRes = await sendEsp32Command(espNode.ip_address, espNode.api_port, espNode.api_key, {
                cmd: 'pair',
                serial: targetSerial,
                ipv6: ipv6,
                home_id: parseInt(home_id, 10),
                zone_id: zone_id ? parseInt(zone_id, 10) : 0
            });
            await dbDevices.updateEmulatedDevicePairingState(targetSerial, 'PAIRING_RF');
        } catch (espErr) {
            console.error(`[Emulated] Error sending pair command to ESP32: ${espErr.message}`);
        }

        res.json({
            success: true,
            device: emulatedDevice,
            ibPairingStarted,
            esp32Response: espRes
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.delete('/devices/:serialNo', async (req, res) => {
    try {
        const serialNo = req.params.serialNo;
        const dbDev = await dbDevices.getDeviceByFullSerial(serialNo) || await dbDevices.getDeviceBySerial(serialNo);
        
        let unassociateTriggered = false;
        if (dbDev && dbDev.home_id) {
            try {
                await commandApi.pushDeviceUnassociation(dbDev.home_id, serialNo);
                unassociateTriggered = true;
            } catch (unassocErr) {
                console.warn(`[Emulated] Warning sending unassociation to IB: ${unassocErr.message}`);
            }
        }

        // Notify assigned ESP32 hardware node to erase device from NVRAM
        let espRemoved = false;
        try {
            const emulatedList = await dbDevices.getAllEmulatedDevices();
            const emDev = emulatedList.find(d => d.serial_no === serialNo);
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

module.exports = router;
