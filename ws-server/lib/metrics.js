/**
 * @file lib/metrics.js
 * @brief Performance counters and telemetry statistics tracker.
 */

'use strict';

/**
 * Metrics — lightweight observability counters for the TaNoClo WS server.
 *
 * Tracks command delivery rates, retry rates, ACK latency, uplink/downlink
 * message counts, and error rates. Exposed via GET /api/metrics.
 *
 * No external dependencies — plain in-memory counters with periodic snapshots.
 */

const _counters = {
    // Commands
    commands_sent: 0,
    commands_acked: 0,
    commands_retried: 0,
    commands_failed: 0,       // gave up after max retries

    // Messages
    uplink_messages: 0,
    downlink_messages: 0,
    proxy_up: 0,
    proxy_down: 0,

    // Protocol
    block1_reassembled: 0,
    block2_sessions: 0,
    etag_matches: 0,
    etag_misses: 0,

    // Errors
    handler_errors: 0,
    db_errors: 0,
    ws_send_errors: 0,

    // Auth
    auth_accepted: 0,
    auth_rejected: 0,

    // Sessions
    connections_total: 0,
    disconnections_total: 0,
};

// Histograms: track ACK latency buckets
const _ackLatencies = [];   // recent ACK latency samples (ms)
const MAX_LATENCY_SAMPLES = 1000;

// Gauges: current values
const _gauges = {
    connected_clients: 0,
    pending_retries: 0,
    active_block_sessions: 0,
};

const _startTime = Date.now();

/**
 * Increment a counter by 1 (or a specified amount).
 * @param {string} name - Counter name (must exist in _counters)
 * @param {number} [amount=1]
 */
function inc(name, amount = 1) {
    if (_counters[name] !== undefined) {
        _counters[name] += amount;
    }
}

/**
 * Set a gauge to a specific value.
 * @param {string} name - Gauge name
 * @param {number} value
 */
function gauge(name, value) {
    _gauges[name] = value;
}

/**
 * Record an ACK latency sample (milliseconds).
 * @param {number} ms
 */
function recordAckLatency(ms) {
    _ackLatencies.push(ms);
    if (_ackLatencies.length > MAX_LATENCY_SAMPLES) {
        _ackLatencies.shift();
    }
}

/**
 * Get all metrics as a JSON-serializable object.
 */
function getAll() {
    const uptimeMs = Date.now() - _startTime;
    const uptimeSec = Math.floor(uptimeMs / 1000);

    // Compute ACK latency percentiles
    let ackP50 = 0, ackP95 = 0, ackP99 = 0, ackAvg = 0;
    if (_ackLatencies.length > 0) {
        const sorted = [..._ackLatencies].sort((a, b) => a - b);
        ackP50 = sorted[Math.floor(sorted.length * 0.50)] || 0;
        ackP95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
        ackP99 = sorted[Math.floor(sorted.length * 0.99)] || 0;
        ackAvg = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
    }

    return {
        uptime_seconds: uptimeSec,
        counters: { ..._counters },
        gauges: { ..._gauges },
        ack_latency_ms: {
            samples: _ackLatencies.length,
            avg: ackAvg,
            p50: ackP50,
            p95: ackP95,
            p99: ackP99,
        },
        rates: {
            commands_success_rate: _counters.commands_sent > 0
                ? Math.round((_counters.commands_acked / _counters.commands_sent) * 10000) / 100
                : 100,
            commands_retry_rate: _counters.commands_sent > 0
                ? Math.round((_counters.commands_retried / _counters.commands_sent) * 10000) / 100
                : 0,
        },
    };
}

/**
 * Reset all counters (for testing).
 */
function reset() {
    for (const key of Object.keys(_counters)) _counters[key] = 0;
    for (const key of Object.keys(_gauges)) _gauges[key] = 0;
    _ackLatencies.length = 0;
}

module.exports = { inc, gauge, recordAckLatency, getAll, reset };
