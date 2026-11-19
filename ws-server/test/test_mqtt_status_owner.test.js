const { EventEmitter } = require('events');
const fs = require('fs');
const vm = require('vm');

function connect(options) {
    const module = { exports: {} };
    const socket = new EventEmitter();
    socket.publish = vi.fn((topic, payload, opts, done) => done());
    socket.end = vi.fn((force, opts, done) => done());
    const broker = { connect: vi.fn(() => socket) };
    const filename = require.resolve('../lib/mqtt-client');
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, require: name => name === 'mqtt' ? broker : require(name)
    }, { filename });
    module.exports.init({ mqtt: { host: 'localhost' } }, undefined, options);
    socket.emit('connect');
    return { client: module.exports, socket, options: broker.connect.mock.calls[0][1] };
}

test('starting and stopping the API worker cannot change backend availability', async () => {
    const backend = connect();
    const api = connect({ ownsStatus: false });

    expect(backend.options.will).toMatchObject({ topic: 'tado/tanoclo/status', payload: 'offline', retain: true });
    expect(backend.socket.publish.mock.calls.map(call => call.slice(0, 2)))
        .toEqual([['tado/tanoclo/status', 'online']]);
    expect(api.options.will).toBeUndefined();
    expect(api.socket.publish).not.toHaveBeenCalled();

    await api.client.shutdown();
    expect(api.socket.publish).not.toHaveBeenCalled();
    await backend.client.shutdown();
    expect(backend.socket.publish.mock.calls.at(-1).slice(0, 2))
        .toEqual(['tado/tanoclo/status', 'offline']);
});
