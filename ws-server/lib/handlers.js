/**
 * @file lib/handlers.js
 * @brief Gateway handler router for parsing incoming CoAP frames.
 */

'use strict';
/**
 * handlers.js — CoAP message handlers extracted from server.js (I15).
 *
 * Delegates processing to submodules:
 *  - path-classifier.js (path classification)
 *  - coap-helpers.js (CoAP helpers)
 *  - device-handlers.js (device config, locks, firmware)
 *  - telemetry-handlers.js (sensor data, HVAC config)
 *  - zone-handlers.js (zone state, overlays, schedules)
 *
 * Dependencies are injected via init() to avoid circular requires.
 */

const crypto = require('crypto');
const { getLogger } = require('./logger');
const log = getLogger();

const pathClassifier = require('./handlers/path-classifier');
const coapHelpers = require('./handlers/coap-helpers');
const deviceHandlers = require('./handlers/device-handlers');
const telemetryHandlers = require('./handlers/telemetry-handlers');
const zoneHandlers = require('./handlers/zone-handlers');

// Injected dependencies (set by init())
let db, coap, tlv, wsBridge, battery, messageCache, configCapture, config, metrics, ZS_SCHEMA, mqttPublisher, workerPool;
// Injected shared state
let clients, proxyConnections, ipv6ToDevice, deviceSessions, downlinkBlockSessions, wsToBridgeId;
// Injected functions
let extractShortSerial, nextMid, onClientConnect, onStateChange;

/**
 * Initialize handler module with dependencies from server.js.
 * Must be called once at startup before any handler is invoked.
 */
function init(containerOrDeps) {
    let deps;
    if (containerOrDeps && typeof containerOrDeps.resolve === 'function') {
        const c = containerOrDeps;
        deps = {
            db: c.resolve('db'),
            coap: c.resolve('coap'),
            tlv: c.resolve('tlv'),
            wsBridge: c.resolve('wsBridge'),
            battery: c.resolve('battery'),
            messageCache: c.resolve('messageCache'),
            configCapture: c.resolve('configCapture'),
            config: c.resolve('config'),
            metrics: c.resolve('metrics'),
            ZS_SCHEMA: c.resolve('ZS_SCHEMA'),
            mqttPublisher: c.resolve('mqttPublisher'),
            workerPool: c.resolve('workerPool'),
            clients: c.resolve('clients'),
            proxyConnections: c.resolve('proxyConnections'),
            ipv6ToDevice: c.resolve('ipv6ToDevice'),
            deviceSessions: c.resolve('deviceSessions'),
            downlinkBlockSessions: c.resolve('downlinkBlockSessions'),
            wsToBridgeId: c.resolve('wsToBridgeId'),
            extractShortSerial: c.resolve('extractShortSerial'),
            nextMid: c.resolve('nextMid'),
            onClientConnect: c.resolve('onClientConnect'),
            onStateChange: c.resolve('onStateChange')
        };
    } else {
        deps = containerOrDeps || {};
    }

    db = deps.db;
    coap = deps.coap;
    tlv = deps.tlv;
    wsBridge = deps.wsBridge;
    battery = deps.battery;
    messageCache = deps.messageCache;
    configCapture = deps.configCapture;
    config = deps.config;
    metrics = deps.metrics;
    ZS_SCHEMA = deps.ZS_SCHEMA;
    mqttPublisher = deps.mqttPublisher;
    workerPool = deps.workerPool;

    clients = deps.clients;
    proxyConnections = deps.proxyConnections;
    ipv6ToDevice = deps.ipv6ToDevice;
    deviceSessions = deps.deviceSessions;
    downlinkBlockSessions = deps.downlinkBlockSessions;
    wsToBridgeId = deps.wsToBridgeId;

    extractShortSerial = deps.extractShortSerial;
    nextMid = deps.nextMid;
    onClientConnect = deps.onClientConnect;
    onStateChange = deps.onStateChange;

    // Initialize submodules
    pathClassifier.init(deps);
    coapHelpers.init(deps);
    deviceHandlers.init(deps);
    telemetryHandlers.init(deps);
    zoneHandlers.init(deps);
}

const classifyPath = pathClassifier.classifyPath;
const populateIpv6Map = pathClassifier.populateIpv6Map;

async function handleTimeSync(ws, frame, coapMsg, decoded, peerInfo) {
    const nowSec = Math.floor(Date.now() / 1000);
    const timePayload = coap.encodeTimeProtobuf(nowSec);

    const ackBytes = coap.buildAckWithPayload(coapMsg, coap.CODE_CONTENT, timePayload);
    coapHelpers.sendWrappedCoAP(ws, ackBytes, peerInfo, wsBridge.DIR_SERVER_TO_CLIENT);
    log('debug', `TIME_SYNC: Sent ${nowSec}`);
}

