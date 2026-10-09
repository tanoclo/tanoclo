/**
 * @file api/routes/homes/heating.js
 * @brief Heating system properties endpoints for individual homes.
 * 
 * Manages properties like underfloor heating toggles, boiler models associations,
 * and wiring configuration settings.
 */

const express = require('express');
const db = require('../../../lib/db');
const config = require('../../../lib/config');
const { getLogger } = require('../../../lib/logger');
const { mapDevice } = require('../../../lib/mappers');
const geoUtils = require('../../../lib/geo-utils');
const fs = require('fs');
const path = require('path');
const { buildHomeDetails, checkZoneConfigReadonly } = require('./helpers');

const router = express.Router();
const _log = getLogger('homes-api');

router.get('/:homeId/heatingSystem', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const pool = db.getPool();
        const [systems] = await pool.execute('SELECT * FROM heating_systems WHERE home_id = ?', [homeId]);
        const hs = systems[0] || {};

        let parsedConfig = null;
        if (hs.last_config_json) {
            try {
                parsedConfig = typeof hs.last_config_json === 'string' ? JSON.parse(hs.last_config_json) : hs.last_config_json;
            } catch (e) {}
        }

        res.json({
            boiler: {
                present: Boolean(hs.boiler_present),
                id: hs.boiler_id || null,
                found: Boolean(hs.boiler_found)
            },
            underfloorHeating: { present: Boolean(hs.underfloor_heating_present) },
            telemetry: {
                flowTemperature: hs.field_044c !== null && hs.field_044c !== undefined ? parseFloat(hs.field_044c) : null,
                returnTemperature: hs.field_044d !== null && hs.field_044d !== undefined ? parseFloat(hs.field_044d) : null,
                controlSetpoint: hs.field_0450 !== null && hs.field_0450 !== undefined ? parseFloat(hs.field_0450) : null,
                modulationPercentage: hs.field_0452 !== null && hs.field_0452 !== undefined ? parseInt(hs.field_0452, 10) : null,
                flameActive: Boolean(hs.field_0457),
                waterPressureBar: hs.field_0460 !== null && hs.field_0460 !== undefined ? parseFloat(((Number(hs.field_0460) & 0xFFFF) / 1000).toFixed(2)) : null,
                dhwTargetTemperature: hs.field_045b !== null && hs.field_045b !== undefined ? parseFloat(hs.field_045b) : null,
                dhwFlowRateLpm: parsedConfig && parsedConfig['0x045e'] !== undefined ? parseFloat(parsedConfig['0x045e']) : null,
                burnerStarts: hs.field_0463 !== null && hs.field_0463 !== undefined && parseInt(hs.field_0463, 10) !== 65535 ? parseInt(hs.field_0463, 10) : null,
                chPumpStarts: hs.field_0464 !== null && hs.field_0464 !== undefined && parseInt(hs.field_0464, 10) !== 65535 ? parseInt(hs.field_0464, 10) : null,
                chBurnerStarts: hs.field_0465 !== null && hs.field_0465 !== undefined && parseInt(hs.field_0465, 10) !== 65535 ? parseInt(hs.field_0465, 10) : null,
                burnerHoursTotal: hs.field_0466 !== null && hs.field_0466 !== undefined ? parseFloat(hs.field_0466) : null,
                burnerHoursCh: hs.field_0467 !== null && hs.field_0467 !== undefined ? parseFloat(hs.field_0467) : null,
                burnerHoursDhw: hs.field_0468 !== null && hs.field_0468 !== undefined ? parseFloat(hs.field_0468) : null,
                faultFlags: hs.field_0458 !== null && hs.field_0458 !== undefined ? parseInt(hs.field_0458, 10) : 0,
                updatedAt: hs.hvac_updated_at || null
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/v2/homes/{homeId}/heatingSystem/boiler
router.put('/:homeId/heatingSystem/boiler', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const { present, found, id } = req.body;
        const pool = db.getPool();

        await pool.execute(
            `INSERT INTO heating_systems (home_id, boiler_present, boiler_found, boiler_id) 
             VALUES (?, ?, ?, ?) 
             ON DUPLICATE KEY UPDATE 
             boiler_present = ?, 
             boiler_found = ?, 
             boiler_id = ?`,
            [homeId, present ? 1 : 0, found ? 1 : 0, id || null, present ? 1 : 0, found ? 1 : 0, id || null]
        );

        res.json({ present: Boolean(present), found: Boolean(found), id: id || null });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/v2/homes/{homeId}/heatingSystem/underfloorHeating
router.put('/:homeId/heatingSystem/underfloorHeating', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const { present } = req.body;
        const pool = db.getPool();

        await pool.execute(
            `INSERT INTO heating_systems (home_id, underfloor_heating_present) 
             VALUES (?, ?) 
             ON DUPLICATE KEY UPDATE 
             underfloor_heating_present = ?`,
            [homeId, present ? 1 : 0, present ? 1 : 0]
        );

        res.json({ present: Boolean(present) });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

router.get('/:homeId/heatingCircuits', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const pool = db.getPool();
        const [drivers] = await pool.execute(
            `SELECT d.*, z.heating_circuit 
             FROM devices d
             LEFT JOIN zones z ON d.zone_id = z.id
             LEFT JOIN emulated_devices ed ON d.serial_no = ed.serial_no
             WHERE d.home_id = ? AND d.device_type IN ('RU01', 'RU02', 'BU01')
               AND (ed.mode IS NULL OR ed.mode != 'WIRELESS_SENSOR')`,
            [homeId]
        );

        res.json(drivers.map(driver => ({
            number: driver.heating_circuit ? parseInt(driver.heating_circuit, 10) : 1,
            driverSerialNo: driver.serial_no,
            driverShortSerialNo: driver.serial_no
        })));
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/v2/homes/{homeId}/heatingCircuits/{circuitNumber}/driverDevice
router.put('/:homeId/heatingCircuits/:circuitNumber/driverDevice', async (req, res) => {
    try {
        const { homeId, circuitNumber } = req.params;
        const { isReadOnly, devBypass } = await checkZoneConfigReadonly(homeId);
        if (isReadOnly && !devBypass) {
            return res.status(403).json({ error: 'zone_config_readonly', message: 'Zone configuration is read-only' });
        }
        const { serialNo } = req.body;
        if (!serialNo) return res.status(400).json({ error: 'serialNo is required' });

        const pool = db.getPool();
        const commandApi = require('../../../lib/command-api');

        // Look up the new driver device
        const [newDriverRows] = await pool.execute('SELECT * FROM devices WHERE serial_no = ? AND home_id = ?', [serialNo, homeId]);
        if (newDriverRows.length === 0) return res.status(404).json({ error: 'Device not found in this home' });

        // Get the old driver for this circuit (if any)
        const [oldCircuits] = await pool.execute('SELECT driver_serial_no FROM heating_circuits WHERE home_id = ? AND number = ?', [homeId, circuitNumber]);
        const oldDriverSerial = oldCircuits.length > 0 ? oldCircuits[0].driver_serial_no : null;

        // Upsert the heating circuit with the new driver
        if (oldCircuits.length > 0) {
            await pool.execute(
                'UPDATE heating_circuits SET driver_serial_no = ? WHERE home_id = ? AND number = ?',
                [serialNo, homeId, circuitNumber]
            );
        } else {
            await pool.execute(
                'INSERT INTO heating_circuits (home_id, number, driver_serial_no) VALUES (?, ?, ?)',
                [homeId, circuitNumber, serialNo]
            );
        }

        // Push config refresh to affected devices so zone binding pairs are recalculated
        const refreshTargets = new Set();
        if (oldDriverSerial) refreshTargets.add(oldDriverSerial);
        refreshTargets.add(serialNo);

        // Also refresh the bridge
        const [ibDevs] = await pool.execute("SELECT serial_no FROM devices WHERE home_id = ? AND device_type LIKE 'IB%' LIMIT 1", [homeId]);
        if (ibDevs.length > 0) refreshTargets.add(ibDevs[0].serial_no);

        for (const target of refreshTargets) {
            await commandApi.pushConfigRefresh(target).catch(e =>
                _log('warn', `Config refresh failed for ${target} after boiler change: ${e.message}`)
            );
        }

        res.json({
            number: parseInt(circuitNumber, 10),
            driverSerialNo: serialNo,
            driverShortSerialNo: serialNo
        });
    } catch (err) {
        _log('error', `Change boiler error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

module.exports = router;