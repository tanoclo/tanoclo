/**
 * @file lib/handlers/coap-helpers.js
 * @brief Shared parser helpers for CoAP message extraction.
 */

'use strict';

const crypto = require('crypto');
const { getLogger } = require('../logger');
const log = getLogger();

let coap, wsBridge, clients, messageCache, proxyConnections, config, downlinkBlockSessions;

function init(deps) {
    coap = deps.coap;
    wsBridge = deps.wsBridge;
    clients = deps.clients;
    messageCache = deps.messageCache;
    proxyConnections = deps.proxyConnections;
    config = deps.config;
    downlinkBlockSessions = deps.downlinkBlockSessions;
}

function sendCoAPAck(ws, coapMsg, peerInfo, originalDirection, responseCode = null) {
    let code = responseCode;
    if (!code) {
        // Method-aware default codes per RFC 7252
        if (coapMsg.code === coap.CODE_GET) {
            code = coap.CODE_CONTENT; // 2.05 Content
        } else {
            code = coap.CODE_CHANGED; // 2.04 Changed
        }
    }

    // Echo Block1/Block2 if present in request (RFC 7252 / RFC 7959)
    const options = [];
    const b1 = coap.optionFirst(coapMsg, coap.OPT_BLOCK1);
    if (b1) options.push({ num: coap.OPT_BLOCK1, value: b1 });
    const b2 = coap.optionFirst(coapMsg, coap.OPT_BLOCK2);
    if (b2) options.push({ num: coap.OPT_BLOCK2, value: b2 });

    const ackBytes = options.length > 0
        ? coap.buildAckWithOptions(coapMsg, code, options)
        : coap.buildAck(coapMsg, code);

    const responseDir = originalDirection === wsBridge.DIR_CLIENT_TO_SERVER
        ? wsBridge.DIR_SERVER_TO_CLIENT
        : wsBridge.DIR_CLIENT_TO_SERVER;
    sendWrappedCoAP(ws, ackBytes, peerInfo, responseDir);
}

async function sendCoAPWithBlock2(ws, coapMsg, fullPayload, etag, contentFormat, peerInfo, directionU16) {
    const block2Opt = coap.optionFirst(coapMsg, coap.OPT_BLOCK2);
    const clientBlock = block2Opt ? coap.decodeBlock(block2Opt) : { num: 0, szx: 3, blockSize: 128 };

    // Check if client provided an ETag for validation (Conditional GET)
    const clientEtag = coap.optionFirst(coapMsg, coap.OPT_ETAG);
    if (clientEtag && etag && Buffer.compare(clientEtag, etag) === 0 && clientBlock.num === 0) {
        log('debug', `ETag match for ${coap.uriPath(coapMsg)}, sending 2.03 Valid`);
        const validBytes = coap.buildAckWithOptions(coapMsg, coap.CODE_VALID, [
            { num: coap.OPT_ETAG, value: etag },
            { num: coap.OPT_BLOCK2, value: coap.encodeBlock2(0, 0, clientBlock.szx) }
        ]);
        sendWrappedCoAP(ws, validBytes, peerInfo, directionU16);
        return;
    }

    const sessionKey = `${peerInfo.ipv6}:${coap.uriPath(coapMsg)}`;
    let session = downlinkBlockSessions.get(sessionKey);

    // Block 0 or new session: Snapshot the resource
    if (clientBlock.num === 0 || !session) {
        session = {
            payload: fullPayload,
            etag: etag,
            expiresAt: Date.now() + 60000
        };
        downlinkBlockSessions.set(sessionKey, session);
        log('debug', `Started multi-block session for ${sessionKey} (Length: ${fullPayload.length}B)`);
    } else {
        // Refresh session TTL
        session.expiresAt = Date.now() + 60000;
    }

    const blockSize = clientBlock.blockSize || 128;
    const offset = clientBlock.num * blockSize;
    const end = Math.min(offset + blockSize, session.payload.length);
    const chunk = session.payload.subarray(offset, end);
    const more = end < session.payload.length ? 1 : 0;

    // Build options in ascending order: ETag(4) → ContentFormat(12) → Block2(23)
    const options = [];

    // Ensure we always have an ETag if the resource is versioned (not /neighbors)
    let finalEtag = session.etag;
    const isNeighbors = coap.uriPath(coapMsg).endsWith('/neighbors');
    if (!finalEtag && !isNeighbors) {
        // Generate stable fallback ETag from payload
        finalEtag = crypto.createHash('md5').update(fullPayload).digest().subarray(0, 8);
    }

    if (finalEtag && !isNeighbors) options.push({ num: coap.OPT_ETAG, value: finalEtag });
    if (contentFormat != null) options.push({ num: coap.OPT_CONTENT_FORMAT, value: coap.encOptUint(contentFormat) });

    // Always include Block2 if the client requested it or if there's more data
    if (block2Opt || more === 1) {
        options.push({ num: coap.OPT_BLOCK2, value: coap.encodeBlock2(clientBlock.num, more, clientBlock.szx) });
    }

    const ackBytes = coap.buildAckWithOptions(coapMsg, coap.CODE_CONTENT, options, chunk);
    sendWrappedCoAP(ws, ackBytes, peerInfo, directionU16);

    if (more === 0) {
        log('debug', `Finished multi-block session for ${sessionKey}`);
        downlinkBlockSessions.delete(sessionKey);
    } else {
        log('debug', `Sent block ${clientBlock.num} for ${sessionKey} (${chunk.length} bytes, more=${more})`);
    }
}

