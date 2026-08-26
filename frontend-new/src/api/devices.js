/**
 * @file src/api/devices.js
 * @brief Handles Tado client-side API requests for interacting with physical device hardware.
 * 
 * Includes methods for retrieving device details, updating calibration offsets, triggering identification blinks,
 * setting child lock properties, modifying valve orientation, and starting/stopping pairing.
 */

import { apiFetch } from './client';

/**
 * Gets all devices in home
 * @param {string|number} homeId
 */
export function getDevices(homeId) {
  return apiFetch(`/api/v2/homes/${homeId}/devices`);
}

/**
 * Registers/Creates a device in home
 * @param {string|number} homeId
 * @param {object} deviceData - { serialNo, deviceType, zoneId, shortSerialNo }
 */
export function createDevice(homeId, deviceData) {
  return apiFetch(`/api/v2/homes/${homeId}/devices`, {
    method: 'POST',
    body: deviceData
  });
}

/**
 * Gets details of a specific device
 * @param {string|number} homeId
 * @param {string} deviceId
 */
export function getDevice(homeId, deviceId) {
  return apiFetch(`/api/v2/homes/${homeId}/devices/${deviceId}`);
}

/**
 * Removes/Deletes a device from home
 * @param {string|number} homeId
 * @param {string} deviceId
 */
export function deleteDevice(homeId, deviceId) {
  return apiFetch(`/api/v2/homes/${homeId}/devices/${deviceId}`, {
    method: 'DELETE'
  });
}

/**
 * Gets calibration temperature offset of a device
 * @param {string|number} homeId
 * @param {string} deviceId
 */
export function getTemperatureOffset(homeId, deviceId) {
  return apiFetch(`/api/v2/homes/${homeId}/devices/${deviceId}/temperatureOffset`);
}

/**
 * Updates calibration temperature offset of a device
 * @param {string|number} homeId
 * @param {string} deviceId
 * @param {number} celsiusOffset
 */
export function updateTemperatureOffset(homeId, deviceId, celsiusOffset) {
  return apiFetch(`/api/v2/homes/${homeId}/devices/${deviceId}/temperatureOffset`, {
    method: 'PUT',
    body: { celsius: celsiusOffset }
  });
}

/**
 * Blinks the display of a device for identification
 * @param {string|number} homeId
 * @param {string} deviceId
 */
export function identifyDevice(homeId, deviceId) {
  return apiFetch(`/api/v2/homes/${homeId}/devices/${deviceId}/identify`, {
    method: 'POST'
  });
}

/**
 * Updates child lock state of a device
 * @param {string|number} homeId
 * @param {string} deviceId
 * @param {boolean} childLockEnabled
 */
export function updateChildLock(homeId, deviceId, childLockEnabled) {
  return apiFetch(`/api/v2/homes/${homeId}/devices/${deviceId}/childLock`, {
    method: 'PUT',
    body: { childLockEnabled }
  });
}

/**
 * Updates device role between Wired Thermostat (71) and Wireless Sensor (200)
 * @param {string|number} homeId
 * @param {string} deviceId
 * @param {number|string} role - 71 or 200
 */
export function updateDeviceRole(homeId, deviceId, role, options = {}) {
  return apiFetch(`/api/v2/homes/${homeId}/devices/${deviceId}/role`, {
    method: 'PUT',
    body: { role, ...options }
  });
}

/**
 * Updates orientation of a valve adapter device (HORIZONTAL/VERTICAL)
 * @param {string|number} homeId
 * @param {string} deviceId
 * @param {string} orientation
 */
export function updateOrientation(homeId, deviceId, orientation) {
  return apiFetch(`/api/v2/homes/${homeId}/devices/${deviceId}/orientation`, {
    method: 'POST',
    body: { orientation }
  });
}

/**
 * Enables pairing mode on a device
 * @param {string|number} homeId
 * @param {string} deviceId
 */
export function startPairing(homeId, deviceId) {
  return apiFetch(`/api/v2/homes/${homeId}/devices/${deviceId}/pairing`, {
    method: 'POST'
  });
}

/**
 * Disables pairing mode on a device
 * @param {string|number} homeId
 * @param {string} deviceId
 */
export function stopPairing(homeId, deviceId) {
  return apiFetch(`/api/v2/homes/${homeId}/devices/${deviceId}/pairing`, {
    method: 'DELETE'
  });
}

/**
 * Updates actuator limits for a valve device
 * @param {string|number} homeId
 * @param {string} deviceId
 * @param {object} limits - { lowSteps, highSteps, driveConstant }
 */
export function updateActuatorLimits(homeId, deviceId, limits) {
  return apiFetch(`/api/v2/homes/${homeId}/devices/${deviceId}/actuatorLimits`, {
    method: 'PUT',
    body: limits
  });
}

