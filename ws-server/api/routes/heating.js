/**
 * @file api/routes/heating.js
 * @brief REST routes governing heating systems and boiler circuit optimization controls.
 * 
 * Implements endpoints to read/update boiler flow temperature constraints, enable OpenTherm
 * auto-adaptation profiles, retrieve active boiler status, and configure modulation variables.
 */

const express = require('express');
const db = require('../../lib/db');
const authMiddleware = require('../middleware/auth');
const homeAccessMiddleware = require('../middleware/home-access');
const { getLogger } = require('../../lib/logger');

const router = express.Router();
const _log = getLogger('heating-api');

router.use(authMiddleware);
router.use(homeAccessMiddleware);

function parseUtcDate(ts) {
    if (!ts) return new Date();
    if (typeof ts === 'string') {
        if (!ts.includes('T') && !ts.includes('Z') && !ts.includes('+')) {
            return new Date(ts.replace(' ', 'T') + 'Z');
        }
    }
    return new Date(ts);
}

const getFlowTempOpt = async (req, res) => {
    try {
        const { homeId } = req.params;
        const pool = db.getPool();

        const [settingsRows] = await pool.execute('SELECT * FROM flow_temperature_settings WHERE home_id = ?', [homeId]);
        const settings = settingsRows.length > 0 ? settingsRows[0] : null;

        const [deviceRows] = await pool.execute("SELECT serial_no FROM devices WHERE home_id = ? AND device_type IN ('BU01', 'RU01', 'RU02') LIMIT 1", [homeId]);
        const serialNo = deviceRows.length > 0 ? deviceRows[0].serial_no : null;

        const maxTemp = settings ? parseInt(settings.max_flow_temperature, 10) : 60;
        const minTemp = settings ? parseInt(settings.min_flow_temperature || 30, 10) : 30;
        const maxTempLimit = settings ? parseInt(settings.max_flow_temperature_limit || 80, 10) : 80;
        const autoAdapt = settings ? Boolean(settings.auto_adaptation_enabled) : false;

        // Fetch live boiler metrics & latest history
        const [boilerRows] = await pool.execute(
            'SELECT field_044c, field_044d, field_0452 FROM heating_systems WHERE home_id = ? LIMIT 1',
            [homeId]
        );
        const liveFlowTemp = boilerRows.length > 0 && boilerRows[0].field_044c !== null ? parseFloat(boilerRows[0].field_044c) : null;
        const liveReturnTemp = boilerRows.length > 0 && boilerRows[0].field_044d !== null ? parseFloat(boilerRows[0].field_044d) : null;
        const liveModulation = boilerRows.length > 0 && boilerRows[0].field_0452 !== null ? parseInt(boilerRows[0].field_0452, 10) : null;

        const [histRows] = await pool.execute(
            'SELECT * FROM flow_temperature_history WHERE home_id = ? ORDER BY id DESC LIMIT 1',
            [homeId]
        );
        const latestHist = histRows.length > 0 ? histRows[0] : null;

        res.json({
            hasMultipleBoilerControlDevices: false,
            maxFlowTemperature: maxTemp,
            minFlowTemperature: minTemp,
            maxFlowTemperatureLimit: maxTempLimit,
            maxFlowTemperatureConstraints: { min: minTemp, max: maxTempLimit },
            autoAdaptation: {
                enabled: autoAdapt,
                maxFlowTemperature: autoAdapt ? maxTemp : null,
                currentActualFlowTemperature: liveFlowTemp,
                currentReturnTemperature: liveReturnTemp,
                currentModulation: liveModulation,
                currentOutsideTemperature: latestHist ? parseFloat(latestHist.outside_temp) : null,
                lastReason: latestHist ? latestHist.reason : null,
                lastOptimized: latestHist ? latestHist.timestamp : null
            },
            openThermDeviceSerialNumber: serialNo
        });
    } catch (err) {
        _log('error', `GET flowTemperatureOptimization failed: ${err.message}\n${err.stack}`);
        res.status(500).json({ error: 'internal_error' });
    }
};

