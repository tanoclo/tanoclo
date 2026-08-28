/**
 * @file server.js
 * @brief Entrypoint file for the main TaNoClo WebSocket Server.
 * 
 * Sets up the high-performance uWebSockets.js server to handle incoming connections from Tado
 * Internet Bridges, handles SSL handshakes, loads initial mappings, registers core sub-modules,
 * and maintains active client connection sessions.
 */

const uWS = require('uWebSockets.js');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const tls = require('tls');
const net = require('net');
const WebSocket = require('ws');


let apiProcess = null;

const { getLogger } = require('./lib/logger');
const log = getLogger();
const { reconstructBuffers } = require('./lib/utils');

process.on('uncaughtException', (err) => {
    log('error', `[CRASH] Uncaught Exception: ${err.message}\n${err.stack}`);
    // Process state may be corrupt after uncaught exception — exit and let supervisor restart
    setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
    log('error', `[CRASH] Unhandled Rejection: ${reason?.stack || reason}`);
    // Process state may be inconsistent after unhandled rejection — exit and let supervisor restart
    setTimeout(() => process.exit(1), 1000);
});

log('info', '[STARTUP] Initializing TaNoClo WS Server...');

const logDir = path.join(__dirname, 'log');
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

const rootFiles = fs.readdirSync(__dirname);
rootFiles.forEach(file => {
    if (file.startsWith('debug.log') && fs.statSync(path.join(__dirname, file)).isFile()) {
        const oldLogPath = path.join(__dirname, file);
        const newLogPath = path.join(logDir, file);
        if (!fs.existsSync(newLogPath)) {
            try {
                fs.renameSync(oldLogPath, newLogPath);
            } catch (e) {
                log('error', `[STARTUP] Failed to migrate ${file}: ${e.message}`);
            }
        }
    }
});

const config = require('./lib/config');
const wsBridge = require('./lib/ws-bridge');
const coap = require('./lib/coap');
const tlv = require('./lib/tlv');
const db = require('./lib/db');
const workerPool = require('./lib/worker-pool');
const commandApi = require('./lib/command-api');
const battery = require('./lib/battery');
const messageCache = require('./lib/message-cache');

const mqttClient = require('./lib/mqtt-client');
const mqttPublisher = require('./lib/mqtt-publisher');
const mqttHaDiscovery = require('./lib/mqtt-ha-discovery');
const mqttCommands = require('./lib/mqtt-commands');
const configCapture = require('./lib/config-capture');
const metrics = require('./lib/metrics');
const stateSnapshot = require('./lib/state-snapshot');
const { ZS_SCHEMA } = require('./lib/zone-state-schema');
const handlers = require('./lib/handlers');
const commandLog = require('./lib/command-log');

const TADO_ROOT_CA = fs.readFileSync(config.tadoRootCA);

const { clients, deviceSessions, wsToBridgeId, extractShortSerial, isBridgeBlocked, getBridgeBlockStatus } = require('./lib/device-manager');
const { proxyConnections, proxyMidCache, startProxyServer, stopProxyServer } = require('./lib/proxy-manager');
const { downlinkBlockSessions, blockReassembly, ipv6ToDevice, nextMid, parseResourceIds, handleMessage, init: initMessageRouter } = require('./lib/message-router');

/**
 * Periodically cleanup expired OAuth tokens and sessions (Frequency: 1 hour)
 */
const _cleanupOAuthTimer = setInterval(async () => {
    try {
        await db.cleanupExpiredTokens();
    } catch (err) {
        log('error', `Periodic OAuth cleanup failed: ${err.message}`);
    }
}, 3600000); // 1 hour
_cleanupOAuthTimer.unref();




