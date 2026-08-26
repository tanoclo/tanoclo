/**
 * @file lib/command-api.js
 * @brief Broadcaster helper to send TLV commands to connected bridges.
 */

'use strict';

const http = require('http');
const crypto = require('crypto');
const coap = require('./coap');
const wsBridge = require('./ws-bridge');
const tlv = require('./tlv');
const defaultDb = require('./db');
const metrics = require('./metrics');
const { getLogger } = require('./logger');
const { ZS_SCHEMA } = require('./zone-state-schema');
const config = require('./config');
const commandLog = require('./command-log');

const coapTransport = require('./coap-transport');

let _db = defaultDb;
let _server = null;
let _clients = null;
let _sendFn = null;
let _broadcastTime = null;
let _log = getLogger('cmd-api');

const _commandTracker = coapTransport._commandTracker;

const SERVER_BLOCK1_SIZE = 128;

const getNextMid = coapTransport.getNextMid;
const isTaNoCloOriginatedMid = coapTransport.isTaNoCloOriginatedMid;

const findBridgeForHome = coapTransport.findBridgeForHome;
const sendViaBridge = coapTransport.sendViaBridge;
const scheduleRetry = coapTransport.scheduleRetry;
const handleAckReceived = coapTransport.handleAckReceived;
const clearPendingRetries = coapTransport.clearPendingRetries;
const waitForAck = coapTransport.waitForAck;
const _singleQueryAttempt = coapTransport._singleQueryAttempt;
const queryDeviceConfig = coapTransport.queryDeviceConfig;

async function internalPush(deviceId, clientInfo, code, path, payload = Buffer.alloc(0), etag = null, customOptions = []) {
    const mid = getNextMid();
    const token = Buffer.from([(Math.random() * 256) | 0, (Math.random() * 256) | 0]);

    const extraOptions = [];
    if (clientInfo.session2048) {
        extraOptions.push({ num: coap.OPT_VENDOR_2048, value: clientInfo.session2048 });
    }
    if (etag) {
        extraOptions.push({ num: coap.OPT_ETAG, value: Buffer.from(etag, 'hex') });
    }
    if (customOptions && customOptions.length > 0) {
        extraOptions.push(...customOptions);
    }

    const coapBytes = coap.buildRequest({
        code, path, token, mid, type: coap.TYPE_CON, payload, extraOptions
    });

    const wsFrame = wsBridge.build({
        direction: 'server_to_client',
        ipv6: clientInfo.ipv6,
        udpPort: clientInfo.udpPort || clientInfo.port || 0,
        coapBytes,
        fieldA: clientInfo.fieldA || 0,
        fieldB: clientInfo.fieldB || 0,
        fieldC: clientInfo.fieldC || 0,
    });

    _log('debug', `[cmd-api] CoAP TX hex: ${coapBytes.toString('hex')}`);
    _log('debug', `[cmd-api] Raw TX hex: ${wsFrame.toString('hex')}`);

    const cache = coapTransport.getProxyMidCache();
    if (path && cache) {
        cache.set(mid, { path, ts: Date.now() });
    }

    _sendFn(deviceId, wsFrame);
    return mid;
}

async function sendCoAPPush(res, deviceId, clientInfo, code, path, payload = Buffer.alloc(0), etag = null, customOptions = []) {
    try {
        const mid = await internalPush(deviceId, clientInfo, code, path, payload, etag, customOptions);
        jsonResponse(res, 200, { ok: true, mid });
    } catch (err) {
        jsonResponse(res, 500, { error: `Push failed: ${err.message}` });
    }
}

