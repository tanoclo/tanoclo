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
const _midToTrackingId = new Map();
let _trackingIdCounter = 1;
const _pendingCommands = new Map();
const _pendingQueries = new Map();
const _ackCallbacks = new Map();
const _tanocloMids = new Map(); // mid -> timestamp
const _sleepyDownlinkQueue = new Map(); // deviceId -> Map(pathKey -> queueItem)
const _deviceLastSeen = new Map(); // deviceId -> timestamp
const _latestZoneState = new Map(); // Resource key -> current intent object (not a reusable MID)
const _supersededMids = new Map(); // MID -> time of supersession, including untracked/queued commands
const SUPERSEDED_TTL_MS = 2 * 60 * 1000;
const MAX_SUPERSEDED_MIDS = 500;
const SLEEPY_AWAKE_WINDOW_MS = 4000;
const QUEUE_TTL_MS = 2 * 60 * 60 * 1000;

// Per-bridge downlink burst pacing queue: prevents 802.15.4 CSL preamble collisions and 6LoWPAN queue overflow
const _bridgePacingQueues = new Map(); // bridgeId -> Array of queued items
const _bridgePacingActive = new Map(); // bridgeId -> boolean
let _downlinkPacingMs = (process.env.VITEST || process.env.NODE_ENV === 'test') ? 0 : 200;

const RETRY_INTERVALS = [6000, 13000, 26000, 50000, 90000];
const QUERY_TIMEOUT_MS = 5000;
const MAX_QUERY_RETRIES = 2;

/**
 * Server-originated MID range: 0x7000 - 0xFFFF (36,864 unique values).
 * Avoids collision with device-side MIDs (0x0000 - 0x6FFF) per Contiki er-coap.
 * See message-router/index.js for the same constraint.
 */
let _serverMid = Math.floor(Math.random() * 0x9000);

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
            for (const [mid, ts] of _supersededMids) {
                if (ts < cutoff) _supersededMids.delete(mid);
            }
        }, 60 * 1000);
        _tanocloMidsSweepInterval.unref();
    }
}

function getProxyMidCache() {
    return _proxyMidCache;
}

function getNextMid() {
    const mid = 0x7000 + (_serverMid % 0x9000);
    _serverMid = (_serverMid + 1) % 0x9000;
    return mid;
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

function releaseZoneState(item) {
    if (item && _latestZoneState.get(item.resourceKey) === item) {
        _latestZoneState.delete(item.resourceKey);
    }
}

function supersededCommandError() {
    return Object.assign(new Error('Superseded by newer zone state'), { code: 'COMMAND_SUPERSEDED' });
}

function replaceZoneState(item) {
    const previous = _latestZoneState.get(item.resourceKey);
    _latestZoneState.set(item.resourceKey, item);
    if (!previous) return;

    _supersededMids.delete(previous.mid);
    _supersededMids.set(previous.mid, Date.now());
    if (_supersededMids.size > MAX_SUPERSEDED_MIDS) {
        _supersededMids.delete(_supersededMids.keys().next().value);
    }

    const pending = _pendingCommands.get(previous.mid);
    if (pending && pending.intent === previous) {
        clearTimeout(pending.timer);
        _pendingCommands.delete(previous.mid);
    }
    const tracking = _commandTracker.get(_midToTrackingId.get(previous.mid));
    if (tracking && tracking.status === 'pending') tracking.status = 'superseded';

    const callback = _ackCallbacks.get(previous.mid) || _ackCallbacks.get(String(previous.mid));
    _ackCallbacks.delete(previous.mid);
    _ackCallbacks.delete(String(previous.mid));
    if (callback) {
        callback.reject(supersededCommandError());
    }

    const queue = _bridgePacingQueues.get(item.bridgeId);
    if (queue) {
        _bridgePacingQueues.set(item.bridgeId, queue.filter(entry => entry.resourceKey !== item.resourceKey));
    }
}

function _dispatchDownlinkFrame(item) {
    const { bridgeId, wsFrame, coapBytes, commandLabel, targetIpv6 } = item;
    if (item.resourceKey && _latestZoneState.get(item.resourceKey) !== item) return;
    _log('debug', `[cmd-api] CoAP TX hex: ${coapBytes.toString('hex')}`);
    _log('debug', `[cmd-api] Raw TX hex: ${wsFrame.toString('hex')}`);

    const coapPath = coap.uriPath(item.parsedCoap) || commandLabel || '';
    commandLog.logWsCommand(bridgeId, commandLabel || 'unlabeled', coapPath || 'unlabeled', coapBytes, wsFrame);

    if (typeof _sendFn === 'function') {
        _sendFn(bridgeId, wsFrame);
    }
    metrics.inc('commands_sent');

    if (coapBytes.length >= 4) {
        const mid = coapBytes.readUInt16BE(2);
        _tanocloMids.set(mid, Date.now());
        if (coapPath && _proxyMidCache) {
            _proxyMidCache.set(mid, { path: coapPath, ts: Date.now() });
        }
        scheduleRetry(mid, bridgeId, wsFrame, 0, item.resourceKey ? item : null);

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
            _midToTrackingId.set(mid, trackingId);
            if (_commandTracker.size > 500) {
                const firstKey = _commandTracker.keys().next().value;
                const oldEntry = _commandTracker.get(firstKey);
                if (oldEntry && _midToTrackingId.get(oldEntry.mid) === firstKey) {
                    _midToTrackingId.delete(oldEntry.mid);
                }
                _commandTracker.delete(firstKey);
            }
        }
    }
}

