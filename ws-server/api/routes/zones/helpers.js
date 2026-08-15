/**
 * @file api/routes/zones/helpers.js
 * @brief Helper functions and utilities for zone routing endpoints.
 * 
 * Provides shared routines to check zone config readonly locks, format timestamps,
 * parse local home timezone strings, fetch zone parameters, and map sensor measurements.
 */

const express = require('express');
const db = require('../../../lib/db');
const { getLogger } = require('../../../lib/logger');
const { mapDevice } = require('../../../lib/mappers');
const { parseUtcDate, getLocalParts, parseLocalTimeInTimezone } = require('../../../lib/utils');
const _log = getLogger('zones-api-helpers');

async function checkZoneConfigReadonly(homeId) {
    const pool = db.getPool();
    const [homes] = await pool.execute('SELECT zone_config_readonly, dev_bypass FROM homes WHERE id = ?', [homeId]);
    if (homes.length === 0) return { isReadOnly: false, devBypass: false };
    const config = require('../../../lib/config');
    const isReadOnly = homes[0].zone_config_readonly === null ? config.zoneConfigReadonly : Boolean(homes[0].zone_config_readonly);
    const devBypass = Boolean(homes[0].dev_bypass);
    return { isReadOnly, devBypass };
}

// mapDevice is imported from lib/mappers.js

function formatDate(dateStr) {
    if (!dateStr) return new Date().toISOString();
    return parseUtcDate(dateStr).toISOString();
}

function normalizeSetting(setting) {
    if (!setting) return null;
    if (setting.temperature) {
        if (setting.temperature.celsius !== undefined) {
            setting.temperature.celsius = parseFloat(parseFloat(setting.temperature.celsius).toFixed(2));
        }
        if (setting.temperature.fahrenheit !== undefined) {
            setting.temperature.fahrenheit = parseFloat(parseFloat(setting.temperature.fahrenheit).toFixed(2));
        }
    }
    return setting;
}

// Delegate to canonical implementation in db.js
async function getHomeTimezone(homeId, zoneId) {
    if (arguments.length === 1 || zoneId === undefined) {
        zoneId = homeId;
        homeId = null;
    }
    return db.getHomeTimezone(homeId, zoneId);
}

function getTimetableIdFromType(type) {
    const map = { 'ONE_DAY': 0, 'THREE_DAY': 1, 'SEVEN_DAY': 2 };
    return map[type] ?? 0;
}

function getTimetableTypeFromId(id) {
    const map = { 0: 'ONE_DAY', 1: 'THREE_DAY', 2: 'SEVEN_DAY' };
    return map[id] || 'ONE_DAY';
}

function formatHomeLocalTime(date, tzName) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tzName,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hourCycle: 'h23'
    });
    const parts = fmt.formatToParts(date);
    const map = {};
    parts.forEach(p => map[p.type] = p.value);
    return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
}

function formatTimezoneOffset(offsetStr) {
    const match = offsetStr.match(/GMT(?:([+-])(\d+)(?::?(\d+))?)?/);
    if (!match || !match[1]) {
        return 'Z';
    }
    const sign = match[1];
    let hours = match[2];
    let minutes = match[3] || '00';
    if (hours.length === 1) hours = '0' + hours;
    if (minutes.length === 1) minutes = '0' + minutes;
    return `${sign}${hours}:${minutes}`;
}

function parseHomeLocalTime(dateStr, tzName) {
    const [d, t] = dateStr.includes('T') ? dateStr.split('T') : dateStr.split(' ');
    const [y, m, day] = d.split('-');
    const [h, min, sFull] = t.split(':');
    const s = sFull.split('.')[0].split('Z')[0];

    const testDate = new Date(Date.UTC(parseInt(y), parseInt(m) - 1, parseInt(day), parseInt(h), parseInt(min), parseInt(s)));
    const offsetParts = new Intl.DateTimeFormat('en-US', {
        timeZone: tzName, timeZoneName: 'longOffset'
    }).formatToParts(testDate);
    const offsetStr = offsetParts.find(p => p.type === 'timeZoneName').value;

    const isoStr = `${y}-${m.padStart(2, '0')}-${day.padStart(2, '0')}T${h.padStart(2, '0')}:${min.padStart(2, '0')}:${s.padStart(2, '0')}${formatTimezoneOffset(offsetStr)}`;
    return new Date(isoStr).getTime();
}

