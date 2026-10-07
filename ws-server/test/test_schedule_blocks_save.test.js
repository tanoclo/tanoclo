'use strict';

const assert = require('assert');
const db = require('../lib/db');
const router = require('../api/routes/zones/schedule');

const BASE = '/:homeId/zones/:zoneId/schedule';
const ROUTES = {
    putBlocks: ['put', `${BASE}/timetables/:timetableId/blocks/:dayType`],
    getBlocks: ['get', `${BASE}/timetables/:timetableId/blocks`],
    getDayBlocks: ['get', `${BASE}/timetables/:timetableId/blocks/:dayType`],
    putActive: ['put', `${BASE}/activeTimetable`],
};

function handler(name) {
    const [method, path] = ROUTES[name];
    const layer = router.stack.find(l => l.route && l.route.path === path && l.route.methods[method]);
    assert.ok(layer, `${name} route is registered`);
    return layer.route.stack[0].handle;
}

const tick = () => new Promise(resolve => setImmediate(resolve));

/**
 * In-memory stand-in for the three schedule tables. Connections serialise on the
 * `SELECT ... FROM zones ... FOR UPDATE` lock until commit/rollback, like InnoDB would,
 * and every statement yields so concurrent requests really interleave.
 */
function makeFakeDb({ failOn } = {}) {
    const state = { timetables: [], blocks: [], nextId: 1 };
    const log = [];
    const stats = { connections: 0, released: 0, poolStatements: 0 };
    let lockTail = Promise.resolve();

    function run(sql, params) {
        const stmt = sql.replace(/\s+/g, ' ').trim();
        let m;
        if (/^SELECT id FROM zones .* FOR UPDATE$/.test(stmt)) return [[{ id: 1 }]];
        if (/^SELECT type FROM zones/.test(stmt)) return [[{ type: 'HEATING' }]];
        if (/^SELECT id FROM zone_timetables/.test(stmt)) {
            return [state.timetables.filter(t => t.type === params[2]).map(t => ({ id: t.id }))];
        }
        if (/^INSERT INTO zone_timetables/.test(stmt)) {
            const row = { id: state.nextId++, type: params[2], is_active: /is_active\)/.test(stmt) ? 1 : 0 };
            state.timetables.push(row);
            return [{ insertId: row.id, affectedRows: 1 }];
        }
        if (/^UPDATE zone_timetables SET is_active = 0/.test(stmt)) {
            state.timetables.forEach(t => { t.is_active = 0; });
            return [{ affectedRows: state.timetables.length }];
        }
        if ((m = /^UPDATE zone_timetables SET is_active = 1 .* AND type = \?/.exec(stmt))) {
            const hit = state.timetables.filter(t => t.type === params[2]);
            hit.forEach(t => { t.is_active = 1; });
            return [{ affectedRows: hit.length }];
        }
        if (/^SELECT COUNT\(\*\) as c FROM schedule_blocks/.test(stmt)) {
            return [[{ c: state.blocks.filter(b => b.timetable_id === params[0]).length }]];
        }
        if (/^SELECT id, day_type, .* FROM schedule_blocks/.test(stmt)) {
            const rows = state.blocks.filter(b => b.timetable_id === params[0] && (params.length < 3 || b.day_type === params[2]));
            return [rows.map(b => ({ ...b }))];
        }
        if (/^INSERT INTO schedule_blocks/.test(stmt)) {
            const isDefault = stmt.includes("'00:00', '00:00'");
            state.blocks.push({
                id: state.nextId++, timetable_id: params[0], day_type: params[2],
                start_time: isDefault ? '00:00' : params[3], end_time: isDefault ? '00:00' : params[4],
                geolocation_override: 0, setting_type: 'HEATING', setting_power: 'ON',
                setting_temp_celsius: isDefault ? params[4] : params[8], setting_temp_fahrenheit: null,
            });
            return [{ affectedRows: 1 }];
        }
        if (/^DELETE FROM schedule_blocks/.test(stmt)) {
            state.blocks = state.blocks.filter(b => !(b.timetable_id === params[0] && b.day_type === params[2]));
            return [{ affectedRows: 1 }];
        }
        if (/^UPDATE zones SET last_schedule_change_at/.test(stmt)) return [{ affectedRows: 1 }];
        throw new Error(`fake db: unhandled statement: ${stmt}`);
    }

    function makeConnection() {
        stats.connections++;
        let releaseLock = null;
        const unlock = () => { if (releaseLock) { releaseLock(); releaseLock = null; } };
        return {
            beginTransaction: async () => { log.push('BEGIN'); },
            commit: async () => { log.push('COMMIT'); unlock(); },
            rollback: async () => { log.push('ROLLBACK'); unlock(); },
            release: () => { stats.released++; unlock(); },
            execute: async (sql, params = []) => {
                const stmt = sql.replace(/\s+/g, ' ').trim();
                log.push(stmt);
                if (/FOR UPDATE$/.test(stmt) && /FROM zones/.test(stmt)) {
                    const previous = lockTail;
                    let release;
                    lockTail = new Promise(resolve => { release = resolve; });
                    await previous;
                    releaseLock = release;
                }
                await tick();
                if (failOn && failOn.test(stmt)) throw new Error('boom');
                return run(sql, params);
            },
        };
    }

    return {
        state, log, stats,
        pool: {
            getConnection: async () => makeConnection(),
            execute: async (sql, params = []) => { stats.poolStatements++; await tick(); return run(sql, params); },
        },
    };
}

function makeRes() {
    const res = { statusCode: 200, body: undefined };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}

