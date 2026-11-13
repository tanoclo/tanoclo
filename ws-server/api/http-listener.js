/**
 * @file api/http-listener.js
 * @brief Dual-stack HTTP listener with an IPv4 fallback for IPv6-disabled hosts.
 */

'use strict';

const http = require('http');

/**
 * @param {Function} app HTTP request handler.
 * @param {{port: number|string, host?: string|null}} options Explicit hosts never fall back.
 * @param {Function} log Server logger.
 * @returns {Promise<import('http').Server>} The listening server, also used for shutdown.
 */
async function listenHttp(app, { port, host = null }, log) {
    const server = http.createServer(app);

    function bind(address) {
        return new Promise((resolve, reject) => {
            function onError(error) {
                server.removeListener('listening', onListening);
                server.removeListener('error', onError);
                reject(error);
            }
            function onListening() {
                server.removeListener('error', onError);
                server.on('error', error => log('error', `[REST-API] Server error: ${error.message}`));
                resolve();
            }
            server.once('error', onError);
            server.once('listening', onListening);
            try {
                server.listen({ port, host: address, ipv6Only: false });
            } catch (error) {
                onError(error);
            }
        });
    }

    try {
        await bind(host || '::');
    } catch (error) {
        // Only automatic IPv6 selection may fall back. Port/permission errors
        // and failures for an explicitly configured host must remain visible.
        if (host || !['EAFNOSUPPORT', 'EPROTONOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) {
            throw error;
        }
        log('warn', `[REST-API] IPv6 unavailable (${error.code}), falling back to IPv4`);
        await bind('0.0.0.0');
    }

    const address = server.address();
    const displayHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    log('info', `[REST-API] Listening on ${displayHost}:${address.port}`);
    return server;
}

module.exports = { listenHttp };
