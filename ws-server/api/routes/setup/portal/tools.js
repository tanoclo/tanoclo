/**
 * @file api/routes/setup/portal/tools.js
 * @brief Admin setup portal diagnostic tool helper routes.
 * 
 * Implements endpoints to decode raw hex payload strings (parsing inner WS bridge frame wrappers,
 * identifying CoAP message headers, and extracting nested dynamic TLV fields).
 */

const express = require('express');
const db = require('../../../../lib/db');
const { getLogger } = require('../../../../lib/logger');
const wsBridge = require('../../../../lib/ws-bridge');
const coap = require('../../../../lib/coap');
const tlv = require('../../../../lib/tlv');
const adminAuth = require('../../../middleware/admin-auth');

const router = express.Router();
const _log = getLogger('setup-api');

// --- Routes ---
router.post('/decode', adminAuth, async (req, res) => {
    const { hex } = req.body;
    if (!hex) return res.status(400).json({ error: 'hex is required' });

    try {
        const cleanHex = hex.replace(/[^0-9a-fA-F]/g, '');
        const data = Buffer.from(cleanHex, 'hex');

        const result = {
            ok: true,
            rawLen: data.length,
            bridge: null,
            coap: null,
            tlv: null
        };

        let coapBytes = data;

        // 1. Try WS Bridge
        if (data.length >= 28 && data[2] === 0x10) {
            const frame = wsBridge.parse(data);
            if (frame.ok) {
                result.bridge = {
                    direction: frame.direction,
                    ipv6: frame.ipv6,
                    udpPort: frame.udpPort,
                    fields: {
                        fieldA: frame.fieldA,
                        fieldB: frame.fieldB,
                        fieldC: frame.fieldC
                    }
                };
                coapBytes = frame.coapBytes;

                const deviceId = await db.getDeviceByIPv6(frame.ipv6);
                if (deviceId) {
                    const pool = db.getPool();
                    const [devs] = await pool.execute('SELECT * FROM devices WHERE serial_no = ?', [deviceId]);
                    if (devs[0]) {
                        result.bridge.device = {
                            serialNo: devs[0].serial_no,
                            shortSerialNo: devs[0].serial_no,
                            type: devs[0].device_type
                        };
                    }
                }
            }
        }

        // 2. Try CoAP
        const coapMsg = coap.parse(coapBytes);
        if (coapMsg.ok) {
            result.coap = {
                method: coap.codeStr(coapMsg.code),
                mid: coapMsg.mid,
                token: coapMsg.token ? coapMsg.token.toString('hex') : '',
                path: coap.uriPath(coapMsg),
                options: coapMsg.options.map(o => ({
                    num: o.num,
                    name: Object.keys(coap).find(k => coap[k] === o.num && k.startsWith('OPT_')) || `Option ${o.num}`,
                    value: (o.num === coap.OPT_URI_PATH || o.num === coap.OPT_URI_QUERY)
                        ? (o.value ? o.value.toString('utf-8') : '')
                        : (o.value ? o.value.toString('hex') : '')
                })),
                payloadLen: coapMsg.payload ? coapMsg.payload.length : 0
            };

            // 3. Try TLV
            if (coapMsg.payload.length >= 3) {
                const pool = db.getPool();
                const [labelRows] = await pool.execute('SELECT * FROM tlv_labels');
                const labels = {};
                for (const row of labelRows) {
                    const key = (row.hex_id || '').toLowerCase();
                    if (key.startsWith('0x')) {
                        let scale = null;
                        if (row.json_data) {
                            try {
                                const meta = JSON.parse(row.json_data);
                                if (meta.scale !== undefined) scale = meta.scale;
                            } catch (e) { }
                        }

                        labels[key] = {
                            name: row.name,
                            type: row.type,
                            unit: row.unit,
                            scale: scale
                        };
                    }
                }
                tlv.init(labels);
                const decodedTlv = tlv.decode(coapMsg.payload);
                if (decodedTlv.ok) {
                    result.tlv = {
                        items: decodedTlv.items.map(item => ({
                            fid: item.fid,
                            name: item.name,
                            value: item.value,
                            type: item.type,
                            unit: item.unit,
                            raw: item.rawHex
                        }))
                    };
                }
            }
        } else {
            return res.status(400).json({ error: `CoAP parse error: ${coapMsg.err}` });
        }

        res.json(result);
    } catch (err) {
        _log('error', `Decode failed: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.get('/cache', adminAuth, async (req, res) => {
    const downlinkCache = req.app.get('downlinkCache');
    if (!downlinkCache) return res.json({});
    const data = await downlinkCache.getCache();
    // Flatten for easy display
    const flat = {};
    for (const [deviceId, paths] of Object.entries(data)) {
        flat[deviceId] = {};
        for (const [pathKey, sources] of Object.entries(paths)) {
            flat[deviceId][pathKey] = {};
            for (const [source, entries] of Object.entries(sources)) {
                if (Array.isArray(entries) && entries.length > 0) {
                    const last = entries[entries.length - 1];
                    flat[deviceId][pathKey][source] = {
                        hex: last.hex,
                        timestamp: last.timestamp,
                        request: last.request ? { hex: last.request.hex, timestamp: last.request.decoded?.timestamp } : null,
                    };
                }
            }
        }
    }
    res.json(flat);
});

module.exports = router;