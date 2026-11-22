'use strict';
const { ingestWeather } = require('../lib/mqtt-weather');
const weather = require('../lib/weather-source');
const now = Date.parse('2026-11-22T12:00:00Z');
let values, db, publishHomeTelemetry;
beforeEach(() => {
    values = new Map([['weather_source_1', 'mqtt']]);
    const execute = vi.fn(async (sql, params) => {
        if (sql.includes('FROM homes')) return [params[0] === 1 ? [{ id: 1 }] : []];
        if (sql.startsWith('SELECT value')) return [values.has(params[0]) ? [{ value: values.get(params[0]) }] : []];
        if (sql.startsWith('INSERT INTO server_settings')) { values.set(params[0], params[1]); return [{}]; }
        if (sql.includes('FROM home_weather')) return [[]];
        throw new Error(sql);
    });
    db = { getPool: () => ({ execute }) };
    publishHomeTelemetry = vi.fn(async () => {});
});
test('selected MQTT input persists observation time and publishes the selected temperature', async () => {
    const payload = JSON.stringify({ temperature: 5.2, observed_at: '2026-11-22T11:30:00Z' });
    expect(await ingestWeather(db, { publishHomeTelemetry }, 'tado/tanoclo/h/1/weather/telemetry', payload, now)).toBe(true);
    const status = await weather.getReading(db, 1, now);
    expect(status).toMatchObject({ source: 'mqtt', stale: false, ageSeconds: 1800, reading: { outside_temp_celsius: 5.2 } });
    expect(publishHomeTelemetry).toHaveBeenCalledWith(1);
    expect(await ingestWeather(db, null, 'tado/tanoclo/h/1/weather/telemetry', payload, now)).toBe(false);
    expect((await weather.getReading(db, 1, now + 3 * 3600000)).stale).toBe(true);
});
test.each(['bad', '{}', '{"temperature":null}', '{"temperature":"5"}', '{"temperature":100}', '{"temperature":5,"observed_at":"bad"}', '{"temperature":5,"observed_at":"2026-11-22T08:00:00Z"}'])('rejects invalid or stale payload %s', async payload => {
    expect(await ingestWeather(db, null, 'tado/tanoclo/h/1/weather/telemetry', payload, now)).toBe(false);
    expect(values.has('mqtt_weather_1')).toBe(false);
});
test('Open-Meteo is default and unselected/unknown-home MQTT data is ignored', async () => {
    values.clear();
    expect(await weather.getSource(db, 1)).toBe('open_meteo');
    expect(await ingestWeather(db, null, 'tado/tanoclo/h/1/weather/telemetry', '{"temperature":5}', now)).toBe(false);
    expect(await ingestWeather(db, null, 'tado/tanoclo/h/2/weather/telemetry', '{"temperature":5}', now)).toBe(false);
    await expect(weather.setSource(db, 1, 'invalid')).rejects.toThrow();
});
