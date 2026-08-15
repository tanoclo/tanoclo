/**
 * @file api/routes/homes/helpers.js
 * @brief Helper utility functions for home API endpoints.
 * 
 * Provides shared routines to check zone config readonly states and assemble home details
 * JSON structures (containing address, geolocation, contact details, and user permissions).
 */

const db = require('../../../lib/db');
const config = require('../../../lib/config');

async function checkConfigReadonly(homeId) {
    const pool = db.getPool();
    const [homes] = await pool.execute('SELECT zone_config_readonly, dev_bypass FROM homes WHERE id = ?', [homeId]);
    if (homes.length === 0) return { isReadOnly: false, devBypass: false };
    const config = require('../../lib/config');
    const isReadOnly = homes[0].zone_config_readonly === null ? config.zoneConfigReadonly : Boolean(homes[0].zone_config_readonly);
    const devBypass = Boolean(homes[0].dev_bypass);
    return { isReadOnly, devBypass };
}
const checkZoneConfigReadonly = checkConfigReadonly;

async function buildHomeDetails(homeRow, userId = null) {
    const pool = db.getPool();
    const [zonerows] = await pool.execute('SELECT COUNT(*) as count FROM zones WHERE home_id = ?', [homeRow.id]);

    let adminRows;
    if (homeRow.admin_user_id) {
        [adminRows] = await pool.execute('SELECT id, name, email FROM users WHERE id = ? LIMIT 1', [homeRow.admin_user_id]);
    }

    if (!adminRows || adminRows.length === 0) {
        [adminRows] = await pool.execute(
            `SELECT u.id, u.name, u.email FROM users u 
             WHERE u.home_id = ? LIMIT 1`,
            [homeRow.id]
        );
    }
    const adminUser = adminRows[0] || { id: '0', name: 'Unknown', email: '' };

    let isCurrentUserAdmin = false;
    if (userId) {
        if (userId === adminUser.id) {
            isCurrentUserAdmin = true;
        } else {
            const [hu] = await pool.execute('SELECT is_tanoclo_admin FROM users WHERE id = ?', [userId]);
            if (hu.length > 0 && hu[0].is_tanoclo_admin === 1) {
                isCurrentUserAdmin = true;
            }
        }
    }

    return {
        id: parseInt(homeRow.id, 10),
        name: homeRow.name,
        isCurrentUserAdmin: isCurrentUserAdmin,
        adminUser: {
            id: adminUser.id,
            name: adminUser.name,
            email: adminUser.email,
            skills: []
        },
        adminUserId: adminUser.id,
        dateTimeZone: homeRow.date_time_zone || 'Europe/Berlin',
        dateCreated: homeRow.date_created ? (typeof homeRow.date_created === 'string' ? homeRow.date_created : homeRow.date_created.toISOString()) : new Date().toISOString(),
        temperatureUnit: homeRow.temperature_unit || 'CELSIUS',
        partner: null,
        simpleSmartScheduleEnabled: true,
        awayRadiusInMeters: parseFloat(homeRow.away_radius_in_meters || 300.0).toFixed(2) * 1,
        installationCompleted: Boolean(homeRow.installation_completed),
        incidentDetection: {
            supported: Boolean(homeRow.incident_detection_enabled),
            enabled: Boolean(homeRow.incident_detection_enabled)
        },
        generation: homeRow.generation || 'PRE_LINE_X',
        zonesCount: parseInt(zonerows[0].count, 10),
        language: homeRow.language || 'en',
        skills: ["AUTO_ASSIST", "PRE_2025_FREE_FEATURES"],
        christmasModeEnabled: true,
        showAutoAssistReminders: true,
        contactDetails: {
            name: homeRow.contact_name || adminUser.name,
            email: homeRow.contact_email || adminUser.email,
            phone: homeRow.contact_phone || ""
        },
        address: {
            addressLine1: homeRow.address_line1 || "",
            addressLine2: homeRow.address_line2 || "",
            zipCode: homeRow.address_zip_code || "",
            city: homeRow.address_city || "",
            state: homeRow.address_state || null,
            country: homeRow.address_country || ""
        },
        geolocation: {
            latitude: parseFloat(parseFloat(homeRow.latitude || 0.0).toFixed(7)),
            longitude: parseFloat(parseFloat(homeRow.longitude || 0.0).toFixed(7))
        },
        consentGrantSkippable: true,
        enabledFeatures: [
            "ADAPTIVE_HEATING",
            "AI_ASSIST_MESSAGING_ENABLED",
            "AI_ASSIST_OVERVIEW",
            "AI_PREHEATING_V2",
            "ASSIST_BANNER_TEST_HIDE_DISMISSAL",
            "CUSTOM_THREAD_NETWORK_FLOW",
            "HOLIDAY_MODE",
            "ONE_WEBVIEW",
            "TABBAR_IN_WEBVIEW"
        ],
        isAirComfortEligible: true,
        isEnergyIqEligible: true,
        isHeatSourceInstalled: false,
        isHeatPumpInstalled: false,
        supportsFlowTemperatureOptimization: true,
        configReadonly: homeRow.zone_config_readonly === null ? config.zoneConfigReadonly : Boolean(homeRow.zone_config_readonly),
        zoneConfigReadonly: homeRow.zone_config_readonly === null ? config.zoneConfigReadonly : Boolean(homeRow.zone_config_readonly),
        devBypass: Boolean(homeRow.dev_bypass)
    };
}

module.exports = {
    checkConfigReadonly,
    checkZoneConfigReadonly,
    buildHomeDetails
};
