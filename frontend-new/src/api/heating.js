/**
 * @file src/api/heating.js
 * @brief Handles Tado client-side API requests for heating circuits.
 * 
 * Includes methods for configuring supply temperature optimizations, pulling boiler operation runtime statistics,
 * and setting circuit driver devices.
 */

import { apiFetch } from './client';

/**
 * Gets supply temperature optimization settings
 * @param {string|number} homeId
 */
export function getSupplyTemperatureOptimization(homeId) {
  return apiFetch(`/api/v2/homes/${homeId}/heatingCircuits/0/supplyTemperatureOptimization`);
}

/**
 * Updates supply temperature optimization settings
 * @param {string|number} homeId
 * @param {object} settings
 */
export function updateSupplyTemperatureOptimization(homeId, settings) {
  return apiFetch(`/api/v2/homes/${homeId}/heatingCircuits/0/supplyTemperatureOptimization`, {
    method: 'PUT',
    body: settings
  });
}

/**
 * Gets supply temperature optimization history
 * @param {string|number} homeId
 * @param {number} [limit=50]
 */
export function getSupplyTemperatureHistory(homeId, limit = 50) {
  return apiFetch(`/api/v2/homes/${homeId}/supplyTemperatureHistory?limit=${limit}`);
}

/**
 * Gets heating running times (boiler operation hours)
 * @param {string|number} homeId
 * @param {object} params - { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', aggregate: 'day'|'month', summary_only: boolean }
 */
export function getRunningTimes(homeId, params = {}) {
  const query = new URLSearchParams();
  if (params.from) query.append('from', params.from);
  if (params.to) query.append('to', params.to);
  if (params.aggregate) query.append('aggregate', params.aggregate);
  if (params.summary_only !== undefined) query.append('summary_only', String(params.summary_only));

  const queryString = query.toString();
  return apiFetch(`/api/v2/homes/${homeId}/runningTimes${queryString ? `?${queryString}` : ''}`);
}

/**
 * Updates the driver device for a heating circuit
 * @param {string|number} homeId
 * @param {number} circuitNumber
 * @param {string} serialNo
 */
export function updateHeatingCircuitDriver(homeId, circuitNumber, serialNo) {
  return apiFetch(`/api/v2/homes/${homeId}/heatingCircuits/${circuitNumber}/driverDevice`, {
    method: 'PUT',
    body: { serialNo }
  });
}

/**
 * Gets gas energy usage and costs breakdown
 * @param {string|number} homeId
 * @param {object} params - { from, to, days }
 */
export function getGasEnergyUsage(homeId, params = {}) {
  const query = new URLSearchParams();
  if (params.from) query.append('from', params.from);
  if (params.to) query.append('to', params.to);
  if (params.days) query.append('days', String(params.days));

  const qs = query.toString();
  return apiFetch(`/api/v2/homes/${homeId}/energy/gas${qs ? `?${qs}` : ''}`);
}

/**
 * Gets daily gas summary history
 * @param {string|number} homeId
 * @param {number} [days=30]
 */
export function getGasEnergyDaily(homeId, days = 30) {
  return apiFetch(`/api/v2/homes/${homeId}/energy/gas/daily?days=${days}`);
}

/**
 * Gets gas energy settings and topics
 * @param {string|number} homeId
 */
export function getGasEnergySettings(homeId) {
  return apiFetch(`/api/v2/homes/${homeId}/energy/settings`);
}

/**
 * Updates gas energy settings and topics
 * @param {string|number} homeId
 * @param {object} settings
 */
export function updateGasEnergySettings(homeId, settings) {
  return apiFetch(`/api/v2/homes/${homeId}/energy/settings`, {
    method: 'PUT',
    body: settings
  });
}

/**
 * Manually posts a gas meter reading
 * @param {string|number} homeId
 * @param {object} data - { meter_m3, unit_cost, timestamp, source }
 */
export function postGasMeterReading(homeId, data) {
  return apiFetch(`/api/v2/homes/${homeId}/energy/gas/reading`, {
    method: 'POST',
    body: data
  });
}

/**
 * Gets recent historical meter readings
 * @param {string|number} homeId
 * @param {number} [limit=50]
 */
export function getGasMeterReadings(homeId, limit = 50) {
  return apiFetch(`/api/v2/homes/${homeId}/energy/gas/readings?limit=${limit}`);
}

/**
 * Bulk posts historical meter readings
 * @param {string|number} homeId
 * @param {Array} readings - Array of { meter_m3, unit_cost, timestamp }
 */
export function postBulkGasMeterReadings(homeId, readings) {
  return apiFetch(`/api/v2/homes/${homeId}/energy/gas/readings/bulk`, {
    method: 'POST',
    body: { readings }
  });
}

/**
 * Deletes a recorded gas meter reading
 * @param {string|number} homeId
 * @param {number} readingId
 */
export function deleteGasMeterReading(homeId, readingId) {
  return apiFetch(`/api/v2/homes/${homeId}/energy/gas/readings/${readingId}`, {
    method: 'DELETE'
  });
}