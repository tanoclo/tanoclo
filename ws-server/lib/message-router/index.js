/**
 * @file lib/message-router/index.js
 */

'use strict';

// ==========================================
// 1. Imports, Configuration and Constants
// ==========================================

const coap = require('../coap');
const wsBridge = require('../ws-bridge');
const db = require('../db');
const workerPool = require('../worker-pool');
const stateSnapshot = require('../state-snapshot');
const commandLog = require('../command-log');
const messageCache = require('../message-cache');
const configCapture = require('../config-capture');
const { reconstructBuffers } = require('../utils');
const WebSocket = require('ws');
const proxyManager = require('../proxy-manager');
const ensureProxyConnection = proxyManager.ensureProxyConnection;
const shouldBlockProxyMessage = proxyManager.shouldBlockProxyMessage;
const logProxyMessage = proxyManager.logProxyMessage;

// ==========================================
// 2. In-Memory Session and Reassembly State
// ==========================================
// In-memory CoAP transfer/address tables
const downlinkBlockSessions = new Map();
const blockReassembly = new Map();
const ipv6ToDevice = new Map();
const MAX_BLOCK_REASSEMBLY = 100;

// Runtime state references initialized from server.js
let log;
let config;
let clients;
let deviceSessions;
let wsToBridgeId;
let proxyConnections;
let proxyMidCache;
let getApiProcess;
let handlers;
let commandApi;
let metrics;
let TADO_ROOT_CA;
let extractShortSerial;

// MID tracking
let serverMid = 0;


const downlink = require('./downlink');
const uplink = require('./uplink');

const captureDownlinkEtags = downlink.captureDownlinkEtags;
const captureDownlinkConfig = downlink.captureDownlinkConfig;
const captureDownlinkZoneState = downlink.captureDownlinkZoneState;
const captureDownlinkSubpaths = downlink.captureDownlinkSubpaths;
const captureUplinkPutRequest = uplink.captureUplinkPutRequest;

let _cleanupBlockSessionsTimer;
let _refreshIpv6ToDeviceTimer;

function nextMid() {
    const mid = 0x7000 + (serverMid % 0x9000);
    serverMid = (serverMid + 1) % 0x9000;
    return mid;
}

function init(opts = {}) {
    log = opts.log;
    config = opts.config;
    clients = opts.clients;
    deviceSessions = opts.deviceSessions;
    wsToBridgeId = opts.wsToBridgeId;
    proxyConnections = opts.proxyConnections;
    proxyMidCache = opts.proxyMidCache;
    getApiProcess = opts.getApiProcess || (() => null);
    handlers = opts.handlers;
    commandApi = opts.commandApi;
    metrics = opts.metrics;
    TADO_ROOT_CA = opts.TADO_ROOT_CA;
    extractShortSerial = opts.extractShortSerial;

    const allOpts = { ...opts, downlinkBlockSessions, blockReassembly, ipv6ToDevice };
    downlink.init(allOpts);
    uplink.init(allOpts);

    proxyManager.init({
        log,
        db,
        clients,
        proxyConnections,
        proxyMidCache,
        TADO_ROOT_CA,
        extractShortSerial,
        config,
        handleMessage: (ws, msg, isBinary, isProxy) => handleMessage(ws, msg, isBinary, isProxy)
    });
}

function stop() {
    if (_cleanupBlockSessionsTimer) {
        clearInterval(_cleanupBlockSessionsTimer);
    }
    if (_refreshIpv6ToDeviceTimer) {
        clearInterval(_refreshIpv6ToDeviceTimer);
    }
}

