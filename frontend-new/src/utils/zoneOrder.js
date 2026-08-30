/**
 * @file src/utils/zoneOrder.js
 * @brief Utilities for managing user-specific local zone display ordering.
 * 
 * Persists zone ordering in localStorage per user ID and per home ID,
 * allowing different users to customize room ordering independently.
 */

import { STORAGE_KEYS } from './constants';

/**
 * @brief Constructs the localStorage key for user/home zone order.
 * @param {string|number} userId - ID of current user.
 * @param {string|number} homeId - ID of active home.
 * @returns {string} localStorage key.
 */
export function getUserZoneOrderKey(userId, homeId) {
  const u = userId != null ? String(userId) : 'anon';
  const h = homeId != null ? String(homeId) : 'default';
  return `${STORAGE_KEYS.ZONE_ORDER_PREFIX || 'tanoclo_zone_order_'}${u}_${h}`;
}

/**
 * @brief Retrieves saved zone IDs order array from localStorage.
 * @param {string|number} userId - ID of current user.
 * @param {string|number} homeId - ID of active home.
 * @returns {Array<string|number>} Ordered array of zone IDs, or empty array.
 */
export function getUserZoneOrder(userId, homeId) {
  if (userId == null || homeId == null) return [];
  try {
    const raw = localStorage.getItem(getUserZoneOrderKey(userId, homeId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_e) {
    return [];
  }
}

/**
 * @brief Saves custom zone IDs order array to localStorage for this user and home.
 * @param {string|number} userId - ID of current user.
 * @param {string|number} homeId - ID of active home.
 * @param {Array<string|number>} zoneIds - Ordered array of zone IDs.
 */
export function setUserZoneOrder(userId, homeId, zoneIds) {
  if (userId == null || homeId == null || !Array.isArray(zoneIds)) return;
  try {
    localStorage.setItem(getUserZoneOrderKey(userId, homeId), JSON.stringify(zoneIds));
  } catch (_e) {
    // Ignore storage quota errors
  }
}

/**
 * @brief Sorts a list of zone objects according to the user's custom saved order.
 * Any zones not in the saved order are appended at the end in their original order.
 * @param {Array<object>} zones - List of zone objects.
 * @param {string|number} userId - ID of current user.
 * @param {string|number} homeId - ID of active home.
 * @returns {Array<object>} Sorted zone objects array.
 */
export function sortZonesByUserOrder(zones, userId, homeId) {
  if (!Array.isArray(zones) || zones.length <= 1) return zones || [];
  const order = getUserZoneOrder(userId, homeId);
  if (!order || order.length === 0) return [...zones];

  const zoneMap = new Map(zones.map(z => [String(z.id), z]));
  const sorted = [];

  for (const id of order) {
    const strId = String(id);
    if (zoneMap.has(strId)) {
      sorted.push(zoneMap.get(strId));
      zoneMap.delete(strId);
    }
  }

  for (const remainingZone of zoneMap.values()) {
    sorted.push(remainingZone);
  }

  return sorted;
}
