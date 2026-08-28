/**
 * Shared mapping functions for API responses.
 * Centralized to avoid duplicate copies across route files.
 */
const geoUtils = require('./geo-utils');
const { getFriendlyErrorFlags } = require('./mqtt-publisher');

const deriveMacFromIpv6 = (ipv6) => {
    if (!ipv6 || typeof ipv6 !== 'string') return null;
    let parts = ipv6.split(':');
    if (ipv6.includes('::')) {
        const [left, right] = ipv6.split('::');
        const leftParts = left ? left.split(':') : [];
        const rightParts = right ? right.split(':') : [];
        const missingCount = 8 - (leftParts.length + rightParts.length);
        const middle = new Array(missingCount).fill('0');
        parts = [...leftParts, ...middle, ...rightParts];
    }
    if (parts.length !== 8) return null;
    const last4 = parts.slice(4).map(part => part.padStart(4, '0').toLowerCase());
    const hexStr = last4.join('');
    const bytes = Buffer.from(hexStr, 'hex');
    if (bytes.length !== 8) return null;
    bytes[0] = bytes[0] ^ 0x02;
    const macParts = [];
    for (let i = 0; i < 8; i++) {
        macParts.push(bytes[i].toString(16).padStart(2, '0').toUpperCase());
    }
    return macParts.join(':');
};


/**
 * Maps a raw device DB row to the API response format.
 */
function mapDevice(d) {
    const mapped = {
        deviceType: d.device_type || 'SU02',
        serialNo: d.serial_no,
        shortSerialNo: d.serial_no,
        friendlyName: d.friendly_name || null,
        currentFwVersion: d.current_fw_version || '215.1',
        connectionState: {
            value: Boolean(d.connection_state ?? true),
            timestamp: d.connection_state_timestamp ? (typeof d.connection_state_timestamp === 'string' ? d.connection_state_timestamp : d.connection_state_timestamp.toISOString()) : new Date().toISOString()
        },
        characteristics: {
            capabilities: (() => {
                const caps = [];
                if (d.cap_inside_temp_measurement !== 0) caps.push("INSIDE_TEMPERATURE_MEASUREMENT");
                if (d.cap_identify !== 0) caps.push("IDENTIFY");
                if (d.cap_radio_encryption_key_access === 1) caps.push("RADIO_ENCRYPTION_KEY_ACCESS");
                return caps;
            })()
        },
        batteryState: d.battery_state || 'NORMAL',
        mountingStateWithError: d.mounting_state_with_error || null,
        temperatureOffset: parseFloat(d.field_0140 || 0),
        zoneId: d.zone_id ? parseInt(d.zone_id, 10) : null,
        errorFlags: d.field_01a3 !== null && d.field_01a3 !== undefined ? parseInt(d.field_01a3, 10) : 0,
        friendlyErrorFlags: getFriendlyErrorFlags(d.field_01a3),
        displayBrightness: d.field_019e !== null && d.field_019e !== undefined ? parseInt(d.field_019e, 10) : 112,
        displayContrast: d.field_019d !== null && d.field_019d !== undefined ? parseInt(d.field_019d, 10) : 128,
        displayActiveTimeout: d.field_02b2 !== null && d.field_02b2 !== undefined ? parseInt(d.field_02b2, 10) : 0,
        ipv6Address: d.ipv6_address || null,
        isEmulated: Boolean(d.is_emulated || d.emulated_mode),
        emulatedMode: d.emulated_mode || null,
        field_015d: Boolean(d.is_emulated || d.emulated_mode) 
            ? (d.device_type && d.device_type.startsWith('RU') ? 200 : (d.field_015d !== null && d.field_015d !== undefined ? parseInt(d.field_015d, 10) : (d.device_type === 'VA02' ? 112 : 71)))
            : (d.field_015d !== null && d.field_015d !== undefined ? parseInt(d.field_015d, 10) : (d.device_type && d.device_type.startsWith('RU') ? 71 : (d.device_type === 'VA02' ? 112 : null))),
        deviceRole: (Boolean(d.is_emulated || d.emulated_mode) && d.device_type && d.device_type.startsWith('RU')) || (d.field_015d === 200 || d.field_015d === '200')
            ? 'WIRELESS_SENSOR'
            : (d.device_type && d.device_type.startsWith('RU') ? 'WIRED_THERMOSTAT' : null)
    };

    if ((d.device_type && d.device_type.startsWith('IB')) || mapped.isEmulated) {
        delete mapped.batteryState;
    }

    if (d.device_type !== 'VA01' && d.device_type !== 'VA02') {
        delete mapped.mountingStateWithError;
    }

    if (d.device_type && d.device_type.startsWith('VA')) {
        mapped.actuatorLimits = {
            lowSteps: d.field_0273 !== null && d.field_0273 !== undefined ? parseInt(d.field_0273, 10) : null,
            highSteps: d.field_027c !== null && d.field_027c !== undefined ? parseInt(d.field_027c, 10) : null,
            driveConstant: d.field_0280 !== null && d.field_0280 !== undefined ? parseInt(d.field_0280, 10) : null,
            position1: d.field_0265 !== null && d.field_0265 !== undefined ? parseInt(d.field_0265, 10) : null,
            position2: d.field_0266 !== null && d.field_0266 !== undefined ? parseInt(d.field_0266, 10) : null,
            active: (d.field_028c !== null && d.field_028c !== undefined)
                ? parseInt(d.field_028c, 10)
                : ((d.field_016a === 'CALIBRATED' || d.field_016a === 'MOUNTED' || (parseInt(d.field_01b6, 10) > 0 && parseInt(d.field_0273, 10) > 0)) ? 1 : 0),
            mountingState: d.field_016a !== null && d.field_016a !== undefined ? d.field_016a : (parseInt(d.field_01b6, 10) > 0 ? 'CALIBRATED' : null),
            seatPoint: d.field_01b6 !== null && d.field_01b6 !== undefined ? parseInt(d.field_01b6, 10) : null,
            referencePoint: d.field_01b5 !== null && d.field_01b5 !== undefined ? parseInt(d.field_01b5, 10) : null,
            mode: d.field_01fa !== null && d.field_01fa !== undefined ? parseInt(d.field_01fa, 10) : null,
            flags: d.field_01fb !== null && d.field_01fb !== undefined ? parseInt(d.field_01fb, 10) : null,
            deviation: d.field_0283 !== null && d.field_0283 !== undefined ? parseInt(d.field_0283, 10) : null
        };
    }

    if (d.device_type === 'VA02') {
        mapped.orientation = d.field_0149 || 'VERTICAL';
    }

    if (d.device_type === 'VA02' && d.field_016a) {
        mapped.mountingState = {
            value: d.field_016a,
            timestamp: d.mounting_state_timestamp ? (typeof d.mounting_state_timestamp === 'string' ? d.mounting_state_timestamp : d.mounting_state_timestamp.toISOString()) : new Date().toISOString()
        };
    }

    if (d.device_type === 'VA02') {
        mapped.childLockEnabled = Boolean(d.child_lock_enabled);
    }

    if (d.device_type === 'IB01' || (d.device_type && d.device_type.startsWith('IB'))) {
        mapped.inPairingMode = Boolean(d.in_pairing_mode);
        try {
            const { getBridgeBlockStatus } = require('./device-manager');
            mapped.pairingBlock = getBridgeBlockStatus(d.serial_no);
        } catch (e) {
            mapped.pairingBlock = { active: false, remainingSeconds: 0 };
        }
    }

    mapped.neighborData = null;
    if (d.neighbor_data) {
        try {
            mapped.neighborData = typeof d.neighbor_data === 'string' ? JSON.parse(d.neighbor_data) : d.neighbor_data;
        } catch (e) {
            mapped.neighborData = null;
        }
    }

    return mapped;
}

