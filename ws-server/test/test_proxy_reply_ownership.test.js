const fs = require('fs');
const vm = require('vm');
const acorn = require('acorn');
const coap = require('../lib/coap');

function setup(proxied) {
    const filename = require.resolve('../server');
    const source = fs.readFileSync(filename, 'utf8');
    const node = acorn.parse(source, { ecmaVersion: 'latest' }).body
        .find(item => item.type === 'FunctionDeclaration' && item.id.name === 'sendToDevice');
    const ws = { send: vi.fn() };
    const cacheMessage = vi.fn();
    const send = vm.runInNewContext('(' + source.slice(node.start, node.end) + ')', {
        clients: new Map([['bridge', { ws, homeId: 1 }]]),
        proxyConnections: new Map(proxied ? [[ws, {}]] : []),
        db: { isOffline: () => false, getHome: async () => ({ allow_commands_in_proxy: 1 }) },
        messageCache: { cacheMessage }, proxyMidCache: new Map(),
        wsBridge: { parse: bytes => ({ ok: true, coapBytes: bytes }) },
        coap, Buffer, log: () => {}
    }, { filename });
    return { send, ws, cacheMessage };
}

test.each([0, 0x45, 0x84])('caches but does not forward local CoAP reply %i on a proxied socket', async code => {
    const { send, ws, cacheMessage } = setup(true);
    const reply = Buffer.from([0x60, code, 0, 1]);
    await send('bridge', reply);
    expect(cacheMessage).toHaveBeenCalledWith('bridge', reply, 'TANOCLO');
    expect(ws.send).not.toHaveBeenCalled();
});

test('still forwards allowed local requests on a proxied socket', async () => {
    const { send, ws } = setup(true);
    const request = coap.buildRequest({ code: coap.CODE_PUT, path: 'z/s', mid: 1 });
    await send('bridge', request);
    expect(ws.send).toHaveBeenCalledWith(request, true);
});

test('still forwards local replies on a standalone socket', async () => {
    const { send, ws } = setup(false);
    const reply = Buffer.from([0x60, 0x45, 0, 1]);
    await send('bridge', reply);
    expect(ws.send).toHaveBeenCalledWith(reply, true);
});
