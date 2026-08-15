/**
 * @file lib/proxy-manager.js
 * @brief Bridge proxy connection tunnels coordinator.
 * 
 * NOTE: init() is called by message-router/index.js during server startup
 * (server.js → initMessageRouter → message-router/index.init → proxyManager.init).
 * startProxyServer() is called directly from server.js.
 */

'use strict';

const tls = require('tls');
const net = require('net');
const fs = require('fs');
const WebSocket = require('ws');
const coap = require('./coap');
const wsBridge = require('./ws-bridge');
const workerPool = require('./worker-pool');
const stateSnapshot = require('./state-snapshot');
const commandLog = require('./command-log');
const { getLogger } = require('./logger');

const defaultLogger = getLogger('proxy-mgr');
const proxyConnections = new Map();
const proxyMidCache = new Map();

let log = defaultLogger, db, clients, TADO_ROOT_CA, extractShortSerial, config, handleMessage;
let proxyMidCacheSweepInterval = null;

let defaultTlsServer = null;
let ipTlsServers = {};
let netProxy = null;

function init(deps) {
    log = deps.log || defaultLogger;
    db = deps.db;
    clients = deps.clients;
    TADO_ROOT_CA = deps.TADO_ROOT_CA;
    extractShortSerial = deps.extractShortSerial;
    config = deps.config;
    handleMessage = deps.handleMessage;

    // Periodic sweep: evict proxyMidCache entries older than 5 minutes
    if (proxyMidCacheSweepInterval) clearInterval(proxyMidCacheSweepInterval);
    proxyMidCacheSweepInterval = setInterval(() => {
        const cutoff = Date.now() - 5 * 60 * 1000;
        for (const [mid, entry] of proxyMidCache) {
            if (entry.ts < cutoff) proxyMidCache.delete(mid);
        }
    }, 5 * 60 * 1000);
    proxyMidCacheSweepInterval.unref();
}

function startProxyServer(opts) {
    const { config: proxyConfig, log: proxyLog, INTERNAL_UWS_PORT } = opts;

    const handleTlsConnection = (clientSocket) => {
        const clientAddr = clientSocket.remoteAddress;
        proxyLog('debug', `TLS connection from ${clientAddr}`);

        const upstream = net.connect(INTERNAL_UWS_PORT, '127.0.0.1');
        let firstChunk = true;

        clientSocket.on('data', (chunk) => {
            if (firstChunk) {
                firstChunk = false;
                const idx = chunk.indexOf('HTTP/1.0');
                if (idx !== -1) {
                    proxyLog('debug', `Rewriting HTTP/1.0 → HTTP/1.1 for ${clientAddr}`);
                    const fixed = Buffer.concat([
                        chunk.subarray(0, idx),
                        Buffer.from('HTTP/1.1'),
                        chunk.subarray(idx + 8),
                    ]);
                    upstream.write(fixed);
                    return;
                }
            }
            upstream.write(chunk);
        });

        upstream.on('data', (chunk) => {
            clientSocket.write(chunk);
        });

        clientSocket.on('close', () => upstream.destroy());
        clientSocket.on('error', (e) => { proxyLog('debug', `TLS client error: ${e.message}`); upstream.destroy(); });
        upstream.on('close', () => clientSocket.destroy());
        upstream.on('error', (e) => { proxyLog('debug', `Upstream error: ${e.message}`); clientSocket.destroy(); });
    };

    defaultTlsServer = tls.createServer({
        key: fs.readFileSync(proxyConfig.sslKeyPath),
        cert: fs.readFileSync(proxyConfig.sslCertPath),
    }, handleTlsConnection);

    defaultTlsServer.on('tlsClientError', (err, socket) => {
        proxyLog('error', `Default TLS Client Error: ${err.message}`);
    });

    ipTlsServers = {};
    if (proxyConfig.ipCerts) {
        for (const [ip, certs] of Object.entries(proxyConfig.ipCerts)) {
            try {
                ipTlsServers[ip] = tls.createServer({
                    key: fs.readFileSync(certs.key),
                    cert: fs.readFileSync(certs.cert)
                }, handleTlsConnection);
                ipTlsServers[ip].on('tlsClientError', (err, socket) => {
                    proxyLog('error', `Custom TLS Client Error (${ip}): ${err.message}`);
                });
            } catch (err) {
                proxyLog('error', `Failed to initialize custom TLS server for ${ip}: ${err.message}`);
            }
        }
    }

    netProxy = net.createServer((socket) => {
        const clientIp = socket.remoteAddress ? socket.remoteAddress.replace(/^.*:/, '') : null;
        if (clientIp && ipTlsServers[clientIp]) {
            proxyLog('debug', `Routing connection from ${clientIp} to custom TLS server`);
            ipTlsServers[clientIp].emit('connection', socket);
        } else {
            defaultTlsServer.emit('connection', socket);
        }
    });

    netProxy.listen(proxyConfig.wsPort, () => {
        proxyLog('debug', `✓ TLS proxy listening on wss://0.0.0.0:${proxyConfig.wsPort} → internal :${INTERNAL_UWS_PORT}`);
    });
}

