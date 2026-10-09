/**
 * @file src/api/balancing.js
 * @brief Handles client-side API requests for hydraulic balancing features.
 */

import { apiFetch } from './client';

/**
 * Runs hydraulic balancing analysis for a home
 * @param {string|number} homeId
 * @param {number} [hours=72]
 */
export function getBalancingAnalysis(homeId, hours = 72) {
  return apiFetch(`/api/v2/homes/${homeId}/balancing/analysis?hours=${hours}`);
}

/**
 * Batch applies suggested valve sensitivities to devices
 * @param {string|number} homeId
 * @param {Array<{ serial: string, sensitivity: number }>} devices
 * @param {number|null} [snapshotId]
 */
export function applyBalancingSuggestions(homeId, devices, snapshotId = null) {
  return apiFetch(`/api/v2/homes/${homeId}/balancing/apply`, {
    method: 'POST',
    body: { devices, snapshotId }
  });
}

/**
 * Retrieves historical analysis snapshots for a home
 * @param {string|number} homeId
 */
export function getBalancingHistory(homeId) {
  return apiFetch(`/api/v2/homes/${homeId}/balancing/history`);
}
