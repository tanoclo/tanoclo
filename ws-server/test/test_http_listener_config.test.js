'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

function loadConfig(env) {
    const filename = path.resolve(__dirname, '../lib/config.js');
    const context = {
        module: { exports: {} }, process: { env }, console,
        __dirname: path.dirname(filename), require: Module.createRequire(filename)
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    return context.module.exports;
}

describe('REST listener environment configuration', () => {
    test.each([
        [{}, 3111, null],
        [{ HTTP_API_PORT: '8081' }, 8081, null],
        [{ API_PORT: '8082' }, 8082, null],
        [{ API_PORT: '8082', HTTP_API_PORT: '8081' }, 8082, null],
        [{ HTTP_API_PORT: '0' }, 0, null],
        [{ API_HOST: '127.0.0.1' }, 3111, '127.0.0.1'],
        [{ HTTP_API_HOST: '::1' }, 3111, '::1'],
        [{ API_HOST: '127.0.0.1', HTTP_API_HOST: '::1' }, 3111, '127.0.0.1'],
        [{ API_HOST: '', HTTP_API_HOST: '::1' }, 3111, '::1']
    ])('loads %j as port=%s host=%s', (env, port, host) => {
        const config = loadConfig(env);
        expect(config.httpApiPort).toBe(port);
        expect(config.httpApiHost).toBe(host);
    });
});