async function internalPushViabridge(deviceId, code, path, payload = Buffer.alloc(0), etag = null, customOptions = [], skipVendor = true, type = coap.TYPE_CON, token = null, commandLabel = null) {
    if (_db.isOffline()) {
        throw new Error('Database is offline, cannot resolve device');
    }
    let dbDev = await _db.getDeviceByFullSerial(deviceId);
    if (!dbDev) dbDev = await _db.getDeviceBySerial(deviceId);
    if (!dbDev) throw new Error(`Device ${deviceId} not found in DB`);

    const bridge = findBridgeForHome(dbDev.home_id);
    if (!bridge) throw new Error(`No bridge connected for home ${dbDev.home_id}`);

    const mid = getNextMid();

    let pushToken = token;
    if (!pushToken) {
        const tokenLen = Math.floor(Math.random() * 8) + 1;
        pushToken = crypto.randomBytes(tokenLen);
    }

    const extraOptions = [];
    if (!skipVendor && bridge.bridgeClient.session2048) {
        extraOptions.push({ num: coap.OPT_VENDOR_2048, value: bridge.bridgeClient.session2048 });
    }
    if (etag) {
        extraOptions.push({ num: coap.OPT_ETAG, value: Buffer.from(etag, 'hex') });
    }
    if (customOptions && customOptions.length > 0) {
        extraOptions.push(...customOptions);
    }

    const coapBytes = coap.buildRequest({
        code, path, token: pushToken, mid, type, payload, extraOptions
    });

    sendViaBridge(bridge.bridgeId, bridge.bridgeClient, dbDev.ipv6_address, dbDev.udp_port || 5683, coapBytes, commandLabel || `push:${path}`);
    return mid;
}

async function sendCoAPBridgePush(res, bridge, targetDev, code, path, payload = Buffer.alloc(0), etag = null, customOptions = []) {
    try {
        const mid = getNextMid();
        const token = crypto.randomBytes(8);

        const extraOptions = [];
        const sessionToken = targetDev.field_025e || bridge.bridgeClient.session2048;
        if (sessionToken) {
            extraOptions.push({ num: coap.OPT_VENDOR_2048, value: sessionToken });
        }
        if (etag) {
            extraOptions.push({ num: coap.OPT_ETAG, value: Buffer.from(etag, 'hex') });
        }
        if (customOptions && customOptions.length > 0) {
            extraOptions.push(...customOptions);
        }

        const coapBytes = coap.buildRequest({
            code, path, token, mid, type: coap.TYPE_CON, payload, extraOptions
        });

        sendViaBridge(bridge.bridgeId, bridge.bridgeClient, targetDev.ipv6_address, targetDev.udp_port || 5683, coapBytes);
        jsonResponse(res, 200, { ok: true, mid });
    } catch (err) {
        jsonResponse(res, 500, { error: `Push failed: ${err.message}` });
    }
}

function findBestDeviceIdForPing(homeId) {
    homeId = String(homeId);
    for (const [deviceId, info] of _clients.entries()) {
        if (info.homeId && String(info.homeId) === homeId) {
            return deviceId;
        }
    }
    return null;
}

function jsonResponse(res, code, data) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function stop() {
    clearPendingRetries();
    if (_server) {
        _server.close();
        _server = null;
    }
}

async function checkZoneConfigReadonly(homeId) {
    const [homeRows] = await _db.getPool().execute('SELECT zone_config_readonly, dev_bypass FROM homes WHERE id = ?', [homeId]);
    if (homeRows.length === 0) return { isReadOnly: false, devBypass: false };
    const homeReadonly = homeRows[0].zone_config_readonly;
    const devBypass = Boolean(homeRows[0].dev_bypass);
    const isReadOnly = homeReadonly !== null && homeReadonly !== undefined ? !!homeReadonly : config.zoneConfigReadonly;
    return { isReadOnly, devBypass };
}

