/**
 * @file lib/handlers/path-classifier.js
 * @brief URL path classifier logic matching CoAP paths.
 */

'use strict';

const { getLogger } = require('../logger');
const log = getLogger();

let db, wsBridge, ipv6ToDevice, extractShortSerial;

function init(deps) {
    db = deps.db;
    wsBridge = deps.wsBridge;
    ipv6ToDevice = deps.ipv6ToDevice;
    extractShortSerial = deps.extractShortSerial;
}

function extractHomeId(parts) {
    const homeIdx = parts.indexOf('h');
    return homeIdx >= 0 && homeIdx + 1 < parts.length ? parts[homeIdx + 1] : null;
}

function extractDeviceId(parts, keyword, fallback) {
    const pathDeviceId = getDeviceIdFromPath(parts);
    return (pathDeviceId && pathDeviceId !== keyword) ? pathDeviceId : fallback;
}

function extractZoneId(parts, queryOptions) {
    const zIdx = parts.indexOf('z');
    if (zIdx < 0 || zIdx + 1 >= parts.length) return null;
    if (parts[zIdx + 1] === 's' || parts[zIdx + 1] === 'overlay') {
        const idQuery = queryOptions.find(q => q.startsWith('id='));
        return idQuery ? parseInt(idQuery.split('=')[1], 10) : null;
    }
    return parseInt(parts[zIdx + 1], 10) || parts[zIdx + 1];
}

function extractCircuitId(parts) {
    const cIdx = parts.indexOf('c');
    return cIdx >= 0 && cIdx + 1 < parts.length ? parts[cIdx + 1] : null;
}

const SIMPLE_ROUTES = [
    { match: 'sen', type: 'device_sensor', extract: 'device' },
    { match: 'info', type: 'device_info', extract: 'device' },
    { match: 'dbg', type: 'device_debug', extract: 'device' },
    { match: 'dbg2', type: 'device_debug', extract: 'device' },
    { match: 'dispsettings', type: 'device_dispsettings', extract: 'device' },
    { match: 'err', type: 'device_error', extract: 'device' },
    { match: 'mnt', type: 'mount', extract: 'device' },
    { match: 'neighbors', type: 'neighbors', extract: 'device' },
    { match: 'selftest', type: 'selftest', extract: 'device' },
    { match: 'rfkey', type: 'rfkey', extract: 'device' },
    { match: 'lock', type: 'lock', extract: 'device' },
    { match: 'reboot', type: 'device_reboot', extract: 'device' },
    { match: 'time', type: 'time', extract: 'none' },
    { match: 'found', type: 'pair_found', extract: 'none' },
    { match: 'pair', type: 'pair', extract: 'none' },
    { match: 'identify', type: 'identify', extract: 'none' },
    { match: 'extui', type: 'zone_extui', extract: 'zone' },
    { match: 'ov', type: 'zone_overlay', extract: 'zone' },
    { match: 'p', type: 'zone_params', extract: 'zone' },
    { match: 'ow', type: 'open_window', extract: 'zone' }
];

