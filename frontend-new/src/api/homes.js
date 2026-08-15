/**
 * @file src/api/homes.js
 * @brief Handles Tado client-side API requests for Home metadata management.
 * 
 * Provides methods for retrieving home info, setting geolocation pins, locking physical
 * presence states, reordering zone listing cards, and adding/removing home administrator access.
 */

import { apiFetch } from './client';

/**
 * Gets home basic info
 * @param {string|number} homeId
 */
export function getHomeInfo(homeId) {
  return apiFetch(`/api/v2/homes/${homeId}`);
}

/**
 * Gets home details (address, contact)
 * @param {string|number} homeId
 */
export function getHomeDetails(homeId) {
  return apiFetch(`/api/v2/homes/${homeId}/details`);
}

/**
 * Updates home details
 * @param {string|number} homeId
 * @param {object} details
 */
export function updateHomeDetails(homeId, details) {
  return apiFetch(`/api/v2/homes/${homeId}/details`, {
    method: 'PUT',
    body: details
  });
}

/**
 * Gets home presence state
 * @param {string|number} homeId
 */
export function getHomeState(homeId) {
  return apiFetch(`/api/v2/homes/${homeId}/state`);
}

/**
 * Locks home presence (HOME or AWAY)
 * @param {string|number} homeId
 * @param {string} state - 'HOME' or 'AWAY'
 */
export function setHomePresenceLock(homeId, state) {
  return apiFetch(`/api/v2/homes/${homeId}/presenceLock`, {
    method: 'PUT',
    body: { homePresence: state }
  });
}

/**
 * Releases home presence lock (reverts to AUTO/geofencing)
 * @param {string|number} homeId
 */
export function releaseHomePresenceLock(homeId) {
  return apiFetch(`/api/v2/homes/${homeId}/presenceLock`, {
    method: 'DELETE'
  });
}

/**
 * Gets home weather state
 * @param {string|number} homeId
 */
export function getHomeWeather(homeId) {
  return apiFetch(`/api/v2/homes/${homeId}/weather`);
}

/**
 * Gets users belonging to a home
 * @param {string|number} homeId
 */
export function getHomeUsers(homeId) {
  return apiFetch(`/api/v2/homes/${homeId}/users`);
}

/**
 * Updates zone display order
 * @param {string|number} homeId
 * @param {Array<string|number>} zoneIds
 */
export function updateZoneOrder(homeId, zoneIds) {
  return apiFetch(`/api/v2/homes/${homeId}/zoneOrder`, {
    method: 'PUT',
    body: zoneIds
  });
}

/**
 * Updates geofencing away radius
 * @param {string|number} homeId
 * @param {number} radius
 */
export function updateAwayRadius(homeId, radius) {
  return apiFetch(`/api/v2/homes/${homeId}/awayRadiusInMeters`, {
    method: 'PUT',
    body: { awayRadiusInMeters: radius }
  });
}

/**
 * Updates home geolocation coordinates
 * @param {string|number} homeId
 * @param {number} latitude
 * @param {number} longitude
 */
export function updateHomeGeolocation(homeId, latitude, longitude) {
  return apiFetch(`/api/v2/homes/${homeId}/geolocation`, {
    method: 'PUT',
    body: { latitude, longitude }
  });
}

/**
 * Updates the home admin user ID
 * @param {string|number} homeId
 * @param {string|null} adminUserId
 */
export function updateHomeAdmin(homeId, adminUserId) {
  return apiFetch(`/api/v2/homes/${homeId}/admin/${adminUserId}`, {
    method: 'PUT',
    body: {}
  });
}

/**
 * Toggles a user's admin status (makes them a TaNoClo Admin or revokes it)
 * @param {string|number} homeId
 * @param {string} userId
 * @param {boolean} isAdmin
 */
export function toggleUserAdminStatus(homeId, userId, isAdmin) {
  return apiFetch(`/api/v2/homes/${homeId}/tanoclo/users/${userId}/admin`, {
    method: 'PUT',
    body: { isAdmin }
  });
}

/**
 * Invites a user to the home by email
 * @param {string|number} homeId
 * @param {string} email
 */
export function inviteUserToHome(homeId, email) {
  return apiFetch(`/api/v2/homes/${homeId}/invitations`, {
    method: 'POST',
    body: { email }
  });
}

/**
 * Removes a user from a home
 * @param {string|number} homeId
 * @param {string} username
 */
export function deleteUserFromHome(homeId, username) {
  return apiFetch(`/api/v2/homes/${homeId}/users/${encodeURIComponent(username)}`, {
    method: 'DELETE'
  });
}


