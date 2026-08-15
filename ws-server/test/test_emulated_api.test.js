'use strict';

require('./test_config');
const dbDevices = require('../lib/db-devices');

test('db-devices - getAllEsp32Nodes returns array', async () => {
    const nodes = await dbDevices.getAllEsp32Nodes();
    if (!Array.isArray(nodes)) throw new Error('Expected array');
});

test('db-devices - getAllEmulatedDevices returns array', async () => {
    const devices = await dbDevices.getAllEmulatedDevices();
    if (!Array.isArray(devices)) throw new Error('Expected array');
});