function _processNextPacedDownlink(bridgeId) {
    const queue = _bridgePacingQueues.get(bridgeId);
    if (!queue || queue.length === 0) {
        _bridgePacingActive.set(bridgeId, false);
        return;
    }

    _bridgePacingActive.set(bridgeId, true);
    const nextItem = queue.shift();
    _dispatchDownlinkFrame(nextItem);

    const timer = setTimeout(() => {
        _processNextPacedDownlink(bridgeId);
    }, _downlinkPacingMs);
    if (timer.unref) timer.unref();
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

    const parsed = coap.parse(coapBytes);
    const item = { bridgeId, bridgeClient, targetIpv6, targetPort, coapBytes, commandLabel, wsFrame, parsedCoap: parsed };
    if (parsed.ok && parsed.code === coap.CODE_PUT && coap.uriPath(parsed) === 'z/s') {
        const query = parsed.options.filter(option => option.num === coap.OPT_URI_QUERY);
        const fragmented = parsed.options.some(option => option.num === coap.OPT_BLOCK1);
        // Only complete, unambiguous zone-state writes are replaceable.
        if (!fragmented && query.length === 1 && /^id=\d+$/.test(query[0].value.toString())) {
            const zoneId = query[0].value.toString().slice(3).replace(/^0+(?=\d)/, '');
            item.resourceKey = JSON.stringify([
                bridgeId, wsBridge.ipv6ToBytes(targetIpv6).toString('hex'), targetPort || 5683, zoneId
            ]);
            item.mid = parsed.mid;
            replaceZoneState(item);
        }
    }
    // A new request may reuse a MID. Clear history after replacement so a
    // same-MID successor is not mistaken for its superseded predecessor.
    if (parsed.ok && parsed.code > 0 && parsed.code < 32) _supersededMids.delete(parsed.mid);

    if (!bridgeId || _downlinkPacingMs <= 0) {
        _dispatchDownlinkFrame(item);
        return;
    }

    if (!_bridgePacingQueues.has(bridgeId)) {
        _bridgePacingQueues.set(bridgeId, []);
    }
    const queue = _bridgePacingQueues.get(bridgeId);

    if (!_bridgePacingActive.get(bridgeId)) {
        _bridgePacingActive.set(bridgeId, true);
        _dispatchDownlinkFrame(item);
        const timer = setTimeout(() => {
            _processNextPacedDownlink(bridgeId);
        }, _downlinkPacingMs);
        if (timer.unref) timer.unref();
    } else {
        queue.push(item);
        _log('debug', `[cmd-api] Downlink pacing: Queued frame for ${targetIpv6} on bridge ${bridgeId} (queue length: ${queue.length})`);
    }
}

