'use strict';
require('./test_config');
const db = require('../lib/db');
const source = require('../lib/weather-source');
const publisher = require('../lib/mqtt-publisher');
const router = require('../api/routes/homes/weather');
const handler = method => router.stack.find(l => l.route?.path === '/:homeId/weather-source' && l.route.methods[method]).route.stack[0].handle;
afterEach(() => vi.restoreAllMocks());
test.each(['get', 'put'])('%s rejects access to another home', async method => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(method)({ params: { homeId: '1' }, user: { homes: [2] }, body: { source: 'mqtt' } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
});
test('source selection is validated, persisted and republished', async () => {
    const save = vi.spyOn(source, 'setSource').mockResolvedValue();
    vi.spyOn(publisher, 'publishHomeTelemetry').mockResolvedValue();
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const req = { params: { homeId: '1' }, user: { homes: [1] }, body: { source: 'bad' } };
    await handler('put')(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(save).not.toHaveBeenCalled();
    req.body.source = 'mqtt';
    await handler('put')(req, res);
    expect(save).toHaveBeenCalledWith(db, '1', 'mqtt');
    expect(res.json).toHaveBeenLastCalledWith({ source: 'mqtt' });
});