function sortConfigFields(fields) {
    const { CONFIG_FIDS_ORDER } = require('./db-utils');

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

function sortZoneStateFields(fields) {
    const ZONE_STATE_FIDS_ORDER = [
        0x6160, 0x6180, 0x6020, 0x61e0, 0x6200, 0x6240, 0x6260, 0x6280, 0x62e0, 0x6440
    ];

    const getFid = (key) => {
        if (key.startsWith('0x')) {
            return parseInt(key, 16);
        }
        return null;
    };

    const keysWithFids = Object.keys(fields).map(key => ({
        key,
        fid: getFid(key)
    }));

    keysWithFids.sort((a, b) => {
        const idxA = a.fid !== null ? ZONE_STATE_FIDS_ORDER.indexOf(a.fid) : -1;
        const idxB = b.fid !== null ? ZONE_STATE_FIDS_ORDER.indexOf(b.fid) : -1;

        if (idxA !== -1 && idxB !== -1) {
            return idxA - idxB;
        }
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;

        if (a.fid !== null && b.fid !== null) {
            return a.fid - b.fid;
        }
        return a.key.localeCompare(b.key);
    });

    const sorted = {};
    for (const item of keysWithFids) {
        sorted[item.key] = fields[item.key];
    }
    return sorted;
}

function getCommandStatus(trackingId) {
    return _commandTracker.get(trackingId) || null;
}

function getCommandHistory(limit = 50) {
    const entries = [..._commandTracker.entries()]
        .map(([id, entry]) => ({ trackingId: id, ...entry }))
        .reverse()
        .slice(0, limit);
    return entries;
}

function handleMetrics(req, res) {
    jsonResponse(res, 200, metrics.getAll());
}

function initialize(opts) {
    _clients = opts.clients;
    _sendFn = opts.sendToDevice;
    _broadcastTime = opts.broadcastTime;
    if (opts.log) _log = opts.log;
    _db = opts.db || defaultDb;

    module.exports._clients = _clients;
    module.exports._sendFn = _sendFn;
    module.exports._broadcastTime = _broadcastTime;
    module.exports._log = _log;
    module.exports._db = _db;

    coapTransport.init({
        db: _db,
        clients: _clients,
        sendFn: _sendFn,
        log: _log,
        proxyMidCache: opts.proxyMidCache
    });
}

function start(port = 19881) {
    if (_server) return;
    _server = http.createServer(async (req, res) => {
        try {
            const urlObj = new URL(req.url, 'http://localhost');
            const pathname = urlObj.pathname;

            let bodyStr = '';
            await new Promise((resolve) => {
                req.on('data', (c) => bodyStr += c.toString());
                req.on('end', resolve);
            });

            if (bodyStr) {
                try {
                    req.body = JSON.parse(bodyStr);
                } catch (_e) {
                    req.body = bodyStr;
                }
            }

            if (pathname === '/api/clients' && req.method === 'GET') {
                return handleGetClients(req, res);
            }
            if (pathname === '/api/send' && req.method === 'POST') {
                return handleSend(req, res);
            }
            if (pathname === '/api/send-raw' && req.method === 'POST') {
                return handleSendRaw(req, res);
            }
            if (pathname === '/api/time/broadcast' && req.method === 'POST') {
                if (typeof _broadcastTime === 'function') {
                    _broadcastTime();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'ok', msg: 'Time broadcast triggered' }));
                } else {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'error', error: 'broadcastTime not injected' }));
                }
                return;
            }
            if (pathname.match(/^\/api\/devices\/[^\/]+\/config$/) && req.method === 'POST') {
                const deviceId = pathname.split('/')[3];
                return module.exports.handleDeviceConfigPush(req, res, deviceId);
            }
            if (pathname.match(/^\/api\/devices\/[^\/]+\/lock$/) && req.method === 'POST') {
                const deviceId = pathname.split('/')[3];
                return module.exports.handleDeviceLock(req, res, deviceId);
            }
            if (pathname.match(/^\/api\/devices\/[^\/]+\/identify$/) && req.method === 'POST') {
                const deviceId = pathname.split('/')[3];
                return module.exports.handleDeviceIdentify(req, res, deviceId);
            }
            if (pathname.match(/^\/api\/devices\/[^\/]+\/pair$/) && req.method === 'POST') {
                const deviceId = pathname.split('/')[3];
                return module.exports.handleDevicePair(req, res, deviceId);
            }
            if (pathname.match(/^\/api\/homes\/[^\/]+\/c\/[^\/]+\/config$/) && req.method === 'POST') {
                const parts = pathname.split('/');
                const homeId = parts[3];
                const circuitId = parts[5];
                return handleCircuitConfig(req, res, homeId, circuitId);
            }
            if (pathname.match(/^\/api\/homes\/[^\/]+\/z\/[^\/]+\/config$/) && req.method === 'POST') {
                const parts = pathname.split('/');
                const homeId = parts[3];
                const zoneId = parts[5];
                return handleZoneConfig(req, res, homeId, zoneId);
            }
            if (pathname.match(/^\/api\/homes\/[^\/]+\/z\/[^\/]+\/overlay$/)) {
                const parts = pathname.split('/');
                const homeId = parts[3];
                const zoneId = parts[5];
                if (req.method === 'POST') {
                    return module.exports.handleZoneOverlay(req, res, homeId, zoneId);
                }
                if (req.method === 'DELETE') {
                    return module.exports.handleZoneOverlayDelete(req, res, homeId, zoneId);
                }
            }

            if (pathname.match(/^\/api\/devices\/[^\/]+\/rfkey\/refresh$/) && req.method === 'POST') {
                const deviceId = pathname.split('/')[3];
                return module.exports.handleRfKeyRefresh(req, res, deviceId);
            }
            if (pathname.match(/^\/api\/devices\/[^\/]+\/config\/refresh$/) && req.method === 'POST') {
                const deviceId = pathname.split('/')[3];
                return module.exports.handleGlobalConfigRefresh(req, res, deviceId);
            }
            if (pathname.match(/^\/api\/devices\/[^\/]+\/reboot$/) && req.method === 'POST') {
                const deviceId = pathname.split('/')[3];
                return module.exports.handleDeviceReboot(req, res, deviceId);
            }
            if (pathname === '/api/health' && req.method === 'GET') {
                return jsonResponse(res, 200, { status: 'ok', clients: _clients.size });
            }

            jsonResponse(res, 404, { error: 'Not found' });
        } catch (err) {
            _log('error', '[cmd-api] Error:', err.message, err.stack);
            jsonResponse(res, 500, { error: err.message });
        }
    });

    _server.listen(port, () => {
        _log('info', `[cmd-api] HTTP Command API listening on port ${port}`);
    });
}

