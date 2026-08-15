/**
 * @file src/api/weather.js
 * @brief Handles Tado client-side API requests for Weather and Climate Quality metrics.
 */

import { apiFetch } from './client';

/**
 * Gets climate quality diagnostic report for all zones
 * @param {string|number} homeId
 */
export function getClimateQuality(homeId) {
  return apiFetch(`/api/v2/homes/${homeId}/climateQuality`);
}

/**
 * Gets weather data for the home
 * @param {string|number} homeId
 */
export function getWeather(homeId) {
  return apiFetch(`/api/v2/homes/${homeId}/weather`);
}
