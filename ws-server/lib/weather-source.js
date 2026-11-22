'use strict';
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const key = homeId => `weather_source_${homeId}`;
const readingKey = homeId => `mqtt_weather_${homeId}`;
async function getSource(db, homeId) {
    const [rows] = await db.getPool().execute('SELECT value FROM server_settings WHERE `key` = ?', [key(homeId)]);
    return rows[0]?.value === 'mqtt' ? 'mqtt' : 'open_meteo';
}
async function setSource(db, homeId, source) {
    if (!['mqtt', 'open_meteo'].includes(source)) throw new Error('Invalid weather source');
    await db.getPool().execute('INSERT INTO server_settings (`key`, value, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)', [key(homeId), source, new Date().toISOString()]);
}
async function getReading(db, homeId, now = Date.now()) {
    const source = await getSource(db, homeId);
    let reading = null;
    if (source === 'mqtt') {
        const [rows] = await db.getPool().execute('SELECT value FROM server_settings WHERE `key` = ?', [readingKey(homeId)]);
        try { reading = rows[0] ? JSON.parse(rows[0].value) : null; } catch { /* Missing/corrupt input is unavailable. */ }
    } else {
        const [rows] = await db.getPool().execute('SELECT * FROM home_weather WHERE home_id = ? ORDER BY timestamp DESC LIMIT 1', [homeId]);
        reading = rows[0] || null;
    }
    const raw = reading?.timestamp;
    const timestamp = raw instanceof Date ? raw.toISOString() : raw ? (/Z$|[+-]\d\d:\d\d$/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z') : null;
    const age = timestamp ? now - Date.parse(timestamp) : NaN;
    const fresh = Number.isFinite(age) && age >= -60000 && age <= MAX_AGE_MS;
    return { source, reading, timestamp, stale: !fresh, ageSeconds: Number.isFinite(age) ? Math.max(0, Math.floor(age / 1000)) : null };
}
module.exports = { getSource, setSource, getReading, readingKey, MAX_AGE_MS };
