/**
 * @file lib/utils.js
 * @brief Shared dates, times, and buffer reconstruction utilities.
 */

'use strict';

/**
 * Recursively convert Uint8Array instances to Buffer.
 * Needed when passing objects through IPC (child_process.send),
 * which deserializes Buffers as plain Uint8Arrays.
 */
function reconstructBuffers(obj) {
    if (!obj) return obj;
    if (typeof obj === 'object') {
        if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
            return Buffer.from(obj.data);
        }
        if (obj instanceof Uint8Array && !Buffer.isBuffer(obj)) {
            return Buffer.from(obj);
        }
        if (Array.isArray(obj)) {
            return obj.map(reconstructBuffers);
        }
        for (const key of Object.keys(obj)) {
            obj[key] = reconstructBuffers(obj[key]);
        }
    }
    return obj;
}

function parseUtcDate(ts) {
    if (!ts) return new Date();
    if (typeof ts === 'string') {
        if (!ts.includes('T') && !ts.includes('Z') && !ts.includes('+')) {
            return new Date(ts.replace(' ', 'T') + 'Z');
        }
    }
    return new Date(ts);
}

function getTzOffsetMs(date, timeZone) {
    const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
    const tzDate = new Date(date.toLocaleString('en-US', { timeZone }));
    return tzDate.getTime() - utcDate.getTime();
}

function getLocalParts(date, timeZone) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'long',
        hourCycle: 'h23'
    });
    const parts = formatter.formatToParts(date);
    const p = {};
    for (const part of parts) {
        p[part.type] = part.value;
    }
    return {
        dateStr: `${p.year}-${p.month}-${p.day}`,
        timeStr: `${p.hour}:${p.minute}:${p.second}`,
        hour: parseInt(p.hour, 10),
        minute: parseInt(p.minute, 10),
        second: parseInt(p.second, 10),
        dayName: p.weekday ? p.weekday.toUpperCase() : ''
    };
}

function parseLocalTimeInTimezone(localDateTimeStr, timeZone) {
    const ISOStr = localDateTimeStr.replace(' ', 'T').slice(0, 16) + ':00Z';
    const dateAsUtc = new Date(ISOStr);
    const offsetMs = getTzOffsetMs(dateAsUtc, timeZone);
    return new Date(dateAsUtc.getTime() - offsetMs);
}

function getDayBoundsInTimezone(dateStr, timeZone) {
    const startUtc = parseLocalTimeInTimezone(dateStr + ' 00:00', timeZone);
    const parts = dateStr.split('-');
    const d = new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10)));
    d.setUTCDate(d.getUTCDate() + 1);
    const nextYear = d.getUTCFullYear();
    const nextMonth = String(d.getUTCMonth() + 1).padStart(2, '0');
    const nextDay = String(d.getUTCDate()).padStart(2, '0');
    const nextDateStr = `${nextYear}-${nextMonth}-${nextDay}`;
    const nextStartUtc = parseLocalTimeInTimezone(nextDateStr + ' 00:00', timeZone);
    const endUtc = new Date(nextStartUtc.getTime() - 1);
    const hoursInDay = Math.round((nextStartUtc.getTime() - startUtc.getTime()) / 3600000);
    return { startUtc, endUtc, hoursInDay };
}

function parseResourceIds(displayPath, fallbackHomeId = null) {
    const parts = displayPath.split('/');
    const zIdx = parts.indexOf('z');
    const hIdx = parts.indexOf('h');
    const cIdx = parts.indexOf('c');

    let zoneId = null;
    if (zIdx >= 0 && parts[zIdx + 1] && parts[zIdx + 1] !== 's') {
        zoneId = parts[zIdx + 1];
    }

    const homeId = hIdx >= 0 ? parts[hIdx + 1] : fallbackHomeId;
    const circuitNumber = cIdx >= 0 ? parseInt(parts[cIdx + 1], 10) : null;

    return { zoneId, homeId, circuitNumber };
}

module.exports = { reconstructBuffers, parseUtcDate, getTzOffsetMs, getLocalParts, parseLocalTimeInTimezone, getDayBoundsInTimezone, parseResourceIds };
