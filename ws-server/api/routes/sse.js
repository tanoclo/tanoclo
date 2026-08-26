/**
 * @file api/routes/sse.js
 * @brief Server-Sent Events (SSE) streaming connections routes.
 * 
 * Supports browser-based push notifications, manages ticket token generation, handles CORS
 * streaming HTTP connections, and handles periodic keepalive heartbeat broadcasts.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../../lib/config');
const db = require('../../lib/db');
const { getLogger } = require('../../lib/logger');
const authMiddleware = require('../middleware/auth');
const rateLimit = require('express-rate-limit');
const metrics = require('../../lib/metrics');

const router = express.Router();
const _log = getLogger('sse');

// homeId -> Set<Response>
const connections = new Map();
const MAX_CONNECTIONS_PER_HOME = 20;

// SSE Tickets: ticketId -> { homeId, userId, expiresAt }
const sseTickets = new Map();

// Cleanup expired tickets every 60s
const ticketCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [ticket, info] of sseTickets.entries()) {
        if (now > info.expiresAt) {
            sseTickets.delete(ticket);
        }
    }
}, 60000);
// Prevent keeping the process alive just for the cleanup timer
ticketCleanupInterval.unref();

async function sseAuth(req, res, next) {
    const ticket = req.query.ticket;
    if (ticket) {
        const ticketInfo = sseTickets.get(ticket);
        if (!ticketInfo) {
            return res.status(401).json({ error: 'invalid_ticket', error_description: 'Ticket not found or expired' });
        }
        sseTickets.delete(ticket); // Single use
        if (Date.now() > ticketInfo.expiresAt) {
            return res.status(401).json({ error: 'invalid_ticket', error_description: 'Ticket has expired' });
        }
        const homeId = parseInt(req.params.homeId, 10);
        if (ticketInfo.homeId !== homeId) {
            return res.status(403).json({ error: 'forbidden', error_description: 'Ticket not valid for this home' });
        }
        req.user = {
            id: ticketInfo.userId,
            homes: [homeId]
        };
        return next();
    }

    // Authenticate via standard Bearer header
    let token = null;
    if (req.headers.authorization) {
        const authHeader = req.headers.authorization;
        if (authHeader.startsWith('Bearer ')) {
            token = authHeader.split(' ')[1];
        }
    }

    if (!token) {
        return res.status(401).json({ error: 'unauthorized', error_description: 'Authentication is required' });
    }

    try {
        const { verifyBearerToken } = require('../middleware/verify-bearer');
        req.user = await verifyBearerToken(token);

        const homeId = parseInt(req.params.homeId, 10);
        if (!req.user.homes.includes(homeId)) {
            return res.status(403).json({ error: 'forbidden', error_description: 'No access to this home' });
        }

        next();
    } catch (err) {
        _log('warn', `SSE auth failed: ${err.message}`);
        return res.status(401).json({ error: 'invalid_token', error_description: err.message });
    }
}

// Rate limiter for SSE ticket requests (10 per minute per IP)
const sseLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false },
    message: { error: 'too_many_requests', error_description: 'Too many SSE ticket requests.' }
});

// POST endpoint to get a short-lived SSE ticket
router.post('/homes/:homeId/events/ticket', sseLimiter, authMiddleware, (req, res) => {
    const homeId = parseInt(req.params.homeId, 10);
    const userHomes = req.user.homes || [];
    if (!userHomes.includes(homeId)) {
        return res.status(403).json({ error: 'forbidden', error_description: 'No access to this home' });
    }

    const ticket = crypto.randomUUID();
    const expiresAt = Date.now() + 30000; // 30 seconds
    sseTickets.set(ticket, {
        homeId,
        userId: req.user.id,
        expiresAt
    });

    res.json({ ticket });
});

router.get('/homes/:homeId/events', sseAuth, (req, res) => {
    const homeId = String(req.params.homeId);

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no' // nginx support
    });

    res.write(`event: connected\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);

    if (!connections.has(homeId)) {
        connections.set(homeId, new Set());
    }
    const homeClients = connections.get(homeId);
    homeClients.add(res);

    // Evict oldest connection if limit exceeded
    if (homeClients.size > MAX_CONNECTIONS_PER_HOME) {
        const oldest = homeClients.values().next().value;
        _log('warn', `SSE: evicted oldest connection for home ${homeId} (limit ${MAX_CONNECTIONS_PER_HOME})`);
        removeClient(homeId, oldest);
        try { oldest.end(); } catch (e) {}
    }

    const keepalive = setInterval(() => {
        try {
            res.write(':\n\n'); // SSE spec comment heartbeat
        } catch (e) {
            clearInterval(keepalive);
            removeClient(homeId, res);
        }
    }, 30000);
    res._sseKeepalive = keepalive; // store ref for cleanup on broadcast failure

    req.on('close', () => {
        clearInterval(keepalive);
        removeClient(homeId, res);
    });

    _updateSseGauge();
});

function removeClient(homeId, res) {
    if (res._sseKeepalive) {
        clearInterval(res._sseKeepalive);
        res._sseKeepalive = null;
    }
    const homeClients = connections.get(homeId);
    if (homeClients) {
        homeClients.delete(res);
        if (homeClients.size === 0) {
            connections.delete(homeId);
        }
    }
    _updateSseGauge();
}

// Periodic sweep to detect stale SSE connections (e.g. proxy timeout without close event)
const staleSweepInterval = setInterval(() => {
    for (const [homeId, clients] of connections.entries()) {
        for (const res of clients) {
            if (res.writableEnded || res.destroyed) {
                _log('debug', `SSE: sweeping stale connection for home ${homeId}`);
                removeClient(homeId, res);
            }
        }
    }
}, 60000);
staleSweepInterval.unref();

function broadcastToHome(homeId, event, data) {
    const homeClients = connections.get(String(homeId));
    if (!homeClients || homeClients.size === 0) {
        _log('debug', `[SSE] No active SSE clients connected for home ${homeId} (total connected homes: ${connections.size})`);
        return;
    }

    _log('debug', `[SSE] Broadcasting event '${event}' to ${homeClients.size} client(s) for home ${homeId}`);
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of homeClients) {
        try {
            res.write(msg);
        } catch (e) {
            removeClient(String(homeId), res);
        }
    }
}

module.exports = {
    router,
    broadcastToHome
};

/** Update the metrics gauge with total SSE client count across all homes */
function _updateSseGauge() {
    let total = 0;
    for (const clients of connections.values()) total += clients.size;
    metrics.gauge('sse_connections', total);
}
