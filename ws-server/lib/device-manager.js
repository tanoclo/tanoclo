/**
 * @file lib/device-manager.js
 * @brief State tracking cache for active websocket bridge clients.
 */

'use strict';

// Connection and session maps
const clients = new Map();
const deviceSessions = new Map();
const wsToBridgeId = new Map();
const blockedBridges = new Map();

function extractShortSerial(deviceId) {
    if (!deviceId) return null;
    return deviceId.trim();
}

function blockBridge(deviceId, durationMs = 120000, onExpire = null) {
    const cleanId = extractShortSerial(deviceId);
    if (!cleanId) return null;

    if (process.send && process.env.IS_CHILD_PROCESS === 'true') {
        process.send({ type: 'BLOCK_BRIDGE', deviceId: cleanId, durationMs });
    }

    unblockBridge(cleanId);

    // Find and terminate all matching sockets
    for (const [ws, bId] of wsToBridgeId.entries()) {
        if (bId === cleanId || bId === deviceId || (cleanId && bId && bId.includes(cleanId))) {
            wsToBridgeId.delete(ws);
            try { ws.close(); } catch (e) {}
            try { ws.end(); } catch (e) {}
        }
    }

    const clientInfo = clients.get(cleanId);
    if (clientInfo && clientInfo.ws) {
        try { clientInfo.ws.close(); } catch (e) {}
        try { clientInfo.ws.end(); } catch (e) {}
    }
    clients.delete(cleanId);

    const unblockAt = Date.now() + durationMs;
    const timer = setTimeout(() => {
        blockedBridges.delete(cleanId);
        if (typeof onExpire === 'function') {
            try { onExpire(cleanId); } catch (e) {}
        }
    }, durationMs);
    timer.unref();

    const record = { unblockAt, timer, pendingDisablePairing: true };
    blockedBridges.set(cleanId, record);
    return record;
}

function unblockBridge(deviceId) {
    const cleanId = extractShortSerial(deviceId);
    if (!cleanId) return;

    if (process.send && process.env.IS_CHILD_PROCESS === 'true') {
        process.send({ type: 'UNBLOCK_BRIDGE', deviceId: cleanId });
    }

    for (const id of Array.from(blockedBridges.keys())) {
        if (id === cleanId || id.includes(cleanId) || cleanId.includes(id)) {
            const existing = blockedBridges.get(id);
            if (existing && existing.timer) clearTimeout(existing.timer);
            blockedBridges.delete(id);
        }
    }
}

function isBridgeBlocked(deviceId, ip = null) {
    if (blockedBridges.size === 0) return false;
    const cleanId = extractShortSerial(deviceId);
    if (!cleanId) {
        for (const [id, record] of blockedBridges.entries()) {
            if (Date.now() < record.unblockAt) {
                return true;
            } else {
                unblockBridge(id);
            }
        }
        return false;
    }

    for (const [id, record] of blockedBridges.entries()) {
        if (cleanId === id || cleanId.includes(id) || id.includes(cleanId)) {
            if (Date.now() < record.unblockAt) {
                return true;
            } else {
                unblockBridge(id);
            }
        }
    }

    return false;
}

function getBridgeBlockStatus(deviceId) {
    const cleanId = extractShortSerial(deviceId);
    if (!cleanId || !blockedBridges.has(cleanId)) {
        return { active: false, remainingSeconds: 0 };
    }
    const record = blockedBridges.get(cleanId);
    const remainingMs = record.unblockAt - Date.now();
    if (remainingMs <= 0) {
        unblockBridge(cleanId);
        return { active: false, remainingSeconds: 0 };
    }
    return { active: true, remainingSeconds: Math.ceil(remainingMs / 1000) };
}

module.exports = {
    clients,
    deviceSessions,
    wsToBridgeId,
    blockedBridges,
    extractShortSerial,
    blockBridge,
    unblockBridge,
    isBridgeBlocked,
    getBridgeBlockStatus
};

