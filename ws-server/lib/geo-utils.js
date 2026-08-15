/**
 * @file lib/geo-utils.js
 * @brief Geofencing distances and boundary intersection algorithms.
 */

'use strict';

/**
 * lib/geo-utils.js
 * 
 * Shared geolocation utilities for TaNoClo.
 */

/**
 * Calculate the Haversine distance between two points in meters.
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * Calculate the initial bearing between two points in radians.
 */
function calculateBearing(lat1, lon1, lat2, lon2) {
    const lat1Rad = lat1 * Math.PI / 180;
    const lat2Rad = lat2 * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;

    const y = Math.sin(dLon) * Math.cos(lat2Rad);
    const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) -
        Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);
    
    return Math.atan2(y, x);
}

/**
 * Map a bearing in radians to degrees (0-360).
 */
function radiansToDegrees(rad) {
    return (rad * 180 / Math.PI + 360) % 360;
}

module.exports = {
    haversineDistance,
    calculateBearing,
    radiansToDegrees
};