async function populateIpv6Map() {
    try {
        const devices = await db.getAllDevices();
        let count = 0;
        for (const dev of devices) {
            if (dev.ipv6_address && dev.serial_no) {
                try {
                    const normIp = wsBridge.ipv6FromBytes(wsBridge.ipv6ToBytes(dev.ipv6_address));
                    ipv6ToDevice.set(normIp, dev.serial_no);
                    count++;
                } catch (e) {
                    ipv6ToDevice.set(dev.ipv6_address, dev.serial_no);
                    count++;
                }
            }
        }
        log('debug', `Pre-populated IPv6 map with ${count} devices`);
    } catch (e) {
        log('error', `Failed to populate IPv6 map: ${e.message}`);
    }
}

async function seedBatteryGuard() {
    try {
        const voltages = await db.getLatestBatteryVoltages();
        battery.seedBatteryGuardState(voltages);
        log('debug', `Seeded battery guard state for ${voltages.length} devices`);
    } catch (e) {
        log('warn', `Failed to seed battery guard state: ${e.message}`);
    }
}

async function sendToDevice(deviceId, wsMessage) {
    if (db.isOffline()) return;

    const clientInfo = clients.get(deviceId);
    if (!clientInfo || !clientInfo.ws) {
        throw new Error(`Device ${deviceId} not connected`);
    }

    // Cache recreated downlink messages even when proxied
    messageCache.cacheMessage(deviceId, wsMessage, 'recreated');

    let isReboot = false;
    let isConfig = false;
    try {
        const frame = wsBridge.parse(Buffer.from(wsMessage));
        if (frame.ok && frame.coapBytes) {
            const coapMsg = coap.parse(frame.coapBytes);
            if (coapMsg.ok) {
                const uriPathStr = coap.uriPath(coapMsg);
                if (coapMsg.mid !== undefined && uriPathStr) {
                    proxyMidCache.set(coapMsg.mid, { path: uriPathStr, ts: Date.now() });
                }
                if (uriPathStr && (uriPathStr === 'd/reboot' || uriPathStr.endsWith('/reboot') || uriPathStr.includes('reboot'))) {
                    isReboot = true;
                } else if (uriPathStr && (
                    uriPathStr.includes('config') ||
                    uriPathStr === 'd/config' ||
                    uriPathStr.endsWith('/config')
                )) {
                    isConfig = true;
                }
            }
        }
    } catch (err) {
        log('error', `Failed to parse CoAP message in sendToDevice check: ${err.message}`);
    }

    if (proxyConnections.has(clientInfo.ws)) {

        if (isReboot) {
            log('info', `[sendToDevice] Allowing system reboot command for ${deviceId} despite active proxy.`);
        } else {
            try {
                const home = await db.getHome(clientInfo.homeId);
                const allowInProxy = home && home.allow_commands_in_proxy === 1;
                if (!allowInProxy) {
                    log('debug', `Skipping sendToDevice(${deviceId}) because connection is proxied. Commands should go to real API.`);
                    return;
                }

                if (isConfig) {
                    const homeReadonly = home?.zone_config_readonly;
                    const effectiveReadonly = homeReadonly !== null && homeReadonly !== undefined
                        ? !!homeReadonly
                        : config.zoneConfigReadonly;
                    if (effectiveReadonly) {
                        log('debug', `Blocking config write to device ${deviceId} in proxy mode because config is read-only (home override: ${homeReadonly !== null && homeReadonly !== undefined}).`);
                        return;
                    }
                }

                // Not blocked, send command
                log('debug', `Allowing command in proxy mode to ${deviceId} (isConfig=${isConfig})`);
                try {
                    if (!clientInfo.ws.isClosed) {
                        clientInfo.ws.send(wsMessage, true);
                    } else {
                        log('debug', `sendToDevice(${deviceId}) skipped: socket is closed`);
                    }
                } catch (err) {
                    log('error', `sendToDevice(${deviceId}) failed in proxy bypass: ${err.message}`);
                }
            } catch (err) {
                log('error', `Error checking allow_commands_in_proxy for home ${clientInfo.homeId}: ${err.message}`);
            }
            return;
        }
    }
    try {
        if (!clientInfo.ws.isClosed) {
            clientInfo.ws.send(wsMessage, true);
        } else {
            log('debug', `sendToDevice(${deviceId}) skipped: socket is closed`);
        }
    } catch (err) {
        log('error', `sendToDevice(${deviceId}) failed: ${err.message}`);
        // Don't re-throw to avoid crashing caller (like cron)
    }
}

