/**
 * @file lib/message-router/uplink.js
 */

'use strict';

// ==========================================
// 1. Imports, Configuration and Constants
// ==========================================
'use strict';

const coap = require('../coap');
const wsBridge = require('../ws-bridge');
const db = require('../db');
const workerPool = require('../worker-pool');
const stateSnapshot = require('../state-snapshot');
const commandLog = require('../command-log');
const messageCache = require('../message-cache');
const configCapture = require('../config-capture');
const { reconstructBuffers, parseResourceIds } = require('../utils');
const WebSocket = require('ws');
const proxyManager = require('../proxy-manager');
const ensureProxyConnection = proxyManager.ensureProxyConnection;
const shouldBlockProxyMessage = proxyManager.shouldBlockProxyMessage;
const logProxyMessage = proxyManager.logProxyMessage;

// ==========================================
// 2. In-Memory Session and Reassembly State
// ==========================================
// In-memory CoAP transfer/address tables
let downlinkBlockSessions;
let blockReassembly;
let ipv6ToDevice;
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



function init(opts) {
    if (opts.log !== undefined) log = opts.log;
    if (opts.config !== undefined) config = opts.config;
    if (opts.clients !== undefined) clients = opts.clients;
    if (opts.deviceSessions !== undefined) deviceSessions = opts.deviceSessions;
    if (opts.wsToBridgeId !== undefined) wsToBridgeId = opts.wsToBridgeId;
    if (opts.proxyConnections !== undefined) proxyConnections = opts.proxyConnections;
    if (opts.proxyMidCache !== undefined) proxyMidCache = opts.proxyMidCache;
    if (opts.getApiProcess !== undefined) getApiProcess = opts.getApiProcess;
    if (opts.handlers !== undefined) handlers = opts.handlers;
    if (opts.commandApi !== undefined) commandApi = opts.commandApi;
    if (opts.metrics !== undefined) metrics = opts.metrics;
    if (opts.TADO_ROOT_CA !== undefined) TADO_ROOT_CA = opts.TADO_ROOT_CA;
    if (opts.extractShortSerial !== undefined) extractShortSerial = opts.extractShortSerial;
    if (opts.ipv6ToDevice !== undefined) ipv6ToDevice = opts.ipv6ToDevice;
    if (opts.downlinkBlockSessions !== undefined) downlinkBlockSessions = opts.downlinkBlockSessions;
    if (opts.blockReassembly !== undefined) blockReassembly = opts.blockReassembly;
}

const { persistCapturedConfig } = require('./downlink');

async function captureUplinkPutRequest(coapMsg, displayPath, activeDeviceId, pathInfo) {
    if ((coapMsg.code === coap.CODE_PUT || coapMsg.code === coap.CODE_POST) && coapMsg.payload && coapMsg.payload.length > 0) {
        const isTarget = displayPath && (
            displayPath.includes('config') ||
            displayPath.includes('hvac') ||
            displayPath.endsWith('/lock') ||
            displayPath.endsWith('/act') ||
            displayPath.match(/\/z\/\d+\/s$/) ||
            displayPath.match(/^z\/\d+\/s$/) ||
            displayPath.endsWith('z/s') ||
            displayPath === 'z/s'
        );
        if (isTarget) {
            const decoded = await workerPool.tlvDecode(coapMsg.payload);
            if (decoded.ok) {
                const shortSerial = extractShortSerial(activeDeviceId);
                const snapHomeId = await db.getHomeForDevice(shortSerial);
                
                let canonicalPath = displayPath;
                let zoneId = pathInfo ? pathInfo.zoneId : null;
                
                if (displayPath.endsWith('z/s') || displayPath === 'z/s' || displayPath.match(/\/z\/\d+\/s$/) || displayPath.match(/^z\/\d+\/s$/)) {
                    if (!zoneId) {
                        const { zoneId: parsedZoneId } = parseResourceIds(displayPath, snapHomeId);
                        zoneId = parsedZoneId;
                    }
                    if (zoneId) {
                        canonicalPath = `z/s?id=${zoneId}`;
                    }
                } else if (displayPath.includes('hvac') && !displayPath.endsWith('/config') && !displayPath.includes('hvac/')) {
                    canonicalPath = `${displayPath}/config`;
                }

                log('info', `PROXY: Captured uplink config/state PUT request for ${canonicalPath} (${activeDeviceId})`);
                
                const captureEtag = coap.optionFirst(coapMsg, coap.OPT_ETAG);
                await configCapture.capture({
                    deviceId: activeDeviceId,
                    path: canonicalPath,
                    coapCode: coap.codeStr(coapMsg.code),
                    coapEtag: captureEtag,
                    payload: coapMsg.payload,
                    tlvDecoded: decoded,
                });

                if (snapHomeId && stateSnapshot.isCapturing(snapHomeId)) {
                    await stateSnapshot.recordMessage(snapHomeId, canonicalPath, decoded.fields, captureEtag);
                }

                try {
                    if (displayPath.includes('hvac') || displayPath.includes('/config')) {
                        await persistCapturedConfig(displayPath, decoded, activeDeviceId, captureEtag, snapHomeId);
                    } else if (displayPath.match(/\/z\/\d+\/s$/) || displayPath.match(/^z\/\d+\/s$/) || displayPath.endsWith('z/s') || displayPath === 'z/s') {
                        let hId = snapHomeId;
                        if (zoneId && hId) {
                            await db.insertZoneState(hId, zoneId, decoded.fields);
                            if (captureEtag) await db.storeRealZoneEtag(hId, zoneId, 'state', captureEtag);
                        }
                    } else if (displayPath.endsWith('/lock')) {
                        if (decoded.fields['0x0290'] !== undefined) {
                            const enabled = decoded.fields['0x0290'] === 1 || decoded.fields['0x0290'] === true;
                            await db.updateDeviceLock(activeDeviceId, enabled);
                            if (captureEtag) await db.storeRealEtag(activeDeviceId, 'lock', captureEtag);
                        }
                    }
                } catch (e) {
                    log('error', `PROXY: Failed to update local DB on uplink PUT: ${e.message}`);
                }
            }
        }
    }
}

module.exports = {
    init,
    captureUplinkPutRequest
};