function sendWrappedCoAP(ws, coapBytes, peerInfo, directionU16) {
    const direction = directionU16 === wsBridge.DIR_SERVER_TO_CLIENT ? 'server_to_client' : 'client_to_server';
    const isDownlink = (directionU16 === wsBridge.DIR_SERVER_TO_CLIENT);

    const wsFrame = wsBridge.build({
        direction,
        ipv6: peerInfo.ipv6,
        coapBytes,
        fieldA: isDownlink ? 4 : peerInfo.fieldA,
        fieldB: isDownlink ? 2 : peerInfo.fieldB,
        udpPort: peerInfo.udpPort,
        fieldC: isDownlink ? 5 : peerInfo.fieldC,
    });

    // Cache recreated downlink messages even when proxied
    if (directionU16 === wsBridge.DIR_SERVER_TO_CLIENT) {
        let deviceId = null;
        for (const [id, info] of clients.entries()) {
            if (info.ws === ws) { deviceId = id; break; }
        }
        if (deviceId) {
            messageCache.cacheMessage(deviceId, wsFrame, 'recreated');
        }
    }

    if (proxyConnections.has(ws)) {
        let isReboot = false;
        try {
            const coapMsg = coap.parse(coapBytes);
            if (coapMsg.ok) {
                const uriPathStr = coap.uriPath(coapMsg);
                if (uriPathStr && (uriPathStr === 'd/reboot' || uriPathStr.endsWith('/reboot') || uriPathStr.includes('reboot'))) {
                    isReboot = true;
                }
            }
        } catch (e) {}

        if (!isReboot) {
            log('debug', 'Skipping local WS send because connection is proxied to real server.');
            return;
        }
    }
    log('debug', `Sending WS Frame: isBuffer=${Buffer.isBuffer(wsFrame)} len=${wsFrame.length}`);
    if (config.logLevel === 'debug') {
        log('debug', `CoAP TX hex: ${coapBytes.toString('hex')}`);
        log('debug', `Raw TX hex: ${wsFrame.toString('hex')}`);
    }

    try {
        if (!ws.isClosed) {
            ws.send(wsFrame, true);
        } else {
            log('debug', `Skipping WS send: socket is already closed`);
        }
    } catch (err) {
        if (!ws.isClosed) {
            log('error', `Failed to send WS frame: ${err.message}`);
        }
    }
}

function sortZoneStateFields(fields) {
    const ZONE_STATE_FIDS_ORDER = [
        0x6160, 0x6180, 0x6020, 0x61e0, 0x6200, 0x6240, 0x6260, 0x6280, 0x62e0, 0x6440
    ];

    const getFid = (key) => {
        if (key.startsWith('0x')) {
            return parseInt(key, 16);
        }
        return null;
    };

    const keysWithFids = Object.keys(fields).map(key => ({
        key,
        fid: getFid(key)
    }));

    keysWithFids.sort((a, b) => {
        const idxA = a.fid !== null ? ZONE_STATE_FIDS_ORDER.indexOf(a.fid) : -1;
        const idxB = b.fid !== null ? ZONE_STATE_FIDS_ORDER.indexOf(b.fid) : -1;

        if (idxA !== -1 && idxB !== -1) {
            return idxA - idxB;
        }
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;

        if (a.fid !== null && b.fid !== null) {
            return a.fid - b.fid;
        }
        return a.key.localeCompare(b.key);
    });

    const sorted = {};
    for (const item of keysWithFids) {
        sorted[item.key] = fields[item.key];
    }
    return sorted;
}

module.exports = {
    init,
    sendCoAPAck,
    sendCoAPWithBlock2,
    sendWrappedCoAP,
    sortZoneStateFields
};
