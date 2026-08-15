/**
 * @file lib/state-restore.js
 * @brief Restores database state parameters from snapshots.
 */

'use strict';

const db = require('./db');
const { getLogger } = require('./logger');
const log = getLogger('state-restore');
const commandApi = require('./command-api');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Restores a home to the state saved in a state snapshot.
 * @param {number} homeId 
 * @param {number} snapshotId 
 * @returns {Promise<Object>} Summary of restored items and errors
 */
async function restoreSnapshot(homeId, snapshotId) {
    log('info', `Starting restore of snapshot ${snapshotId} for home ${homeId}`);
    const snapshot = await db.getSnapshotById(snapshotId);
    if (!snapshot) {
        throw new Error(`Snapshot ${snapshotId} not found`);
    }

    if (parseInt(snapshot.home_id) !== parseInt(homeId)) {
        throw new Error(`Snapshot ${snapshotId} does not belong to home ${homeId}`);
    }

    const data = JSON.parse(snapshot.snapshot_json || '{}');
    const errors = [];
    let restoredCount = 0;

    // Helper to log and track step execution
    const runStep = async (name, fn) => {
        try {
            log('info', `Executing restore step: ${name}`);
            await fn();
            restoredCount++;
            await sleep(2000); // 2-second delay to protect RF mesh
        } catch (e) {
            log('error', `Error during step "${name}": ${e.message}`);
            errors.push({ step: name, error: e.message });
        }
    };

    // 1. Device Configs
    if (data.devices) {
        for (const [serial, devData] of Object.entries(data.devices)) {
            if (devData.config && devData.config.fields) {
                await runStep(`Device Config for ${serial}`, async () => {
                    await db.updateDeviceConfig(serial, devData.config.fields, devData.config.fields);
                    await commandApi.pushDeviceConfig(serial, devData.config.fields);
                });
            }
        }
    }

    // 2. Device Locks
    if (data.devices) {
        for (const [serial, devData] of Object.entries(data.devices)) {
            if (devData.lock && devData.lock.fields && devData.lock.fields['0x0290'] !== undefined) {
                await runStep(`Device Lock for ${serial}`, async () => {
                    const enabled = devData.lock.fields['0x0290'] === 1 || devData.lock.fields['0x0290'] === true;
                    await db.updateDeviceLock(serial, enabled);
                    await commandApi.pushDeviceLock(serial, enabled);
                });
            }
        }
    }

    // 3. Zone Configs
    if (data.zones) {
        for (const [zoneId, zoneData] of Object.entries(data.zones)) {
            if (zoneData.config && zoneData.config.fields) {
                await runStep(`Zone Config for zone ${zoneId}`, async () => {
                    await db.updateZoneConfig(homeId, parseInt(zoneId), {}, zoneData.config.fields);
                });
            }
        }
    }

    // 4. Zone States (Overlays)
    if (data.zones) {
        for (const [zoneId, zoneData] of Object.entries(data.zones)) {
            if (zoneData.state && zoneData.state.fields) {
                await runStep(`Zone State/Overlay for zone ${zoneId}`, async () => {
                    const fields = zoneData.state.fields;
                    const overlayMode = fields['0x6240'];

                    if (overlayMode === 0 || overlayMode === undefined || overlayMode === null) {
                        await commandApi.pushZoneOverlayDelete(homeId, parseInt(zoneId));
                    } else {
                        let setting = { power: 'ON' };
                        if (fields['0x6280'] !== undefined && fields['0x6280'] !== null) {
                            setting.temperature = { celsius: parseFloat(fields['0x6280']) };
                        } else if (fields['0x6160'] === 0) {
                            setting = { power: 'OFF' };
                        }

                        let termination = { type: 'MANUAL', typeSkillBasedApp: 'MANUAL' };
                        if (overlayMode === 3) {
                            termination = { type: 'NEXT_TIME_BLOCK', typeSkillBasedApp: 'NEXT_TIME_BLOCK' };
                        }
                        await commandApi.pushZoneOverlay(homeId, parseInt(zoneId), setting, termination);
                    }
                });
            }
        }
    }

    // 5. Circuit Configs
    if (data.circuits) {
        for (const [circuitId, circuitData] of Object.entries(data.circuits)) {
            if (circuitData.config && circuitData.config.fields) {
                await runStep(`Circuit Config for circuit ${circuitId}`, async () => {
                    await db.updateCircuitConfig(homeId, parseInt(circuitId), {}, circuitData.config.fields);
                });
            }
        }
    }

    // 6. HVAC
    if (data.hvac) {
        const mergedHvacFields = {};
        for (const [type, hvacData] of Object.entries(data.hvac)) {
            if (hvacData && hvacData.fields) {
                Object.assign(mergedHvacFields, hvacData.fields);
            }
        }

        if (Object.keys(mergedHvacFields).length > 0) {
            await runStep(`HVAC system configurations`, async () => {
                await db.upsertHeatingSystem(homeId, {}, mergedHvacFields);
            });
        }
    }

    log('info', `Restore completed. Executed: ${restoredCount} steps. Errors: ${errors.length}`);
    return { restored: restoredCount, errors };
}

module.exports = {
    restoreSnapshot
};