async function handleMessage(ws, message, isBinary, isDownlink = false) {
    if (!isDownlink) {
        const bridgeId = wsToBridgeId.get(ws);
        if (bridgeId) {
            const client = clients.get(bridgeId);
            if (client) {
                client.lastMessageAt = new Date().toISOString();
                const _api1 = getApiProcess();
                if (_api1 && _api1.connected) {
                    _api1.send({
                        type: 'CLIENT_UPDATE',
                        deviceId: bridgeId,
                        updates: { lastMessageAt: client.lastMessageAt }
                    });
                }
                const now = Date.now();
                if (!client.lastDbUpdate || (now - client.lastDbUpdate) > 60000) {
                    client.lastDbUpdate = now;
                    const shortSerial = extractShortSerial(bridgeId);
                    if (shortSerial) {
                        db.updateDeviceConnectionState(shortSerial, true).catch(err => {
                            log('error', `Failed to refresh bridge status: ${err.message}`);
                        });
                    }
                }
            }
        }
    }
    if (db.isOffline()) return;

    if (!isBinary) {
        log('debug', 'Received non-binary message, ignoring');
        return;
    }

    // CRITICAL: DO NOT change this to Buffer.from(message).
    // The `message` parameter is an ArrayBuffer pointing directly to uWebSockets.js internal memory.
    // uWS reuses this buffer once the synchronous callback returns.
    // We MUST force a deep memory copy using Buffer.from(Buffer.from(message)) (or slicing)
    // so that the buffer remains valid during async operations (e.g. proxying).
    const data = Buffer.from(Buffer.from(message));
    const proxyWs = proxyConnections.get(ws);

    log('debug', `Received message: ${data.byteLength} bytes`);
    if (config.logLevel === 'debug') {
        log('debug', `Raw RX hex: ${data.toString('hex')}`);
    }
    if (data.length < 28) {
        log('warn', `Short message: ${data.length} bytes`);
        return;
    }

    const frame = wsBridge.parse(data);
    if (!frame.ok) {
        log('warn', `WS Bridge parse error: ${frame.err}`);
        return;
    }

    log('debug', `Frame: dir=${frame.direction} ipv6=${frame.ipv6} coapLen=${frame.coapLen}`);

    let coapMsg;
    try {
        coapMsg = await workerPool.coapParse(frame.coapBytes);
    } catch (err) {
        log('warn', `CoAP parse error: ${err.message}`);
        return;
    }

    const isReq = coap.isRequest(coapMsg.code);
    const uriPathStr = coap.uriPath(coapMsg);
    const codeStr = coap.codeStr(coapMsg.code);
    const isAck = (coapMsg.type === coap.TYPE_ACK);
    let queryOptions = coap.optionValues(coapMsg, coap.OPT_URI_QUERY).map(b => Buffer.isBuffer(b) ? b.toString() : String(b));
    const sessionToken = coap.getOptionVendor2048(coapMsg);
    if (sessionToken) {
        log('debug', `[CoAP] Session Token (Opt 2048): ${sessionToken.toString('hex')}`);
    }

    let displayPath = uriPathStr;
    if (!isReq) {
        const storedReq = messageCache.getRequest(frame.ipv6, coapMsg.mid);
        if (storedReq && storedReq.decoded && storedReq.decoded.coap) {
            if (!displayPath) {
                displayPath = storedReq.decoded.coap.path;
            }
            if (queryOptions.length === 0 && storedReq.decoded.coap.options) {
                queryOptions = storedReq.decoded.coap.options
                    .filter(opt => opt.num === coap.OPT_URI_QUERY)
                    .map(opt => opt.uri_query)
                    .filter(Boolean);
            }
        }
        if (!displayPath) {
            const cached = proxyMidCache.get(coapMsg.mid);
            displayPath = (cached && typeof cached === 'object') ? cached.path : (cached || '');
        }
    }
    displayPath = displayPath || '';

    if (isReq) {
        if (!isDownlink) messageCache.storeRequest(frame.ipv6, coapMsg.mid, data);
        if (uriPathStr) proxyMidCache.set(coapMsg.mid, { path: uriPathStr, ts: Date.now() });
    }

    if (proxyWs && !isDownlink) {
        if (coapMsg && commandApi.isTaNoCloOriginatedMid && commandApi.isTaNoCloOriginatedMid(coapMsg.mid)) {
            log('debug', `[PROXY BLOCK UP] Blocking tanoclo-originated response MID=${coapMsg.mid} from proxy forwarding`);
        }
    }

    if (proxyWs && !isDownlink && isReq) {
        let modifiedData = data;
        const isTarget = uriPathStr && (
            uriPathStr.endsWith('config') ||
            uriPathStr.includes('hvac') ||
            uriPathStr.endsWith('z/s') ||
            uriPathStr === 'z/s' ||
            /\/z\/\d+\/s$/.test(uriPathStr) ||
            /^z\/\d+\/s$/.test(uriPathStr)
        );

        if (isTarget) {
            let deviceIdForProxy = ipv6ToDevice.get(frame.ipv6);
            if (!deviceIdForProxy) deviceIdForProxy = await db.getDeviceByIPv6(frame.ipv6);

            let hasPermanentCapture = false;
            if (deviceIdForProxy) {
                hasPermanentCapture = configCapture.hasCapture(deviceIdForProxy, uriPathStr);
            }

            const isEtagPresent = coapMsg.options.some(opt => opt.num === coap.OPT_ETAG);
            if (isEtagPresent) {
                const isZoneOrCircuitConfig = uriPathStr && (
                    /^h\/\d+\/z\/\d+\/config$/.test(uriPathStr) ||
                    /^z\/\d+\/config$/.test(uriPathStr) ||
                    /^h\/\d+\/c\/\d+\/config$/.test(uriPathStr) ||
                    /^c\/\d+\/config$/.test(uriPathStr)
                );
                let shouldStrip = !hasPermanentCapture;
                if (!shouldStrip && isZoneOrCircuitConfig) {
                    let homeId = null;
                    if (deviceIdForProxy) {
                        const shortSerial = extractShortSerial(deviceIdForProxy);
                        homeId = await db.getHomeForDevice(shortSerial);
                    }
                    const hasDbConfig = await db.hasValidConfigForResource(uriPathStr, homeId);
                    shouldStrip = !hasDbConfig;
                }

                if (!shouldStrip && deviceIdForProxy) {
                    const shortSerial = extractShortSerial(deviceIdForProxy);
                    const snapHomeId = await db.getHomeForDevice(shortSerial);
                    if (snapHomeId && stateSnapshot.isCapturing(snapHomeId)) {
                        shouldStrip = true;
                    }
                }

                if (shouldStrip) {
                    log('info', `PROXY: Stripping ETag for ${uriPathStr} to force capture/seed (permanent capture: ${hasPermanentCapture})`);
                    const newOptions = coapMsg.options.filter(opt => opt.num !== coap.OPT_ETAG);
                    const newCoapBytes = coap.serialize({
                        type: coapMsg.type, code: coapMsg.code, mid: coapMsg.mid,
                        token: coapMsg.token, options: newOptions, payload: coapMsg.payload
                     });
                     modifiedData = wsBridge.build({
                         ...frame,
                         coapBytes: newCoapBytes
                     });
                }
            }
        }

        if (await shouldBlockProxyMessage(modifiedData, 'UP')) return;
        if (proxyWs.loggingEnabled) await logProxyMessage('UP', modifiedData);
        if (proxyWs.readyState === WebSocket.OPEN) {
            proxyWs.send(modifiedData);
        } else {
            if (!proxyWs._messageQueue) proxyWs._messageQueue = [];
            proxyWs._messageQueue.push(modifiedData);
        }
    }

    let deviceIdByIPv6 = ipv6ToDevice.get(frame.ipv6);
    if (!deviceIdByIPv6 && !isDownlink) {
        deviceIdByIPv6 = await db.getDeviceByIPv6(frame.ipv6);
        if (deviceIdByIPv6) ipv6ToDevice.set(frame.ipv6, deviceIdByIPv6);
    }

    const pathInfo = await handlers.classifyPath(displayPath, queryOptions, deviceIdByIPv6);
    log('debug', `Path classification: ${JSON.stringify(pathInfo)}`);

    let activeDeviceId = (pathInfo && pathInfo.deviceId) ? pathInfo.deviceId : deviceIdByIPv6;

    if (isDownlink && activeDeviceId) {
        messageCache.cacheMessage(activeDeviceId, data, 'real');
        await captureDownlinkEtags(coapMsg, displayPath, activeDeviceId, pathInfo);

        if ((coapMsg.code === coap.CODE_CONTENT || coap.isRequest(coapMsg.code)) && coapMsg.payload.length > 0) {
            await captureDownlinkConfig(coapMsg, displayPath, activeDeviceId, pathInfo);
            await captureDownlinkZoneState(coapMsg, displayPath, activeDeviceId, pathInfo);
        }
        await captureDownlinkSubpaths(coapMsg, displayPath, activeDeviceId);
    }

    if (proxyWs && !isDownlink && isReq && activeDeviceId) {
        await captureUplinkPutRequest(coapMsg, displayPath, activeDeviceId, pathInfo);
    }

    const session2048 = coap.optionFirst(coapMsg, coap.OPT_VENDOR_2048);
    metrics.inc('uplink_messages');

    if (!isDownlink && session2048 && !wsToBridgeId.has(ws)) {
        try {
            const [rows] = await db.getPool().execute('SELECT serial_no FROM devices WHERE field_025e = ? LIMIT 1', [session2048]);
            if (rows.length > 0) {
                const tokenBridgeId = rows[0].serial_no;
                log('info', `Identified bridge ${tokenBridgeId} from session token Option 2048`);
                if (!clients.has(tokenBridgeId)) {
                    log('debug', `Resurrecting Bridge session for ${tokenBridgeId} from session token...`);
                    const dbDev = await db.getDeviceByFullSerial(tokenBridgeId);
                    const homeId = dbDev ? dbDev.home_id : null;
                    clients.set(tokenBridgeId, {
                        ws,
                        ipv6: frame.ipv6,
                        fieldA: frame.fieldA,
                        fieldB: frame.fieldB,
                        udpPort: frame.udpPort,
                        fieldC: frame.fieldC,
                        session2048: session2048,
                        homeId: homeId,
                        connectedAt: new Date().toISOString(),
                        lastMessageAt: new Date().toISOString(),
                        lastDbUpdate: Date.now()
                    });
                    wsToBridgeId.set(ws, tokenBridgeId);
                    const _api2 = getApiProcess();
                    if (_api2 && _api2.connected) {
                        const infoCopy = { ...clients.get(tokenBridgeId) };
                        delete infoCopy.ws;
                        _api2.send({
                            type: 'CLIENT_CONNECT',
                            deviceId: tokenBridgeId,
                            info: reconstructBuffers(infoCopy)
                        });
                    }
                    const shortSerial = extractShortSerial(tokenBridgeId);
                    if (shortSerial) {
                        db.updateDeviceConnectionState(shortSerial, true).catch(() => {});
                        db.updateDeviceIPv6(tokenBridgeId, frame.ipv6).catch(() => {});
                    }
                } else {
                    wsToBridgeId.set(ws, tokenBridgeId);
                    const shortSerial = extractShortSerial(tokenBridgeId);
                    if (shortSerial) {
                        db.updateDeviceConnectionState(shortSerial, true).catch(() => {});
                        db.updateDeviceIPv6(tokenBridgeId, frame.ipv6).catch(() => {});
                    }
                }
            }
        } catch (err) {
            log('error', `Failed to identify bridge by session token: ${err.message}`);
        }
    }

    if (activeDeviceId && !clients.has(activeDeviceId) && activeDeviceId.startsWith('IB')) {
        log('debug', `Resurrecting Bridge session for ${activeDeviceId} after restart...`);

        let token = session2048;
        let homeId = null;

        const dbDev = await db.getDeviceByFullSerial(activeDeviceId);
        if (dbDev) {
            homeId = dbDev.home_id;
            if (!token && dbDev.field_025e) {
                token = dbDev.field_025e;
                deviceSessions.set(activeDeviceId, token);
            }
        }

        if (!token) {
            token = deviceSessions.get(activeDeviceId);
        }

        clients.set(activeDeviceId, {
            ws,
            ipv6: frame.ipv6,
            fieldA: frame.fieldA,
            fieldB: frame.fieldB,
            udpPort: frame.udpPort,
            fieldC: frame.fieldC,
            session2048: token,
            homeId: homeId,
            connectedAt: new Date().toISOString(),
            lastMessageAt: new Date().toISOString(),
            lastDbUpdate: Date.now()
        });
        wsToBridgeId.set(ws, activeDeviceId);
        const _api2 = getApiProcess();
        if (_api2 && _api2.connected) {
            const infoCopy = { ...clients.get(activeDeviceId) };
            delete infoCopy.ws;
            _api2.send({
                type: 'CLIENT_CONNECT',
                deviceId: activeDeviceId,
                info: reconstructBuffers(infoCopy)
            });
        }
        const shortSerialForResurrection = extractShortSerial(activeDeviceId);
        if (shortSerialForResurrection) {
            db.updateDeviceConnectionState(shortSerialForResurrection, true).catch(err => {
                log('error', `Failed to update resurrected bridge state: ${err.message}`);
            });
        }
    }

    if (activeDeviceId) {
        await ensureProxyConnection(ws, activeDeviceId, data);
    }

    if (session2048 && activeDeviceId && clients.has(activeDeviceId)) {
        const storedSession = clients.get(activeDeviceId).session2048;
        if (storedSession && Buffer.isBuffer(storedSession) && Buffer.isBuffer(session2048)) {
            if (!storedSession.equals(session2048)) {
                log('debug', `[session] Token mismatch for ${activeDeviceId}: expected ${storedSession.toString('hex')}, got ${session2048.toString('hex')}`);
            }
        }
    }

    let decoded = null;
    let timeDecoded = false;
    const isTimePath = displayPath && (displayPath === 'time' || displayPath === 'time (ACK)' || displayPath.includes('/time') || displayPath.startsWith('time'));
    const isRawBinary = displayPath && (
        displayPath.includes('dbg/m') ||
        displayPath.includes('d/dbg/m') ||
        displayPath.includes('dbg/st') ||
        displayPath.includes('d/dbg/st') ||
        displayPath.includes('dbg/valves') ||
        displayPath.includes('dbg/rtc') ||
        displayPath.includes('d/dbg/rtc') ||
        displayPath.includes('dbg/nvm')
    );

    if (coapMsg.payload.length >= 1) {
        if (isTimePath && coapMsg.payload.length === 5 && coapMsg.payload[0] === 0x0D) {
            const decodedTime = coap.decodeTimeProtobuf(coapMsg.payload);
            if (decodedTime.ok) {
                log('debug', `Time fields: ${JSON.stringify({ unix_s: decodedTime.unix_s, utc: decodedTime.utc })}`);
                log('debug', `    └─ Payload (Time): ${decodedTime.unix_s} (${decodedTime.utc})`);
                decoded = { ok: true, isTime: true, unix_s: decodedTime.unix_s, utc: decodedTime.utc };
                timeDecoded = true;
            }
        } else if (isRawBinary) {
            log('debug', `[RAW DEBUG] Path: /${displayPath}, Payload (${coapMsg.payload.length}B): ${coapMsg.payload.slice(0, 32).toString('hex')}${coapMsg.payload.length > 32 ? '...' : ''}`);
            decoded = { ok: true, isBinary: true, length: coapMsg.payload.length, hex: coapMsg.payload.toString('hex') };
        }

        if (!timeDecoded && !isRawBinary && coapMsg.payload.length >= 3) {
            decoded = await workerPool.tlvDecode(coapMsg.payload);
            if (decoded.ok && decoded.fields && Object.keys(decoded.fields).length > 0) {
                log('debug', `TLV fields: ${JSON.stringify(decoded.fields)}`);
                if (decoded.items && decoded.items.length > 0) {
                    const friendly = {};
                    for (const item of decoded.items) {
                        friendly[item.name || item.fid] = item.value;
                    }
                    log('debug', `    └─ Payload (TLV): ${JSON.stringify(friendly)}`);
                }

                if (activeDeviceId) {
                    const val015a = decoded.fields['0x015a'];
                    if (val015a) {
                        const shortSerial = extractShortSerial(activeDeviceId);
                        if (shortSerial) {
                            db.updateDeviceConfig(shortSerial, { '0x015a': val015a }, null).catch(e => {
                                log('error', `Failed to auto-update field_015a for ${shortSerial}: ${e.message}`);
                            });
                            log('info', `[AUTO] Captured 0x015a for ${shortSerial}: ${val015a}`);
                        }
                    }
                }
            } else if (isAck && coapMsg.payload.length > 0) {
                log('debug', `Response payload (${coapMsg.payload.length}B): ${coapMsg.payload.toString('hex')}`);
            }
        }
    }

    const peerInfo = {
        ipv6: frame.ipv6,
        udpPort: frame.udpPort,
        fieldA: frame.fieldA,
        fieldB: frame.fieldB,
        fieldC: frame.fieldC
    };

    if (pathInfo && pathInfo.deviceId) {
        db.updateDeviceIPv6(pathInfo.deviceId, frame.ipv6).catch(err => {
            log('error', `Failed to update IPv6 for ${pathInfo.deviceId}: ${err.message}`);
        });
    }

    if (isAck) {
        const payloadHex = (coapMsg.payload && coapMsg.payload.length > 0) ? ` [Payload ${coapMsg.payload.length}B: ${coapMsg.payload.toString('hex')}]` : '';
        log('debug', `Response from ${isDownlink ? 'server' : 'device'} (${activeDeviceId || 'unknown'}): ${codeStr} /${displayPath}${displayPath !== uriPathStr ? ' (ACK)' : ''}${payloadHex}`);

        if (!isDownlink) {
            if (commandApi.handleAckReceived) {
                commandApi.handleAckReceived(coapMsg.mid, { deviceId: activeDeviceId, coapMsg });
            }
            const _api3 = getApiProcess();
            if (_api3 && _api3.connected) {
                const coapMsgCopy = {
                    type: coapMsg.type,
                    code: coapMsg.code,
                    mid: coapMsg.mid,
                    token: coapMsg.token,
                    options: coapMsg.options,
                    payload: coapMsg.payload
                };
                _api3.send({
                    type: 'ACK_RECEIVED',
                    mid: coapMsg.mid,
                    deviceId: activeDeviceId,
                    coapMsg: coapMsgCopy
                });
            }
        }
        if (isDownlink) {
            metrics.inc('downlink_messages');
        } else {
            metrics.inc('uplink_acks');
        }
        return;
    }

    const block1Opt = coap.optionFirst(coapMsg, coap.OPT_BLOCK1);
    if (block1Opt && !isDownlink) {
        const block1 = coap.decodeBlock(block1Opt);
        if (block1) {
            const reassemblyKey = `${peerInfo.ipv6}:${coapMsg.token.toString('hex')}`;

            if (block1.more === 1) {
                if (!blockReassembly.has(reassemblyKey) && blockReassembly.size >= MAX_BLOCK_REASSEMBLY) {
                    const oldestKey = blockReassembly.keys().next().value;
                    const oldEntry = blockReassembly.get(oldestKey);
                    if (oldEntry && oldEntry.timer) clearTimeout(oldEntry.timer);
                    blockReassembly.delete(oldestKey);
                    log('warn', `Block reassembly map full (${MAX_BLOCK_REASSEMBLY}), evicted: ${oldestKey}`);
                }

                let entry = blockReassembly.get(reassemblyKey);
                if (!entry) {
                    entry = { blocks: [], expectedNext: 0, timer: null };
                    blockReassembly.set(reassemblyKey, entry);
                }

                if (block1.num === entry.expectedNext) {
                    entry.blocks.push(coapMsg.payload);
                    entry.expectedNext = block1.num + 1;
                }

                if (entry.timer) clearTimeout(entry.timer);
                entry.timer = setTimeout(() => {
                    blockReassembly.delete(reassemblyKey);
                    log('debug', `Block1 reassembly timeout for ${reassemblyKey}`);
                }, 30000);

                const ackBytes = coap.buildAckWithOptions(coapMsg, coap.CODE_CONTINUE, [
                    { num: coap.OPT_BLOCK1, value: block1Opt }
                ]);
                handlers.sendWrappedCoAP(ws, ackBytes, peerInfo,
                    frame.directionU16 === wsBridge.DIR_CLIENT_TO_SERVER ? wsBridge.DIR_SERVER_TO_CLIENT : wsBridge.DIR_CLIENT_TO_SERVER);
                log('debug', `Block1: ACK'd block ${block1.num} with 2.31 Continue for ${reassemblyKey}`);
                return;
            }

            const entry = blockReassembly.get(reassemblyKey);
            if (entry) {
                if (entry.timer) clearTimeout(entry.timer);
                entry.blocks.push(coapMsg.payload);
                coapMsg.payload = Buffer.concat(entry.blocks);
                blockReassembly.delete(reassemblyKey);
                log('debug', `Block1: Reassembled ${entry.blocks.length} blocks (${coapMsg.payload.length}B) for ${reassemblyKey}`);

                if (coapMsg.payload.length >= 3) {
                    decoded = await workerPool.tlvDecode(coapMsg.payload);
                    if (decoded.ok) {
                        log('debug', `Block1 TLV fields: ${JSON.stringify(decoded.fields)}`);
                    }
                }
            }
        }
    }

    try {
        if (!isDownlink) {
            if (proxyConnections.has(ws) && activeDeviceId) {
                const devInDb = await db.getDeviceByFullSerial(activeDeviceId) || await db.getDeviceBySerial(activeDeviceId);
                if (!devInDb) {
                    log('debug', `Device ${activeDeviceId} is not in TaNoClo database but connection is proxied. Bypassing local CoAP handling.`);
                    return;
                }
            }

            switch (pathInfo.type) {
                case 'auth_key':
                    await handlers.handleAuthKey(ws, frame, coapMsg, decoded, peerInfo, data);
                    break;
                case 'auth_token':
                    await handlers.handleAuthToken(ws, frame, coapMsg, decoded, peerInfo, data);
                    break;
                case 'device_info':
                    await handlers.handleDeviceInfo(ws, frame, coapMsg, decoded, peerInfo, pathInfo);
                    break;
                case 'device_debug':
                case 'device_dispsettings':
                    handlers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
                    if (decoded && decoded.fields) {
                        const dbgDevId = pathInfo.deviceId || ipv6ToDevice.get(peerInfo.ipv6);
                        log('debug', `${pathInfo.type.toUpperCase()} ${dbgDevId}: ${JSON.stringify(decoded.fields)}`);
                    }
                    break;
                case 'device_sensor':
                    await handlers.handleSensorData(ws, frame, coapMsg, decoded, peerInfo, pathInfo);
                    break;
                case 'device_actuator':
                    await handlers.handleDeviceActuator(ws, frame, coapMsg, decoded, peerInfo, pathInfo);
                    break;
                case 'device_config':
                    await handlers.handleDeviceConfig(ws, frame, coapMsg, decoded, peerInfo, pathInfo);
                    break;
                case 'circuit_actuator':
                    await handlers.handleCircuitActuator(ws, frame, coapMsg, decoded, peerInfo, pathInfo);
                    break;
                case 'zone_state':
                case 'zone_overlay':
                    await handlers.handleZoneState(ws, frame, coapMsg, decoded, peerInfo, pathInfo);
                    break;
                case 'hvac_mon':
                case 'hvac_codes':
                case 'hvac_dhw':
                case 'hvac_maint':
                    if (coapMsg.code === coap.CODE_GET) await handlers.handleHvacGet(ws, frame, coapMsg, peerInfo, pathInfo);
                    else await handlers.handleHvac(ws, frame, coapMsg, decoded, peerInfo, pathInfo);
                    break;
                case 'hvac_config':
                    if (coapMsg.code === coap.CODE_GET) await handlers.handleHvacGet(ws, frame, coapMsg, peerInfo, pathInfo);
                    else await handlers.handleHvacConfig(ws, frame, coapMsg, decoded, peerInfo, pathInfo);
                    break;
                case 'zone_actuator':
                    await handlers.handleZoneActuator(ws, frame, coapMsg, decoded, peerInfo, pathInfo);
                    break;
                case 'zone_extui':
                    await handlers.handleZoneExtui(ws, frame, coapMsg, decoded, peerInfo, pathInfo);
                    break;
                case 'zone_fallback':
                    await handlers.handleZoneFallback(ws, frame, coapMsg, decoded, peerInfo, pathInfo);
                    break;
                case 'device_fallback':
                    await handlers.handleDeviceFallback(ws, frame, coapMsg, decoded, peerInfo, pathInfo);
                    break;
                case 'open_window':
                    await handlers.handleZoneOpenWindow(ws, frame, coapMsg, decoded, peerInfo, pathInfo);
                    break;
                case 'zone_config':
                    await handlers.handleZoneConfig(ws, frame, coapMsg, decoded, peerInfo, pathInfo);
                    break;
                case 'firmware_state':
                    await handlers.handleDeviceFirmware(ws, frame, coapMsg, decoded, peerInfo, pathInfo);
                    break;
                case 'device_error':
                    await handlers.handleDeviceError(ws, frame, coapMsg, decoded, peerInfo, pathInfo);
                    break;
                case 'neighbors':
                    await handlers.handleDeviceNeighbors(ws, frame, coapMsg, decoded, peerInfo, pathInfo);
                    break;
                case 'mount':
                    await handlers.handleDeviceMount(ws, frame, coapMsg, decoded, peerInfo, pathInfo);
                    break;
                case 'lock':
                    await handlers.handleDeviceLock(ws, frame, coapMsg, decoded, peerInfo, pathInfo);
                    break;
                case 'selftest':
                    await handlers.handleDeviceSelftest(ws, frame, coapMsg, decoded, peerInfo, pathInfo);
                    break;
                case 'rfkey':
                    await handlers.handleDeviceRfKey(ws, frame, coapMsg, decoded, peerInfo, pathInfo);
                    break;
                case 'identify':
                    handlers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
                    log('debug', `ACK'd ${pathInfo.type} /${uriPathStr}`);
                    break;
                case 'circuit_config':
                    await handlers.handleCircuitConfig(ws, frame, coapMsg, decoded, peerInfo, pathInfo);
                    break;
                case 'time':
                    await handlers.handleTimeSync(ws, frame, coapMsg, decoded, peerInfo);
                    break;
                case 'pair_found':
                    await handlers.handlePairFound(ws, frame, coapMsg, decoded, peerInfo, coapMsg.payload);
                    break;
                default:
                    handlers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
                    log('warn', `Unknown path: /${uriPathStr}, ACK'd`);
            }
        }
    } catch (err) {
        log('error', `Handler error for /${uriPathStr}:`, err.message, err.stack);
        handlers.sendCoAPAck(ws, coapMsg, peerInfo, frame.directionU16);
    }
}

_cleanupBlockSessionsTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, session] of downlinkBlockSessions.entries()) {
        if (now > session.expiresAt) {
            downlinkBlockSessions.delete(key);
            log('debug', `Cleared expired downlink block session: ${key}`);
        }
    }
}, 30000);

_cleanupBlockSessionsTimer.unref();

_refreshIpv6ToDeviceTimer = setInterval(async () => {
    try {
        const freshDevices = await db.getAllDevices();
        const freshMap = new Map();
        for (const dev of freshDevices) {
            if (dev.ipv6_address && dev.serial_no) {
                try {
                    const normIp = wsBridge.ipv6FromBytes(wsBridge.ipv6ToBytes(dev.ipv6_address));
                    freshMap.set(normIp, dev.serial_no);
                } catch (e) {
                    freshMap.set(dev.ipv6_address, dev.serial_no);
                }
            }
        }
        for (const [deviceId, info] of clients.entries()) {
            if (info.ipv6) {
                freshMap.set(info.ipv6, deviceId);
            }
        }
        ipv6ToDevice.clear();
        for (const [k, v] of freshMap) {
            ipv6ToDevice.set(k, v);
        }
        log('debug', `Refreshed ipv6ToDevice map: ${ipv6ToDevice.size} entries`);
    } catch (e) {
        log('error', `Failed to refresh ipv6ToDevice map: ${e.message}`);
    }
}, 3600000);

_refreshIpv6ToDeviceTimer.unref();

module.exports = {
    downlinkBlockSessions,
    blockReassembly,
    ipv6ToDevice,
    nextMid,
    handleMessage,
    init,
    stop,
    captureDownlinkEtags,
    captureDownlinkConfig,
    captureDownlinkZoneState,
    captureDownlinkSubpaths,
    captureUplinkPutRequest
};
