'use strict';
require('./test_config');
const db = require('../lib/db');
const coordinator = require('../lib/zone-coordinator');
const router = require('../api/routes/zones/devices');

const route = router.stack.find(layer => layer.route?.path === '/:homeId/zones/:zoneId/virtual-sensor' && layer.route.methods.get).route.stack[0].handle;

afterEach(() => vi.restoreAllMocks());

test.each([
    [{ field_012d: '22.21', field_0135: '64.09', field_40a0: '0.00', field_6280: '22.00', timestamp: '2026-11-22 09:07:00' }, { temperature: 22.21, humidity: 64.09, demand: 0, setpoint: 22 }],
    [{ field_012d: null, field_0135: null, field_40a0: null, field_6280: null }, { temperature: null, humidity: null, demand: null, setpoint: null }],
    [null, null]
])('settings reads shared measurements even without API-worker coordinator state: %j', async (measurement, expected) => {
    const execute = vi.fn(async (sql, params) => {
        if (sql.includes('FROM zones')) return [[{ measuring_device_serial: 'IB_VS_1_1' }]];
        if (sql.includes('FROM devices')) return [[{ serial_no: 'IB_VS_1_1', is_virtual_leader: 1, connection_state: 1 }]];
        if (sql.includes('FROM zone_measurements')) {
            expect(params).toEqual(['1', '1206133']);
            return [measurement ? [measurement] : []];
        }
        throw new Error(`Unexpected query: ${sql}`);
    });
    vi.spyOn(db, 'getPool').mockReturnValue({ execute });
    vi.spyOn(coordinator, 'getZoneState').mockReturnValue(null);
    vi.spyOn(coordinator, 'getObservers').mockReturnValue([]);
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    await route({ params: { homeId: '1206133', zoneId: '1' } }, res);
    expect(res.status).not.toHaveBeenCalled();
    const response = res.json.mock.calls[0][0];
    expect(response.isVirtualLeader).toBe(true);
    if (expected) {
        expect(response.state).toMatchObject(expected);
        expect(response.state.lastPushTimestamp).toBeNull();
        expect(response.state.lastPushedValues).toBeNull();
    } else expect(response.state).toBeNull();
});