function broadcastTime() {
    log('debug', 'Broadcasting time to all devices...');
    const nowSec = Math.floor(Date.now() / 1000);
    const timePayload = coap.encodeTimeProtobuf(nowSec);

    for (const [deviceId, info] of clients.entries()) {
        const coapBytes = coap.buildResponse({
            code: coap.CODE_CONTENT,
            payload: timePayload,
            token: Buffer.alloc(0),
            mid: nextMid(),
            type: coap.TYPE_NON,
        });

        try {
            handlers.sendWrappedCoAP(info.ws, coapBytes, {
                ipv6: info.ipv6,
                fieldA: info.fieldA,
                fieldB: info.fieldB,
                udpPort: info.udpPort,
                fieldC: info.fieldC
            }, wsBridge.DIR_SERVER_TO_CLIENT);
        } catch (e) {
            log('warn', `Failed to broadcast time to ${deviceId}: ${e.message}`);
        }
    }
}

/**
 * Periodically broadcasts RF key request to all Internet Bridges.
 */
function broadcastRfKey() {
    log('info', 'Broadcasting RF Key refresh to all Internet Bridges...');
    for (const [deviceId, info] of clients.entries()) {
        if (!deviceId.startsWith('IB')) continue;
        const coapBytes = coap.serialize({
            type: coap.TYPE_CON,
            code: coap.CODE_GET,
            mid: nextMid(),
            token: crypto.randomBytes(8),
            options: [
                { num: 7, value: Buffer.from('ffff', 'hex') },     // OPT_URI_PORT: broadcast to all devices (0xFFFF)
                { num: 11, value: Buffer.from('d') },              // OPT_URI_PATH: 'd' (device path segment)
                { num: 11, value: Buffer.from('rfkey') },          // OPT_URI_PATH: 'rfkey' (RF key resource)
                { num: 12, value: coap.encOptUint(42) }            // OPT_CONTENT_FORMAT: application/octet-stream (42)
            ]
        });

        try {
            const destIpv6 = info.ipv6;
            handlers.sendWrappedCoAP(info.ws, coapBytes, {
                ipv6: destIpv6,
                fieldA: 4,
                fieldB: 2,
                udpPort: info.udpPort || 5683,
                fieldC: 5
            }, wsBridge.DIR_SERVER_TO_CLIENT);
        } catch (e) {
            log('warn', `Failed to broadcast RF Key to ${deviceId}: ${e.message}`);
        }
    }
}

const INTERNAL_UWS_PORT = 19880;