async function classifyPath(uriPathStr = '', queryOptions = [], activeDeviceId = null) {
    const parts = (uriPathStr || '').split('/').filter(p => p.length > 0);
    let result;

    if (parts.length === 0) {
        result = { type: 'root', deviceId: activeDeviceId };
    }
    // 1. Complex/special route logic
    else if (parts.includes('auth')) {
        const deviceId = extractDeviceId(parts, 'auth', activeDeviceId);
        const homeId = extractHomeId(parts);
        if (parts.includes('key')) {
            result = { type: 'auth_key', deviceId, homeId };
        } else {
            result = { type: 'auth_token', deviceId, homeId };
        }
    }
    else if (parts.includes('act')) {
        const actIdx = parts.lastIndexOf('act');
        const prevSegIdx = actIdx - 1;
        if (prevSegIdx >= 0) {
            const prevPrev = prevSegIdx - 1 >= 0 ? parts[prevSegIdx - 1] : null;
            if (prevPrev === 'c' || parts.includes('c')) {
                const circuitId = extractCircuitId(parts);
                const homeId = extractHomeId(parts);
                result = { type: 'circuit_actuator', circuitId, homeId, deviceId: activeDeviceId };
            } else if (parts.includes('d')) {
                const deviceId = extractDeviceId(parts, 'act', activeDeviceId);
                const homeId = extractHomeId(parts);
                result = { type: 'device_actuator', deviceId, homeId };
            } else if (parts.includes('z')) {
                const zIdx = parts.indexOf('z');
                const zoneId = zIdx >= 0 && zIdx + 1 < parts.length ? parts[zIdx + 1] : null;
                const homeId = extractHomeId(parts);
                result = { type: 'zone_actuator', zoneId, homeId, deviceId: activeDeviceId };
            } else {
                const deviceId = extractDeviceId(parts, 'act', activeDeviceId);
                const homeId = extractHomeId(parts);
                result = { type: 'device_actuator', deviceId, homeId };
            }
        } else {
            const deviceId = extractDeviceId(parts, 'act', activeDeviceId);
            const homeId = extractHomeId(parts);
            result = { type: 'device_actuator', deviceId, homeId };
        }
    }
    else if (parts.includes('config')) {
        const homeId = extractHomeId(parts);
        if (parts.includes('d')) {
            const deviceId = extractDeviceId(parts, 'config', activeDeviceId);
            result = { type: 'device_config', deviceId, homeId };
        } else if (parts.includes('c')) {
            const circuitId = extractCircuitId(parts);
            result = { type: 'circuit_config', circuitId, homeId, deviceId: activeDeviceId };
        } else if (parts.includes('z')) {
            const zIdx = parts.indexOf('z');
            const zoneId = zIdx + 1 < parts.length ? parts[zIdx + 1] : null;
            result = { type: 'zone_config', zoneId, homeId, deviceId: activeDeviceId };
        } else if (parts.includes('hvac')) {
            result = { type: 'hvac_config', homeId, deviceId: activeDeviceId };
        } else {
            const deviceId = extractDeviceId(parts, 'config', activeDeviceId);
            result = { type: 'device_config', deviceId, homeId };
        }
    }
    else if (parts.includes('fw')) {
        const pathDeviceId = getDeviceIdFromPath(parts);
        const deviceId = (pathDeviceId && pathDeviceId !== 'fw' && pathDeviceId !== 'state' && pathDeviceId !== 'rq') ? pathDeviceId : activeDeviceId;
        const homeId = extractHomeId(parts);
        if (parts.includes('rq')) {
            result = { type: 'firmware_request', deviceId, homeId };
        } else {
            result = { type: 'firmware_state', deviceId, homeId };
        }
    }
    else if (parts.includes('fallback')) {
        const homeId = extractHomeId(parts);
        if (parts.includes('z')) {
            const zIdx = parts.indexOf('z');
            const zoneId = zIdx >= 0 && zIdx + 1 < parts.length ? parts[zIdx + 1] : null;
            result = { type: 'zone_fallback', zoneId, homeId, deviceId: activeDeviceId };
        } else {
            const deviceId = extractDeviceId(parts, 'fallback', activeDeviceId);
            result = { type: 'device_fallback', deviceId, homeId };
        }
    }
    else if (parts.includes('s')) {
        const zIdx = parts.indexOf('z');
        let zoneId = null;
        if (zIdx >= 0 && zIdx + 1 < parts.length) {
            if (parts[zIdx + 1] === 's') {
                const idQuery = queryOptions.find(q => q.startsWith('id='));
                if (idQuery) zoneId = parseInt(idQuery.split('=')[1], 10);
            } else {
                zoneId = parseInt(parts[zIdx + 1], 10);
            }
        }
        let homeId = extractHomeId(parts);
        if (zoneId == null && activeDeviceId) {
            try {
                const zt = await db.getZoneForDevice(activeDeviceId);
                if (zt) {
                    zoneId = zt.zoneId;
                    if (!homeId) homeId = zt.homeId;
                }
            } catch (e) { /* ignore */ }
        }
        result = { type: 'zone_state', zoneId, homeId, deviceId: activeDeviceId };
    }
    else if (parts.includes('overlay')) {
        const zIdx = parts.indexOf('z');
        let zoneId = null;
        if (zIdx >= 0 && zIdx + 1 <= parts.length) {
            if (parts[zIdx + 1] === 'overlay') {
                const idQuery = queryOptions.find(q => q.startsWith('id='));
                if (idQuery) zoneId = parseInt(idQuery.split('=')[1], 10);
            } else {
                zoneId = parseInt(parts[zIdx + 1], 10);
            }
        }
        const homeId = extractHomeId(parts);
        result = { type: 'zone_overlay', zoneId, homeId, deviceId: activeDeviceId };
    }
    else if (parts.includes('hvac')) {
        const homeId = extractHomeId(parts);
        if (parts.includes('mon')) {
            if (parts.includes('dhw')) result = { type: 'hvac_dhw', homeId, deviceId: activeDeviceId };
            else result = { type: 'hvac_mon', homeId, deviceId: activeDeviceId };
        } else if (parts.includes('codes')) result = { type: 'hvac_codes', homeId, deviceId: activeDeviceId };
        else if (parts.includes('config')) result = { type: 'hvac_config', homeId, deviceId: activeDeviceId };
        else if (parts.includes('dhw')) result = { type: 'hvac_dhw', homeId, deviceId: activeDeviceId };
        else if (parts.includes('maint')) result = { type: 'hvac_maint', homeId, deviceId: activeDeviceId };
        else result = { type: 'hvac_mon', homeId, deviceId: activeDeviceId };
    }
    // 2. Declarative lookup for simple/flat routes
    else {
        let matched = false;
        for (const route of SIMPLE_ROUTES) {
            if (parts.includes(route.match)) {
                matched = true;
                const homeId = extractHomeId(parts);
                if (route.extract === 'device') {
                    result = { type: route.type, deviceId: extractDeviceId(parts, route.match, activeDeviceId), homeId };
                } else if (route.extract === 'zone') {
                    const zoneId = extractZoneId(parts, queryOptions);
                    result = { type: route.type, zoneId, homeId, deviceId: activeDeviceId };
                } else {
                    result = { type: route.type, deviceId: activeDeviceId };
                }
                break;
            }
        }

        // 3. Fallback for unlisted structural routes
        if (!matched) {
            const homeId = extractHomeId(parts);
            if (parts.includes('z')) {
                const zoneId = extractZoneId(parts, queryOptions);
                result = { type: 'zone_state', zoneId, homeId, deviceId: activeDeviceId };
            } else if (parts.includes('c')) {
                const circuitId = extractCircuitId(parts);
                result = { type: 'circuit_actuator', circuitId, homeId, deviceId: activeDeviceId };
            } else if (parts.includes('d')) {
                const deviceId = extractDeviceId(parts, '', activeDeviceId);
                result = { type: 'device_info', deviceId, homeId };
            } else if (parts.includes('h')) {
                result = { type: 'home', homeId, deviceId: activeDeviceId };
            } else {
                result = { type: parts[parts.length - 1] || 'root', deviceId: activeDeviceId, homeId };
            }
        }
    }

    // 3. Fallback homeId resolution from DB
    if (result.deviceId && !result.homeId) {
        const shortSerial = extractShortSerial(result.deviceId);
        if (shortSerial && !shortSerial.match(/^(lock|identify|time|config|pair|s|sen|act|fw|state|err|fallback|mnt|neighbors|hvac|ow|overlay|selftest|rfkey|reboot)$/)) {
            const inferredHomeId = await db.getHomeForDevice(shortSerial);
            if (inferredHomeId !== null && inferredHomeId !== undefined) {
                result.homeId = inferredHomeId.toString();
            }
        }
    }

    return result;
}

function getDeviceIdFromPath(parts) {
    const dIdx = parts.indexOf('d');
    return dIdx >= 0 && dIdx + 1 < parts.length ? parts[dIdx + 1] : null;
}

async function populateIpv6Map() {
    try {
        const devices = await db.getAllDevices();
        let count = 0;
        for (const dev of devices) {
            if (dev.ipv6_address && dev.serial_no) {
                try {
                    const normIp = wsBridge.ipv6FromBytes(wsBridge.ipv6ToBytes(dev.ipv6_address));
                    ipv6ToDevice.set(normIp, dev.serial_no);
                    count++;
                } catch (e) {
                    ipv6ToDevice.set(dev.ipv6_address, dev.serial_no);
                    count++;
                }
            }
        }
        log('debug', `Pre-populated IPv6 map with ${count} devices`);
    } catch (e) {
        log('error', `Failed to populate IPv6 map: ${e.message}`);
    }
}

module.exports = {
    init,
    classifyPath,
    getDeviceIdFromPath,
    populateIpv6Map
};