function handleGetClients(req, res) {
    const list = [];
    for (const [deviceId, info] of _clients.entries()) {
        list.push({
            deviceId,
            ipv6: info.ipv6,
            port: info.port,
            connectedAt: info.connectedAt,
            homeId: info.homeId || null,
            lastMessageAt: info.lastMessageAt || null,
        });
    }
    jsonResponse(res, 200, { clients: list });
}

async function handleSend(req, res) {
    const body = req.body;
    if (!body || typeof body !== 'object') return jsonResponse(res, 400, { error: 'Invalid JSON body' });

    _log('debug', `[cmd-api] /api/send body: ${JSON.stringify(body)}`);
    const { deviceId, code, path, tlvPayload, payloadHex, etag } = body;

    if (!deviceId) return jsonResponse(res, 400, { error: 'deviceId is required' });
    if (!path) return jsonResponse(res, 400, { error: 'path is required' });

    let dbDev = await _db.getDeviceByFullSerial(deviceId);
    if (!dbDev) dbDev = await _db.getDeviceBySerial(deviceId);
    if (!dbDev) {
        _log('warn', `[cmd-api] Device ${deviceId} not found in DB. Total clients: ${_clients.size}`);
        return jsonResponse(res, 404, { error: `Device ${deviceId} not found in DB` });
    }

    const bridge = findBridgeForHome(dbDev.home_id);
    if (!bridge) {
        return jsonResponse(res, 503, { error: `No bridge connected for home ${dbDev.home_id}` });
    }

    let payload = Buffer.alloc(0);
    if (tlvPayload && Array.isArray(tlvPayload)) {
        const entries = tlvPayload.map(f => ({
            fid: f.fid,
            value: tlv.encodeValue(f.value, f.type || 'bytes'),
        }));
        payload = tlv.encode(entries);
    } else if (payloadHex) {
        payload = Buffer.from(payloadHex, 'hex');
    }

    const mid = getNextMid();
    const token = crypto.randomBytes(2);

    const extraOptions = [];
    if (bridge.bridgeClient.session2048) {
        extraOptions.push({ num: coap.OPT_VENDOR_2048, value: bridge.bridgeClient.session2048 });
    }
    if (etag) {
        extraOptions.push({ num: coap.OPT_ETAG, value: Buffer.from(etag, 'hex') });
    }

    const coapBytes = coap.buildRequest({
        code: code || coap.CODE_PUT,
        path,
        token,
        mid,
        type: coap.TYPE_CON,
        payload,
        extraOptions,
    });

    try {
        sendViaBridge(bridge.bridgeId, bridge.bridgeClient, dbDev.ipv6_address, dbDev.udp_port || 0, coapBytes);
        jsonResponse(res, 200, {
            ok: true,
            mid,
            coapHex: coapBytes.toString('hex'),
        });
    } catch (err) {
        jsonResponse(res, 500, { error: `Failed to send: ${err.message}` });
    }
}

