/**
 * @file api/routes/bridges.js
 * @brief REST routes invoked by Internet Bridges to obtain configuration parameters.
 * 
 * Implements endpoints queried by hardware devices to read/write boiler configuration metrics,
 * check installation steps completion status, and manage maximum boiler water flow temperatures.
 */

const express = require('express');
const db = require('../../lib/db');
const { getLogger } = require('../../lib/logger');

const router = express.Router();
const _log = getLogger('bridges-api');

async function checkAuthKey(req, res, next) {
    const authKey = req.query.authKey;
    const bridgeId = req.params.bridgeId;

    if (!authKey) return res.status(400).json({ errors: [{ code: 'badRequest', title: 'Missing authKey' }] });

    const pool = db.getPool();
    const [devices] = await pool.execute('SELECT config_etag FROM devices WHERE serial_no = ? AND device_type = "IB01"', [bridgeId]);

    if (devices.length === 0) return res.status(404).json({ errors: [{ code: 'notFound', title: 'Bridge not found' }] });

    const rawKey = devices[0].config_etag;
    const dbAuthKey = Buffer.isBuffer(rawKey) ? rawKey.toString('utf8') : String(rawKey || '');
    if (dbAuthKey !== authKey) return res.status(401).json({ errors: [{ code: 'unauthorized', title: 'Invalid authKey' }] });

    next();
}

// GET /api/v2/bridges/{bridgeId}
router.get('/:bridgeId', checkAuthKey, async (req, res) => {
    try {
        const pool = db.getPool();
        const [devices] = await pool.execute('SELECT home_id FROM devices WHERE serial_no = ?', [req.params.bridgeId]);

        res.json({
            partner: null,
            homeId: parseInt(devices[0].home_id, 10)
        });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/bridges/{bridgeId}/boiler/info
// GET /api/v2/homeByBridge/{bridgeId}/boilerInfo
router.get(['/:bridgeId/boiler/info', '/:bridgeId/boilerInfo'], checkAuthKey, async (req, res) => {
    try {
        const bridgeId = req.params.bridgeId;
        const pool = db.getPool();

        const [homeIds] = await pool.execute(
            'SELECT h.id FROM homes h JOIN devices d ON h.id = d.home_id WHERE d.serial_no = ?',
            [bridgeId]
        );
        if (homeIds.length === 0) return res.status(404).json({ error: 'Home for bridge not found' });

        const homeId = homeIds[0].id;
        const [systems] = await pool.execute('SELECT * FROM heating_systems WHERE home_id = ?', [homeId]);

        let boilerLabel = 'Generic Boiler';
        let boilerManufacturer = null;
        let hs = systems[0] || {};

        if (hs.boiler_model_id) {
            const [models] = await pool.execute('SELECT name, manufacturer FROM boiler_models WHERE id = ?', [hs.boiler_model_id]);
            if (models.length > 0) {
                boilerLabel = models[0].name || boilerLabel;
                boilerManufacturer = models[0].manufacturer || null;
            }
        }

        res.json({
            boilerLabel,
            boilerType: hs.boiler_type || 'GAS',
            boilerManufacturer,
            isModulating: hs.field_0458 !== null ? true : Boolean(hs.is_modulating ?? true)
        });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/bridges/{bridgeId}/boilerMaxOutputTemperature
router.get('/:bridgeId/boilerMaxOutputTemperature', checkAuthKey, async (req, res) => {
    try {
        const bridgeId = req.params.bridgeId;
        const pool = db.getPool();

        const [homeIds] = await pool.execute(
            'SELECT h.id FROM homes h JOIN devices d ON h.id = d.home_id WHERE d.serial_no = ?',
            [bridgeId]
        );
        if (homeIds.length === 0) return res.status(404).json({ error: 'Home for bridge not found' });

        const homeId = homeIds[0].id;
        let maxTemp = 75;
        const [ftRows] = await pool.execute('SELECT max_flow_temperature FROM flow_temperature_settings WHERE home_id = ?', [homeId]);
        if (ftRows.length > 0 && ftRows[0].max_flow_temperature) {
            maxTemp = parseFloat(ftRows[0].max_flow_temperature);
        }

        res.json({ maxOutputTemperature: maxTemp });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/v2/bridges/{bridgeId}/boilerWiringInstallationState
router.get('/:bridgeId/boilerWiringInstallationState', checkAuthKey, async (req, res) => {
    try {
        const bridgeId = req.params.bridgeId;
        const pool = db.getPool();

        const [homes] = await pool.execute(
            'SELECT h.installation_completed FROM homes h JOIN devices d ON h.id = d.home_id WHERE d.serial_no = ?',
            [bridgeId]
        );
        if (homes.length === 0) return res.status(404).json({ error: 'Home not found' });

        const completed = Boolean(homes[0].installation_completed);
        res.json({ state: completed ? 'COMPLETED' : 'IN_PROGRESS' });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/v2/bridges/{bridgeId}/boilerMaxOutputTemperature
// PUT /api/v2/homeByBridge/{bridgeId}/boilerMaxOutputTemperature
router.put('/:bridgeId/boilerMaxOutputTemperature', checkAuthKey, async (req, res) => {
    try {
        const bridgeId = req.params.bridgeId;
        const { maxOutputTemperature } = req.body;
        if (maxOutputTemperature === undefined || maxOutputTemperature === null) {
            return res.status(400).json({ errors: [{ code: 'badRequest', title: 'Missing maxOutputTemperature' }] });
        }
        const pool = db.getPool();

        const [homeIds] = await pool.execute(
            'SELECT h.id FROM homes h JOIN devices d ON h.id = d.home_id WHERE d.serial_no = ?',
            [bridgeId]
        );
        if (homeIds.length === 0) return res.status(404).json({ error: 'Home for bridge not found' });

        const homeId = homeIds[0].id;
        const [existing] = await pool.execute('SELECT id FROM flow_temperature_settings WHERE home_id = ?', [homeId]);
        if (existing.length > 0) {
            await pool.execute(
                'UPDATE flow_temperature_settings SET max_flow_temperature = ? WHERE home_id = ?',
                [maxOutputTemperature, homeId]
            );
        } else {
            await pool.execute(
                'INSERT INTO flow_temperature_settings (home_id, max_flow_temperature) VALUES (?, ?)',
                [homeId, maxOutputTemperature]
            );
        }

        res.json({ maxOutputTemperature });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

module.exports = router;