async function handleAuthKey(ws, frame, coapMsg, decoded, peerInfo, rawData) {
    let deviceId = null;
    if (decoded && decoded.fields) {
        deviceId = decoded.fields['0x0260'] || null;
    }
    if (!deviceId) {
        deviceId = ipv6ToDevice.get(peerInfo.ipv6);
    }

    log('debug', `AUTH_KEY: device=${deviceId} ipv6=${peerInfo.ipv6}`);

    const dbDev = deviceId ? await db.getDeviceByFullSerial(deviceId) : null;
    if (!dbDev) {
        log('warn', `AUTH_KEY REJECTED: Device ${deviceId || 'unknown'} is not a known device in standalone mode.`);
        return;
    }

    // Generate a cryptographically secure random 16-byte ephemeral challenge key for the session
    const serverKey = crypto.randomBytes(16);

    let keyPayload = serverKey;
    if (dbDev.factory_key && dbDev.factory_key.length === 32) {
        try {
            const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(dbDev.factory_key, 'hex'), null);
            cipher.setAutoPadding(false);
            keyPayload = Buffer.concat([cipher.update(serverKey), cipher.final()]);
        } catch (e) {
            log('warn', `Failed to encrypt server challenge key with factory_key: ${e.message}`);
        }
    }

    const responsePayload = tlv.encode([
        { fid: 0x0260, value: Buffer.from(deviceId || 'IB0000000000', 'utf8') },
        { fid: 0x0261, value: keyPayload },
    ]);

    const ackBytes = coap.buildAckWithPayload(coapMsg, coap.CODE_CONTENT, responsePayload);
    coapHelpers.sendWrappedCoAP(ws, ackBytes, peerInfo, wsBridge.DIR_SERVER_TO_CLIENT);
}

async function handlePairFound(ws, frame, coapMsg, decoded, peerInfo, rawData) {
    log('info', `PAIR_FOUND received from Bridge: ipv6=${peerInfo.ipv6} payloadHex=${coapMsg.payload ? coapMsg.payload.toString('hex') : 'empty'}`);

    let targetIpv6 = null;
    let targetDevice = null;
    let factoryKey = null;

    if (coapMsg.payload && coapMsg.payload.length >= 18) {
        for (let i = 0; i + 17 < coapMsg.payload.length; i++) {
            if (coapMsg.payload[i] === 0x05 && coapMsg.payload[i + 1] === 0x10) {
                const ipBuf = coapMsg.payload.subarray(i + 2, i + 18);
                targetIpv6 = wsBridge.ipv6FromBytes(ipBuf);
                break;
            }
        }
    }

    log('info', `PAIR_FOUND: Discovered device target IPv6 = ${targetIpv6}`);

    if (targetIpv6) {
        targetDevice = await db.getDeviceByIPv6(targetIpv6);
    }

    if (!targetDevice) {
        const pool = db.getPool();
        const [rows] = await pool.execute('SELECT * FROM emulated_devices WHERE pairing_state != "PAIRED" ORDER BY created_at DESC LIMIT 1');
        if (rows && rows.length > 0) {
            targetDevice = rows[0];
            if (targetIpv6 && !targetDevice.ipv6_address) {
                await pool.execute('UPDATE emulated_devices SET ipv6_address = ? WHERE serial_no = ?', [targetIpv6, targetDevice.serial_no]);
            }
        }
    }

    if (targetDevice && targetDevice.factory_key) {
        factoryKey = targetDevice.factory_key;
    } else {
        factoryKey = '8ee8b8fc9693c412f253be8f02e608d7';
    }

    log('info', `PAIR_FOUND: Supplying factory key ${factoryKey} for device ${targetDevice ? targetDevice.serial_no : 'unknown'} to Bridge`);

    const responsePayload = Buffer.concat([
        Buffer.from([0x06, 0x10]),
        Buffer.from(factoryKey, 'hex')
    ]);

    const ackBytes = coap.buildAckWithPayload(coapMsg, coap.CODE_CONTENT, responsePayload);
    coapHelpers.sendWrappedCoAP(ws, ackBytes, peerInfo, wsBridge.DIR_SERVER_TO_CLIENT);
}

