'use strict';
const weatherSource = require('./weather-source');
async function ingestWeather(db, publisher, topic, payload, now = Date.now()) {
    const match = /^tado\/tanoclo\/h\/([1-9]\d*)\/weather\/telemetry$/.exec(topic);
    if (!match) return false;
    let data;
    try { data = JSON.parse(String(payload)); } catch { return false; }
    if (!data || typeof data.temperature !== 'number' || !Number.isFinite(data.temperature) || data.temperature < -90 || data.temperature > 60) return false;
    const homeId = Number(match[1]);
    if (!Number.isSafeInteger(homeId)) return false;
    const observedAt = data.observed_at === undefined ? now : typeof data.observed_at === 'string' ? Date.parse(data.observed_at) : NaN;
    if (!Number.isFinite(observedAt) || observedAt > now + 60000 || now - observedAt > weatherSource.MAX_AGE_MS) return false;
    const pool = db.getPool();
    const [homes] = await pool.execute('SELECT id FROM homes WHERE id = ?', [homeId]);
    if (!homes.length || await weatherSource.getSource(db, homeId) !== 'mqtt') return false;
    const previous = await weatherSource.getReading(db, homeId, now);
    if (previous.timestamp && observedAt <= Date.parse(previous.timestamp)) return false;
    const reading = { outside_temp_celsius: data.temperature, timestamp: new Date(observedAt).toISOString(), weather_state: 'UNKNOWN', solar_intensity_percentage: null };
    await pool.execute('INSERT INTO server_settings (`key`, value, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)', [weatherSource.readingKey(homeId), JSON.stringify(reading), new Date(now).toISOString()]);
    if (publisher) await publisher.publishHomeTelemetry(homeId);
    return true;
}
module.exports = { ingestWeather };
