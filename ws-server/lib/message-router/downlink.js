/**
 * @file lib/message-router/downlink.js
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

async function captureDownlinkEtags(coapMsg, displayPath, activeDeviceId, pathInfo) {
    const realEtag = coap.optionFirst(coapMsg, coap.OPT_ETAG);
    if (realEtag && displayPath) {
        try {
            if (displayPath.endsWith('/lock') || displayPath.match(/^d\/[^/]+\/lock$/)) {
                await db.storeRealEtag(activeDeviceId, 'lock', realEtag);
                log('debug', `PROXY: Captured real lock ETag for ${activeDeviceId}: ${realEtag.toString('hex')}`);
            } else if (displayPath.endsWith('/config') || displayPath.match(/\/config$/)) {
                const shortSerial = activeDeviceId ? extractShortSerial(activeDeviceId) : null;
                let fallbackHomeId = null;
                if (shortSerial) {
                    fallbackHomeId = await db.getHomeForDevice(shortSerial);
                }
                const { zoneId, homeId, circuitNumber } = parseResourceIds(displayPath, fallbackHomeId);

                if (displayPath.match(/^h\/\d+\/z\/\d+\/config$/) || displayPath.match(/^z\/\d+\/config$/)) {
                    if (zoneId) {
                        await db.storeRealZoneEtag(homeId, zoneId, 'config', realEtag);
                        log('debug', `PROXY: Captured real zone config ETag for h/${homeId} z/${zoneId}: ${realEtag.toString('hex')}`);
                    }
                } else if (displayPath.match(/^h\/\d+\/c\/\d+\/config$/) || displayPath.match(/^c\/\d+\/config$/)) {
                    if (circuitNumber && homeId) {
                        await db.storeRealCircuitEtag(homeId, circuitNumber, realEtag);
                        log('debug', `PROXY: Captured real circuit config ETag for h/${homeId}/c/${circuitNumber}: ${realEtag.toString('hex')}`);
                    }
                } else {
                    await db.storeRealEtag(activeDeviceId, 'config', realEtag);
                    log('debug', `PROXY: Captured real device config ETag for ${activeDeviceId}: ${realEtag.toString('hex')}`);
                }
            } else if (displayPath.match(/\/s$/) || displayPath.endsWith('/s')) {
                const shortSerial = activeDeviceId ? extractShortSerial(activeDeviceId) : null;
                let fallbackHomeId = null;
                if (shortSerial) {
                    fallbackHomeId = await db.getHomeForDevice(shortSerial);
                }
                const { zoneId, homeId } = parseResourceIds(displayPath, fallbackHomeId);
                if (zoneId) {
                    await db.storeRealZoneEtag(homeId, zoneId, 'state', realEtag);
                    log('debug', `PROXY: Captured real zone state ETag for h/${homeId} z/${zoneId}: ${realEtag.toString('hex')}`);
                }
            }
        } catch (e) {
            log('error', `PROXY: Failed to store real ETag for ${displayPath}: ${e.message}`);
        }
    }
}

async function persistCapturedConfig(displayPath, decoded, activeDeviceId, captureEtag, snapHomeId) {
    if (displayPath.includes('hvac')) {
        if (snapHomeId) await db.upsertHeatingSystem(snapHomeId, {}, decoded.fields);
    } else if (displayPath.includes('/config')) {
        const { zoneId: parsedZoneId, homeId: parsedHomeId, circuitNumber } = parseResourceIds(displayPath, snapHomeId);
        const homeId = parsedHomeId || snapHomeId;
        const zoneIdVal = parsedZoneId;

        if (displayPath.startsWith('z/') || displayPath.match(/^h\/\d+\/z\/\d+\/config$/)) {
            if (zoneIdVal) {
                await db.updateZoneConfig(homeId, zoneIdVal, {}, decoded.fields);
                if (captureEtag) await db.storeRealZoneEtag(homeId, zoneIdVal, 'config', captureEtag);
            }
        } else if (displayPath.startsWith('c/') || displayPath.match(/^h\/\d+\/c\/\d+\/config$/)) {
            if (circuitNumber && homeId) {
                await db.updateCircuitConfig(homeId, circuitNumber, decoded.fields, decoded.fields);
                if (captureEtag) await db.storeRealCircuitEtag(homeId, circuitNumber, captureEtag);
            }
        } else {
            const configFields = { ...decoded.fields };
            if (configFields.actuator_config !== undefined) {
                configFields.field_015a = configFields.actuator_config;
            }
            await db.updateDeviceConfig(activeDeviceId, configFields, decoded.fields);
            if (captureEtag) await db.storeRealEtag(activeDeviceId, 'config', captureEtag);
        }
    }
}

async function captureDownlinkConfig(coapMsg, displayPath, activeDeviceId, pathInfo) {
    if (displayPath && (displayPath.endsWith('config') || displayPath.endsWith('hvac'))) {
        log('info', `PROXY: Captured config response for ${displayPath} (${activeDeviceId})`);
        const decoded = await workerPool.tlvDecode(coapMsg.payload);
        if (decoded.ok) {
            const captureEtag = coap.optionFirst(coapMsg, coap.OPT_ETAG);
            
            let canonicalPath = displayPath;
            if (displayPath.includes('hvac') && !displayPath.endsWith('/config') && !displayPath.includes('hvac/')) {
                canonicalPath = `${displayPath}/config`;
            }

            await configCapture.capture({
                deviceId: activeDeviceId,
                path: canonicalPath,
                coapCode: coap.codeStr(coapMsg.code),
                coapEtag: captureEtag,
                payload: coapMsg.payload,
                tlvDecoded: decoded,
            });

            let snapHomeId = null;
            if (activeDeviceId) {
                const shortSerial = extractShortSerial(activeDeviceId);
                snapHomeId = await db.getHomeForDevice(shortSerial);
                if (snapHomeId && stateSnapshot.isCapturing(snapHomeId)) {
                    await stateSnapshot.recordMessage(snapHomeId, canonicalPath, decoded.fields, captureEtag);
                }
            }

            await persistCapturedConfig(displayPath, decoded, activeDeviceId, captureEtag, snapHomeId);
        }
    }
}

async function captureDownlinkZoneState(coapMsg, displayPath, activeDeviceId, pathInfo) {
    const isZoneState = displayPath && (
        displayPath.match(/\/z\/\d+\/s$/) || 
        displayPath.match(/^z\/\d+\/s$/) || 
        displayPath.endsWith('z/s') || 
        displayPath === 'z/s'
    );
    if (isZoneState) {
        let fallbackHomeId = null;
        if (activeDeviceId) {
            const shortSerial = extractShortSerial(activeDeviceId);
            fallbackHomeId = await db.getHomeForDevice(shortSerial);
        }
        const { zoneId: parsedZoneId, homeId: parsedHomeId } = parseResourceIds(displayPath, fallbackHomeId);
        let zoneId = parsedZoneId;
        if (zoneId === 's' || !zoneId) {
            zoneId = pathInfo ? pathInfo.zoneId : null;
        }

        let hId = parsedHomeId;
        if (!hId) {
            hId = pathInfo ? pathInfo.homeId : null;
        }

        if (zoneId) {
            const decoded = await workerPool.tlvDecode(coapMsg.payload);
            if (decoded.ok) {
                const canonicalPath = `z/s?id=${zoneId}`;
                const captureEtag = coap.optionFirst(coapMsg, coap.OPT_ETAG);
                await configCapture.capture({
                    deviceId: activeDeviceId,
                    path: canonicalPath,
                    coapCode: coap.codeStr(coapMsg.code),
                    coapEtag: captureEtag,
                    payload: coapMsg.payload,
                    tlvDecoded: decoded,
                });

                if (hId) {
                    log('info', `PROXY: Captured zone state for z/s?id=${zoneId} (home ${hId}): ${JSON.stringify(decoded.fields)}`);
                    await db.insertZoneState(hId, zoneId, decoded.fields);

                    if (stateSnapshot.isCapturing(hId)) {
                        await stateSnapshot.recordMessage(hId, canonicalPath, decoded.fields, captureEtag);
                    }

                    const eTag = coap.optionFirst(coapMsg, coap.OPT_ETAG);
                    if (eTag) {
                        log('info', `PROXY: Captured real ETag for z/s?id=${zoneId} state: ${eTag.toString('hex')}`);
                        await db.storeRealZoneEtag(hId, zoneId, 'state', eTag);
                    }
                }
            }
        }
    }
}

async function captureDownlinkSubpaths(coapMsg, displayPath, activeDeviceId) {
    if (displayPath && (displayPath.includes('hvac/mon') || displayPath.includes('hvac/dhw') || displayPath.includes('hvac/maint'))) {
        const decoded = await workerPool.tlvDecode(coapMsg.payload);
        if (decoded.ok && activeDeviceId) {
            const shortSerial = extractShortSerial(activeDeviceId);
            const snapHomeId = await db.getHomeForDevice(shortSerial);
            const captureEtag = coap.optionFirst(coapMsg, coap.OPT_ETAG);
            if (snapHomeId && stateSnapshot.isCapturing(snapHomeId)) {
                await stateSnapshot.recordMessage(snapHomeId, displayPath, decoded.fields, captureEtag);
            }
            await configCapture.capture({
                deviceId: activeDeviceId,
                path: displayPath,
                coapCode: coap.codeStr(coapMsg.code),
                coapEtag: captureEtag,
                payload: coapMsg.payload,
                tlvDecoded: decoded,
            });
        }
    }

    if (displayPath && (displayPath.endsWith('/lock') || displayPath.endsWith('/act'))) {
        const decoded = await workerPool.tlvDecode(coapMsg.payload);
        if (decoded.ok && activeDeviceId) {
            const shortSerial = extractShortSerial(activeDeviceId);
            const snapHomeId = await db.getHomeForDevice(shortSerial);
            if (snapHomeId && stateSnapshot.isCapturing(snapHomeId)) {
                const captureEtag = coap.optionFirst(coapMsg, coap.OPT_ETAG);
                await stateSnapshot.recordMessage(snapHomeId, displayPath, decoded.fields, captureEtag);
            }
            await configCapture.capture({
                deviceId: activeDeviceId,
                path: displayPath,
                coapCode: coap.codeStr(coapMsg.code),
                coapEtag: coap.optionFirst(coapMsg, coap.OPT_ETAG),
                payload: coapMsg.payload,
                tlvDecoded: decoded,
            });
        }
    }
}

module.exports = {
    init,
    captureDownlinkEtags,
    persistCapturedConfig,
    captureDownlinkConfig,
    captureDownlinkZoneState,
    captureDownlinkSubpaths
};