async function startServer() {
    let deps;
    log('info', '[STARTUP] Bootstrapping database...');
    await db.bootstrap();

    // Run database migrations
    const dbMigrate = require('./lib/db-migrate');
    await dbMigrate.runPending(db.getPool(), log);

    await populateIpv6Map();
    await seedBatteryGuard();
    await config.loadFromDb();
    log('debug', `Starting TaNoClo WS Server on wss://0.0.0.0:${config.wsPort}...`);

    try {
        log('debug', 'Loading TLV labels from database...');
        const labels = await db.getTlvLabels();
        tlv.init(labels.fields);
        workerPool.init({ labels: labels.fields }, log);
        log('debug', `Loaded ${Object.keys(labels.fields).length} TLV labels.`);

        // Initialize message cache (after TLV labels are loaded so decodes work)
        messageCache.init({
            logDir: path.join(__dirname, 'log'),
            log,
            ipv6Resolver: (ipv6) => ipv6ToDevice.get(ipv6),
        });

        // Initialize permanent config capture (never deleted/overwritten)
        configCapture.init({
            logDir: path.join(__dirname, 'log'),
            log,
        });

        deps = {
            db,
            coap,
            tlv,
            wsBridge,
            battery,
            messageCache,
            configCapture,
            config,
            metrics,
            ZS_SCHEMA,
            mqttPublisher,
            workerPool,
            clients,
            proxyConnections,
            ipv6ToDevice,
            deviceSessions,
            downlinkBlockSessions,
            wsToBridgeId,
            extractShortSerial,
            nextMid,
            log,
            proxyMidCache,
            commandApi,
            TADO_ROOT_CA,
            handlers,
            onClientConnect: (deviceId, info) => {
                if (apiProcess && apiProcess.connected) {
                    const infoCopy = { ...info };
                    delete infoCopy.ws;
                    apiProcess.send({
                        type: 'CLIENT_CONNECT',
                        deviceId,
                        info: reconstructBuffers(infoCopy)
                    });
                }
            },
            onStateChange: (homeId, changeType, data) => {
                if (apiProcess && apiProcess.connected) {
                    apiProcess.send({
                        type: 'STATE_CHANGE',
                        homeId,
                        changeType,
                        data
                    });
                }
            },
            getApiProcess: () => apiProcess
        };

        handlers.init(deps);

        // Initialize command log (needs coap/tlv/wsBridge for decoding)
        commandLog.init({ coap, tlv, wsBridge });

        // Initialize MQTT Client and other modules
        mqttClient.init(config, log);
        mqttPublisher.init(mqttClient, db, config, log);
        mqttHaDiscovery.init(mqttClient, db, config, log);
        mqttCommands.init(mqttClient, db, commandApi, mqttPublisher, log);

        // Initialize OWD Detector
        const owdDetector = require('./lib/owd-detector');
        owdDetector.init(db, commandApi, mqttPublisher);

        mqttClient.onConnect(() => {
            mqttPublisher.publishFullState();
            mqttHaDiscovery.publishAllDiscovery();
        });

        config.onMqttChange(() => {
            log('info', '[MQTT] Settings changed, reconnecting client...');
            mqttClient.reconnect().catch(() => {});
        });
    } catch (err) {
        log('error', `Failed to load TLV labels: ${err.message}`);
        process.exit(1);
    }

    const app = uWS.App();

    app.ws('/hw/v2', {
        compression: uWS.DISABLED,
        maxPayloadLength: 64 * 1024,
        maxBackpressure: 1024 * 1024,
        idleTimeout: 0,

        upgrade: (res, req, context) => {
            const secKey = req.getHeader('sec-websocket-key');
            const proto = req.getHeader('sec-websocket-protocol');
            const ip = Buffer.from(res.getRemoteAddressAsText()).toString();

            if (isBridgeBlocked(null, ip)) {
                log('info', `[PAIRING_BLOCK] Rejecting WS upgrade from isolated Bridge IP ${ip} (offline pairing active)`);
                res.writeStatus('403 Forbidden').end();
                return;
            }

            log('debug', `WS upgrade from ${ip}, protocol: ${proto}`);

            res.upgrade(
                { ip, proto },
                secKey,
                req.getHeader('sec-websocket-protocol'),
                req.getHeader('sec-websocket-extensions'),
                context
            );
        },

        open: (ws) => {
            const userData = ws.getUserData ? ws.getUserData() : {};
            log('debug', `WS connected from ${userData.ip || 'unknown'}`);
            metrics.inc('connections_total');
        },

        message: (ws, message, isBinary) => {
            handleMessage(ws, message, isBinary).catch(err => {
                if (db.handleDbError && db.handleDbError(err)) {
                    log('error', `Database offline detected during message handling: ${err.message}`);
                } else {
                    log('error', `Message handler crash: ${err.message}`, err.stack);
                }
            });
        },

        close: (ws, code, message) => {
            ws.isClosed = true;
            log('debug', `WS closed: code=${code}`);
            metrics.inc('disconnections_total');

            const deviceId = wsToBridgeId.get(ws);
            if (deviceId) {
                const info = clients.get(deviceId);
                if (info && info.ws === ws) {
                    log('debug', `Device ${deviceId} disconnected`);
                    clients.delete(deviceId);
                    if (apiProcess && apiProcess.connected) {
                        apiProcess.send({ type: 'CLIENT_DISCONNECT', deviceId });
                    }
                } else {
                    log('debug', `Stale socket for ${deviceId} closed, keeping active session`);
                }
                wsToBridgeId.delete(ws);

                const shortSerial = extractShortSerial(deviceId);
                if (shortSerial) {
                    db.updateDeviceConnectionState(shortSerial, false).catch(err => {
                        log('error', `Failed to update disconnect state: ${err.message}`);
                    });
                    if (mqttPublisher) {
                        mqttPublisher.publishDeviceAvailability(shortSerial, false).catch(() => {});
                    }
                }
            }

            const proxyWs = proxyConnections.get(ws);
            if (proxyWs) {
                if (proxyWs._pingInterval) {
                    clearInterval(proxyWs._pingInterval);
                    proxyWs._pingInterval = null;
                }
                proxyConnections.delete(ws);
                proxyWs.terminate();
            }

            metrics.gauge('connected_clients', clients.size);
        },
    });

    app.get('/health', (res, req) => {
        res.writeHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            status: 'ok',
            clients: clients.size,
            uptime: process.uptime(),
            memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024)
        }));
    });

    app.listen(INTERNAL_UWS_PORT, (listenSocket) => {
        if (listenSocket) {
            log('debug', `Internal uWS listening on port ${INTERNAL_UWS_PORT}`);
        } else {
            log('error', `✗ Failed to listen on internal port ${INTERNAL_UWS_PORT}`);
            process.exit(1);
        }
    });

    initMessageRouter(deps);

    startProxyServer({
        config,
        log,
        INTERNAL_UWS_PORT
    });

    // Command routes will be set up inside the child API process

    const cron = require('./lib/cron');
    commandApi.initialize({
        clients,
        sendToDevice,
        broadcastTime,
        log,
        proxyMidCache
    });

    cron.start({
        broadcastTime,
        broadcastRfKey,
        pushZoneOverlayDelete: commandApi.pushZoneOverlayDelete,
        pushScheduleTransition: commandApi.pushScheduleTransition,
        mqttPublisher,
        mqttHaDiscovery
    });

    log('info', `Zone config writes: ${config.zoneConfigReadonly ? 'DISABLED (readonly)' : 'ENABLED'}`);
    await stateSnapshot.resumeCapture();
    log('debug', `Server startup complete`);
}

