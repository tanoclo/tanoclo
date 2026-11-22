'use strict';
const weatherSource = require('./weather-source');
async function ingestWeather(db, publisher, topic, payload, now = Date.now()) {
    const match = /^tado\/tanoclo\/h\/([1-9]\d*)\/weather\/telemetry$/.exec(topic);
    if (!match) return false;
    let data;
    try { data = JSON.parse(String(payload)); } catch { return false; }
    if (!data || typeof data.temperature !== 'number' || !Number.isFinite(data.temperature) || data.temperature < -90 || data.temperature > 60) return false;
    const conditions = {
        sunny: 'SUNNY', 'clear-night': 'NIGHT_CLEAR', cloudy: 'CLOUDY', partlycloudy: 'CLOUDY_PARTLY',
        fog: 'FOGGY', rainy: 'RAINY', pouring: 'RAINY', snowy: 'SNOW', 'snowy-rainy': 'RAIN_SNOW',
        lightning: 'THUNDERSTORM', 'lightning-rainy': 'THUNDERSTORM', hail: 'RAIN_SNOW',
        windy: 'WINDY', 'windy-variant': 'WINDY', exceptional: 'UNKNOWN'
    };
    if (data.condition !== undefined && !Object.hasOwn(conditions, data.condition)) return false;
    const numeric = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
    if (data.solar_radiation !== undefined && !numeric(data.solar_radiation, 0, 2000)) return false;
    if (data.aqi !== undefined && !numeric(data.aqi, 0, 500)) return false;
    const pollen = {};
    if (data.pollen !== undefined) {
        if (!data.pollen || typeof data.pollen !== 'object' || Array.isArray(data.pollen)) return false;
        for (const species of ['grass', 'birch', 'ragweed', 'olive']) {
            const level = data.pollen[species];
            if (level !== undefined && !['NONE', 'LOW', 'MODERATE', 'HIGH', 'VERY_HIGH'].includes(level)) return false;
            pollen[`pollen_${species}`] = level ?? null;
        }
    }
    let forecast = null;
    if (data.forecast !== undefined) {
        if (!Array.isArray(data.forecast) || data.forecast.length > 48) return false;
        forecast = [];
        let previousTime = -Infinity;
        for (const point of data.forecast) {
            const time = typeof point?.datetime === 'string' ? Date.parse(point.datetime) : NaN;
            if (!Number.isFinite(time) || time <= previousTime || !numeric(point.temperature, -90, 60)) return false;
            previousTime = time;
            forecast.push({ datetime: new Date(time).toISOString(), temperature: point.temperature });
        }
    }
    const homeId = Number(match[1]);
    if (!Number.isSafeInteger(homeId)) return false;
    const observedAt = data.observed_at === undefined ? now : typeof data.observed_at === 'string' ? Date.parse(data.observed_at) : NaN;
    if (!Number.isFinite(observedAt) || observedAt > now + 60000 || now - observedAt > weatherSource.MAX_AGE_MS) return false;
    const pool = db.getPool();
    const [homes] = await pool.execute('SELECT id FROM homes WHERE id = ?', [homeId]);
    if (!homes.length || await weatherSource.getSource(db, homeId) !== 'mqtt') return false;
    const previous = await weatherSource.getReading(db, homeId, now);
    if (previous.timestamp && observedAt <= Date.parse(previous.timestamp)) return false;
    const reading = {
        outside_temp_celsius: data.temperature,
        timestamp: new Date(observedAt).toISOString(),
        weather_state: data.condition === undefined ? 'UNKNOWN' : conditions[data.condition],
        solar_intensity_percentage: data.solar_radiation === undefined ? null : Math.min(100, Math.round(data.solar_radiation / 10)),
        aqi: data.aqi ?? null,
        ...pollen,
        forecast
    };
    await pool.execute('INSERT INTO server_settings (`key`, value, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)', [weatherSource.readingKey(homeId), JSON.stringify(reading), new Date(now).toISOString()]);
    if (publisher) await publisher.publishHomeTelemetry(homeId);
    return true;
}
module.exports = { ingestWeather };