const putFlowTempOpt = async (req, res) => {
    try {
        const { homeId } = req.params;
        const data = req.body || {};
        const pool = db.getPool();

        const [existingRows] = await pool.execute('SELECT * FROM flow_temperature_settings WHERE home_id = ?', [homeId]);
        const existing = existingRows.length > 0 ? existingRows[0] : null;

        let temp = 60, minTemp = 30, maxLimit = 80, autoAdapt = 0;

        if (existing) {
            temp = parseInt(existing.max_flow_temperature, 10);
            minTemp = parseInt(existing.min_flow_temperature, 10);
            maxLimit = parseInt(existing.max_flow_temperature_limit, 10);
            autoAdapt = parseInt(existing.auto_adaptation_enabled, 10);
        }

        if (data.minFlowTemperature !== undefined) {
            minTemp = parseInt(data.minFlowTemperature, 10);
        } else if (data.maxFlowTemperatureConstraints && data.maxFlowTemperatureConstraints.min !== undefined) {
            minTemp = parseInt(data.maxFlowTemperatureConstraints.min, 10);
        }

        if (data.maxFlowTemperatureLimit !== undefined) {
            maxLimit = parseInt(data.maxFlowTemperatureLimit, 10);
        } else if (data.maxFlowTemperatureConstraints && data.maxFlowTemperatureConstraints.max !== undefined) {
            maxLimit = parseInt(data.maxFlowTemperatureConstraints.max, 10);
        }

        // Clamp guardrails
        minTemp = Math.max(20, Math.min(minTemp, 50));
        maxLimit = Math.max(minTemp, Math.min(maxLimit, 85));

        if (data.maxFlowTemperature !== undefined) {
            temp = parseInt(data.maxFlowTemperature, 10);
        }
        temp = Math.max(minTemp, Math.min(maxLimit, temp));

        if (data.autoAdaptation && data.autoAdaptation.enabled !== undefined) {
            autoAdapt = data.autoAdaptation.enabled ? 1 : 0;
        }

        await pool.execute(
            'REPLACE INTO flow_temperature_settings (home_id, max_flow_temperature, min_flow_temperature, max_flow_temperature_limit, auto_adaptation_enabled) VALUES (?, ?, ?, ?, ?)',
            [homeId, temp, minTemp, maxLimit, autoAdapt]
        );

        // Dynamically determine target circuit(s) for the home
        const { circuitId } = req.params;
        const [circRows] = await pool.execute(
            'SELECT number, driver_serial_no FROM heating_circuits WHERE home_id = ? ORDER BY number ASC',
            [homeId]
        );

        let targetCircuitNumbers = [];
        const requestedNum = circuitId !== undefined ? parseInt(circuitId, 10) : null;

        if (requestedNum !== null && !isNaN(requestedNum) && requestedNum > 0 && circRows.some(r => r.number === requestedNum)) {
            targetCircuitNumbers.push(requestedNum);
        } else if (circRows.length > 0) {
            const driverCircuit = circRows.find(r => r.driver_serial_no);
            if (driverCircuit) {
                targetCircuitNumbers.push(driverCircuit.number);
            } else {
                targetCircuitNumbers = circRows.map(r => r.number);
            }
        } else {
            const [devCircRows] = await pool.execute(
                `SELECT z.heating_circuit 
                 FROM devices d 
                 JOIN zones z ON d.zone_id = z.id 
                 WHERE d.home_id = ? AND d.device_type IN ('RU01', 'RU02', 'BU01') AND z.heating_circuit IS NOT NULL LIMIT 1`,
                [homeId]
            );
            if (devCircRows.length > 0 && devCircRows[0].heating_circuit) {
                targetCircuitNumbers.push(parseInt(devCircRows[0].heating_circuit, 10));
            } else {
                targetCircuitNumbers.push(1);
            }
        }

        for (const cNum of targetCircuitNumbers) {
            await db.updateCircuitConfig(homeId, cNum, { '0x2040': temp });
        }

        // If auto adaptation is enabled, trigger immediate evaluation
        if (autoAdapt) {
            try {
                const flowOptimizer = require('../../lib/flow-optimizer');
                flowOptimizer.evaluateHome(homeId).catch(() => {});
            } catch (optErr) {
                _log('warn', `Immediate flow optimizer evaluation trigger failed: ${optErr.message}`);
            }
        }

        res.status(204).end();
    } catch (err) {
        _log('error', `PUT flowTemperatureOptimization failed: ${err.message}\n${err.stack}`);
        res.status(500).json({ error: 'internal_error' });
    }
};