function scheduleRetry(mid, bridgeId, wsFrame, attempt, intent = null) {
    if (intent && _latestZoneState.get(intent.resourceKey) !== intent) return;
    const existing = _pendingCommands.get(mid);
    if (existing && existing.timer) clearTimeout(existing.timer);

    if (attempt >= RETRY_INTERVALS.length) {
        _log('warn', `[cmd-api] MID ${mid}: Giving up after ${attempt} retries (no ACK received)`);
        _pendingCommands.delete(mid);
        releaseZoneState(intent);
        metrics.inc('commands_failed');

        const cb = _ackCallbacks.get(mid);
        if (cb) {
            cb.reject(new Error('Timeout waiting for device ACK'));
            _ackCallbacks.delete(mid);
        }

        const trId = _midToTrackingId.get(mid);
        if (trId !== undefined) {
            const entry = _commandTracker.get(trId);
            if (entry && entry.status === 'pending') {
                entry.status = 'failed';
            }
        }
        return;
    }

    const pending = { bridgeId, wsFrame, attempt, intent, timer: null };
    const timer = setTimeout(() => {
        // A canceled callback may already be runnable. Compare intent identity,
        // not just MID, since the MID generator eventually wraps.
        if (_pendingCommands.get(mid) !== pending ||
            (intent && _latestZoneState.get(intent.resourceKey) !== intent)) return;
        _log('debug', `[cmd-api] MID ${mid}: Retry ${attempt + 1}/${RETRY_INTERVALS.length} (no ACK after ${RETRY_INTERVALS[attempt]}ms)`);
        _sendFn(bridgeId, wsFrame);
        metrics.inc('commands_retried');
        const trId = _midToTrackingId.get(mid);
        if (trId !== undefined) {
            const entry = _commandTracker.get(trId);
            if (entry && entry.status === 'pending') {
                entry.retries = attempt + 1;
            }
        }
        scheduleRetry(mid, bridgeId, wsFrame, attempt + 1, intent);
    }, RETRY_INTERVALS[attempt]);

    pending.timer = timer;
    _pendingCommands.set(mid, pending);
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
        releaseZoneState(pending.intent);
        metrics.inc('commands_acked');

        const trId = _midToTrackingId.get(mid) ?? _midToTrackingId.get(midInput);
        if (trId !== undefined) {
            const entry = _commandTracker.get(trId);
            if (entry && entry.status === 'pending') {
                entry.status = 'acked';
                entry.ackedAt = new Date().toISOString();
            }
        }
    }

    let payload = null;
    let coapMsg = null;
    if (deviceIdOrMsg && typeof deviceIdOrMsg === 'object' && deviceIdOrMsg.coapMsg) {
        coapMsg = deviceIdOrMsg.coapMsg;
        if (coapMsg.payload) {
            const raw = coapMsg.payload;
            payload = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.data || raw);
        }
    }

    const cb = _ackCallbacks.get(mid) || _ackCallbacks.get(midInput);
    if (cb) {
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
        if (payload && payload.length > 0) {
            if (q.timer) clearTimeout(q.timer);
            _pendingQueries.delete(mid);
            _pendingQueries.delete(midInput);
            let etag = null;
            if (coapMsg && coapMsg.options) {
                const etagOpt = coapMsg.options.find(o => o.num === 4 || o.num === coap.OPT_ETAG);
                if (etagOpt && etagOpt.value) {
                    etag = Buffer.isBuffer(etagOpt.value) ? etagOpt.value : Buffer.from(etagOpt.value);
                }
            }
            _log('debug', `[cmd-api] Resolving query for MID ${mid} from ${displayId} with payload (${payload.length}B)`);
            q.resolve({ payload, etag, coapMsg });
        } else {
            _log('debug', `[cmd-api] Ignoring simple ACK for Query MID ${mid} from ${displayId}. Waiting for actual Content payload response.`);
        }
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
    _sleepyDownlinkQueue.clear();
    _deviceLastSeen.clear();
    _latestZoneState.clear();
    _supersededMids.clear();
    _bridgePacingQueues.clear();
    _bridgePacingActive.clear();
    if (_tanocloMidsSweepInterval) {
        clearInterval(_tanocloMidsSweepInterval);
        _tanocloMidsSweepInterval = null;
    }
}

