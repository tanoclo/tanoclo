/**
 * @file lib/coap-transport.js
 * @brief UDP Transport wrapper handling CoAP network sockets.
 */

'use strict';

const crypto = require('crypto');
const coap = require('./coap');
const wsBridge = require('./ws-bridge');
const commandLog = require('./command-log');
const metrics = require('./metrics');
const { getLogger } = require('./logger');

let _db, _clients, _sendFn;
let _log = getLogger('cmd-api');

const _commandTracker = new Map();
let _trackingIdCounter = 1;
const _pendingCommands = new Map();
const _pendingQueries = new Map();
const _ackCallbacks = new Map();
const _tanocloMids = new Map(); // mid -> timestamp

const RETRY_INTERVALS = [6000, 13000, 26000, 50000, 90000];
const QUERY_TIMEOUT_MS = 5000;
const MAX_QUERY_RETRIES = 2;

let _serverMid = 0xB000;

let _tanocloMidsSweepInterval = null;

let _proxyMidCache = null;

function init(deps) {
    _db = deps.db || deps._db;
    _clients = deps.clients || deps._clients;
    _sendFn = deps.sendFn || deps._sendFn;
    _log = deps.log || deps._log || getLogger('cmd-api');
    if (deps.proxyMidCache) _proxyMidCache = deps.proxyMidCache;

    // Periodic sweep: evict _tanocloMids entries older than 2 minutes
    if (!_tanocloMidsSweepInterval) {
        _tanocloMidsSweepInterval = setInterval(() => {
            const cutoff = Date.now() - 2 * 60 * 1000;
            for (const [mid, ts] of _tanocloMids) {
                if (ts < cutoff) _tanocloMids.delete(mid);
            }
        }, 60 * 1000);
        _tanocloMidsSweepInterval.unref();
    }
}

function getProxyMidCache() {
    return _proxyMidCache;
}

function getNextMid() {
    return (_serverMid++) & 0xFFFF;
}

function isTaNoCloOriginatedMid(mid) {
    return _tanocloMids.has(mid);
}

function findBridgeForHome(homeId) {
    homeId = String(homeId);
    if (!_clients) return null;

    for (const [deviceId, info] of _clients.entries()) {
        if (info && info.homeId && String(info.homeId) === homeId && (deviceId.startsWith('IB') || deviceId.startsWith('GW') || deviceId.includes('BRIDGE'))) {
            return { bridgeId: deviceId, bridgeClient: info };
        }
    }

    return null;
}

function sendViaBridge(bridgeId, bridgeClient, targetIpv6, targetPort, coapBytes, commandLabel) {
    const wsFrame = wsBridge.build({
        direction: 'server_to_client',
        ipv6: targetIpv6,
        udpPort: targetPort || 5683,
        fieldA: 4,
        fieldB: 2,
        fieldC: 5,
        coapBytes
    });
    _log('debug', `[cmd-api] CoAP TX hex: ${coapBytes.toString('hex')}`);
    _log('debug', `[cmd-api] Raw TX hex: ${wsFrame.toString('hex')}`);

    const coapPath = coap.uriPath(coap.parse(coapBytes)) || commandLabel || '';
    commandLog.logWsCommand(bridgeId, commandLabel || 'unlabeled', coapPath || 'unlabeled', coapBytes, wsFrame);

    _sendFn(bridgeId, wsFrame);
    metrics.inc('commands_sent');

    if (coapBytes.length >= 4) {
        const mid = coapBytes.readUInt16BE(2);
        _tanocloMids.set(mid, Date.now());
        if (coapPath && _proxyMidCache) {
            _proxyMidCache.set(mid, { path: coapPath, ts: Date.now() });
        }
        scheduleRetry(mid, bridgeId, wsFrame, 0);

        if (commandLabel) {
            const trackingId = _trackingIdCounter++;
            _commandTracker.set(trackingId, {
                mid,
                bridgeId,
                targetIpv6,
                command: commandLabel,
                sentAt: new Date().toISOString(),
                status: 'pending',
                ackedAt: null,
                retries: 0,
            });
            if (_commandTracker.size > 500) {
                const firstKey = _commandTracker.keys().next().value;
                _commandTracker.delete(firstKey);
            }
        }
    }
}

