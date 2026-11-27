'use strict';

const config = require('../lib/config');
const cron = require('../lib/cron');
const flowOptimizer = require('../lib/flow-optimizer');
const owd = require('../lib/owd-detector');

test.each([false, true])('cron keeps maintenance when external controller is %s', external => {
    const previous = config.externalScheduler;
    vi.useFakeTimers();
    const intervals = vi.spyOn(global, 'setInterval');
    config.externalScheduler = external;
    try {
        cron.start({});
        const callbacks = intervals.mock.calls.map(([callback]) => callback.name);
        expect(callbacks).toContain('checkInactiveDevices');
        expect(callbacks).toContain('runCleanup');
        for (const task of ['checkZones', 'evaluateAllHomesPresence', 'evaluateAllHomesAutoProfiles']) {
            expect(callbacks.includes(task)).toBe(!external);
        }
    } finally {
        cron.stop();
        config.externalScheduler = previous;
        intervals.mockRestore();
        vi.useRealTimers();
    }
});

test('external controller mode suppresses reactive control before it reads the database', async () => {
    const previous = config.externalController;
    const db = { getPool: vi.fn(() => { throw new Error('Unexpected database access'); }) };
    vi.useFakeTimers();
    config.externalController = true;
    try {
        flowOptimizer.init(db);
        const timerCount = vi.getTimerCount();
        flowOptimizer.scheduleEvaluation(1);
        expect(vi.getTimerCount()).toBe(timerCount);
        await flowOptimizer.evaluateAllHomes();
        await owd.evaluate(1, 10, { temperature: 19 });
        expect(db.getPool).not.toHaveBeenCalled();
    } finally {
        config.externalController = previous;
        vi.useRealTimers();
    }
});