function waitForAck(midInput, timeoutMs = 35000) {
    const mid = Number(midInput);
    const supersededAt = _supersededMids.get(mid);
    if (supersededAt !== undefined) {
        if (Date.now() - supersededAt < SUPERSEDED_TTL_MS) {
            return Promise.reject(supersededCommandError());
        }
        _supersededMids.delete(mid);
    }
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

    try {
        const { buildDeviceConfigTLV } = require('./db-utils');
        const payload = await buildDeviceConfigTLV(deviceSerial, dbDev);
        if (payload && payload.length > 0) {
            _log('debug', `[cmd-api] Built canonical DB config for ${deviceSerial} (${payload.length}B)`);
            const etag = dbDev.config_etag ? dbDev.config_etag.toString('hex') : null;
            return { payload, etag };
        }
    } catch (buildErr) {
        _log('warn', `[cmd-api] Failed building canonical config for ${deviceSerial}: ${buildErr.message}`);
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

function isDebugMid(mid) {
    if (mid === undefined || mid === null) return false;
    const trId = _midToTrackingId.get(Number(mid)) ?? _midToTrackingId.get(mid);
    if (trId !== undefined) {
        const entry = _commandTracker.get(trId);
        if (entry && entry.command && entry.command.startsWith('debug:')) {
            return true;
        }
    }
    return false;
}

function isSleepyDevice(deviceId) {
    if (!deviceId || typeof deviceId !== 'string') return false;
    return deviceId.toUpperCase().startsWith('VA');
}

function recordDeviceActivity(deviceId) {
    if (!deviceId) return;
    _deviceLastSeen.set(deviceId, Date.now());
}

function isDeviceAwake(deviceId) {
    if (!deviceId) return false;
    const last = _deviceLastSeen.get(deviceId);
    if (last && (Date.now() - last < SLEEPY_AWAKE_WINDOW_MS)) {
        return true;
    }
    if (_clients && _clients.has(deviceId)) {
        const info = _clients.get(deviceId);
        if (info && info.lastMessageAt) {
            const diff = Date.now() - new Date(info.lastMessageAt).getTime();
            if (diff >= 0 && diff < SLEEPY_AWAKE_WINDOW_MS) return true;
        }
    }
    return false;
}

function queueSleepyDownlink(deviceId, item) {
    if (!deviceId || !item) return;
    if (!_sleepyDownlinkQueue.has(deviceId)) {
        _sleepyDownlinkQueue.set(deviceId, new Map());
    }
    const devQueue = _sleepyDownlinkQueue.get(deviceId);
    const pathKey = item.path || 'default';
    _log('info', `[cmd-api] Device ${deviceId} is sleeping. Queuing downlink command for /${pathKey} (MID=${item.mid})`);
    devQueue.set(pathKey, {
        ...item,
        enqueuedAt: Date.now()
    });
}

function drainSleepyDownlink(deviceId) {
    if (!deviceId) return;
    recordDeviceActivity(deviceId);
    const devQueue = _sleepyDownlinkQueue.get(deviceId);
    if (!devQueue || devQueue.size === 0) return;

    _sleepyDownlinkQueue.delete(deviceId);
    _log('info', `[cmd-api] Device ${deviceId} woke up. Draining ${devQueue.size} queued downlink command(s)...`);

    setTimeout(() => {
        let delay = 0;
        for (const [pathKey, item] of devQueue.entries()) {
            if (Date.now() - item.enqueuedAt > QUEUE_TTL_MS) {
                _log('warn', `[cmd-api] Dropping expired queued downlink command for ${deviceId} /${pathKey}`);
                continue;
            }
            setTimeout(() => {
                _log('info', `[cmd-api] Dispatching queued downlink to ${deviceId}: /${pathKey} (MID=${item.mid})`);
                try {
                    sendViaBridge(item.bridgeId, item.bridgeClient, item.targetIpv6, item.targetPort, item.coapBytes, item.commandLabel);
                } catch (err) {
                    _log('error', `[cmd-api] Error dispatching queued downlink to ${deviceId}: ${err.message}`);
                }
            }, delay);
            delay += 150;
        }
    }, 120);
}

function getSleepyQueue(deviceId) {
    if (deviceId) return _sleepyDownlinkQueue.get(deviceId) || null;
    return _sleepyDownlinkQueue;
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
    _commandTracker,
    isDebugMid,
    isSleepyDevice,
    recordDeviceActivity,
    isDeviceAwake,
    queueSleepyDownlink,
    drainSleepyDownlink,
    getSleepyQueue,
    getBridgePacingQueue: (bridgeId) => _bridgePacingQueues.get(bridgeId) || [],
    clearBridgePacingQueue: (bridgeId) => {
        for (const [id, queue] of _bridgePacingQueues) {
            if (!bridgeId || id === bridgeId) queue.forEach(releaseZoneState);
        }
        if (bridgeId) _bridgePacingQueues.delete(bridgeId);
        else _bridgePacingQueues.clear();
        if (bridgeId) _bridgePacingActive.delete(bridgeId);
        else _bridgePacingActive.clear();
    },
    setDownlinkPacingMs: (ms) => { _downlinkPacingMs = ms; },
    getDownlinkPacingMs: () => _downlinkPacingMs
};