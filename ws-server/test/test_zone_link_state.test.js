/**
 * @file test/test_zone_link_state.test.js
 * @brief Known measuring-device connectivity outranks cached zone link metadata.
 */

'use strict';

const express = require('express');
const db = require('../lib/db');
const { mapZoneState } = require('../api/routes/zones/helpers');
const stateRouter = require('../api/routes/zones/state');

const timestamp = '2026-01-01T12:00:00.000Z';
const measurement = {
    home_id: 1, zone_id: 1, timestamp,
    field_012d: 20.5, field_0135: 45, field_40a0: 30,
    link_state: 'OFFLINE', tado_mode: 'HOME'
};

describe('zone state link mapping', () => {
    test.each([
        [1, 'OFFLINE', 'ONLINE'], [1, 'ONLINE', 'ONLINE'],
        [0, 'ONLINE', 'OFFLINE'], [0, 'OFFLINE', 'OFFLINE'],
        [null, 'OFFLINE', 'OFFLINE'], [undefined, 'OFFLINE', 'OFFLINE'],
        [null, 'ONLINE', 'ONLINE'], [null, null, 'ONLINE'], [null, undefined, 'ONLINE']
    ])('connection=%s cached=%s maps to %s', (connection, cached, expected) => {
        const result = mapZoneState({ ...measurement, link_state: cached }, null, null, {}, connection);
        expect(result.link.state).toBe(expected);
    });

    test.each([[1, 'ONLINE'], [0, 'OFFLINE'], [null, 'ONLINE']])(
        'handles missing measurement with connection=%s', (connection, expected) => {
            expect(mapZoneState(null, null, null, {}, connection).link.state).toBe(expected);
        }
    );

    test('connectivity changes only the link projection', () => {
        const online = mapZoneState(measurement, null, null, {}, 1, 'AWAY');
        const offline = mapZoneState(measurement, null, null, {}, 0, 'AWAY');
        expect({ ...online, link: null }).toEqual({ ...offline, link: null });
        expect(online.tadoMode).toBe('AWAY');
        expect(online.sensorDataPoints.insideTemperature.celsius).toBe(20.5);
        expect(online.activityDataPoints.heatingPower.percentage).toBe(30);
    });
});

describe('zone state endpoints', () => {
    let server;
    let port;
    let zone;
    let devices;
    let cached;
    let presence;

    beforeAll(async () => {
        const app = express();
        app.use('/api/v2/homes', stateRouter);
        server = await new Promise((resolve, reject) => {
            const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
            listener.once('error', reject);
        });
        port = server.address().port;
    });

    afterAll(async () => {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });

    beforeEach(() => {
        zone = { id: 1, home_id: 1, name: 'Test room', type: 'HEATING', measuring_device_serial: 'VA-test' };
        devices = [{ serial_no: 'VA-test', connection_state: 1 }];
        cached = 'OFFLINE';
        presence = 'HOME';
        const pool = {
            async execute(sql, params) {
                const query = sql.replace(/\s+/g, ' ').trim();
                if (!query.startsWith('SELECT ')) throw new Error('Unexpected write in read-only fixture');
                if (query.includes('FROM homes')) return [[{ date_time_zone: 'Europe/Berlin', presence }]];
                if (query.includes('FROM zone_measurements')) return [[{ ...measurement, link_state: cached }]];
                if (query.includes('FROM zone_overlays') || query.includes('FROM zone_timetables') || query.includes('FROM away_configurations')) return [[]];
                if (query.includes('FROM zones')) return [[zone]];
                if (query.includes('FROM devices')) {
                    if (query.includes('WHERE serial_no = ?')) {
                        expect(params).toEqual(['VA-test', '1']);
                        return [devices.filter(device => device.serial_no === params[0])];
                    }
                    expect(params).toEqual(['1']);
                    return [devices];
                }
                throw new Error('Unexpected fixture query: ' + query);
            }
        };
        vi.spyOn(db, 'getPool').mockReturnValue(pool);
        vi.spyOn(db, 'getHomeTimezone').mockResolvedValue('Europe/Berlin');
        vi.spyOn(db, 'getCurrentScheduleBlock').mockResolvedValue(null);
    });

    afterEach(() => { vi.restoreAllMocks(); });

    const scenarios = [
        { name: 'online device overrides stale offline metadata', connection: 1, cached: 'OFFLINE', expected: 'ONLINE' },
        { name: 'offline device overrides stale online metadata', connection: 0, cached: 'ONLINE', expected: 'OFFLINE' },
        { name: 'null connection preserves offline metadata', connection: null, cached: 'OFFLINE', expected: 'OFFLINE' },
        { name: 'missing device preserves offline metadata', missingDevice: true, cached: 'OFFLINE', expected: 'OFFLINE' },
        { name: 'missing measuring serial preserves offline metadata', missingSerial: true, cached: 'OFFLINE', expected: 'OFFLINE' },
        { name: 'unknown connection preserves online metadata', connection: null, cached: 'ONLINE', expected: 'ONLINE' },
        { name: 'unknown connection and absent metadata retain online default', connection: null, cached: null, expected: 'ONLINE' }
    ];

    for (const endpoint of ['zoneStates', 'zones/1/state']) {
        test.each(scenarios)(`${endpoint}: $name`, async scenario => {
            cached = scenario.cached;
            devices = scenario.missingDevice ? [] : [{ serial_no: 'VA-test', connection_state: scenario.connection ?? null }];
            // Another device's state must not replace the selected measuring device.
            devices.push({ serial_no: 'VA-other', connection_state: scenario.expected === 'ONLINE' ? 0 : 1 });
            if (scenario.missingSerial) zone.measuring_device_serial = null;
            const response = await fetch(`http://127.0.0.1:${port}/api/v2/homes/1/${endpoint}`, {
                headers: { Connection: 'close' }
            });
            expect(response.status).toBe(200);
            const body = await response.json();
            const state = endpoint === 'zoneStates' ? body.zoneStates['1'] : body;
            expect(state.link.state).toBe(scenario.expected);
            expect(state.sensorDataPoints.insideTemperature.celsius).toBe(20.5);
        });

        test(`${endpoint}: preserves home presence and away settings`, async () => {
            presence = 'AWAY';
            const response = await fetch(`http://127.0.0.1:${port}/api/v2/homes/1/${endpoint}`, {
                headers: { Connection: 'close' }
            });
            expect(response.status).toBe(200);
            const body = await response.json();
            const state = endpoint === 'zoneStates' ? body.zoneStates['1'] : body;
            expect(state.link.state).toBe('ONLINE');
            expect(state.tadoMode).toBe('AWAY');
            expect(state.setting.temperature.celsius).toBe(15);
        });
    }
});
