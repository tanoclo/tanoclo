/**
 * @file api/routes/zones/reports.js
 * @brief Daily telemetry reporting endpoints for home zones.
 * 
 * Computes day reports aggregating temperature curves, humidity stats, weather solar
 * conditions, and boiler activity intervals to build interactive dashboard charts.
 */

const express = require('express');
const db = require('../../../lib/db');
const { getLogger } = require('../../../lib/logger');
const commandApi = require('../../../lib/command-api');
const { mapDevice } = require('../../../lib/mappers');
const { parseUtcDate, getLocalParts, parseLocalTimeInTimezone, getDayBoundsInTimezone } = require('../../../lib/utils');
const {
    checkZoneConfigReadonly,
    formatDate,
    normalizeSetting,
    getHomeTimezone,
    getTimetableIdFromType,
    getTimetableTypeFromId,
    formatHomeLocalTime,
    formatTimezoneOffset,
    parseHomeLocalTime,
    getZoneDetails
} = require('./helpers');

const router = express.Router();
const _log = getLogger('zones-api');

router.get('/:homeId/zones/:zoneId/dayReport', async (req, res) => {
    try {
        const { homeId, zoneId } = req.params;
        const tzName = await getHomeTimezone(homeId, zoneId);
        const momentHomeStr = getLocalParts(new Date(), tzName).dateStr;
        const date = req.query.date || momentHomeStr;
        const pool = db.getPool();

        const [zones] = await pool.execute('SELECT type, date_created FROM zones WHERE id = ? AND home_id = ?', [zoneId, homeId]);
        if (zones.length === 0) return res.status(404).json({ error: 'Zone not found' });
        const zone = zones[0];
        const zoneType = zone.type || 'HEATING';

        if (zone.date_created) {
            const createdDate = getLocalParts(new Date(zone.date_created), tzName).dateStr;
            if (date < createdDate) {
                return res.status(422).json({
                    errors: [{ code: 'beforeZoneCreation', title: `zone was created at ${zone.date_created.toISOString()}` }]
                });
            }
        }

        const bounds = getDayBoundsInTimezone(date, tzName);
        const startOfDay = bounds.startUtc;
        const endOfDay = bounds.endUtc;
        const hoursInDay = bounds.hoursInDay;

        const startBuffer = new Date(startOfDay.getTime() - 15 * 60 * 1000);
        const endBuffer = new Date(endOfDay.getTime() + 15 * 60 * 1000);

        const startUtc = startBuffer.toISOString();
        const endUtc = endBuffer.toISOString();

        const nowMs = Date.now();
        const actualEndMs = Math.min(new Date(endUtc).getTime(), nowMs);
        const actualEndUtc = new Date(actualEndMs).toISOString();

        const rows = await db.getZoneMeasurementsForTimeRange(homeId, zoneId, startUtc, endUtc);
        const weatherRows = await db.getHomeWeatherForTimeRange(homeId, startUtc, endUtc);

        const [dhwZones] = await db.getPool().execute('SELECT id FROM zones WHERE home_id = ? AND type = "HOT_WATER"', [homeId]);
        const dhwZoneId = dhwZones.length > 0 ? dhwZones[0].id : 0;
        const dhwRows = await db.getZoneMeasurementsForTimeRange(homeId, dhwZoneId, startUtc, endUtc);

        const tempPoints = [];
        const humidityPoints = [];
        const solarPoints = [];
        let minTemp = null, maxTemp = null, minHum = null, maxHum = null, minSolar = null, maxSolar = null;

        const stripes = [];
        const settingsData = [];
        const callForHeatData = [];
        const hotWaterProduction = [];

        // Fetch Schedule for better interval alignment
        const [activeTTs] = await pool.execute('SELECT id, type FROM zone_timetables WHERE zone_id = ? AND home_id = ? AND is_active = 1', [zoneId, homeId]);
        let scheduleBlocks = [];
        if (activeTTs.length > 0) {
            const ttId = activeTTs[0].id;
            const ttType = activeTTs[0].type;
            const dayName = getLocalParts(startOfDay, tzName).dayName;

            let dayType = 'MONDAY_TO_SUNDAY';
            if (ttType === 'THREE_DAY') {
                if (['SATURDAY', 'SUNDAY'].includes(dayName)) dayType = dayName;
                else dayType = 'MONDAY_TO_FRIDAY';
            } else if (ttType === 'SEVEN_DAY') {
                dayType = dayName;
            }

            const [blocks] = await pool.execute('SELECT * FROM schedule_blocks WHERE timetable_id = ? AND home_id = ? AND day_type = ? ORDER BY start_time ASC', [ttId, homeId, dayType]);
            scheduleBlocks = blocks;
        }

        // 1. Resample DataPoints using exact Linear Interpolation
        const intervalMs = 15 * 60 * 1000;
        const startMs = startBuffer.valueOf();

        const getInterpolatedValue = (arr, ts, valKey, defaultVal, lastIdxObj) => {
            if (!arr || arr.length === 0) return defaultVal;

            let i = lastIdxObj.idx;
            while (i < arr.length && parseUtcDate(arr[i].timestamp).getTime() < ts) {
                i++;
            }

            if (i >= arr.length) {
                const lp = arr[arr.length - 1];
                lastIdxObj.idx = arr.length - 1;
                return (lp[valKey] !== null && lp[valKey] !== undefined) ? parseFloat(lp[valKey]) : defaultVal;
            }

            if (i === 0) {
                const fp = arr[0];
                return (fp[valKey] !== null && fp[valKey] !== undefined) ? parseFloat(fp[valKey]) : defaultVal;
            }

            const p1 = arr[i - 1];
            const p2 = arr[i];

            const t1 = parseUtcDate(p1.timestamp).getTime();
            const t2 = parseUtcDate(p2.timestamp).getTime();

            const v1_raw = p1[valKey];
            const v2_raw = p2[valKey];

            const v1 = (v1_raw !== null && v1_raw !== undefined) ? parseFloat(v1_raw) : defaultVal;
            const v2 = (v2_raw !== null && v2_raw !== undefined) ? parseFloat(v2_raw) : defaultVal;

            if (t1 === t2) return v2;

            const fraction = (ts - t1) / (t2 - t1);
            lastIdxObj.idx = i - 1;
            return v1 + (v2 - v1) * fraction;
        };

        const idxTemp = { idx: 0 };
        const idxHum = { idx: 0 };
        const idxSolar = { idx: 0 };

        const hasTempSensors = rows.some(r => r.field_012d !== null && r.field_012d !== undefined);
        const hasHumSensors = rows.some(r => r.field_0135 !== null && r.field_0135 !== undefined);
        const isDhwZone = zoneType === 'HOT_WATER' || zoneType === 'DHW';

        for (let t = startMs; t <= actualEndMs; t += intervalMs) {
            const tsIso = new Date(t).toISOString();

            // Temp
            if (isDhwZone && !hasTempSensors) {
                tempPoints.push({
                    timestamp: tsIso,
                    value: null
                });
            } else {
                let temp = getInterpolatedValue(rows, t, 'field_012d', 20.0, idxTemp);
                temp = Math.round(temp * 100) / 100;
                if (minTemp === null || temp < minTemp) minTemp = temp;
                if (maxTemp === null || temp > maxTemp) maxTemp = temp;
                tempPoints.push({
                    timestamp: tsIso,
                    value: { celsius: temp, fahrenheit: parseFloat((temp * 1.8 + 32).toFixed(2)) }
                });
            }

            // Humidity
            if (isDhwZone && !hasHumSensors) {
                humidityPoints.push({ timestamp: tsIso, value: null });
            } else {
                let humRaw = getInterpolatedValue(rows, t, 'field_0135', 50.0, idxHum);
                let hum = Math.round((humRaw / 100.0) * 1000) / 1000;
                if (minHum === null || hum < minHum) minHum = hum;
                if (maxHum === null || hum > maxHum) maxHum = hum;
                humidityPoints.push({ timestamp: tsIso, value: hum });
            }

            // Solar
            let solarRaw = getInterpolatedValue(weatherRows, t, 'solar_intensity_percentage', 0.0, idxSolar);
            let solar = Math.round((solarRaw / 100.0) * 1000) / 1000;
            if (minSolar === null || solar < minSolar) minSolar = solar;
            if (maxSolar === null || solar > maxSolar) maxSolar = solar;
            solarPoints.push({ timestamp: tsIso, value: solar });
        }

        if (minTemp === null) { minTemp = null; maxTemp = null; }
        if (minHum === null) { minHum = null; maxHum = null; }
        if (minSolar === null) { minSolar = 0.0; maxSolar = 0.0; }

        // Helper closures for independent tracking
        let lastCallForHeatParams = null;
        const flushCallForHeat = (toTs) => {
            if (lastCallForHeatParams) {
                lastCallForHeatParams.to = toTs;
                callForHeatData.push(lastCallForHeatParams);
                lastCallForHeatParams = null;
            }
        };

        let lastHotWaterParams = null;
        const flushHotWater = (toTs) => {
            if (lastHotWaterParams) {
                lastHotWaterParams.to = toTs;
                hotWaterProduction.push(lastHotWaterParams);
                lastHotWaterParams = null;
            }
        };

        const generateSettingObj = (row) => {
            const isOverlay = row.field_6240 !== null && row.field_6240 !== undefined && row.field_6240 !== 0;
            const temp = isOverlay ? row.field_6280 : row.field_6200;
            const power = (temp && temp > 0) ? 'ON' : 'OFF';
            const settingValue = { type: zoneType, power };
            if (zoneType === 'HEATING') {
                settingValue.temperature = {
                    celsius: parseFloat(temp || 20),
                    fahrenheit: parseFloat(((temp || 20) * 1.8 + 32).toFixed(2))
                };
            }
            return settingValue;
        };

        // Populate DHW mapping independently
        if (dhwRows.length > 0) {
            dhwRows.forEach((row, i) => {
                const ts = parseUtcDate(row.timestamp).toISOString();
                if (ts > actualEndUtc) return; // Prevent creating segments in future

                // Tado boiler logic maps "is ON" to if it is demanding heat OR explicitly scheduled above 15
                // Sometimes default off is 15.0 or 0
                const t = row.field_6200 ? parseFloat(row.field_6200) : 0;
                const hp = row.field_40a0 ? parseFloat(row.field_40a0) : 0;
                const producing = (hp > 0 || t > 30);

                if (!lastHotWaterParams) {
                    lastHotWaterParams = { from: startUtc, to: null, value: producing };
                } else if (lastHotWaterParams.value !== producing) {
                    flushHotWater(ts);
                    lastHotWaterParams = { from: ts, to: null, value: producing };
                }
            });
            if (lastHotWaterParams) flushHotWater(actualEndUtc);
        } else {
            hotWaterProduction.push({ from: startUtc, to: actualEndUtc, value: false });
        }

        const parseTimeStringAsUtc = (timeStr) => {
            return parseLocalTimeInTimezone(`${date} ${timeStr}`, tzName).toISOString();
        };

        // 3. Layer Overlays from measurements
        const overlays = rows.filter(r => r.field_6240 !== null && r.field_6240 !== undefined && r.field_6240 !== 0);
        if (overlays.length > 0) {
            const allIntervals = []; // { from, to, value: { stripeType, setting } }

            scheduleBlocks.forEach((block, i) => {
                const s = (i === 0) ? startUtc : parseTimeStringAsUtc(block.start_time);
                const e = (block.end_time === '00:00') ? endUtc : parseTimeStringAsUtc(block.end_time);
                const tempC = block.setting_temp_celsius !== null ? parseFloat(block.setting_temp_celsius) : null;
                allIntervals.push({
                    from: s, to: e, stripeType: 'HOME', setting: {
                        type: zoneType, power: block.setting_power || 'ON', temperature: tempC !== null ? {
                            celsius: tempC,
                            fahrenheit: parseFloat((tempC * 1.8 + 32).toFixed(2))
                        } : null
                    }
                });
            });

            let currentOv = null;
            const ovSegments = [];
            rows.forEach(r => {
                const isOv = r.field_6240 !== null && r.field_6240 !== undefined && r.field_6240 !== 0;
                const ts = parseUtcDate(r.timestamp).toISOString();
                if (ts > actualEndUtc) return;

                if (isOv) {
                    const setting = {
                        type: zoneType,
                        power: r.field_6280 > 0 ? 'ON' : 'OFF',
                        temperature: zoneType === 'HEATING' ? {
                            celsius: parseFloat(r.field_6280),
                            fahrenheit: parseFloat((r.field_6280 * 1.8 + 32).toFixed(2))
                        } : null
                    };

                    if (!currentOv) {
                        currentOv = { from: ts, to: null, setting };
                    } else if (JSON.stringify(currentOv.setting) !== JSON.stringify(setting)) {
                        currentOv.to = ts;
                        ovSegments.push(currentOv);
                        currentOv = { from: ts, to: null, setting };
                    }
                } else if (currentOv) {
                    currentOv.to = ts;
                    ovSegments.push(currentOv);
                    currentOv = null;
                }
            });
            if (currentOv) { currentOv.to = actualEndUtc; ovSegments.push(currentOv); }

            stripes.length = 0;
            settingsData.length = 0;

            let lastTs = startUtc;
            const finalSegments = [];

            const bounds = new Set([startUtc, actualEndUtc]);
            allIntervals.forEach(i => { bounds.add(i.from); bounds.add(i.to); });
            ovSegments.forEach(s => { bounds.add(s.from); bounds.add(s.to); });
            const sortedBounds = Array.from(bounds).sort();

            for (let i = 0; i < sortedBounds.length - 1; i++) {
                const s = sortedBounds[i];
                const e = sortedBounds[i + 1];
                if (s >= actualEndUtc) break;

                const ov = ovSegments.find(o => o.from <= s && (o.to === null || o.to > s));
                if (ov) {
                    finalSegments.push({ from: s, to: e, stripeType: 'OVERLAY_ACTIVE', setting: ov.setting });
                } else {
                    const block = allIntervals.find(b => b.from <= s && (b.to === null || b.to > s));
                    if (block) {
                        finalSegments.push({ from: s, to: e, stripeType: 'HOME', setting: block.setting });
                    }
                }
            }

            finalSegments.forEach(seg => {
                stripes.push({ from: seg.from, to: seg.to, value: { stripeType: seg.stripeType, setting: seg.setting } });
                settingsData.push({ from: seg.from, to: seg.to, value: seg.setting });
            });

        } else if (scheduleBlocks.length > 0) {
            scheduleBlocks.forEach((block, i) => {
                const start = (i === 0) ? startUtc : parseTimeStringAsUtc(block.start_time);
                let end = (block.end_time === '00:00') ? endUtc : parseTimeStringAsUtc(block.end_time);

                if (start < startUtc) start = startUtc;
                if (end > actualEndUtc) end = actualEndUtc;
                if (start >= actualEndUtc) return;

                const tempC = block.setting_temp_celsius !== null ? parseFloat(block.setting_temp_celsius) : null;
                const sVal = {
                    type: zoneType,
                    power: block.setting_power || 'ON',
                    temperature: tempC !== null ? {
                        celsius: tempC,
                        fahrenheit: parseFloat((tempC * 1.8 + 32).toFixed(2))
                    } : null
                };

                stripes.push({ from: start, to: end, value: { stripeType: 'HOME', setting: sVal } });
                settingsData.push({ from: start, to: end, value: sVal });
            });
        }

        if (rows.length > 0) {
            rows.forEach((row) => {
                const ts = parseUtcDate(row.timestamp).toISOString();
                if (ts > actualEndUtc) return;

                const hp = parseFloat(row.field_40a0 || 0);
                let cfh = 'NONE';
                if (hp > 66) cfh = 'HIGH'; else if (hp > 33) cfh = 'MEDIUM'; else if (hp > 0) cfh = 'LOW';

                if (!lastCallForHeatParams) {
                    lastCallForHeatParams = { from: startUtc, to: null, value: cfh };
                } else if (lastCallForHeatParams.value !== cfh) {
                    flushCallForHeat(ts);
                    lastCallForHeatParams = { from: ts, to: null, value: cfh };
                }
            });
            if (lastCallForHeatParams) flushCallForHeat(actualEndUtc);
        } else {
            callForHeatData.push({ from: startUtc, to: actualEndUtc, value: 'NONE' });
        }

        // DHW hotWaterProduction is already populated in the first pass above (line ~1775)

        if (stripes.length === 0) {
            const defSetting = { type: zoneType, power: 'OFF', temperature: { celsius: 20, fahrenheit: 68 } };
            stripes.push({ from: startUtc, to: actualEndUtc, value: { stripeType: 'HOME', setting: defSetting } });
            settingsData.push({ from: startUtc, to: actualEndUtc, value: defSetting });
        }

        res.json({
            zoneType,
            interval: { from: startUtc, to: actualEndUtc },
            hoursInDay,
            measuredData: {
                measuringDeviceConnected: {
                    timeSeriesType: 'dataIntervals', valueType: 'boolean',
                    dataIntervals: [{ from: startUtc, to: actualEndUtc, value: true }]
                },
                insideTemperature: {
                    timeSeriesType: 'dataPoints', valueType: 'temperature',
                    min: { celsius: minTemp, fahrenheit: parseFloat((minTemp * 1.8 + 32).toFixed(2)) },
                    max: { celsius: maxTemp, fahrenheit: parseFloat((maxTemp * 1.8 + 32).toFixed(2)) },
                    dataPoints: tempPoints
                },
                humidity: {
                    timeSeriesType: 'dataPoints', valueType: 'percentage', percentageUnit: 'UNIT_INTERVAL',
                    min: minHum, max: maxHum, dataPoints: humidityPoints
                }
            },
            stripes: { timeSeriesType: 'dataIntervals', valueType: 'stripes', dataIntervals: stripes },
            settings: {
                timeSeriesType: 'dataIntervals',
                valueType: zoneType === 'HEATING' ? 'heatingSetting' : 'hotWaterSetting',
                dataIntervals: settingsData
            },
            callForHeat: { timeSeriesType: 'dataIntervals', valueType: 'callForHeat', dataIntervals: callForHeatData },
            hotWaterProduction: { timeSeriesType: 'dataIntervals', valueType: 'boolean', dataIntervals: hotWaterProduction },
            weather: await formatWeatherDayReport(weatherRows, startUtc, actualEndUtc, tzName)
        });

    } catch (err) {
        _log('error', `DayReport Error: ${err.message}\n${err.stack}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

async function formatWeatherDayReport(rows, from, to, tzName) {
    const conditions = [];
    const slots = {};
    const sunny = [];

    const targetHoursLocal = ["04:00", "08:00", "12:00", "16:00", "20:00"];

    const getWeatherState = (state, timestamp) => {
        const parts = getLocalParts(new Date(timestamp), tzName);
        const localHour = parts.hour;
        const isNight = localHour < 6 || localHour >= 20;
        if (isNight && !state.startsWith('NIGHT_')) {
            if (state === 'CLEAR' || state === 'SUNNY') return 'NIGHT_CLEAR';
            if (state === 'CLOUDY' || state === 'CLOUDY_MOSTLY' || state === 'CLOUDY_PARTLY') return 'NIGHT_CLOUDY';
        }
        return state;
    };

    let lastCond = null;
    const flushCond = (toTs) => {
        if (lastCond) { lastCond.to = toTs; conditions.push(lastCond); lastCond = null; }
    };

    let lastSunny = null;
    const flushSunny = (toTs) => {
        if (lastSunny) { lastSunny.to = toTs; sunny.push(lastSunny); lastSunny = null; }
    };

    if (rows.length === 0) {
        conditions.push({ from, to, value: { state: 'CLOUDY', temperature: { celsius: 10.0, fahrenheit: 50.0 } } });
        sunny.push({ from, to, value: false });
        targetHoursLocal.forEach(h => {
            slots[h] = { state: 'CLOUDY', temperature: { celsius: 10.0, fahrenheit: 50.0 } };
        });
    } else {
        rows.forEach(row => {
            const ts = parseUtcDate(row.timestamp).toISOString();
            if (ts > to) return;

            const baseState = row.weather_state || 'CLOUDY';
            const state = getWeatherState(baseState, row.timestamp);
            const temp = parseFloat(row.outside_temp_celsius || 10);

            if (!lastCond) {
                lastCond = { from, to: null, value: { state, temperature: { celsius: temp, fahrenheit: parseFloat((temp * 1.8 + 32).toFixed(2)) } } };
            } else if (lastCond.value.state !== state || Math.abs(lastCond.value.temperature.celsius - temp) >= 1.0) {
                flushCond(ts);
                lastCond = { from: ts, to: null, value: { state, temperature: { celsius: temp, fahrenheit: parseFloat((temp * 1.8 + 32).toFixed(2)) } } };
            }

            const isSunny = ['CLEAR', 'SUNNY', 'MOSTLY_SUNNY', 'CLOUDY_PARTLY'].includes(baseState);
            if (!lastSunny) {
                lastSunny = { from, to: null, value: isSunny };
            } else if (lastSunny.value !== isSunny) {
                flushSunny(ts);
                lastSunny = { from: ts, to: null, value: isSunny };
            }

            const parts = getLocalParts(new Date(row.timestamp), tzName);
            const hourStr = String(parts.hour).padStart(2, '0') + ':00';

            if (targetHoursLocal.includes(hourStr) && !slots[hourStr]) {
                slots[hourStr] = {
                    state: state,
                    temperature: { celsius: temp, fahrenheit: parseFloat((temp * 1.8 + 32).toFixed(2)) }
                };
            }
        });

        if (lastCond) flushCond(to);
        if (lastSunny) flushSunny(to);
    }

    return {
        condition: { timeSeriesType: 'dataIntervals', valueType: 'weatherCondition', dataIntervals: conditions },
        sunny: { timeSeriesType: 'dataIntervals', valueType: 'boolean', dataIntervals: sunny },
        slots: { timeSeriesType: 'slots', valueType: 'weatherCondition', slots }
    };
}

module.exports = router;