function stopProxyServer() {
    if (netProxy) netProxy.close();
    if (defaultTlsServer) defaultTlsServer.close();
    for (const s of Object.values(ipTlsServers)) {
        s.close();
    }
    if (proxyMidCacheSweepInterval) {
        clearInterval(proxyMidCacheSweepInterval);
        proxyMidCacheSweepInterval = null;
    }
}

async function ensureProxyConnection(ws, deviceId, rawData) {
    if (!deviceId) return;
    if (proxyConnections.has(ws) || ws._proxyChecked) return;
    ws._proxyChecked = true;

    try {
        const shortSerial = extractShortSerial(deviceId);
        if (!shortSerial) return;
        const homeId = await db.getHomeForDevice(shortSerial);
        if (!homeId) return;
        const home = await db.getHome(homeId);

        if (home && home.is_proxied) {
            log('debug', `CONNECTION EVENT: Home ${homeId} is PROXIED. Bootstrapping upstream socket to ingress.tado.com`);

            if (!stateSnapshot.isCapturing(homeId)) {
                try {
                    const pool = db.getPool();
                    const [rows] = await pool.execute(
                        'SELECT COUNT(*) as count FROM state_snapshots WHERE home_id = ?',
                        [homeId]
                    );
                    if (rows[0] && rows[0].count === 0) {
                        await stateSnapshot.startCapture(homeId);
                        log('info', `[state-snapshot] Auto-started capture for home ${homeId} (proxy enabled)`);
                    }
                } catch (e) {
                    log('error', `[state-snapshot] Failed to auto-start capture: ${e.message}`);
                }
            }

            commandLog.setEnabled(true);
            log('info', `[cmd-log] Command logging ENABLED (proxy active for home ${homeId})`);

            const proxyWs = new WebSocket('wss://ingress.tado.com/hw/v2', {
                ca: [TADO_ROOT_CA],
                rejectUnauthorized: true,
                headers: { 'Sec-WebSocket-Protocol': 'binary' },
                handshakeTimeout: 10000
            });

            proxyWs.loggingEnabled = !!home.proxy_logging;
            proxyConnections.set(ws, proxyWs);

            proxyWs.on('open', async () => {
                try {
                    log('debug', `Proxy connected dynamically for device ${deviceId} (logging: ${proxyWs.loggingEnabled})`);
                    if (await shouldBlockProxyMessage(rawData, 'UP')) {
                        return;
                    }
                    if (proxyWs.loggingEnabled) await logProxyMessage('UP', rawData);
                    proxyWs.send(rawData);

                    if (proxyWs._messageQueue) {
                        for (const qData of proxyWs._messageQueue) {
                            proxyWs.send(qData);
                        }
                        proxyWs._messageQueue = [];
                    }

                    proxyWs._pingInterval = setInterval(() => {
                        if (proxyWs.readyState === WebSocket.OPEN) proxyWs.ping();
                    }, 30000);
                } catch (e) {
                    log('error', `Error in proxy open handler: ${e.message}`, e.stack);
                }
            });

            proxyWs.on('message', async (proxyMsg, isBinary) => {
                try {
                    if (await shouldBlockProxyMessage(proxyMsg, 'DOWN')) {
                        return;
                    }
                    if (proxyWs.loggingEnabled) await logProxyMessage('DOWN', proxyMsg);
                    if (!ws.isClosed) {
                        try {
                            ws.send(proxyMsg, isBinary);
                        } catch (e) {
                            log('error', `Failed to send proxied downlink: ${e.message}`);
                        }
                    }

                    handleMessage(ws, proxyMsg, isBinary, true).catch(err => {
                        log('error', `Failed to locally parse proxy downlink for ${deviceId}: ${err.message}`);
                    });
                } catch (e) {
                    log('error', `Error in proxy message handler: ${e.message}`, e.stack);
                }
            });

            proxyWs.on('close', (code, reason) => {
                log('debug', `Proxy connection closed for ${deviceId} (code=${code}, reason=${reason ? reason.toString() : ''})`);
                if (proxyWs._pingInterval) clearInterval(proxyWs._pingInterval);
                proxyConnections.delete(ws);
                if (!ws.isClosed) {
                    try {
                        const closeCode = code || 1011;
                        const closeReason = reason ? reason.toString() : 'Proxy connection closed';
                        ws.end(closeCode, closeReason);
                    } catch (e) { }
                }
            });

            proxyWs.on('error', (err) => log('error', `Proxy error for ${deviceId}: ${err.message}`));
        }
    } catch (e) {
        log('error', `Error verifying proxy for ${deviceId}: ${e.message}`);
    }
}

