/**
 * @file api/routes/graphql.js
 * @brief Simple GraphQL API mock routing endpoints.
 * 
 * Interrogates search queries from boiler configuration portals, resolving searchManufacturers
 * and searchSystems parameters using database tables without full GraphQL engine overheads.
 */

const express = require('express');
const db = require('../../lib/db');
const authMiddleware = require('../middleware/auth');
const { getLogger } = require('../../lib/logger');

const router = express.Router();
const _log = getLogger('graphql-api');

// The ivar graphql endpoint should not be covered by authorization
// router.use(authMiddleware);

async function searchManufacturers(query, variables, res) {
    const match = query.match(/searchText\s*:\s*"([^"]+)"/);
    const searchText = match ? match[1] : '';

    const pool = db.getPool();
    let sql = "SELECT * FROM manufacturers";
    const params = [];

    if (searchText) {
        sql += " WHERE name LIKE ?";
        params.push('%' + searchText + '%');
    }
    sql += " ORDER BY name ASC LIMIT 50";

    const [manufacturers] = await pool.execute(sql, params);

    const data = manufacturers.map(m => ({
        id: String(m.id),
        name: m.name
    }));

    res.json({ data: { searchManufacturers: { manufacturers: data } } });
}

async function searchSystems(query, variables, res) {
    let manufacturerIds = [];
    const matchIds = query.match(/manufacturerIds\s*:\s*\[([\d,\s]+)\]/);
    if (matchIds) {
        manufacturerIds = matchIds[1].split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    }

    const matchText = query.match(/searchText\s*:\s*"([^"]+)"/);
    const searchText = matchText ? matchText[1] : '';

    const pool = db.getPool();
    let sql = "SELECT bm.* FROM boiler_models bm";
    const params = [];
    const conditions = [];

    if (manufacturerIds.length > 0) {
        sql += " JOIN boiler_model_manufacturers bmm ON bm.id = bmm.boiler_model_id";
        const placeholders = manufacturerIds.map(() => '?').join(',');
        conditions.push(`bmm.manufacturer_id IN (${placeholders})`);
        params.push(...manufacturerIds);
    }

    if (searchText) {
        conditions.push("bm.model_name LIKE ?");
        params.push('%' + searchText + '%');
    }

    if (conditions.length > 0) {
        sql += " WHERE " + conditions.join(' AND ');
    }
    sql += " LIMIT 100";

    const [systems] = await pool.execute(sql, params);
    const data = [];

    for (const sys of systems) {
        const [manuNames] = await pool.execute(
            "SELECT m.name FROM manufacturers m JOIN boiler_model_manufacturers bmm ON m.id = bmm.manufacturer_id WHERE bmm.boiler_model_id = ?",
            [sys.id]
        );
        data.push({
            id: String(sys.id),
            modelName: sys.model_name,
            manufacturers: manuNames.map(m => ({ name: m.name })),
            thumbnail: { schematic: sys.local_image_path ? { url: sys.local_image_path } : null }
        });
    }

    res.json({ data: { searchSystems: { systems: data } } });
}

async function getSystem(id, res) {
    const pool = db.getPool();
    const [sysRows] = await pool.execute("SELECT * FROM boiler_models WHERE id = ?", [id]);

    if (sysRows.length === 0) {
        return res.json({ data: { system: null } });
    }
    const sys = sysRows[0];

    const [manuNames] = await pool.execute(
        "SELECT m.name FROM manufacturers m JOIN boiler_model_manufacturers bmm ON m.id = bmm.manufacturer_id WHERE bmm.boiler_model_id = ?",
        [id]
    );

    res.json({
        data: {
            system: {
                modelName: sys.model_name,
                shortModelName: sys.short_model_name || sys.model_name,
                thumbnail: { schematic: sys.local_image_path ? { url: sys.local_image_path } : null },
                manufacturers: manuNames.map(m => ({ name: m.name }))
            }
        }
    });
}

async function getTariffAccountAndPermissions(variables, res) {
    res.json({
        data: {
            home: {
                tariff: {
                    account: {
                        isOwnedByCurrentUser: false,
                        isLinkedToHome: false,
                        isPendingHomeLink: false
                    },
                    accessPermissions: {
                        canAccessEnergyReadings: false,
                        canAccessEnergyPrices: false,
                        canAccessPushNotificationSettings: false
                    }
                }
            }
        }
    });
}

// POST /api/v2/graphql
router.post('/', async (req, res) => {
    try {
        const query = req.body.query || '';
        const variables = req.body.variables || {};

        if (query.includes('searchManufacturers')) {
            return await searchManufacturers(query, variables, res);
        }

        if (query.includes('searchSystems')) {
            return await searchSystems(query, variables, res);
        }

        if (query.includes('TariffAccountAndPermissions')) {
            return await getTariffAccountAndPermissions(variables, res);
        }

        const systemMatch = query.match(/system\s*\(\s*id\s*:\s*(\d+)\s*\)/);
        if (systemMatch) {
            return await getSystem(parseInt(systemMatch[1], 10), res);
        }

        res.status(400).json({ error: 'Unsupported GraphQL query' });
    } catch (err) {
        _log('error', `GraphQL Error: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

module.exports = router;