function scheduleRetry(mid, bridgeId, wsFrame, attempt) {
    const existing = _pendingCommands.get(mid);
    if (existing && existing.timer) clearTimeout(existing.timer);

    if (attempt >= RETRY_INTERVALS.length) {
        _log('warn', `[cmd-api] MID ${mid}: Giving up after ${attempt} retries (no ACK received)`);
        _pendingCommands.delete(mid);
        metrics.inc('commands_failed');
        
        const cb = _ackCallbacks.get(mid);
        if (cb) {
            cb.reject(new Error('Timeout waiting for device ACK'));
            _ackCallbacks.delete(mid);
        }

        for (const [, entry] of _commandTracker) {
            if (entry.mid === mid && entry.status === 'pending') {
                entry.status = 'failed';
                break;
            }
        }
        return;
    }

    const timer = setTimeout(() => {
        _log('debug', `[cmd-api] MID ${mid}: Retry ${attempt + 1}/${RETRY_INTERVALS.length} (no ACK after ${RETRY_INTERVALS[attempt]}ms)`);
        _sendFn(bridgeId, wsFrame);
        metrics.inc('commands_retried');
        for (const [, entry] of _commandTracker) {
            if (entry.mid === mid && entry.status === 'pending') {
                entry.retries = attempt + 1;
                break;
            }
        }
        scheduleRetry(mid, bridgeId, wsFrame, attempt + 1);
    }, RETRY_INTERVALS[attempt]);

    _pendingCommands.set(mid, { bridgeId, wsFrame, attempt, timer });
}

function handleAckReceived(midInput, deviceIdOrMsg) {
    const mid = Number(midInput);
    const pending = _pendingCommands.get(mid) || _pendingCommands.get(midInput);
    let resolvedDeviceId = null;
    if (deviceIdOrMsg && typeof deviceIdOrMsg === 'object' && deviceIdOrMsg.deviceId) {
        resolvedDeviceId = deviceIdOrMsg.deviceId;
    } else if (typeof deviceIdOrMsg === 'string') {
        resolvedDeviceId = deviceIdOrMsg;
    } else if (pending && pending.bridgeId) {
        resolvedDeviceId = pending.bridgeId;
    }
    const displayId = resolvedDeviceId || 'unknown';

    if (pending) {
        _log('debug', `[cmd-api] Received ACK for MID ${mid} from ${displayId}. Canceling retry timer.`);
        if (pending.timer) clearTimeout(pending.timer);
        _pendingCommands.delete(mid);
        _pendingCommands.delete(midInput);
        metrics.inc('commands_acked');

        for (const [, entry] of _commandTracker) {
            if ((entry.mid === mid || entry.mid === midInput) && entry.status === 'pending') {
                entry.status = 'acked';
                entry.ackedAt = new Date().toISOString();
                break;
            }
        }
    }

    const cb = _ackCallbacks.get(mid) || _ackCallbacks.get(midInput);
    if (cb) {
        let payload = null;
        let coapMsg = null;
        if (deviceIdOrMsg && typeof deviceIdOrMsg === 'object' && deviceIdOrMsg.coapMsg) {
            coapMsg = deviceIdOrMsg.coapMsg;
            if (coapMsg.payload) {
                const raw = coapMsg.payload;
                payload = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.data || raw);
            }
        }
        const hex = payload ? payload.toString('hex') : null;
        const bytes = payload ? Array.from(payload) : null;
        const code = coapMsg ? (coapMsg.codeStr || (coap.formatCode ? coap.formatCode(coapMsg.code) : coapMsg.code)) : null;
        _log('debug', `[cmd-api] Resolving waitForAck for MID ${mid} with payload: ${hex || '(empty)'}`);
        cb.resolve({ ok: true, mid, payload, hex, bytes, coapMsg, code });
        _ackCallbacks.delete(mid);
        _ackCallbacks.delete(midInput);
    }

    const q = _pendingQueries.get(mid) || _pendingQueries.get(midInput);
    if (q) {
        _log('debug', `[cmd-api] Ignoring simple ACK for Query MID ${mid} from ${displayId}. Waiting for actual Content payload response.`);
    }
}

function clearPendingRetries() {
    _log('info', `Clearing ${_pendingCommands.size} pending command retries...`);
    for (const [mid, pending] of _pendingCommands.entries()) {
        if (pending.timer) clearTimeout(pending.timer);
    }
    _pendingCommands.clear();
    _pendingQueries.clear();
    _ackCallbacks.clear();
    _tanocloMids.clear();
    if (_tanocloMidsSweepInterval) {
        clearInterval(_tanocloMidsSweepInterval);
        _tanocloMidsSweepInterval = null;
    }
}