async function handleSendRaw(req, res) {
    const body = req.body;
    if (!body || typeof body !== 'object') return jsonResponse(res, 400, { error: 'Invalid JSON body' });

    const { deviceId, wsHex } = body;
    if (!deviceId || !wsHex) {
        return jsonResponse(res, 400, { error: 'deviceId and wsHex are required' });
    }

    const clientInfo = _clients.get(deviceId);
    if (!clientInfo) {
        return jsonResponse(res, 404, { error: `Device ${deviceId} not connected` });
    }

    try {
        const rawBuf = Buffer.from(wsHex, 'hex');
        _sendFn(deviceId, rawBuf);
        jsonResponse(res, 200, { ok: true });
    } catch (err) {
        jsonResponse(res, 500, { error: `Failed to send: ${err.message}` });
    }
}

async function handleCircuitConfig(req, res, homeId, circuitId) {
    const body = (req.body || {});
    if (!body || body.max_temp === undefined) return jsonResponse(res, 400, { error: 'max_temp is required' });

    try {
        const [rows] = await _db.getPool().execute('SELECT last_config_json FROM heating_circuits WHERE home_id=? AND number=?', [homeId, circuitId]);
        let currentConfig = rows.length > 0 ? JSON.parse(rows[0].last_config_json || '{}') : {};

        module.exports.updateFieldInMap(currentConfig, 'circuit_dhw_max_flow_temperature', body.max_temp);

        const payload = tlv.encodeFromFields(currentConfig);
        const etag = _db.generateEtag(payload).toString('hex');

        await _db.getPool().execute(
            'UPDATE heating_circuits SET last_config_json=?, config_etag=? WHERE home_id=? AND number=?',
            [JSON.stringify(currentConfig), Buffer.from(etag, 'hex'), homeId, circuitId]
        );

        _log('info', `[cmd-api] Circuit config updated for H:${homeId} C:${circuitId}, new ETag=${etag}. Devices will pick up on next poll.`);
        jsonResponse(res, 200, { ok: true, etag });
    } catch (err) {
        _log('error', `[cmd-api] handleCircuitConfig failed for circuit ${circuitId}: ${err.message}`);
        jsonResponse(res, 500, { error: err.message });
    }
}

async function handleZoneConfig(req, res, homeId, zoneId) {
    const { isReadOnly, devBypass } = await checkZoneConfigReadonly(homeId);
    if (isReadOnly && !devBypass) {
        return jsonResponse(res, 403, {
            error: 'Zone config modifications are disabled.',
            hint: 'Set zone_config_readonly per-home or TANOCLO_ZONE_CONFIG_READONLY=false globally.'
        });
    }

    const body = (req.body || {});
    if (!body || !body.changes) return jsonResponse(res, 400, { error: 'changes required' });

    try {
        const [rows] = await _db.getPool().execute('SELECT last_config_json FROM zones WHERE id=? AND home_id=?', [zoneId, homeId]);
        let currentConfig = rows.length > 0 ? JSON.parse(rows[0].last_config_json || '{}') : {};

        const updatedConfig = { ...currentConfig };
        for (const [k, v] of Object.entries(body.changes)) {
            module.exports.updateFieldInMap(updatedConfig, k, v);
        }
        const payload = tlv.encodeFromFields(updatedConfig);
        const etag = _db.generateEtag(payload).toString('hex');

        await _db.getPool().execute(
            'UPDATE zones SET last_config_json=?, config_etag=? WHERE id=? AND home_id=?',
            [JSON.stringify(updatedConfig), Buffer.from(etag, 'hex'), zoneId, homeId]
        );

        _log('info', `[cmd-api] Zone config updated for zone ${zoneId}, new ETag=${etag}. Devices will pick up on next poll.`);
        jsonResponse(res, 200, { ok: true, etag });
    } catch (err) {
        _log('error', `[cmd-api] handleZoneConfig failed for zone ${zoneId}: ${err.message}`);
        jsonResponse(res, 500, { error: err.message });
    }
}

