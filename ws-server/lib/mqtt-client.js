/**
 * @file lib/mqtt-client.js
 * @brief Wrapper for connecting and subscribing to the MQTT broker.
 */

'use strict';

const mqtt = require('mqtt');

let config = null;
let log = null;
let client = null;
let connected = false;
let manuallyClosed = false;
let reconnectDelay = 1000;
let reconnectTimer = null;
const throttles = new Map();
const subscriptions = [];
const onConnectCallbacks = [];

function init(_config, _log) {
    config = _config;
    log = _log;

    if (config.mqtt && config.mqtt.host) {
        _connect();
    } else {
        if (log) log('info', '[mqtt] No MQTT host configured, client not started');
    }
}

function _connect() {
    if (client) return;

    const host = config.mqtt.host;
    const port = config.mqtt.port || 1883;
    const user = config.mqtt.user;
    const password = config.mqtt.password;

    let url;
    if (host.startsWith('mqtt://') || host.startsWith('mqtts://')) {
        url = host;
    } else {
        url = `mqtt://${host}:${port}`;
    }
    const opts = {
        reconnectPeriod: 0, // Disable automatic reconnect so we can do it with backoff
        connectTimeout: 30 * 1000,
        will: {
            topic: 'tado/tanoclo/status',
            payload: 'offline',
            qos: 1,
            retain: true
        }
    };

    if (user) opts.username = user;
    if (password) opts.password = password;

    if (log) log('info', `[mqtt] Connecting to ${url}...`);
    client = mqtt.connect(url, opts);

    client.on('connect', () => {
        connected = true;
        reconnectDelay = 1000;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        if (log) log('info', `[mqtt] Connected successfully to ${url}`);

        // Publish status -> online
        client.publish('tado/tanoclo/status', 'online', { retain: true, qos: 1 }, (err) => {
            if (err && log) log('error', `[mqtt] Failed to publish status: ${err.message}`);
        });

        // Resubscribe to all existing subscriptions
        for (const sub of subscriptions) {
            client.subscribe(sub.topic, { qos: 1 }, (err) => {
                if (err && log) log('error', `[mqtt] Subscription failed for ${sub.topic}: ${err.message}`);
            });
        }

        // Fire onConnect callbacks
        for (const cb of onConnectCallbacks) {
            try {
                cb();
            } catch (e) {
                if (log) log('error', `[mqtt] Error in onConnect callback: ${e.message}`);
            }
        }
    });

    client.on('close', () => {
        if (connected) {
            connected = false;
            if (log) log('info', '[mqtt] Connection closed');
        }
        clearThrottles();
        _handleDisconnect();
    });

    client.on('error', (err) => {
        if (log) log('error', `[mqtt] Client error: ${err.message}`);
        _handleDisconnect();
    });

    client.on('message', (topic, message, packet) => {
        const payloadStr = message.toString();
        for (const sub of subscriptions) {
            if (mqttTopicMatch(sub.topic, topic)) {
                try {
                    sub.handler(topic, payloadStr, packet);
                } catch (e) {
                    if (log) log('error', `[mqtt] Error in handler for topic ${topic}: ${e.message}`);
                }
            }
        }
    });
}

function _handleDisconnect() {
    if (manuallyClosed) return;

    if (!reconnectTimer) {
        if (log) log('info', `[mqtt] Will attempt reconnect in ${reconnectDelay}ms`);
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (client) {
                if (log) log('info', '[mqtt] Reconnecting...');
                client.reconnect();
            } else {
                _connect();
            }
            reconnectDelay = Math.min(reconnectDelay * 2, 30000);
        }, reconnectDelay);
    }
}

function mqttTopicMatch(pattern, topic) {
    const patternSegs = pattern.split('/');
    const topicSegs = topic.split('/');

    for (let i = 0; i < patternSegs.length; i++) {
        const p = patternSegs[i];
        if (p === '#') {
            return true;
        }
        if (p === '+') {
            if (topicSegs[i] === undefined) return false;
            continue;
        }
        if (p !== topicSegs[i]) {
            return false;
        }
    }
    return topicSegs.length === patternSegs.length;
}

function publish(topic, payload, opts) {
    if (!client || !connected) {
        return;
    }

    const finalOpts = Object.assign({ retain: true }, opts);

    const entry = throttles.get(topic);
    if (!entry) {
        // Send immediately
        client.publish(topic, payload, finalOpts, (err) => {
            if (err && log) log('error', `[mqtt] Publish error on ${topic}: ${err.message}`);
        });

        throttles.set(topic, { timer: null, pendingPayload: undefined, pendingOpts: undefined });
        setupTimer(topic);
    } else {
        // Throttle active, save latest payload
        entry.pendingPayload = payload;
        entry.pendingOpts = finalOpts;
    }
}

function setupTimer(topic) {
    const timer = setTimeout(() => {
        if (!client || !connected) {
            throttles.delete(topic);
            return;
        }
        const entry = throttles.get(topic);
        if (entry) {
            if (entry.pendingPayload !== undefined) {
                const pl = entry.pendingPayload;
                const op = entry.pendingOpts;
                entry.pendingPayload = undefined;
                entry.pendingOpts = undefined;

                client.publish(topic, pl, op, (err) => {
                    if (err && log) log('error', `[mqtt] Publish error on ${topic}: ${err.message}`);
                });
                setupTimer(topic);
            } else {
                throttles.delete(topic);
            }
        }
    }, 1000);
    timer.unref(); // Prevent keeping the process alive for pending throttled publishes

    const entry = throttles.get(topic);
    if (entry) {
        entry.timer = timer;
    }
}

function clearThrottles() {
    for (const entry of throttles.values()) {
        clearTimeout(entry.timer);
    }
    throttles.clear();
}

function subscribe(topic, handler) {
    // Prevent duplicate subscriptions for the same topic
    if (subscriptions.find(s => s.topic === topic)) return;
    subscriptions.push({ topic, handler });
    if (client && connected) {
        client.subscribe(topic, { qos: 1 }, (err) => {
            if (err && log) log('error', `[mqtt] Subscription error for ${topic}: ${err.message}`);
        });
    }
}

function isConnected() {
    return connected;
}

function reconnect() {
    return shutdown().then(() => {
        manuallyClosed = false;
        if (config.mqtt && config.mqtt.host) {
            _connect();
        }
    });
}

function shutdown() {
    return new Promise((resolve) => {
        manuallyClosed = true;
        clearThrottles();
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (client) {
            if (connected) {
                client.publish('tado/tanoclo/status', 'offline', { retain: true, qos: 1 }, () => {
                    client.end(false, {}, () => {
                        client = null;
                        connected = false;
                        resolve();
                    });
                });
            } else {
                client.end(true, {}, () => {
                    client = null;
                    connected = false;
                    resolve();
                });
            }
        } else {
            resolve();
        }
    });
}

function onConnect(callback) {
    onConnectCallbacks.push(callback);
    if (connected) {
        try {
            callback();
        } catch (e) {
            if (log) log('error', `[mqtt] Error in immediate onConnect callback: ${e.message}`);
        }
    }
}

module.exports = {
    init,
    publish,
    subscribe,
    isConnected,
    reconnect,
    shutdown,
    onConnect
};
