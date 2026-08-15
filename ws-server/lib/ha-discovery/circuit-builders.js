/**
 * @file lib/ha-discovery/circuit-builders.js
 * @brief Home Assistant discovery entity builders for heating circuits.
 */

'use strict';

function buildCircuitDiscovery(publishEntity, circuits, homesMap) {
    for (const c of circuits) {
        const home = homesMap ? (homesMap.get(c.home_id) || { name: `Home ${c.home_id}` }) : { name: `Home ${c.home_id}` };
        const circuitDev = {
            identifiers: [`tanoclo_circuit_${c.home_id}_${c.number}`],
            name: `Circuit ${c.number} (${home.name})`,
            manufacturer: 'TaNoClo (Tado)',
            model: 'Heating Circuit',
            via_device: `tanoclo_home_${c.home_id}`
        };

        const circAvailTopic = `tado/tanoclo/h/${c.home_id}/c/${c.number}/availability`;

        publishEntity('sensor', `tanoclo_circuit_${c.home_id}_${c.number}_target`, {
            unique_id: `tanoclo_circuit_${c.home_id}_${c.number}_target`,
            name: 'Target Temperature',
            state_topic: `tado/tanoclo/h/${c.home_id}/c/${c.number}/target_temperature`,
            device_class: 'temperature',
            unit_of_measurement: '°C',
            availability_topic: circAvailTopic,
            device: circuitDev
        });

        publishEntity('sensor', `tanoclo_circuit_${c.home_id}_${c.number}_reference`, {
            unique_id: `tanoclo_circuit_${c.home_id}_${c.number}_reference`,
            name: 'Reference Temperature',
            state_topic: `tado/tanoclo/h/${c.home_id}/c/${c.number}/reference_temperature`,
            device_class: 'temperature',
            unit_of_measurement: '°C',
            availability_topic: circAvailTopic,
            device: circuitDev
        });

        publishEntity('sensor', `tanoclo_circuit_${c.home_id}_${c.number}_demand`, {
            unique_id: `tanoclo_circuit_${c.home_id}_${c.number}_demand`,
            name: 'Demand',
            state_topic: `tado/tanoclo/h/${c.home_id}/c/${c.number}/demand_percent`,
            unit_of_measurement: '%',
            icon: 'mdi:fire',
            availability_topic: circAvailTopic,
            device: circuitDev
        });
    }
}

module.exports = { buildCircuitDiscovery };