function waitForAck(midInput, timeoutMs = 35000) {
    const mid = Number(midInput);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            if (_ackCallbacks.has(mid) || _ackCallbacks.has(midInput)) {
                _ackCallbacks.delete(mid);
                _ackCallbacks.delete(midInput);
                reject(new Error('Timeout waiting for device ACK'));
            }
        }, timeoutMs);

        const cbObj = {
            resolve: (res) => {
                clearTimeout(timer);
                resolve(res);
            },
            reject: (err) => {
                clearTimeout(timer);
                reject(err);
            }
        };
        _ackCallbacks.set(mid, cbObj);
        if (typeof midInput === 'string') {
            _ackCallbacks.set(midInput, cbObj);
        }
    });
}

function _singleQueryAttempt(bridge, dbDev, coapPath, customExtraOptions = []) {
    return new Promise((resolve, reject) => {
        const mid = getNextMid();
        _tanocloMids.set(mid, Date.now());

        const token = crypto.randomBytes(2);
        const extraOptions = [];
        if (bridge.bridgeClient && bridge.bridgeClient.session2048) {
            extraOptions.push({ num: coap.OPT_VENDOR_2048, value: bridge.bridgeClient.session2048 });
        }
        extraOptions.push({ num: 7, value: Buffer.from([0xff, 0xff]) });
        extraOptions.push({ num: coap.OPT_CONTENT_FORMAT, value: Buffer.from([0x2a]) });
        extraOptions.push({ num: coap.OPT_BLOCK2, value: Buffer.from([0x03]) });
        if (customExtraOptions && customExtraOptions.length > 0) {
            extraOptions.push(...customExtraOptions);
        }

        const coapBytes = coap.buildRequest({
            code: coap.CODE_GET,
            path: coapPath,
            token: token,
            mid: mid,
            type: coap.TYPE_CON,
            extraOptions
        });

        const timer = setTimeout(() => {
            _pendingQueries.delete(mid);
            _tanocloMids.delete(mid);
            const pendingCmd = _pendingCommands.get(mid);
            if (pendingCmd) {
                if (pendingCmd.timer) clearTimeout(pendingCmd.timer);
                _pendingCommands.delete(mid);
            }
            reject(new Error(`Timeout querying ${coapPath} (MID=${mid})`));
        }, QUERY_TIMEOUT_MS);

        _pendingQueries.set(mid, { resolve, reject, timer });

        try {
            sendViaBridge(bridge.bridgeId, bridge.bridgeClient, dbDev.ipv6_address, dbDev.udp_port || 5683, coapBytes, `query:${coapPath}`);
        } catch (err) {
            clearTimeout(timer);
            _pendingQueries.delete(mid);
            _tanocloMids.delete(mid);
            reject(err);
        }
    });
}

const tlv = require('./tlv');

async function queryDeviceConfig(deviceSerial, coapPath) {
    const dbDev = await _db.getDeviceBySerial(deviceSerial) || await _db.getDeviceByFullSerial(deviceSerial);
    if (!dbDev) throw new Error(`Device ${deviceSerial} not found in DB`);
    const bridge = findBridgeForHome(dbDev.home_id);
    if (!bridge) throw new Error(`No bridge connected for home ${dbDev.home_id}`);

    if (dbDev.last_config_json) {
        _log('debug', `[cmd-api] Using cached DB last_config_json for ${deviceSerial} config query`);
        try {
            const rawFields = JSON.parse(dbDev.last_config_json);
            const fields = {};
            const { CONFIG_FIDS_ORDER } = require('./db-utils');
            const CONFIG_KEYS_ORDER = CONFIG_FIDS_ORDER.map(fid => '0x' + fid.toString(16).padStart(4, '0'));
            for (const key of CONFIG_KEYS_ORDER) {
                if (rawFields[key] !== undefined) {
                    fields[key] = rawFields[key];
                }
            }
            const payload = tlv.encodeFromFields(fields);
            const etag = dbDev.config_etag ? dbDev.config_etag.toString('hex') : null;
            return { payload, etag };
        } catch (jsonErr) {
            _log('error', `[cmd-api] Failed to parse last_config_json for ${deviceSerial}: ${jsonErr.message}`);
        }
    }

    for (let attempt = 0; attempt <= MAX_QUERY_RETRIES; attempt++) {
        try {
            return await _singleQueryAttempt(bridge, dbDev, coapPath);
        } catch (err) {
            if (attempt === MAX_QUERY_RETRIES) throw err;
            _log('warn', `Query attempt ${attempt + 1} failed for ${coapPath}, retrying...`);
        }
    }
}

module.exports = {
    init,
    getProxyMidCache,
    getNextMid,
    isTaNoCloOriginatedMid,
    findBridgeForHome,
    sendViaBridge,
    scheduleRetry,
    handleAckReceived,
    clearPendingRetries,
    waitForAck,
    _singleQueryAttempt,
    queryDeviceConfig,
    _commandTracker
};
