/**
 * @file src/api/users.js
 * @brief Handles Tado client-side API requests for User profile and mobile geofencing device registration.
 * 
 * Provides methods for querying list of tracked geofencing devices, renaming account profile names,
 * and updating login credentials (emails and passwords).
 */

import { apiFetch } from './client';

/**
 * Gets mobile devices registered to a home
 * @param {string|number} homeId
 */
export function getMobileDevices(homeId) {
  return apiFetch(`/api/v2/homes/${homeId}/mobileDevices`);
}

/**
 * Gets details of a specific mobile device
 * @param {string|number} homeId
 * @param {string|number} deviceId
 */
export function getMobileDevice(homeId, deviceId) {
  return apiFetch(`/api/v2/homes/${homeId}/mobileDevices/${deviceId}`);
}

/**
 * Removes a mobile device from the home
 * @param {string|number} homeId
 * @param {string|number} deviceId
 */
export function deleteMobileDevice(homeId, deviceId) {
  return apiFetch(`/api/v2/homes/${homeId}/mobileDevices/${deviceId}`, {
    method: 'DELETE'
  });
}

/**
 * Updates user profile name or locale
 * @param {string|number} userId
 * @param {object} data - { name, locale }
 */
export function updateUserProfile(userId, data) {
  return apiFetch(`/api/v2/users/${userId}`, {
    method: 'PUT',
    body: data
  });
}

/**
 * Updates user account email
 * @param {string|number} userId
 * @param {string} email
 * @param {string} currentPassword
 */
export function updateUserEmail(userId, email, currentPassword) {
  return apiFetch(`/api/v2/users/${userId}/email`, {
    method: 'PUT',
    body: { email, currentPassword }
  });
}

/**
 * Updates user account password
 * @param {string|number} userId
 * @param {string} password
 * @param {string} currentPassword
 */
export function updateUserPassword(userId, password, currentPassword) {
  return apiFetch(`/api/v2/users/${userId}/password`, {
    method: 'PUT',
    body: { password, currentPassword }
  });
}