const getFlowTempHistory = async (req, res) => {
    try {
        const { homeId } = req.params;
        const limit = Math.min(parseInt(req.query.limit || 50, 10), 288);
        const pool = db.getPool();

        const [rows] = await pool.execute(
            'SELECT * FROM flow_temperature_history WHERE home_id = ? ORDER BY id DESC LIMIT ?',
            [homeId, limit]
        );

        res.json({
            homeId,
            history: rows.reverse()
        });
    } catch (err) {
        _log('error', `GET flowTemperatureHistory failed: ${err.message}\n${err.stack}`);
        res.status(500).json({ error: 'internal_error' });
    }
};

// GET flow temperature optimization
router.get('/:homeId/heatingCircuits/:circuitId/flowTemperatureOptimization', getFlowTempOpt);
router.get('/:homeId/heatingCircuits/:circuitId/supplyTemperatureOptimization', getFlowTempOpt);
router.get('/:homeId/heatingCircuits/0/flowTemperatureOptimization', getFlowTempOpt);
router.get('/:homeId/heatingCircuits/0/supplyTemperatureOptimization', getFlowTempOpt);
router.get('/:homeId/flowTemperatureOptimization', getFlowTempOpt);
router.get('/:homeId/supplyTemperatureOptimization', getFlowTempOpt);

// PUT flow temperature optimization
router.put('/:homeId/heatingCircuits/:circuitId/flowTemperatureOptimization', putFlowTempOpt);
router.put('/:homeId/heatingCircuits/:circuitId/supplyTemperatureOptimization', putFlowTempOpt);
router.put('/:homeId/heatingCircuits/0/flowTemperatureOptimization', putFlowTempOpt);
router.put('/:homeId/heatingCircuits/0/supplyTemperatureOptimization', putFlowTempOpt);
router.put('/:homeId/flowTemperatureOptimization', putFlowTempOpt);
router.put('/:homeId/supplyTemperatureOptimization', putFlowTempOpt);

// GET History endpoints
router.get('/:homeId/heatingCircuits/:circuitId/flowTemperatureHistory', getFlowTempHistory);
router.get('/:homeId/heatingCircuits/:circuitId/supplyTemperatureHistory', getFlowTempHistory);
router.get('/:homeId/heatingCircuits/0/flowTemperatureHistory', getFlowTempHistory);
router.get('/:homeId/heatingCircuits/0/supplyTemperatureHistory', getFlowTempHistory);
router.get('/:homeId/flowTemperatureHistory', getFlowTempHistory);
router.get('/:homeId/supplyTemperatureHistory', getFlowTempHistory);

