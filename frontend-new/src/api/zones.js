/**
 * @file src/api/zones.js
 * @brief Handles Tado client-side API requests for individual Zone configurations.
 * 
 * Provides methods for modifying zone states, updating manual overlays, dismissing open window alarms,
 * editing timetables schedules, mapping measuring devices, and syncing local offline schedules to physical valve registers.
 */

import { apiFetch } from './client';

/**
 * Gets list of zones in home
 * @param {string|number} homeId
 */
export function getZones(homeId) {
  return apiFetch(`/api/v2/homes/${homeId}/zones`);
}

/**
 * Gets states of all zones in home (real-time temp, humidity, overlays)
 * @param {string|number} homeId
 */
export function getZoneStates(homeId) {
  return apiFetch(`/api/v2/homes/${homeId}/zoneStates`);
}

/**
 * Gets state of a single zone
 * @param {string|number} homeId
 * @param {string|number} zoneId
 */
export function getZoneState(homeId, zoneId) {
  return apiFetch(`/api/v2/homes/${homeId}/zones/${zoneId}/state`);
}

/**
 * Gets temperature control capabilities of a zone
 * @param {string|number} homeId
 * @param {string|number} zoneId
 */
export function getZoneCapabilities(homeId, zoneId) {
  return apiFetch(`/api/v2/homes/${homeId}/zones/${zoneId}/capabilities`);
}

/**
 * Sets temperature overlay for a zone
 * @param {string|number} homeId
 * @param {string|number} zoneId
 * @param {object} overlay - { setting: { type: 'HEATING', temperature: { celsius: 21.0 } }, termination: { type: 'TADO_MODE'|'TIMER'|'MANUAL', durationInSeconds: 1800 } }
 */
export function setZoneOverlay(homeId, zoneId, overlay) {
  return apiFetch(`/api/v2/homes/${homeId}/zones/${zoneId}/overlay`, {
    method: 'PUT',
    body: overlay
  });
}

/**
 * Resumes schedule / deletes overlay for a zone
 * @param {string|number} homeId
 * @param {string|number} zoneId
 */
export function resumeZoneSchedule(homeId, zoneId) {
  return apiFetch(`/api/v2/homes/${homeId}/zones/${zoneId}/overlay`, {
    method: 'DELETE'
  });
}

/**
 * Sets system-wide overlay (e.g. boost or turn off all)
 * @param {string|number} homeId
 * @param {object} overlay
 */
export function setHomeOverlay(homeId, overlay) {
  return apiFetch(`/api/v2/homes/${homeId}/overlay`, {
    method: 'POST',
    body: overlay
  });
}

/**
 * Resumes schedule for all zones in home
 * @param {string|number} homeId
 */
export function resumeHomeSchedule(homeId) {
  return apiFetch(`/api/v2/homes/${homeId}/overlay`, {
    method: 'DELETE'
  });
}

/**
 * Manually activates open window detection
 * @param {string|number} homeId
 * @param {string|number} zoneId
 */
export function activateOpenWindow(homeId, zoneId) {
  return apiFetch(`/api/v2/homes/${homeId}/zones/${zoneId}/state/openWindow/activate`, {
    method: 'POST'
  });
}

/**
 * Dismisses open window detection
 * @param {string|number} homeId
 * @param {string|number} zoneId
 */
export function dismissOpenWindow(homeId, zoneId) {
  return apiFetch(`/api/v2/homes/${homeId}/zones/${zoneId}/state/openWindow`, {
    method: 'DELETE'
  });
}

/**
 * Gets the active timetable type for a zone's schedule
 * @param {string|number} homeId
 * @param {string|number} zoneId
 */
export function getActiveTimetable(homeId, zoneId) {
  return apiFetch(`/api/v2/homes/${homeId}/zones/${zoneId}/schedule/activeTimetable`);
}

/**
 * Sets the active timetable type for a zone's schedule (e.g. 0=ONE_DAY, 1=THREE_DAY, 2=SEVEN_DAY)
 * @param {string|number} homeId
 * @param {string|number} zoneId
 * @param {number} timetableId
 */