async function shouldBlockProxyMessage(data, dir) {
    try {
        const frame = wsBridge.parse(data);
        if (!frame.ok) return false;

        const coapMsg = await workerPool.coapParse(frame.coapBytes);
        if (!coapMsg.ok) return false;

        let uriPathStr = coap.uriPath(coapMsg);
        if (!uriPathStr) {
            const cached = proxyMidCache.get(coapMsg.mid);
            uriPathStr = cached ? cached.path : '';
        }

        const hasBlockOptions = coap.optionFirst(coapMsg, coap.OPT_BLOCK1) || coap.optionFirst(coapMsg, coap.OPT_BLOCK2);

        const isFwPath = uriPathStr && (
            uriPathStr === 'd/fw' ||
            uriPathStr.endsWith('/fw') ||
            uriPathStr.includes('/fw/') ||
            uriPathStr.includes('fw/rq') ||
            uriPathStr.startsWith('fw/')
        ) && !uriPathStr.includes('fw/state');

        if (isFwPath) {
            log('debug', `[PROXY BLOCK ${dir}] Blocked firmware path: /${uriPathStr}`);
            return true;
        }

        if (hasBlockOptions && isFwPath) {
            if (coapMsg.code === coap.CODE_POST || coapMsg.code === coap.CODE_CONTINUE) {
                log('debug', `[PROXY BLOCK ${dir}] Blocked block transfer (possible firmware chunk)`);
                return true;
            }
        }

        return false;
    } catch (e) {
        return false;
    }
}

async function logProxyMessage(dir, data) {
    try {
        const frame = wsBridge.parse(data);
        if (!frame.ok) return;
        const msg = await workerPool.coapParse(frame.coapBytes);
        if (!msg.ok) return;

        let uriPathStr = coap.uriPath(msg);

        if (uriPathStr) {
            proxyMidCache.set(msg.mid, { path: uriPathStr, ts: Date.now() });
        } else {
            const cached = proxyMidCache.get(msg.mid);
            uriPathStr = cached ? `${cached.path} (ACK)` : '(empty)';
        }

        let decodedStr = '';
        if (msg.payload.length >= 3) {
            let timeDecoded = false;
            const isTimePath = uriPathStr && (uriPathStr === 'time' || uriPathStr === 'time (ACK)' || uriPathStr.includes('/time') || uriPathStr.startsWith('time'));
            if (isTimePath && msg.payload.length === 5 && msg.payload[0] === 0x0D) {
                const decodedTime = coap.decodeTimeProtobuf(msg.payload);
                if (decodedTime.ok) {
                    decodedStr = `\n    └─ Payload (Time): ${decodedTime.unix_s} (${decodedTime.utc})`;
                    timeDecoded = true;
                }
            }

            if (!timeDecoded) {
                const decoded = await workerPool.tlvDecode(msg.payload);
                if (decoded && decoded.ok) decodedStr = `\n    └─ Payload (TLV): ${JSON.stringify(decoded.fields)}`;
                else decodedStr = `\n    └─ Payload (Raw): ${msg.payload.toString('hex')}`;
            }
        }

        const code = coap.codeStr(msg.code);
        const consoleLine = `[PROXY ${dir}] ${code} /${uriPathStr}${decodedStr}`;
        log('debug', consoleLine);
    } catch (e) { }
}

function clearProxyConnectionsForHome(homeId) {
    const targetHomeId = String(homeId);
    let count = 0;
    for (const [ws, proxyWs] of proxyConnections.entries()) {
        delete ws._proxyChecked;
        if (proxyWs) {
            if (proxyWs._pingInterval) clearInterval(proxyWs._pingInterval);
            try { proxyWs.close(); } catch (e) {}
        }
        proxyConnections.delete(ws);
        count++;
    }
    log('info', `[proxy-manager] Cleared ${count} active proxy connection(s) for home ${targetHomeId}`);
}

module.exports = {
    init,
    ensureProxyConnection,
    clearProxyConnectionsForHome,
    shouldBlockProxyMessage,
    logProxyMessage,
    startProxyServer,
    stopProxyServer,
    proxyConnections,
    proxyMidCache
};
