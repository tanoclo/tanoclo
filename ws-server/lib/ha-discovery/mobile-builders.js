/**
 * @file lib/ha-discovery/mobile-builders.js
 * @brief Home Assistant discovery entity builders for geofencing mobile apps.
 */

'use strict';

function buildMobileDiscovery(publishEntity, mobileDevices) {
    for (const md of mobileDevices) {
        const mdDev = {
            identifiers: [`tanoclo_mobile_${md.id}`],
            name: md.name || `Mobile Device ${md.id}`,
            manufacturer: md.platform || 'Mobile',
            model: md.model || 'Device',
            sw_version: md.os_version || undefined,
            via_device: `tanoclo_home_${md.home_id}`
        };

        const mdAvailTopic = `tado/tanoclo/h/${md.home_id}/md/${md.id}/availability`;

        publishEntity('device_tracker', `tanoclo_md${md.id}_tracker`, {
            unique_id: `tanoclo_md${md.id}_tracker`,
            name: null, // Default to device name
            state_topic: `tado/tanoclo/h/${md.home_id}/md/${md.id}/state`,
            availability_topic: mdAvailTopic,
            device: mdDev
        });
    }
}

module.exports = { buildMobileDiscovery };