const params = (extra = {}) => ({ homeId: '1', zoneId: '6', timetableId: '0', dayType: 'MONDAY_TO_SUNDAY', ...extra });

const BLOCKS = [
    { start: '00:00', end: '20:00', setting: { type: 'HEATING', power: 'ON', temperature: { celsius: 5 } } },
    { start: '20:00', end: '24:00', setting: { type: 'HEATING', power: 'ON', temperature: { celsius: 20 } } },
];

describe('schedule writes are atomic and serialised per zone', () => {
    const realGetPool = db.getPool;
    let fake;
    beforeEach(() => { fake = makeFakeDb(); db.getPool = () => fake.pool; });
    afterEach(() => { db.getPool = realGetPool; });

    describe('PUT blocks', () => {
        test('deletes and inserts in one transaction that holds the zone lock', async () => {
            const res = makeRes();
            await handler('putBlocks')({ params: params(), body: BLOCKS }, res);

            assert.strictEqual(res.statusCode, 200);
            assert.deepStrictEqual(res.body, BLOCKS);
            assert.strictEqual(fake.log[0], 'BEGIN');
            assert.ok(/FROM zones .* FOR UPDATE$/.test(fake.log[1]), 'zone row is locked first');
            assert.strictEqual(fake.log[fake.log.length - 1], 'COMMIT');
            assert.strictEqual(fake.stats.poolStatements, 0, 'nothing runs outside the transaction');
            assert.strictEqual(fake.stats.released, 1);
            assert.strictEqual(fake.state.blocks.length, BLOCKS.length);
        });

        test('overlapping saves of the same day leave exactly one copy of the blocks', async () => {
            const results = await Promise.all([1, 2, 3].map(async () => {
                const res = makeRes();
                await handler('putBlocks')({ params: params(), body: BLOCKS }, res);
                return res.statusCode;
            }));

            assert.deepStrictEqual(results, [200, 200, 200]);
            assert.strictEqual(fake.state.blocks.length, BLOCKS.length);
            assert.strictEqual(fake.state.timetables.length, 1);
        });

        test('rolls back and releases the connection when an insert fails', async () => {
            fake = makeFakeDb({ failOn: /^INSERT INTO schedule_blocks/ });
            db.getPool = () => fake.pool;
            const res = makeRes();
            await handler('putBlocks')({ params: params(), body: BLOCKS }, res);

            assert.strictEqual(res.statusCode, 500);
            assert.ok(fake.log.includes('ROLLBACK'));
            assert.ok(!fake.log.includes('COMMIT'));
            assert.strictEqual(fake.stats.released, 1);
        });

        test('rejects a non-array body without touching the database', async () => {
            const res = makeRes();
            await handler('putBlocks')({ params: params(), body: { start: '00:00' } }, res);

            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(fake.stats.connections, 0);
            assert.strictEqual(fake.stats.poolStatements, 0);
        });
    });

    describe('GET blocks seeding defaults', () => {
        test('concurrent first loads create one timetable and one default block per day', async () => {
            const bodies = await Promise.all([1, 2, 3].map(async () => {
                const res = makeRes();
                await handler('getBlocks')({ params: params({ timetableId: '1' }) }, res);
                return res.body;
            }));

            assert.strictEqual(fake.state.timetables.length, 1);
            assert.strictEqual(fake.state.blocks.length, 3, 'THREE_DAY seeds 3 day types once');
            for (const body of bodies) assert.strictEqual(body.length, 3);
        });

        test('concurrent first loads of a single day also seed only once', async () => {
            await Promise.all([1, 2, 3].map(async () => {
                await handler('getDayBlocks')({ params: params() }, makeRes());
            }));

            assert.strictEqual(fake.state.timetables.length, 1);
            assert.strictEqual(fake.state.blocks.length, 1);
        });

        test('takes no lock and opens no transaction once blocks exist', async () => {
            await handler('putBlocks')({ params: params(), body: BLOCKS }, makeRes());
            fake.stats.connections = 0;

            const res = makeRes();
            await handler('getBlocks')({ params: params() }, res);

            assert.strictEqual(res.body.length, BLOCKS.length);
            assert.strictEqual(fake.stats.connections, 0);
        });
    });

    describe('PUT activeTimetable', () => {
        test('switches the active timetable in one transaction', async () => {
            await handler('getBlocks')({ params: params({ timetableId: '0' }) }, makeRes()); // ONE_DAY exists
            fake.log.length = 0;
            fake.stats.poolStatements = 0;

            const res = makeRes();
            await handler('putActive')({ params: params(), body: { id: 1 } }, res);

            assert.deepStrictEqual(res.body, { id: 1, type: 'THREE_DAY' });
            assert.strictEqual(fake.log[0], 'BEGIN');
            assert.strictEqual(fake.log[fake.log.length - 1], 'COMMIT');
            assert.strictEqual(fake.stats.poolStatements, 0);
            const active = fake.state.timetables.filter(t => t.is_active === 1);
            assert.deepStrictEqual(active.map(t => t.type), ['THREE_DAY']);
            assert.strictEqual(fake.state.blocks.filter(b => b.timetable_id === active[0].id).length, 3);
        });

        test('concurrent switches leave exactly one active timetable and one seed', async () => {
            await Promise.all([1, 2, 3].map(() => handler('putActive')({ params: params(), body: { id: 2 } }, makeRes())));

            assert.strictEqual(fake.state.timetables.length, 1);
            assert.strictEqual(fake.state.timetables[0].is_active, 1);
            assert.strictEqual(fake.state.blocks.length, 7, 'SEVEN_DAY seeds 7 day types once');
        });
    });
});
