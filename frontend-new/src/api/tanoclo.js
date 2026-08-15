/**
 * @file src/api/tanoclo.js
 * @brief Handles custom TaNoClo extension API requests.
 * 
 * Includes calls to query raw database states, fetch OpenTherm boiler parameters, pull device battery profiles,
 * get physical bridge connection status, and set home timezone mappings.
 */

import { apiFetch } from './client';

/**
 * Gets raw boiler/OpenTherm status data
 * @param {string|number} homeId
 */
export function getRawBoilerData(homeId) {
  return apiFetch(`/api/v2/homes/${homeId}/tanoclo/boiler/raw`);
}

/**
 * Gets battery information for all devices
 * @param {string|number} homeId
 */
export function getDeviceBatteryData(homeId) {
  return apiFetch(`/api/v2/homes/${homeId}/tanoclo/devices/battery`);
}

/**
 * Gets raw device configuration and history measurements
 * @param {string|number} homeId
 * @param {string} deviceId
 */
export function getRawDeviceData(homeId, deviceId) {
  return apiFetch(`/api/v2/homes/${homeId}/tanoclo/devices/${deviceId}/raw`);
}

/**
 * Gets raw zone configuration and history measurements
 * @param {string|number} homeId
 * @param {string|number} zoneId
 */
export function getRawZoneData(homeId, zoneId) {
  return apiFetch(`/api/v2/homes/${homeId}/tanoclo/zones/${zoneId}/raw`);
}

/**
 * Gets all heating circuits data
 * @param {string|number} homeId
 */
export function getCircuits(homeId) {
  return apiFetch(`/api/v2/homes/${homeId}/tanoclo/circuits`);
}

/**
 * Gets Internet Bridge status
 * @param {string|number} homeId
 */
export function getBridge(homeId) {
  return apiFetch(`/api/v2/homes/${homeId}/tanoclo/bridge`);
}


/**
 * Updates device battery type chemistry
 * @param {string|number} homeId
 * @param {string} serial
 * @param {string} batteryType
 */
export function updateDeviceBatteryType(homeId, serial, batteryType) {
  return apiFetch(`/api/v2/homes/${homeId}/tanoclo/devices/${serial}/battery`, {
    method: 'PUT',
    body: { batteryType }
  });
}

/**
 * Gets home timezone
 * @param {string|number} homeId
 */
export function getHomeTimezone(homeId) {
  return apiFetch(`/api/v2/homes/${homeId}/tanoclo/timezone`);
}

/**
 * Updates home timezone
 * @param {string|number} homeId
 * @param {string} dateTimeZone
 */
export function updateHomeTimezone(homeId, dateTimeZone) {
  return apiFetch(`/api/v2/homes/${homeId}/tanoclo/timezone`, {
    method: 'PUT',
    body: { dateTimeZone }
  });
}