async function getZoneDetails(homeId, zoneId, pool) {
    const [zones] = await pool.execute('SELECT * FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
    if (zones.length === 0) return null;
    const zone = zones[0];

    const [devicesRaw] = await pool.execute('SELECT * FROM devices WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
    const mappedDevices = devicesRaw.map(mapDevice);

    return {
        id: parseInt(zone.id, 10),
        name: zone.name,
        type: zone.type,
        dateCreated: formatDate(zone.date_created),
        deviceTypes: Array.from(new Set(mappedDevices.map(m => m.deviceType))),
        devices: mappedDevices,
        reportAvailable: true,
        showScheduleSetup: true,
        supportsDazzle: zone.type !== 'HOT_WATER',
        dazzleEnabled: zone.type !== 'HOT_WATER' ? Boolean(zone.dazzle_enabled) : false,
        dazzleMode: { supported: zone.type !== 'HOT_WATER', enabled: zone.type !== 'HOT_WATER' ? Boolean(zone.dazzle_enabled) : false },
        openWindowDetection: {
            supported: true,
            enabled: Boolean(zone.open_window_enabled),
            timeoutInSeconds: zone.open_window_timeout || 900,
            temperatureDeviationLimit: zone.field_6080 !== null && zone.field_6080 !== undefined ? parseFloat(zone.field_6080) : 0.50,
            owdNvmState: zone.field_6340 !== null && zone.field_6340 !== undefined ? parseInt(zone.field_6340, 10) : 1
        },
        frostMinTemperature: zone.field_60a0 !== null && zone.field_60a0 !== undefined ? parseFloat(zone.field_60a0) : 5.00,
        temperatureBaseline: zone.field_60c0 !== null && zone.field_60c0 !== undefined ? parseFloat(zone.field_60c0) : 19.00,
        tanocloOwdEnabled: Boolean(zone.tanoclo_owd_enabled),
        tanocloOwdSource: zone.tanoclo_owd_source || 'device',
        offlineScheduleEnabled: Boolean(zone.offline_schedule_enabled),
        offlineScheduleSyncedAt: zone.offline_schedule_synced_at,
        heatingCircuit: zone.heating_circuit !== null && zone.heating_circuit !== undefined && zone.heating_circuit !== '' ? parseInt(zone.heating_circuit, 10) : null
    };
}


function blockMatchesDay(blockDayType, targetDayName) {
    if (blockDayType === 'MONDAY_TO_SUNDAY') return true;
    if (blockDayType === 'MONDAY_TO_FRIDAY' && ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'].includes(targetDayName)) return true;
    if (blockDayType === 'SATURDAY_TO_SUNDAY' && ['SATURDAY', 'SUNDAY'].includes(targetDayName)) return true;
    if (blockDayType === 'MONDAY' && targetDayName === 'MONDAY') return true;
    if (blockDayType === 'TUESDAY' && targetDayName === 'TUESDAY') return true;
    if (blockDayType === 'WEDNESDAY' && targetDayName === 'WEDNESDAY') return true;
    if (blockDayType === 'THURSDAY' && targetDayName === 'THURSDAY') return true;
    if (blockDayType === 'FRIDAY' && targetDayName === 'FRIDAY') return true;
    if (blockDayType === 'SATURDAY' && targetDayName === 'SATURDAY') return true;
    if (blockDayType === 'SUNDAY' && targetDayName === 'SUNDAY') return true;
    return false;
}

function getInMemoryCurrentScheduleBlock(activeTT, blocksForTT, tzName) {
    if (!activeTT || !blocksForTT || blocksForTT.length === 0) return null;
    
    const dateObj = (process.env.TEST_PARITY_TIME) ?
        new Date(process.env.TEST_PARITY_TIME) :
        new Date();
    const local = getLocalParts(dateObj, tzName);
    const dayName = local.dayName;
    const timeStr = local.timeStr.slice(0, 5); // HH:mm
    const isoDateStr = local.dateStr;
    
    const dayNames = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
    const prevDayName = dayNames[(dayNames.indexOf(dayName) + 6) % 7];
    
    let todayBlocks = blocksForTT.filter(b => blockMatchesDay(b.day_type, dayName) && b.start_time <= timeStr);
    
    const sortBlocksDesc = (arr, targetDay) => {
        return arr.sort((a, b) => {
            const aIsExact = a.day_type === targetDay ? 1 : 0;
            const bIsExact = b.day_type === targetDay ? 1 : 0;
            if (aIsExact !== bIsExact) return bIsExact - aIsExact;
            
            const aIsMts = a.day_type === 'MONDAY_TO_SUNDAY' ? 1 : 0;
            const bIsMts = b.day_type === 'MONDAY_TO_SUNDAY' ? 1 : 0;
            if (aIsMts !== bIsMts) return aIsMts - bIsMts;
            
            return b.start_time.localeCompare(a.start_time);
        });
    };
    
    sortBlocksDesc(todayBlocks, dayName);
    let block = todayBlocks.length > 0 ? todayBlocks[0] : null;
    
    if (!block) {
        let yesterdayBlocks = blocksForTT.filter(b => blockMatchesDay(b.day_type, prevDayName));
        sortBlocksDesc(yesterdayBlocks, prevDayName);
        block = yesterdayBlocks.length > 0 ? yesterdayBlocks[0] : null;
    }
    
    if (!block) return null;
    
    const setting = {
        type: block.setting_type || 'HEATING',
        power: block.setting_power || 'ON',
        temperature: (block.setting_temp_celsius !== null) ? {
            celsius: parseFloat(block.setting_temp_celsius),
            fahrenheit: (block.setting_temp_fahrenheit !== null) ? parseFloat(block.setting_temp_fahrenheit) : null
        } : null
    };
    
    const startDateTimeLocal = new Date(`${isoDateStr}T${block.start_time}:00`);
    
    return {
        timetableId: activeTT.id,
        blockId: block.id,
        dayType: block.day_type,
        startTime: block.start_time,
        startDateTimeLocal,
        setting
    };
}

function getInMemoryNextScheduleBlock(activeTT, blocksForTT, currentSetting, tzName) {
    if (!activeTT || !blocksForTT || blocksForTT.length === 0) return null;

    const ttId = activeTT.id;
    const typeStr = activeTT.type;
    const typeId = getTimetableIdFromType(typeStr);
    const currentSettingJson = JSON.stringify(currentSetting);

    const nowObj = (process.env.TEST_PARITY_TIME) ?
        new Date(process.env.TEST_PARITY_TIME) :
        new Date();
    const nowLocal = getLocalParts(nowObj, tzName);

    const parts = nowLocal.dateStr.split('-');
    const baseUtc = new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 12, 0, 0));

    let foundBlock = null;
    let targetDateStr = null;

    for (let i = 0; i < 7; i++) {
        const d = new Date(baseUtc.getTime());
        d.setUTCDate(d.getUTCDate() + i);
        const local = getLocalParts(d, tzName);
        const dayName = local.dayName;

        let dayType = 'MONDAY_TO_SUNDAY';
        if (typeId === 1) {
            if (['SATURDAY', 'SUNDAY'].includes(dayName)) dayType = dayName;
            else dayType = 'MONDAY_TO_FRIDAY';
        } else if (typeId === 2) {
            dayType = dayName;
        }

        let dayBlocks = blocksForTT.filter(b => blockMatchesDay(b.day_type, dayName));

        if (i === 0) {
            const nowTimeStr = nowLocal.timeStr.slice(0, 5);
            dayBlocks = dayBlocks.filter(b => b.start_time > nowTimeStr);
        }

        dayBlocks.sort((a, b) => a.start_time.localeCompare(b.start_time));

        for (const block of dayBlocks) {
            const blockSetting = {
                type: block.setting_type || 'HEATING',
                power: block.setting_power || 'ON',
                temperature: (block.setting_temp_celsius !== null) ? {
                    celsius: parseFloat(block.setting_temp_celsius),
                    fahrenheit: (block.setting_temp_fahrenheit !== null) ? parseFloat(block.setting_temp_fahrenheit) : null
                } : null
            };
            const isSameSetting = JSON.stringify(blockSetting) === currentSettingJson;

            if (!isSameSetting || block.start_time !== '00:00') {
                foundBlock = {
                    start_time: block.start_time,
                    setting: blockSetting
                };
                targetDateStr = local.dateStr;
                break;
            }
        }
        if (foundBlock) break;
    }

    if (foundBlock) {
        const finalUtcDate = parseLocalTimeInTimezone(`${targetDateStr} ${foundBlock.start_time}`, tzName);

        return {
            start: finalUtcDate.toISOString(),
            setting: foundBlock.setting
        };
    }

    return null;
}

function mapZoneOverlay(overlay) {
    let setting = {
        type: overlay.setting_type || 'HEATING',
        power: overlay.setting_power || 'ON'
    };
    if (overlay.setting_temp_celsius !== null) {
        setting.temperature = {
            celsius: parseFloat(overlay.setting_temp_celsius),
            fahrenheit: overlay.setting_temp_fahrenheit !== null ? parseFloat(overlay.setting_temp_fahrenheit) : parseFloat((overlay.setting_temp_celsius * 1.8 + 32).toFixed(2))
        };
    }
    setting = normalizeSetting(setting);
    delete setting.isBoost;

    let termType = overlay.termination_type || (overlay.termination && overlay.termination.type);

    let res = {
        type: 'MANUAL',
        setting,
        termination: {
            type: termType,
            typeSkillBasedApp: termType,
            remainingTimeInSeconds: null,
            expiry: null,
            durationInSeconds: null,
            projectedExpiry: null
        }
    };

    if (termType === 'TIMER' || termType === 'NEXT_TIME_BLOCK') {
        let expiryRaw = overlay.termination_expiry || (overlay.termination && overlay.termination.expiry);
        if (expiryRaw) {
            // expiryRaw in DB is now a UTC ISO string.
            const expiryTs = new Date(expiryRaw).getTime();
            const nowTs = Date.now();
            const remaining = Math.max(0, Math.floor((expiryTs - nowTs) / 1000));

            res.termination.type = 'TIMER';
            res.termination.durationInSeconds = overlay.termination_duration_seconds || remaining;
            res.termination.expiry = new Date(expiryRaw).toISOString();
            res.termination.remainingTimeInSeconds = remaining;
            res.termination.projectedExpiry = res.termination.expiry;
            res.termination.typeSkillBasedApp = 'TIMER';
        }
    }
    return res;
}

function resolveAwaySetting(zone, awayConfig) {
    const isDhw = zone && (zone.type === 'HOT_WATER' || zone.type === 'DHW');
    if (awayConfig) {
        const type = awayConfig.type || (isDhw ? 'FIXED_SETTING' : 'HEATING');
        if (type === 'HEATING' && !isDhw) {
            if (awayConfig.min_away_temp_celsius !== null && awayConfig.min_away_temp_celsius !== undefined && parseFloat(awayConfig.min_away_temp_celsius) > 5.0) {
                const c = parseFloat(awayConfig.min_away_temp_celsius);
                const f = awayConfig.min_away_temp_fahrenheit !== null ? parseFloat(awayConfig.min_away_temp_fahrenheit) : c * 1.8 + 32;
                return { type: 'HEATING', power: 'ON', temperature: { celsius: c, fahrenheit: f } };
            }
            return { type: 'HEATING', power: 'OFF', temperature: null };
        } else if (type === 'FIXED_SETTING') {
            const pwr = awayConfig.setting_power || 'OFF';
            const c = awayConfig.setting_temp_celsius !== null && awayConfig.setting_temp_celsius !== undefined ? parseFloat(awayConfig.setting_temp_celsius) : null;
            const f = awayConfig.setting_temp_fahrenheit !== null && awayConfig.setting_temp_fahrenheit !== undefined ? parseFloat(awayConfig.setting_temp_fahrenheit) : (c !== null ? c * 1.8 + 32 : null);
            return {
                type: isDhw ? 'HOT_WATER' : 'HEATING',
                power: pwr,
                temperature: (pwr !== 'OFF' && c !== null) ? { celsius: c, fahrenheit: f } : null
            };
        }
    }
    // Default fallback if no awayConfig row exists
    if (isDhw) {
        return { type: 'HOT_WATER', power: 'OFF', temperature: null };
    }
    return { type: 'HEATING', power: 'ON', temperature: { celsius: 15.0, fahrenheit: 59.0 } };
}

function mapZoneState(measurement, overlay, nextChange, zone, isOffline = false, tadoMode = 'HOME') {
    let state = {
        tadoMode: tadoMode,
        geolocationOverride: false,
        geolocationOverrideDisableTime: null,
        preparation: null,
        setting: normalizeSetting({ type: 'HEATING', power: 'ON', temperature: { celsius: 20.0, fahrenheit: 68.0 } }),
        overlayType: null,
        overlay: null,
        openWindow: null,
        openWindowDetected: false,
        nextScheduleChange: null,
        nextTimeBlock: null,
        link: { state: isOffline ? 'OFFLINE' : (measurement?.link_state || 'ONLINE') },
        runningOfflineSchedule: false,
        activityDataPoints: {},
        sensorDataPoints: {}
    };

    const hp = (measurement?.field_40a0 !== null && measurement?.field_40a0 !== undefined) ? parseFloat(parseFloat(measurement.field_40a0).toFixed(1)) : 0.0;
    state.activityDataPoints.heatingPower = {
        type: 'PERCENTAGE',
        percentage: hp,
        timestamp: measurement?.timestamp ? formatDate(measurement.timestamp) : new Date().toISOString()
    };

    if (measurement?.field_012d !== null && measurement?.field_012d !== undefined) {
        state.sensorDataPoints.insideTemperature = {
            celsius: parseFloat(parseFloat(measurement.field_012d).toFixed(2)),
            fahrenheit: parseFloat((measurement.field_012d * 1.8 + 32).toFixed(2)),
            timestamp: formatDate(measurement.timestamp),
            type: 'TEMPERATURE',
            precision: { celsius: 0.1, fahrenheit: 0.1 }
        };
        state.sensorDataPoints.humidity = {
            type: 'PERCENTAGE', percentage: parseFloat(parseFloat(measurement.field_0135).toFixed(1)),
            timestamp: formatDate(measurement.timestamp)
        };
    }

    if (overlay) {
        let mappedOverlay = mapZoneOverlay(overlay);
        state.overlayType = 'MANUAL';
        state.overlay = mappedOverlay;
        state.setting = normalizeSetting(mappedOverlay.setting);
    }

    if (nextChange) {
        state.nextScheduleChange = nextChange;
        if (state.nextScheduleChange.setting) {
            state.nextScheduleChange.setting = normalizeSetting(state.nextScheduleChange.setting);
        }
        let start = nextChange.start;
        if (start.endsWith('Z') && !start.includes('.')) start = start.replace('Z', '.000Z');
        state.nextTimeBlock = { start };
    }

    // Open Window Detection state
    if (zone && zone.open_window_active) {
        const timeout = zone.open_window_timeout || 900;
        const expiry = zone.open_window_expiry
            ? new Date(zone.open_window_expiry).toISOString()
            : new Date(Date.now() + timeout * 1000).toISOString();
        const remaining = Math.max(0, Math.round((new Date(expiry).getTime() - Date.now()) / 1000));
        if (remaining > 0) {
            state.openWindow = {
                detectedTime: new Date(new Date(expiry).getTime() - timeout * 1000).toISOString(),
                durationInSeconds: timeout,
                expiry: expiry,
                remainingTimeInSeconds: remaining
            };
            state.openWindowDetected = true;
            state.setting = normalizeSetting({ type: 'HEATING', power: 'OFF', temperature: null });
        }
    }

    return state;
}

module.exports = {
    checkZoneConfigReadonly,
    formatDate,
    normalizeSetting,
    getHomeTimezone,
    getTimetableIdFromType,
    getTimetableTypeFromId,
    formatHomeLocalTime,
    formatTimezoneOffset,
    parseHomeLocalTime,
    getZoneDetails,
    blockMatchesDay,
    getInMemoryCurrentScheduleBlock,
    getInMemoryNextScheduleBlock,
    mapZoneOverlay,
    resolveAwaySetting,
    mapZoneState
};