async function pushBoilerMaxFlowTemp(homeId, temp) {
    _log('info', `[cmd-api] Updating Boiler Max Flow Temp in DB: temp=${temp} for H:${homeId}`);

    await _db.upsertHeatingSystem(homeId, { hvac_diagnostic_015d: temp });

    const pool = _db.getPool();
    const [existingRows] = await pool.execute('SELECT * FROM flow_temperature_settings WHERE home_id = ?', [homeId]);
    const existing = existingRows.length > 0 ? existingRows[0] : null;

    let minTemp = 30, maxLimit = 80, autoAdapt = 0;
    if (existing) {
        minTemp = parseInt(existing.min_flow_temperature, 10);
        maxLimit = parseInt(existing.max_flow_temperature_limit, 10);
        autoAdapt = parseInt(existing.auto_adaptation_enabled, 10);
    }

    await pool.execute(
        'REPLACE INTO flow_temperature_settings (home_id, max_flow_temperature, min_flow_temperature, max_flow_temperature_limit, auto_adaptation_enabled) VALUES (?, ?, ?, ?, ?)',
        [homeId, temp, minTemp, maxLimit, autoAdapt]
    );

    return null;
}

function getRouter(opts) {
    const express = require('express');
    const router = express.Router({ mergeParams: true });

    initialize(opts);

    const wrap = (fnName) => (req, res, next) => {
        if (typeof module.exports[fnName] !== 'function') {
            throw new Error(`Handler ${fnName} is not a function`);
        }
        return module.exports[fnName](req, res, next);
    };

    router.get('/clients', wrap('handleGetClients'));
    router.post('/send', wrap('handleSend'));
    router.post('/send-raw', wrap('handleSendRaw'));
    router.post('/time/broadcast', (req, res) => {
        if (_broadcastTime) {
            _broadcastTime();
            jsonResponse(res, 200, { ok: true, message: 'Time broadcast triggered' });
        } else {
            jsonResponse(res, 503, { error: 'Broadcast function not available' });
        }
    });
    router.get('/health', (req, res) => jsonResponse(res, 200, { status: 'ok', clients: _clients ? _clients.size : 0 }));

    router.get('/commands', (req, res) => {
        const limit = parseInt(req.query.limit) || 50;
        jsonResponse(res, 200, { commands: getCommandHistory(limit) });
    });
    router.get('/commands/:trackingId', (req, res) => {
        const entry = getCommandStatus(parseInt(req.params.trackingId));
        if (!entry) return jsonResponse(res, 404, { error: 'Tracking ID not found' });
        jsonResponse(res, 200, { trackingId: parseInt(req.params.trackingId), ...entry });
    });

    router.get('/metrics', wrap('handleMetrics'));

    ['/v2/homes/:homeId', '/homes/:homeId', '/v2', ''].forEach(prefix => {
        router.post(`${prefix}/devices/:id/config`, (req, res) => module.exports.handleDeviceConfigPush(req, res, req.params.id));
        router.post(`${prefix}/devices/:id/lock`, (req, res) => module.exports.handleDeviceLock(req, res, req.params.id));
        router.post(`${prefix}/devices/:id/identify`, (req, res) => module.exports.handleDeviceIdentify(req, res, req.params.id));
        router.post(`${prefix}/devices/:id/pair`, (req, res) => module.exports.handleDevicePair(req, res, req.params.id));
        router.post(`${prefix}/devices/:id/rfkey/refresh`, (req, res) => module.exports.handleRfKeyRefresh(req, res, req.params.id));
        router.post(`${prefix}/devices/:id/config/refresh`, (req, res) => module.exports.handleGlobalConfigRefresh(req, res, req.params.id));
        router.post(`${prefix}/devices/:id/reboot`, (req, res) => module.exports.handleDeviceReboot(req, res, req.params.id));
        router.post(`${prefix}/devices/:id/debug`, (req, res) => module.exports.handleDeviceDebug(req, res, req.params.id));


        if (prefix === '') {
            router.put(`${prefix}/devices/:id/childLock`, (req, res) => {
                try {
                    const body = req.body || {};
                    const enabled = body.childLockEnabled !== undefined ? body.childLockEnabled : body.enabled;
                    module.exports.pushDeviceLock(req.params.id, enabled !== false)
                        .then(mid => jsonResponse(res, 200, { ok: true, mid }))
                        .catch(e => jsonResponse(res, 500, { error: e.message }));
                } catch (e) {
                    jsonResponse(res, 500, { error: e.message });
                }
            });

            router.post(`${prefix}/devices/:id/orientation`, (req, res) => {
                try {
                    const body = req.body || {};
                    const isVertical = body.orientation === 'VERTICAL';
                    module.exports.pushDeviceConfig(req.params.id, { va_orientation: isVertical ? 1 : 0 })
                        .then(mid => jsonResponse(res, 200, { ok: true, mid }))
                        .catch(e => jsonResponse(res, 500, { error: e.message }));
                } catch (e) {
                    jsonResponse(res, 500, { error: e.message });
                }
            });

            router.put(`${prefix}/devices/:id/temperatureOffset`, (req, res) => {
                try {
                    const body = req.body || {};
                    module.exports.pushDeviceConfig(req.params.id, { field_0140: body.celsius || 0 })
                        .then(mid => jsonResponse(res, 200, { ok: true, mid }))
                        .catch(e => jsonResponse(res, 500, { error: e.message }));
                } catch (e) {
                    jsonResponse(res, 500, { error: e.message });
                }
            });

            router.put(`${prefix}/homes/:homeId/zones/:zoneId/dazzle`, (req, res) => {
                try {
                    const body = req.body || {};
                    module.exports.pushZoneDazzleMode(req.params.homeId, req.params.zoneId, body.enabled !== false)
                        .then(mid => jsonResponse(res, 200, { ok: true, mid }))
                        .catch(e => jsonResponse(res, 500, { error: e.message }));
                } catch (e) {
                    jsonResponse(res, 500, { error: e.message });
                }
            });

            router.put(`${prefix}/homes/:homeId/flowTemperatureOptimization`, (req, res) => {
                try {
                    const body = req.body || {};
                    pushBoilerMaxFlowTemp(req.params.homeId, body.maxFlowTemperature || 65)
                        .then(mid => jsonResponse(res, 200, { ok: true, mid }))
                        .catch(e => jsonResponse(res, 500, { error: e.message }));
                } catch (e) {
                    jsonResponse(res, 500, { error: e.message });
                }
            });

            router.post(`${prefix}/devices/:id/pairing`, (req, res) => {
                try {
                    module.exports.pushDevicePair(req.params.id, true)
                        .then(mid => jsonResponse(res, 200, { ok: true, mid }))
                        .catch(e => jsonResponse(res, 500, { error: e.message }));
                } catch (e) {
                    jsonResponse(res, 500, { error: e.message });
                }
            });

            router.delete(`${prefix}/devices/:id/pairing`, (req, res) => {
                try {
                    module.exports.pushDevicePair(req.params.id, false)
                        .then(mid => jsonResponse(res, 200, { ok: true, mid }))
                        .catch(e => jsonResponse(res, 500, { error: e.message }));
                } catch (e) {
                    jsonResponse(res, 500, { error: e.message });
                }
            });

            router.put(`${prefix}/devices/:id/fallback`, (req, res) => {
                try {
                    const body = req.body || {};
                    module.exports.pushDeviceFallback(req.params.id, body.temperature || 5.0)
                        .then(mid => jsonResponse(res, 200, { ok: true, mid }))
                        .catch(e => jsonResponse(res, 500, { error: e.message }));
                } catch (e) {
                    jsonResponse(res, 500, { error: e.message });
                }
            });

            router.put(`${prefix}/devices/:id/displaySettings`, (req, res) => {
                try {
                    module.exports.pushDisplaySettings(req.params.id, req.body || {})
                        .then(mid => jsonResponse(res, 200, { ok: true, mid }))
                        .catch(e => jsonResponse(res, 500, { error: e.message }));
                } catch (e) {
                    jsonResponse(res, 500, { error: e.message });
                }
            });

            router.post(`${prefix}/devices/:id/mount`, (req, res) => {
                try {
                    const body = req.body || {};
                    module.exports.pushMountCalibration(req.params.id, body.action || 'start')
                        .then(mid => jsonResponse(res, 200, { ok: true, mid }))
                        .catch(e => jsonResponse(res, 500, { error: e.message }));
                } catch (e) {
                    jsonResponse(res, 500, { error: e.message });
                }
            });

            router.post(`${prefix}/homes/:homeId/zones/:zoneId/openWindow/activate`, (req, res) => {
                try {
                    module.exports.pushOpenWindowActivate(req.params.homeId, req.params.zoneId)
                        .then(mids => jsonResponse(res, 200, { ok: true, mids }))
                        .catch(e => jsonResponse(res, 500, { error: e.message }));
                } catch (e) {
                    jsonResponse(res, 500, { error: e.message });
                }
            });

            router.delete(`${prefix}/homes/:homeId/zones/:zoneId/openWindow`, (req, res) => {
                try {
                    module.exports.pushOpenWindowCancel(req.params.homeId, req.params.zoneId)
                        .then(mids => jsonResponse(res, 200, { ok: true, mids }))
                        .catch(e => jsonResponse(res, 500, { error: e.message }));
                } catch (e) {
                    jsonResponse(res, 500, { error: e.message });
                }
            });

            router.put(`${prefix}/devices/:id/actuatorLimits`, (req, res) => {
                try {
                    const body = req.body || {};
                    module.exports.pushActuatorLimits(req.params.id, body)
                        .then(mid => jsonResponse(res, 200, { ok: true, mid }))
                        .catch(e => jsonResponse(res, 500, { error: e.message }));
                } catch (e) {
                    jsonResponse(res, 500, { error: e.message });
                }
            });

            router.put(`${prefix}/homes/:homeId/zones/:zoneId/fallback`, (req, res) => {
                try {
                    const body = req.body || {};
                    module.exports.pushZoneFallback(req.params.homeId, req.params.zoneId, body.temperature || 5.0)
                        .then(mids => jsonResponse(res, 200, { ok: true, mids }))
                        .catch(e => jsonResponse(res, 500, { error: e.message }));
                } catch (e) {
                    jsonResponse(res, 500, { error: e.message });
                }
            });

            router.put(`${prefix}/homes/:homeId/zones/:zoneId/extui`, (req, res) => {
                try {
                    module.exports.pushZoneExtUI(req.params.homeId, req.params.zoneId, req.body || {})
                        .then(mids => jsonResponse(res, 200, { ok: true, mids }))
                        .catch(e => jsonResponse(res, 500, { error: e.message }));
                } catch (e) {
                    jsonResponse(res, 500, { error: e.message });
                }
            });

            router.post(`${prefix}/devices/:id/selftest`, (req, res) => {
                try {
                    module.exports.pushSelftestTrigger(req.params.id)
                        .then(mid => jsonResponse(res, 200, { ok: true, mid }))
                        .catch(e => jsonResponse(res, 500, { error: e.message }));
                } catch (e) {
                    jsonResponse(res, 500, { error: e.message });
                }
            });
        }
    });

    ['/v2', ''].forEach(prefix => {
        router.post(`${prefix}/homes/:homeId/c/:circuitId/config`, (req, res) => module.exports.handleCircuitConfig(req, res, req.params.homeId, req.params.circuitId));
        router.post(`${prefix}/homes/:homeId/z/:zoneId/config`, (req, res) => module.exports.handleZoneConfig(req, res, req.params.homeId, req.params.zoneId));
        router.post(`${prefix}/homes/:homeId/z/:zoneId/overlay`, (req, res) => module.exports.handleZoneOverlay(req, res, req.params.homeId, req.params.zoneId));
        router.delete(`${prefix}/homes/:homeId/z/:zoneId/overlay`, (req, res) => module.exports.handleZoneOverlayDelete(req, res, req.params.homeId, req.params.zoneId));
    });

    return router;
}

module.exports = {
    initialize, start, stop, getRouter, findBestDeviceIdForPing,
    findBridgeForHome, queryDeviceConfig, waitForAck, ZS_SCHEMA,
    getNextMid, isTaNoCloOriginatedMid, sendViaBridge, internalPushViabridge,
    handleAckReceived, clearPendingRetries, checkZoneConfigReadonly,
    sortConfigFields, sortZoneStateFields, getCommandStatus, getCommandHistory,
    jsonResponse, handleGetClients, handleSend, handleSendRaw, handleCircuitConfig,
    handleZoneConfig, pushBoilerMaxFlowTemp, handleMetrics,
    _clients, _db, _log, _sendFn, _broadcastTime
};

const zone = require('./commands/zone');
const device = require('./commands/device');
const schedule = require('./commands/schedule');

Object.assign(module.exports, zone);
Object.assign(module.exports, device);
Object.assign(module.exports, schedule);