process.on('SIGINT', async () => {
    log('debug', 'Shutting down...');
    try { const { stop: stopRouter } = require('./lib/message-router'); stopRouter(); } catch (e) {}
    try { stopProxyServer(); } catch (e) {}
    if (apiProcess) {
        try { apiProcess.kill('SIGINT'); } catch (e) {}
    }
    try { await workerPool.shutdown(); } catch (e) {}
    if (mqttClient) {
        try { await mqttClient.shutdown(); } catch (e) {}
    }
    try {
        const cron = require('./lib/cron');
        cron.stop();
    } catch (e) {}
    commandApi.stop();

    for (const [deviceId] of clients.entries()) {
        const shortSerial = extractShortSerial(deviceId);
        if (shortSerial) {
            try { await db.updateDeviceConnectionState(shortSerial, false); } catch { }
        }
    }

    await db.close();
    process.exit(0);
});

process.on('SIGTERM', () => process.emit('SIGINT'));

let apiRestartCount = 0;
const API_MAX_RESTART_DELAY = 60000; // 1 minute max



function startApiChildProcess() {
    const { fork } = require('child_process');
    log('info', '[STARTUP] Spawning REST API child process...');
    apiProcess = fork(path.join(__dirname, 'api/server.js'), [], {
        env: { ...process.env, IS_CHILD_PROCESS: 'true' }
    });

    apiProcess.on('message', (msg) => {
        try {
            msg = reconstructBuffers(msg);
            if (!msg || !msg.type) return;

            switch (msg.type) {
                case 'SYNC_CLIENTS': {
                    apiRestartCount = 0; // Reset on successful communication
                    const clientList = [];
                    for (const [deviceId, info] of clients.entries()) {
                        const infoCopy = { ...info };
                        delete infoCopy.ws;
                        clientList.push([deviceId, infoCopy]);
                    }
                    if (apiProcess && apiProcess.connected) {
                        apiProcess.send({ type: 'SYNC_CLIENTS_RESPONSE', clients: clientList });
                    }
                    break;
                }
                case 'SEND_TO_DEVICE': {
                    sendToDevice(msg.deviceId, msg.message).catch(err => {
                        log('error', `Failed to send to device ${msg.deviceId} via IPC: ${err.message}`);
                    });
                    break;
                }
                case 'BROADCAST_TIME': {
                    broadcastTime();
                    break;
                }
                case 'BROADCAST_RFKEY': {
                    broadcastRfKey();
                    break;
                }
                case 'BLOCK_BRIDGE': {
                    const { blockBridge } = require('./lib/device-manager');
                    log('info', `[IPC] Received BLOCK_BRIDGE for ${msg.deviceId} for ${msg.durationMs}ms`);
                    blockBridge(msg.deviceId, msg.durationMs || 120000, async (expiredSerial) => {
                        log('info', `[PAIRING_TIMEOUT] Auto-disabling pairing mode after timeout for Bridge ${expiredSerial}`);
                        try {
                            const p = db.getPool();
                            await p.execute('UPDATE devices SET in_pairing_mode = 0 WHERE serial_no = ?', [expiredSerial]);
                            await commandApi.pushDevicePair(expiredSerial, false).catch(() => {});
                        } catch (err) {
                            log('error', `Failed to auto-disable pairing for ${expiredSerial}: ${err.message}`);
                        }
                    });
                    break;
                }
                case 'UNBLOCK_BRIDGE': {
                    const { unblockBridge } = require('./lib/device-manager');
                    log('info', `[IPC] Received UNBLOCK_BRIDGE for ${msg.deviceId}`);
                    unblockBridge(msg.deviceId);
                    break;
                }
                case 'GET_MESSAGE_CACHE': {
                    if (apiProcess && apiProcess.connected) {
                        apiProcess.send({
                            type: 'GET_MESSAGE_CACHE_RESPONSE',
                            requestId: msg.requestId,
                            cache: messageCache.getCache()
                        });
                    }
                    break;
                }
            }
        } catch (err) {
            log('error', `[IPC] Error processing IPC message from API process: ${err.message}`);
        }
    });

    apiProcess.on('exit', (code, signal) => {
        apiProcess = null;
        apiRestartCount++;
        const delay = Math.min(5000 * Math.pow(1.5, apiRestartCount - 1), API_MAX_RESTART_DELAY);
        log('error', `[PROCESS] REST API child process exited (code=${code}, signal=${signal}). Restart #${apiRestartCount} in ${Math.round(delay / 1000)}s...`);
        setTimeout(startApiChildProcess, delay);
    });

    apiProcess.on('error', (err) => {
        log('error', `[PROCESS] REST API child process error: ${err.message}`);
    });
}

startServer().then(() => {
    startApiChildProcess();
}).catch(err => {
    log('error', `[FATAL] Database bootstrap or server startup failed: ${err.stack}`);
    process.exit(1);
});