export function setActiveTimetable(homeId, zoneId, timetableId) {
  return apiFetch(`/api/v2/homes/${homeId}/zones/${zoneId}/schedule/activeTimetable`, {
    method: 'PUT',
    body: { id: timetableId }
  });
}

/**
 * Gets the list of available timetables
 * @param {string|number} homeId
 * @param {string|number} zoneId
 */
export function getTimetables(homeId, zoneId) {
  return apiFetch(`/api/v2/homes/${homeId}/zones/${zoneId}/schedule/timetables`);
}

/**
 * Gets blocks for a specific timetable
 * @param {string|number} homeId
 * @param {string|number} zoneId
 * @param {number} timetableId
 */
export function getTimetableBlocks(homeId, zoneId, timetableId) {
  return apiFetch(`/api/v2/homes/${homeId}/zones/${zoneId}/schedule/timetables/${timetableId}/blocks`);
}

/**
 * Gets blocks for a specific day type on a timetable
 * @param {string|number} homeId
 * @param {string|number} zoneId
 * @param {number} timetableId
 * @param {string} dayType
 */
export function getDayBlocks(homeId, zoneId, timetableId, dayType) {
  return apiFetch(`/api/v2/homes/${homeId}/zones/${zoneId}/schedule/timetables/${timetableId}/blocks/${dayType}`);
}

/**
 * Updates blocks for a specific day type on a timetable
 * @param {string|number} homeId
 * @param {string|number} zoneId
 * @param {number} timetableId
 * @param {string} dayType
 * @param {Array<object>} blocks
 */
export function updateDayBlocks(homeId, zoneId, timetableId, dayType, blocks) {
  return apiFetch(`/api/v2/homes/${homeId}/zones/${zoneId}/schedule/timetables/${timetableId}/blocks/${dayType}`, {
    method: 'PUT',
    body: blocks
  });
}

/**
 * Copies schedule from one zone to target zones
 * @param {string|number} homeId
 * @param {string|number} zoneId
 * @param {Array<string|number>} targetZoneIds
 */
export function copySchedule(homeId, zoneId, targetZoneIds) {
  return apiFetch(`/api/v2/homes/${homeId}/zones/${zoneId}/schedule/copy`, {
    method: 'POST',
    body: { targetZoneIds }
  });
}

/**
 * Updates details of a zone (name)
 * @param {string|number} homeId
 * @param {string|number} zoneId
 * @param {object} details - { name, type }
 */
export function updateZoneDetails(homeId, zoneId, details) {
  return apiFetch(`/api/v2/homes/${homeId}/zones/${zoneId}/details`, {
    method: 'PUT',
    body: details
  });
}

/**
 * Updates early start setting for a zone
 * @param {string|number} homeId
 * @param {string|number} zoneId
 * @param {boolean} enabled
 */
export function updateEarlyStart(homeId, zoneId, enabled) {
  return apiFetch(`/api/v2/homes/${homeId}/zones/${zoneId}/earlyStart`, {
    method: 'PUT',
    body: { enabled }
  });
}

/**
 * Updates dazzle mode setting for a zone
 * @param {string|number} homeId
 * @param {string|number} zoneId
 * @param {boolean} enabled
 */
export function updateDazzle(homeId, zoneId, enabled) {
  return apiFetch(`/api/v2/homes/${homeId}/zones/${zoneId}/dazzle`, {
    method: 'PUT',
    body: { enabled }
  });
}

/**
 * Updates open window detection settings for a zone
 * @param {string|number} homeId
 * @param {string|number} zoneId
 * @param {boolean} enabled
 * @param {number} timeoutInSeconds
 * @param {number} temperatureDeviationLimit
 * @param {number} owdNvmState
 */
export function updateOpenWindowDetection(homeId, zoneId, enabled, timeoutInSeconds = 900, temperatureDeviationLimit = 0.50, owdNvmState = 1) {
  return apiFetch(`/api/v2/homes/${homeId}/zones/${zoneId}/openWindowDetection`, {
    method: 'PUT',
    body: { enabled, timeoutInSeconds, temperatureDeviationLimit, owdNvmState }
  });
}