async function getRunningTimes(req, res) {
    try {
        const { homeId } = req.params;
        const fromDateStr = req.query.from || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const toDateStr = req.query.to || new Date().toISOString().slice(0, 10);
        const aggregate = req.query.aggregate || 'day';
        const summaryOnly = req.query.summary_only === 'true';

        const pool = db.getPool();

        const [zoneRows] = await pool.execute("SELECT id FROM zones WHERE home_id = ? AND type = 'HEATING'", [homeId]);
        const zoneIds = zoneRows.map(row => row.id);

        let fromDate = new Date(fromDateStr + "T00:00:00Z");
        let toDate = new Date(toDateStr + "T00:00:00Z");
        let endDate = new Date(toDate.getTime() + 24 * 60 * 60 * 1000); // Excl +1 day

        if (zoneIds.length === 0) {
            return res.json({
                runningTimes: [],
                summary: {
                    startTime: fromDateStr + ' 00:00:00',
                    endTime: endDate.toISOString().slice(0, 10) + ' 00:00:00',
                    totalRunningTimeInSeconds: 0,
                    meanInSecondsPerDay: 0
                },
                lastUpdated: new Date().toISOString()
            });
        }

        const buckets = [];
        let curr = new Date(fromDate);
        while (curr < endDate) {
            let bStart = new Date(curr);
            let bEnd;
            if (aggregate === 'month') {
                bEnd = new Date(Date.UTC(bStart.getUTCFullYear(), bStart.getUTCMonth() + 1, 1));
            } else {
                bEnd = new Date(bStart.getTime() + 24 * 60 * 60 * 1000);
            }
            if (bEnd > endDate) bEnd = endDate;

            buckets.push({
                startTime: bStart.toISOString().slice(0, 19).replace('T', ' '),
                endTime: bEnd.toISOString().slice(0, 19).replace('T', ' '),
                startTs: bStart.getTime() / 1000,
                endTs: bEnd.getTime() / 1000,
                key: bStart.toISOString().slice(0, 19).replace('T', ' ')
            });
            curr = bEnd;
        }

        const placeholders = zoneIds.map(() => '?').join(',');
        const params = [homeId, ...zoneIds, fromDateStr + ' 00:00:00', endDate.toISOString().slice(0, 19).replace('T', ' ')];

        const [measurements] = await pool.execute(
            `SELECT zone_id, timestamp, field_40a0 
             FROM zone_measurements 
             WHERE home_id = ? AND zone_id IN (${placeholders}) 
               AND timestamp >= ? AND timestamp < ?
             ORDER BY zone_id, timestamp`,
            params
        );

        const measurementsByZone = {};
        zoneIds.forEach(id => measurementsByZone[id] = []);
        measurements.forEach(m => {
            const zId = parseInt(m.zone_id, 10);
            if (!measurementsByZone[zId]) measurementsByZone[zId] = [];
            measurementsByZone[zId].push(m);
        });

        const zoneRunningByBucket = {};
        buckets.forEach(b => {
            zoneRunningByBucket[b.key] = {};
            zoneIds.forEach(id => zoneRunningByBucket[b.key][id] = 0);
        });

        const allHeatingIntervals = [];

        for (const [zIdStr, mArr] of Object.entries(measurementsByZone)) {
            const zId = parseInt(zIdStr, 10);
            for (let i = 0; i < mArr.length - 1; i++) {
                const cur = mArr[i];
                const nxt = mArr[i + 1];

                if (parseFloat(cur.field_40a0) > 0) {
                    const t1 = Math.floor(parseUtcDate(cur.timestamp).getTime() / 1000);
                    const t2 = Math.floor(parseUtcDate(nxt.timestamp).getTime() / 1000);
                    let delta = t2 - t1;

                    if (delta > 3600) delta = 3600;
                    if (delta <= 0) continue;

                    const t2Capped = t1 + delta;
                    allHeatingIntervals.push([t1, t2Capped]);

                    for (const b of buckets) {
                        if (t1 >= b.startTs && t1 < b.endTs) {
                            zoneRunningByBucket[b.key][zId] += delta;
                            break;
                        }
                    }
                }
            }
        }

        allHeatingIntervals.sort((a, b) => a[0] - b[0]);
        let systemRunningByBucket = {};
        buckets.forEach(b => systemRunningByBucket[b.key] = 0);

        const mergedAll = [];
        if (allHeatingIntervals.length > 0) {
            mergedAll.push([...allHeatingIntervals[0]]);
            for (let i = 1; i < allHeatingIntervals.length; i++) {
                let last = mergedAll[mergedAll.length - 1];
                let cur = allHeatingIntervals[i];
                if (cur[0] <= last[1]) last[1] = Math.max(last[1], cur[1]);
                else mergedAll.push([...cur]);
            }
        }

        for (const iv of mergedAll) {
            const [ivStart, ivEnd] = iv;
            for (const b of buckets) {
                if (ivStart >= b.startTs && ivStart < b.endTs) {
                    systemRunningByBucket[b.key] += (ivEnd - ivStart);
                    break;
                }
            }
        }

        let totalRunning = 0;
        let runningTimesRes = [];

        for (const b of buckets) {
            let zonesRes = zoneIds.map(zId => ({ id: zId, runningTimeInSeconds: zoneRunningByBucket[b.key][zId] }));
            let bTotal = systemRunningByBucket[b.key] || 0;

            runningTimesRes.push({
                startTime: b.startTime,
                endTime: b.endTime,
                runningTimeInSeconds: bTotal,
                zones: zonesRes
            });
            totalRunning += bTotal;
        }

        const mean = Math.round(totalRunning / (buckets.length || 1));
        const summaryEndStr = buckets.length > 0 ? buckets[buckets.length - 1].endTime : endDate.toISOString().slice(0, 19).replace('T', ' ');

        const summary = {
            startTime: fromDateStr + ' 00:00:00',
            endTime: summaryEndStr,
            totalRunningTimeInSeconds: totalRunning,
            meanInSecondsPerDay: mean
        };

        const resObj = { summary, lastUpdated: new Date().toISOString() };
        if (!summaryOnly) resObj.runningTimes = runningTimesRes;

        res.json(resObj);
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
}

// GET /api/v2/homes/{homeId}/runningTimes
router.get('/:homeId/runningTimes', getRunningTimes);

module.exports = {
    router,
    getRunningTimes
};
