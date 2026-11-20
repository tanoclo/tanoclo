/**
 * @file lib/availability.js
 * @brief Separate cached device connectivity from the bridge required to reach it.
 */

'use strict';

/**
 * @typedef {object} DeviceObservation
 * @property {string} serial_no
 * @property {string|null} device_type
 * @property {0|1|null} connection_state Last observed device state, not backend readiness.
 * @property {number|null} zone_id
 * @property {0|1|boolean} [is_emulated]
 */

/**
 * @param {ReadonlyArray<DeviceObservation>} devices Home-scoped observations.
 * @returns {(device: DeviceObservation) => boolean} Effective availability for this snapshot.
 */
function isBridge(device) {
    const type = String(device.device_type || '').toUpperCase();
    const serial = String(device.serial_no || '').toUpperCase();
    return /^(IB|GW)/.test(type) || /^(IB|GW)/.test(serial) || type === 'BRIDGE';
}

function deviceAvailability(devices) {
    const bridges = devices.filter(isBridge);
    const bridgeOnline = bridges.some(device => device.connection_state === 1);
    return device => {
        if (device.connection_state !== 1) return false;
        if (device.is_emulated === 1 || device.is_emulated === true) return true;
        if (isBridge(device)) return true;
        // The database does not map devices to their bridge. Infer reachability
        // only in single-bridge homes; otherwise keep the device observation.
        return bridges.length !== 1 || bridgeOnline;
    };
}

/**
 * @param {{id: number, type: string}} zone Home-scoped zone row.
 * @param {ReadonlyArray<DeviceObservation>} devices Home-scoped observations.
 * @param {ReadonlyArray<{driver_serial_no: string|null}>} circuits Home-scoped circuits.
 * @param {(device: DeviceObservation) => boolean} available Effective device availability.
 * @returns {boolean}
 */
function zoneAvailability(zone, devices, circuits, available) {
    if (zone.type === 'HOT_WATER' || zone.type === 'DHW') {
        const leaders = new Set(circuits.map(circuit => circuit.driver_serial_no).filter(Boolean));
        return devices.some(device => leaders.has(device.serial_no) && available(device));
    }
    return devices.some(device => device.zone_id === zone.id && available(device));
}

module.exports = { deviceAvailability, zoneAvailability };