async function handleAuthToken(ws, frame, coapMsg, decoded, peerInfo, rawData) {
    let deviceId = null;
    let homeId = null;

    if (decoded && decoded.fields) {
        deviceId = decoded.fields['0x0260'] || null;
    }

    if (!deviceId) {
        deviceId = ipv6ToDevice.get(peerInfo.ipv6);
    }

    log('debug', `AUTH: device=${deviceId} ipv6=${peerInfo.ipv6}`);

    const dbDev = deviceId ? await db.getDeviceByFullSerial(deviceId) : null;
    if (!dbDev) {
        log('warn', `AUTH REJECTED: Device ${deviceId || 'unknown'} is not a known device in standalone mode.`);
        return;
    }

    const sessionToken = crypto.randomBytes(8);
    const validityMinutes = 1440;

    if (deviceId) {
        const shortSerial2 = extractShortSerial(deviceId);
        if (shortSerial2) {
            homeId = await db.getHomeForDevice(shortSerial2);
        }

        const isDeviceAllowed = await db.checkWhitelist('device', deviceId);
        const isHomeAllowed = homeId ? await db.checkWhitelist('home', homeId.toString()) : false;

        if (!isDeviceAllowed && !isHomeAllowed) {
            log('warn', `AUTH REJECTED: Device ${deviceId} (Home ${homeId}) not in whitelist.`);
            const rejectBytes = coap.buildAckWithPayload(coapMsg, 0x81, Buffer.alloc(0));
            coapHelpers.sendWrappedCoAP(ws, rejectBytes, peerInfo, wsBridge.DIR_SERVER_TO_CLIENT);
            return;
        }
    }

    const responsePayload = tlv.encode([
        { fid: 0x025E, value: sessionToken },
        { fid: 0x025F, value: tlv.encodeValue(validityMinutes, 'u16be') },
    ]);

    if (deviceId) {
        deviceSessions.set(deviceId, sessionToken);
        ipv6ToDevice.set(peerInfo.ipv6, deviceId);

        db.updateDeviceSessionToken(deviceId, sessionToken).catch(err => {
            log('error', `Failed to persist session token for ${deviceId}: ${err.message}`);
        });

        const existing = clients.get(deviceId);
        if (existing && existing.ws !== ws) {
            log('warn', `Reconnection for ${deviceId}: Cleaning up stale session.`);
            wsToBridgeId.delete(existing.ws);
            try { existing.ws.end(); } catch (e) { }
        }

        clients.set(deviceId, {
            ws,
            ipv6: peerInfo.ipv6,
            fieldA: peerInfo.fieldA,
            fieldB: peerInfo.fieldB,
            udpPort: peerInfo.udpPort,
            fieldC: peerInfo.fieldC,
            session2048: sessionToken,
            homeId: homeId,
            connectedAt: new Date().toISOString(),
            lastMessageAt: new Date().toISOString(),
            lastDbUpdate: Date.now()
        });
        wsToBridgeId.set(ws, deviceId);

        if (typeof onClientConnect === 'function') {
            onClientConnect(deviceId, clients.get(deviceId));
        }
    }

    const ackBytes = coap.buildAckWithPayload(coapMsg, coap.CODE_CONTENT, responsePayload);
    coapHelpers.sendWrappedCoAP(ws, ackBytes, peerInfo, wsBridge.DIR_SERVER_TO_CLIENT);

    if (deviceId) {
        const shortSerial = extractShortSerial(deviceId);

        if (shortSerial) {
            await db.updateDeviceConnectionState(shortSerial, true);
            if (mqttPublisher) {
                mqttPublisher.publishDeviceAvailability(shortSerial, true).catch(() => { });
            }
            if (decoded && decoded.fields && decoded.fields['0x0007']) {
                db.updateDeviceClientNonce(shortSerial, decoded.fields['0x0007']).catch(err => {
                    log('error', `Failed to persist client nonce for ${shortSerial}: ${err.message}`);
                });
            }
        }

        const client = clients.get(deviceId);
        if (client) client.homeId = homeId;

        log('debug', `AUTH OK: ${deviceId} registered, homeId=${homeId}`);
    }
}

module.exports = {
    init,
    classifyPath,
    handleTimeSync,
    handleAuthKey,
    handleAuthToken,
    handlePairFound,
    handleDeviceInfo: deviceHandlers.handleDeviceInfo,
    handleZoneExtui: zoneHandlers.handleZoneExtui,
    handleSensorData: telemetryHandlers.handleSensorData,
    handleDeviceActuator: deviceHandlers.handleDeviceActuator,
    handleDeviceConfig: deviceHandlers.handleDeviceConfig,
    handleDeviceMount: deviceHandlers.handleDeviceMount,
    handleHvacConfig: telemetryHandlers.handleHvacConfig,
    handleDeviceLock: deviceHandlers.handleDeviceLock,
    handleDeviceError: deviceHandlers.handleDeviceError,
    handleDeviceSelftest: deviceHandlers.handleDeviceSelftest,
    handleDeviceRfKey: deviceHandlers.handleDeviceRfKey,
    handleHvac: telemetryHandlers.handleHvac,
    handleHvacGet: telemetryHandlers.handleHvacGet,
    handleDeviceFirmware: deviceHandlers.handleDeviceFirmware,
    handleDeviceNeighbors: deviceHandlers.handleDeviceNeighbors,
    handleZoneActuator: zoneHandlers.handleZoneActuator,
    handleZoneFallback: zoneHandlers.handleZoneFallback,
    handleDeviceFallback: deviceHandlers.handleDeviceFallback,
    handleZoneOpenWindow: zoneHandlers.handleZoneOpenWindow,
    handleZoneConfig: zoneHandlers.handleZoneConfig,
    handleCircuitActuator: zoneHandlers.handleCircuitActuator,
    handleCircuitConfig: zoneHandlers.handleCircuitConfig,
    handleZoneState: zoneHandlers.handleZoneState,
    sendCoAPAck: coapHelpers.sendCoAPAck,
    sendCoAPWithBlock2: coapHelpers.sendCoAPWithBlock2,
    sendWrappedCoAP: coapHelpers.sendWrappedCoAP,
};