/**
 * Updates default overlay setting for a zone (manual control defaults)
 * @param {string|number} homeId
 * @param {string|number} zoneId
 * @param {object} defaultOverlay - { termination: { type: 'TADO_MODE'|'TIMER'|'MANUAL', durationInSeconds: number } }
 */
export function updateDefaultOverlay(homeId, zoneId, defaultOverlay) {
  return apiFetch(`/api/v2/homes/${homeId}/zones/${zoneId}/defaultOverlay`, {
    method: 'PUT',
    body: defaultOverlay
  });
}

/**
 * Gets default overlay setting for a zone
 * @param {string|number} homeId
 * @param {string|number} zoneId
 */
export function getDefaultOverlay(homeId, zoneId) {
  return apiFetch(`/api/v2/homes/${homeId}/zones/${zoneId}/defaultOverlay`);
}

/**
 * Assigns a device to a zone
 * @param {string|number} homeId
 * @param {string|number} zoneId
 * @param {string} serialNo
 */
export function addDeviceToZone(homeId, zoneId, serialNo) {
  return apiFetch(`/api/v2/homes/${homeId}/zones/${zoneId}/devices`, {
    method: 'POST',
    body: { serialNo }
  });
}

/**
 * Removes a device from a zone
 * @param {string|number} homeId
 * @param {string|number} zoneId
 * @param {string} deviceId - serial number of device
 */
export function removeDeviceFromZone(homeId, zoneId, deviceId) {
  return apiFetch(`/api/v2/homes/${homeId}/zones/${zoneId}/devices/${deviceId}`, {
    method: 'DELETE'
  });
}

/**
 * Updates measuring device of a zone
 * @param {string|number} homeId
 * @param {string|number} zoneId
 * @param {string} serialNo
 */
export function updateMeasuringDevice(homeId, zoneId, serialNo) {
  return apiFetch(`/api/v2/homes/${homeId}/zones/${zoneId}/measuringDevice`, {
    method: 'PUT',
    body: { serialNo }
  });
}

/**
 * Updates heating circuit of a zone
 * @param {string|number} homeId
 * @param {string|number} zoneId
 * @param {number|null} circuitNumber
 */
export function updateHeatingCircuit(homeId, zoneId, circuitNumber) {
  return apiFetch(`/api/v2/homes/${homeId}/zones/${zoneId}/control/heatingCircuit`, {
    method: 'PUT',
    body: { circuitNumber }
  });
}

/**
 * Creates a new zone in a home
 * @param {string|number} homeId
 * @param {object} zoneData - { name, type }
 */
export function createZone(homeId, zoneData) {
  return apiFetch(`/api/v2/homes/${homeId}/zones`, {
    method: 'POST',
    body: zoneData
  });
}

/**
 * Gets zone control configuration (heating circuit info)
 * @param {string|number} homeId
 * @param {string|number} zoneId
 */
export function getZoneControl(homeId, zoneId) {
  return apiFetch(`/api/v2/homes/${homeId}/zones/${zoneId}/control`);
}

/**
 * Updates offline schedule setting for a zone
 * @param {string|number} homeId
 * @param {string|number} zoneId
 * @param {boolean} enabled
 */
export function updateOfflineSchedule(homeId, zoneId, enabled) {
  return apiFetch(`/api/v2/homes/${homeId}/zones/${zoneId}/offline-schedule`, {
    method: 'PUT',
    body: { enabled }
  });
}

/**
 * Triggers manual offline schedule sync
 * @param {string|number} homeId
 * @param {string|number} zoneId
 */
export function syncOfflineSchedule(homeId, zoneId) {
  return apiFetch(`/api/v2/homes/${homeId}/zones/${zoneId}/offline-schedule/sync`, {
    method: 'POST'
  });
}

/**
 * Updates TaNoClo server-side OWD settings for a zone
 * @param {string|number} homeId
 * @param {string|number} zoneId
 * @param {boolean} enabled
 * @param {string} source
 */
export function updateTaNoCloOwdSettings(homeId, zoneId, enabled, source) {
  return apiFetch(`/api/v2/homes/${homeId}/zones/${zoneId}/tanoclo/owd`, {
    method: 'PUT',
    body: { enabled, source }
  });
}


