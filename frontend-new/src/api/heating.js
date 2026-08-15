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

