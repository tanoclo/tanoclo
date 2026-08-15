/**
 * @file lib/device-manager.js
 * @brief State tracking cache for active websocket bridge clients.
 */

'use strict';

// Connection and session maps
const clients = new Map();
const deviceSessions = new Map();
const wsToBridgeId = new Map();

function extractShortSerial(deviceId) {
    if (!deviceId) return null;
    return deviceId.trim();
}

module.exports = {
    clients,
    deviceSessions,
    wsToBridgeId,
    extractShortSerial
};
