/**
 * @file src/utils/presence.js
 * @brief Geofencing presence calculation utility.
 */

/**
 * Calculates auto presence state based on geofencing devices and user check-ins.
 * 
 * Rules:
 * 1. When any person with a geofencing device is home -> 'HOME' (Green)
 * 2. When no geofencing devices linked or recently connected (all unknown/no device linked) -> 'HOME' (Green)
 * 3. When all people with a known/recently updated geofencing device are away -> 'AWAY' (Red)
 * 
 * @param {Array} users - List of home users.
 * @param {Array} devices - List of paired mobile devices.
 * @returns {'HOME'|'AWAY'} Presence state for Auto mode.
 */
export function getAutoPresenceState(users = [], devices = []) {
  if (!users || users.length === 0) {
    return 'HOME';
  }

  let hasHomeUser = false;
  let hasKnownAwayUser = false;

  for (const user of users) {
    const userDevices = (devices || []).filter(d => d.user_id === user.id || d.userId === user.id);
    if (!userDevices || userDevices.length === 0) {
      continue; // No device linked -> status UNKNOWN
    }

    const activeTrackingDevices = userDevices.filter(d => d.settings?.geoTrackingEnabled);
    if (activeTrackingDevices.length === 0) {
      continue; // Tracking disabled -> status UNKNOWN
    }

    const recentDevices = activeTrackingDevices.filter(d => {
      if (!d.location?.lastSeen) return false;
      const lastSeenTime = new Date(d.location.lastSeen).getTime();
      return !isNaN(lastSeenTime) && (Date.now() - lastSeenTime) < 24 * 60 * 60 * 1000;
    });

    if (recentDevices.length === 0) {
      continue; // No recent check-in within 24h -> status UNKNOWN
    }

    if (recentDevices.some(d => d.location?.atHome)) {
      hasHomeUser = true;
    } else {
      hasKnownAwayUser = true;
    }
  }

  if (hasHomeUser) {
    return 'HOME';
  }

  if (hasKnownAwayUser) {
    return 'AWAY';
  }

  return 'HOME';
}
