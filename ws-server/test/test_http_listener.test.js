/**
 * @file test/test_http_listener.test.js
 * @brief Real dual-stack HTTP connections and listener failure handling.
 */

'use strict';

const http = require('http');
const { EventEmitter } = require('events');
const { listenHttp } = require('../api/http-listener');

const unavailableCodes = ['EAFNOSUPPORT', 'EPROTONOSUPPORT', 'EADDRNOTAVAIL'];
const handler = (_req, res) => { res.end('listener-ok'); };

function request(hostname, port) {
    return new Promise((resolve, reject) => {
        const req = http.get({ hostname, port, path: '/', agent: false }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(2000, () => req.destroy(new Error('HTTP request timed out')));
    });
}

function close(server) {
    return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

function mockServer(errors = []) {
    const server = new EventEmitter();
    server.address = () => {
        const options = server.listen.mock.calls[server.listen.mock.calls.length - 1][0];
        return { address: options.host, family: options.host.includes(':') ? 'IPv6' : 'IPv4', port: 3111 };
    };
    server.listen = vi.fn(() => {
        const error = errors.shift();
        process.nextTick(() => server.emit(error ? 'error' : 'listening', ...(error ? [error] : [])));
        return server;
    });
    vi.spyOn(http, 'createServer').mockReturnValue(server);
    return server;
}

function bindError(code) {
    return Object.assign(new Error(code), { code });
}

afterEach(() => { vi.restoreAllMocks(); });

describe('HTTP listener', () => {
    test('the default listener accepts IPv4 HTTP connections', async () => {
        const log = vi.fn();
        const server = await listenHttp(handler, { port: 0 }, log);
        try {
            const port = server.address().port;
            expect(await request('127.0.0.1', port)).toEqual({ status: 200, body: 'listener-ok' });
            expect(log).toHaveBeenCalledWith('info', expect.stringContaining(`:${port}`));
        } finally {
            await close(server);
        }
    });

    test('the default listener serves IPv4 and IPv6 on the same port', async context => {
        const server = await listenHttp(handler, { port: 0 }, vi.fn());
        try {
            if (server.address().family !== 'IPv6') {
                context.skip(); // IPv6 is unavailable on this test host.
                return;
            }
            const port = server.address().port;
            let response;
            try {
                response = await request('::1', port);
            } catch (error) {
                // Some kernels allow binding :: with IPv6 disabled, but have no
                // IPv6 loopback route. Connection refusal must still fail.
                if (['EADDRNOTAVAIL', 'ENETUNREACH', 'EAFNOSUPPORT'].includes(error.code)) {
                    context.skip();
                    return;
                }
                throw error;
            }
            expect(response).toEqual({ status: 200, body: 'listener-ok' });
            expect(await request('127.0.0.1', port)).toEqual({ status: 200, body: 'listener-ok' });
        } finally {
            await close(server);
        }
    });

    test('an explicit IPv4 address remains IPv4-only', async () => {
        const log = vi.fn();
        const server = await listenHttp(handler, { port: 0, host: '127.0.0.1' }, log);
        try {
            const address = server.address();
            expect(address.family).toBe('IPv4');
            expect(address.address).toBe('127.0.0.1');
            expect(await request('127.0.0.1', address.port)).toEqual({ status: 200, body: 'listener-ok' });
            expect(log).toHaveBeenCalledWith('info', `[REST-API] Listening on 127.0.0.1:${address.port}`);
        } finally {
            await close(server);
        }
    });

    test.each(unavailableCodes)('falls back to IPv4 for automatic IPv6 bind failure %s', async code => {
        const server = mockServer([bindError(code)]);
        const log = vi.fn();
        expect(await listenHttp(handler, { port: 3111 }, log)).toBe(server);
        expect(server.listen.mock.calls.map(([options]) => options)).toEqual([
            { port: 3111, host: '::', ipv6Only: false },
            { port: 3111, host: '0.0.0.0', ipv6Only: false }
        ]);
        expect(log).toHaveBeenCalledWith('warn', expect.stringContaining(code));
        expect(log).toHaveBeenCalledWith('info', '[REST-API] Listening on 0.0.0.0:3111');
        expect(server.listenerCount('error')).toBe(0);
        expect(server.listenerCount('listening')).toBe(0);
    });

    test.each(['EADDRINUSE', 'EACCES'])('does not hide %s by falling back', async code => {
        const error = bindError(code);
        const server = mockServer([error]);
        const log = vi.fn();
        await expect(listenHttp(handler, { port: 3111 }, log)).rejects.toBe(error);
        expect(server.listen).toHaveBeenCalledTimes(1);
        expect(log).not.toHaveBeenCalled();
        expect(server.listenerCount('listening')).toBe(0);
    });

    test.each(unavailableCodes)('does not fall back from an explicit IPv6 host for %s', async code => {
        const error = bindError(code);
        const server = mockServer([error]);
        await expect(listenHttp(handler, { port: 3111, host: '::1' }, vi.fn())).rejects.toBe(error);
        expect(server.listen).toHaveBeenCalledTimes(1);
        expect(server.listen).toHaveBeenCalledWith({ port: 3111, host: '::1', ipv6Only: false });
    });

    test('reports a failed IPv4 fallback without logging successful startup', async () => {
        const error = bindError('EADDRINUSE');
        const server = mockServer([bindError('EAFNOSUPPORT'), error]);
        const log = vi.fn();
        await expect(listenHttp(handler, { port: 3111 }, log)).rejects.toBe(error);
        expect(server.listen).toHaveBeenCalledTimes(2);
        expect(log).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith('warn', expect.any(String));
    });

    test('logs the bound IPv6 address and cleans up temporary listeners', async () => {
        const server = mockServer();
        const log = vi.fn();
        expect(await listenHttp(handler, { port: 3111 }, log)).toBe(server);
        expect(log).toHaveBeenCalledWith('info', '[REST-API] Listening on [::]:3111');
        expect(server.listenerCount('error')).toBe(0);
        expect(server.listenerCount('listening')).toBe(0);
    });

    test('cleans up listeners when listen throws synchronously', async () => {
        const server = mockServer();
        const error = bindError('ERR_SOCKET_BAD_PORT');
        server.listen.mockImplementation(() => { throw error; });
        await expect(listenHttp(handler, { port: -1 }, vi.fn())).rejects.toBe(error);
        expect(server.listenerCount('error')).toBe(0);
        expect(server.listenerCount('listening')).toBe(0);
    });
});