/**
 * Maps a raw mobile_device DB row to the API response format.
 */
function mapMobileDevice(d, home = null) {
    let bearing = { degrees: 0.0, radians: 0.0 };
    let relativeDistance = 0.0;

    if (home && d.latitude !== null && d.longitude !== null && home.latitude && home.longitude) {
        const homeLat = parseFloat(home.latitude);
        const homeLon = parseFloat(home.longitude);
        const devLat = parseFloat(d.latitude);
        const devLon = parseFloat(d.longitude);

        const dist = geoUtils.haversineDistance(homeLat, homeLon, devLat, devLon);
        const radius = parseFloat(home.away_radius_in_meters || 200);
        relativeDistance = dist - radius;

        const brngRad = geoUtils.calculateBearing(homeLat, homeLon, devLat, devLon);
        bearing = {
            degrees: geoUtils.radiansToDegrees(brngRad),
            radians: brngRad
        };
    }

    return {
        id: isNaN(Number(d.id)) ? d.id : parseInt(d.id, 10),
        name: d.name,
        userId: d.user_id,
        settings: {
            geoTrackingEnabled: Boolean(d.geo_tracking_enabled ?? false),
            specialOffersEnabled: Boolean(d.special_offers_enabled ?? true),
            onDemandLogRetrievalEnabled: Boolean(d.on_demand_log_retrieval_enabled ?? false),
            smartRemindersInAppEnabled: Boolean(d.smart_reminders_in_app_enabled ?? true),
            pushNotifications: {
                lowBatteryReminder: Boolean(d.push_low_battery_reminder ?? true),
                awayModeReminder: Boolean(d.push_away_mode_reminder ?? true),
                homeModeReminder: Boolean(d.push_home_mode_reminder ?? true),
                openWindowReminder: Boolean(d.push_open_window_reminder ?? true),
                energySavingsReportReminder: Boolean(d.push_energy_savings_report_reminder ?? true),
                incidentDetection: Boolean(d.push_incident_detection ?? true),
                energyIqReminder: Boolean(d.push_energy_iq_reminder ?? false),
                tariffHighPriceAlert: Boolean(d.push_tariff_high_price_alert ?? true),
                tariffLowPriceAlert: Boolean(d.push_tariff_low_price_alert ?? true),
                smartReminders: Boolean(d.push_smart_reminders ?? true)
            }
        },
        location: Boolean(d.geo_tracking_enabled ?? false) ? {
            stale: d.last_seen ? (Date.now() - new Date(d.last_seen).getTime() > 24 * 60 * 60 * 1000) : true,
            atHome: Boolean(d.at_home ?? false),
            bearingFromHome: bearing,
            relativeDistanceFromHomeFence: relativeDistance,
            lastSeen: d.last_seen || null
        } : null,
        deviceMetadata: {
            platform: d.platform || 'Unknown',
            osVersion: d.os_version || 'Unknown',
            model: d.model || 'Unknown',
            locale: d.locale || 'en'
        },
        geofencingAccessToken: d.geofencing_access_token || null
    };
}

module.exports = { mapDevice, mapMobileDevice };