/**
 * Updates the friendly name of a device
 * @param {string|number} homeId
 * @param {string} deviceId
 * @param {string|null} friendlyName
 */
export function updateFriendlyName(homeId, deviceId, friendlyName) {
  return apiFetch(`/api/v2/homes/${homeId}/tanoclo/devices/${deviceId}/friendlyName`, {
    method: 'PUT',
    body: { friendlyName }
  });
}

/**
 * Updates display and screen saver settings of a device
 * @param {string|number} homeId
 * @param {string} deviceId
 * @param {object} settings - { displayBrightness, displayContrast, displayActiveTimeout }
 */
export function updateDisplaySettings(homeId, deviceId, settings) {
  return apiFetch(`/api/v2/homes/${homeId}/devices/${deviceId}/displaySettings`, {
    method: 'PUT',
    body: settings
  });
}

/**
 * Unassociates an unknown neighbor device by IPv6 via the IB
 * @param {string|number} homeId
 * @param {string} ibDeviceId
 * @param {string} neighborIpv6
 */
export function unassociateNeighbor(homeId, ibDeviceId, neighborIpv6) {
  return apiFetch(`/api/v2/homes/${homeId}/devices/${ibDeviceId}/unassociate-neighbor`, {
    method: 'POST',
    body: { neighborIpv6 }
  });
}

/**
 * Reboots a specific device
 * @param {string|number} homeId
 * @param {string} deviceId
 */
export function rebootDevice(homeId, deviceId) {
  return apiFetch(`/api/v2/homes/${homeId}/devices/${deviceId}/reboot`, {
    method: 'POST'
  });
}


/**
 * Triggers hardware selftest on device
 * @param {string|number} homeId
 * @param {string} deviceId
 */
export function triggerSelftest(homeId, deviceId) {
  return apiFetch(`/api/v2/homes/${homeId}/devices/${deviceId}/selftest`, {
    method: 'POST'
  });
}

/**
 * Triggers valve mount calibration ('start' or 'cancel')
 * @param {string|number} homeId
 * @param {string} deviceId
 * @param {string} action
 */
export function triggerMountCalibration(homeId, deviceId, action = 'start') {
  return apiFetch(`/api/v2/homes/${homeId}/devices/${deviceId}/mount`, {
    method: 'POST',
    body: { action }
  });
}

/**
 * Refreshes RF encryption key from device
 * @param {string|number} homeId
 * @param {string} deviceId
 */
export function refreshRfKey(homeId, deviceId) {
  return apiFetch(`/api/v2/homes/${homeId}/devices/${deviceId}/rfkey/refresh`, {
    method: 'POST'
  });
}

/**
 * Forces live device config refresh from device
 * @param {string|number} homeId
 * @param {string} deviceId
 */
export function refreshDeviceConfig(homeId, deviceId) {
  return apiFetch(`/api/v2/homes/${homeId}/devices/${deviceId}/config/refresh`, {
    method: 'POST'
  });
}

/**
 * Triggers CoAP debug endpoint (/d/dbg/st, /d/dbg2/tlvs, /d/dbg/m)
 * @param {string|number} homeId
 * @param {string} deviceId
 * @param {string} subpath
 * @param {Object} params
 */
export function triggerDeviceDebug(homeId, deviceId, subpath = 'st', params = {}) {
  return apiFetch(`/api/v2/homes/${homeId}/devices/${deviceId}/debug`, {
    method: 'POST',
    body: { subpath, ...params }
  });
}

/**
 * Starts a server-side background memory dump
 */
export function startMemoryDump(homeId, deviceId, params = {}) {
  return apiFetch(`/api/v2/homes/${homeId}/devices/${deviceId}/debug/dump/start`, {
    method: 'POST',
    body: params
  });
}

/**
 * Gets status of a server-side background memory dump
 */
export function getMemoryDumpStatus(homeId, deviceId) {
  return apiFetch(`/api/v2/homes/${homeId}/devices/${deviceId}/debug/dump/status`);
}

/**
 * Cancels a server-side background memory dump
 */
export function cancelMemoryDump(homeId, deviceId) {
  return apiFetch(`/api/v2/homes/${homeId}/devices/${deviceId}/debug/dump/cancel`, {
    method: 'POST'
  });
}

/**
 * Downloads completed dump file with authentication header
 */
export async function downloadMemoryDumpFile(homeId, deviceId, fileName) {
  const { STORAGE_KEYS } = await import('../utils/constants');
  const token = localStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
  const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
  const res = await fetch(`/api/v2/homes/${homeId}/devices/${deviceId}/debug/dump/download`, { headers });
  if (!res.ok) throw new Error(`Download failed: ${res.statusText}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || `${deviceId}_dump.bin`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}



