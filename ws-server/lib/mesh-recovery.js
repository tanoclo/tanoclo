/**
 * TaNoClo 6LoWPAN / CoAP Mesh Recovery & Keep-Alive Manager
 *
 * Provides automatic recovery for Tado RF mesh devices:
 * 1. Auto-Recovery on ZONE_FALLBACK (e.g. 0x6460: 3 - zone communication timeout):
 *    Proactively probes zone devices with CON GET /d/info to force ICMPv6 NS/NA
 *    re-resolution and prevent NUD table entry eviction.
 * 2. Proactive Route Keep-Alive:
 *    Periodically transmits lightweight CON GET /d/info probes to inactive nodes
 *    to keep NUD table entries in NBR_REACHABLE state (< 30s timeout).
 * 3. Fallback Escalation (Auto-Reboot):
 *    If probes fail to restore normal zone communication or clear error flags (0x80),
 *    escalates to software reboot via POST d/reboot.
 */

const coap = require('./coap');

let _db = null;
let _commandApi = null;
let _deviceCommands = null;
let _log = console.log;

// Map: zoneKey -> { homeId, zoneId, fallbackValue, firstDetectedTs, lastProbeTs, probeAttempts, rebootAttempts, lastRebootTs }
const activeFallbacks = new Map();

// Map: deviceSerial -> { homeId, lastProbeTs, probeAttempts, lastRebootTs }
const deviceLinkLossMap = new Map();

// Keep-alive tracking
let lastKeepAliveTs = 0;
const KEEP_ALIVE_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const DEVICE_INACTIVE_THRESHOLD_MS = 12 * 60 * 1000; // 12 minutes without contact
const PROBE_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutes between recovery probes
const MAX_PROBES_BEFORE_REBOOT = 2; // After 2 failed probes across >= 6 mins, escalate to reboot
const REBOOT_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes cooldown between reboot attempts

function init(db, commandApi, deviceCommands, logger) {
    _db = db;
    _commandApi = commandApi;
    _deviceCommands = deviceCommands || commandApi;
    if (logger) _log = logger;
    _log('info', '[mesh-recovery] Mesh Recovery & Keep-Alive Manager initialized');
}

/**
 * Sends a CON GET /d/info probe to prime/refresh neighbor table.
 */
async function probeDevice(deviceId) {
    if (!_commandApi) return null;
    try {
        const extraOptions = [
            { num: 17, value: Buffer.from([0x2a]) } // Option 17 (Accept): 42 (application/octet-stream)
        ];
        const mid = await _commandApi.internalPushViabridge(
            deviceId,
            coap.CODE_GET,
            'd/info',
            Buffer.alloc(0),
            null,
            extraOptions,
            true,
            coap.TYPE_CON,
            null,
            'mesh:probe_info'
        );
        _log('info', `[mesh-recovery] Probed ${deviceId} with CON GET /d/info (MID=0x${mid.toString(16).toUpperCase()})`);
        return mid;
    } catch (e) {
        _log('debug', `[mesh-recovery] Failed to probe ${deviceId}: ${e.message}`);
        return null;
    }
}

/**
 * Triggers soft reboot of a device via POST d/reboot.
 */
async function rebootDevice(deviceId) {
    if (!_deviceCommands) return null;
    try {
        const mid = await _deviceCommands.pushDeviceReboot(deviceId);
        _log('warn', `[mesh-recovery] ⚠️ ESCALATION: Dispatched soft reboot POST d/reboot to ${deviceId} (MID=0x${mid.toString(16).toUpperCase()})`);
        return mid;
    } catch (e) {
        _log('error', `[mesh-recovery] Failed to reboot ${deviceId}: ${e.message}`);
        return null;
    }
}

/**
 * Called when RU reports ZONE_FALLBACK (FID 0x6460).
 */
async function onZoneFallback(homeId, zoneId, val) {
    const key = `${homeId}:${zoneId}`;
    const numVal = parseInt(val, 10);

    if (numVal === 0) {
        if (activeFallbacks.has(key)) {
            _log('info', `[mesh-recovery] ✓ Zone ${zoneId} (Home ${homeId}) fallback CLEARED (value 0)`);
            activeFallbacks.delete(key);
        }
        return;
    }

    // Zone is in fallback (e.g. 3 = zone communication timeout)
    const now = Date.now();
    let rec = activeFallbacks.get(key);

    if (!rec) {
        rec = {
            homeId,
            zoneId,
            fallbackValue: numVal,
            firstDetectedTs: now,
            lastProbeTs: 0,
            probeAttempts: 0,
            rebootAttempts: 0,
            lastRebootTs: 0
        };
        activeFallbacks.set(key, rec);
        _log('warn', `[mesh-recovery] ⚠️ Zone ${zoneId} entered fallback ${numVal}. Starting auto-recovery.`);
    } else {
        rec.fallbackValue = numVal;
    }

    // Check if cooldown has elapsed for probe
    if (now - rec.lastProbeTs >= PROBE_COOLDOWN_MS) {
        rec.lastProbeTs = now;
        rec.probeAttempts++;
        await executeZoneRecoveryProbes(homeId, zoneId);
    }
}

/**
 * Finds devices in a zone + circuit driver and transmits recovery probes.
 */
async function executeZoneRecoveryProbes(homeId, zoneId) {
    if (!_db) return;
    try {
        const pool = _db.getPool();
        const [devices] = await pool.execute(
            'SELECT serial_no, device_type FROM devices WHERE zone_id = ? AND home_id = ?',
            [zoneId, homeId]
        );

        // Find circuit driver for this zone
        const [zones] = await pool.execute(
            'SELECT heating_circuit FROM zones WHERE id = ? AND home_id = ?',
            [zoneId, homeId]
        );
        let driverSerial = null;
        if (zones.length > 0 && zones[0].heating_circuit) {
            const [circuits] = await pool.execute(
                'SELECT driver_serial_no FROM heating_circuits WHERE home_id = ? AND number = ?',
                [homeId, zones[0].heating_circuit]
            );
            if (circuits.length > 0) driverSerial = circuits[0].driver_serial_no;
        }

        const targets = new Set();
        for (const d of devices) {
            if (d.serial_no) targets.add(d.serial_no);
        }
        if (driverSerial) targets.add(driverSerial);

        _log('info', `[mesh-recovery] Triggering NUD recovery probes for Zone ${zoneId} targets: ${Array.from(targets).join(', ')}`);
        for (const serial of targets) {
            await probeDevice(serial);
        }
    } catch (e) {
        _log('error', `[mesh-recovery] Error during executeZoneRecoveryProbes for Zone ${zoneId}: ${e.message}`);
    }
}

/**
 * Called when a device reports device_error (e.g. error_flags & 0x80 Link Loss).
 */
async function onDeviceError(homeId, deviceId, flags) {
    const numFlags = parseInt(flags, 10);
    const hasLinkLoss = (numFlags & 0x80) !== 0;

    if (!hasLinkLoss || numFlags === 0) {
        if (deviceLinkLossMap.has(deviceId)) {
            _log('info', `[mesh-recovery] ✓ Device ${deviceId} link loss CLEARED (error flags 0x${numFlags.toString(16)})`);
            deviceLinkLossMap.delete(deviceId);
        }
        return;
    }

    const now = Date.now();
    let rec = deviceLinkLossMap.get(deviceId);
    if (!rec) {
        rec = { homeId, deviceId, firstDetectedTs: now, lastProbeTs: 0, probeAttempts: 0, lastRebootTs: 0 };
        deviceLinkLossMap.set(deviceId, rec);
        _log('warn', `[mesh-recovery] ⚠️ Device ${deviceId} reported Link Loss (0x80). Starting link recovery.`);
    }

    if (now - rec.lastProbeTs >= PROBE_COOLDOWN_MS) {
        rec.lastProbeTs = now;
        rec.probeAttempts++;
        await probeDevice(deviceId);
    }
}

/**
 * Periodic escalation check: Called by cron every minute.
 * If probes failed to restore communication after MAX_PROBES_BEFORE_REBOOT, escalates to soft reboot.
 */
async function checkFallbackEscalation() {
    const now = Date.now();

    // 1. Check active zone fallbacks
    for (const [key, rec] of activeFallbacks.entries()) {
        if (rec.probeAttempts >= MAX_PROBES_BEFORE_REBOOT) {
            if (now - rec.lastRebootTs >= REBOOT_COOLDOWN_MS) {
                rec.lastRebootTs = now;
                rec.rebootAttempts++;
                _log('warn', `[mesh-recovery] ⚠️ Zone ${rec.zoneId} still in fallback ${rec.fallbackValue} after ${rec.probeAttempts} probes. Escalating to device reboot.`);

                try {
                    const pool = _db.getPool();
                    const [devices] = await pool.execute(
                        'SELECT serial_no FROM devices WHERE zone_id = ? AND home_id = ?',
                        [rec.zoneId, rec.homeId]
                    );
                    for (const d of devices) {
                        await rebootDevice(d.serial_no);
                    }

                    // If multiple reboot attempts failed, also reboot circuit driver
                    if (rec.rebootAttempts > 1) {
                        const [zones] = await pool.execute(
                            'SELECT heating_circuit FROM zones WHERE id = ? AND home_id = ?',
                            [rec.zoneId, rec.homeId]
                        );
                        if (zones.length > 0 && zones[0].heating_circuit) {
                            const [circuits] = await pool.execute(
                                'SELECT driver_serial_no FROM heating_circuits WHERE home_id = ? AND number = ?',
                                [rec.homeId, zones[0].heating_circuit]
                            );
                            if (circuits.length > 0 && circuits[0].driver_serial_no) {
                                await rebootDevice(circuits[0].driver_serial_no);
                            }
                        }
                    }
                } catch (e) {
                    _log('error', `[mesh-recovery] Escalation reboot failed for Zone ${rec.zoneId}: ${e.message}`);
                }
            }
        } else if (now - rec.lastProbeTs >= PROBE_COOLDOWN_MS) {
            rec.lastProbeTs = now;
            rec.probeAttempts++;
            await executeZoneRecoveryProbes(rec.homeId, rec.zoneId);
        }
    }

    // 2. Check active device link losses
    for (const [deviceId, rec] of deviceLinkLossMap.entries()) {
        if (rec.probeAttempts >= MAX_PROBES_BEFORE_REBOOT) {
            if (now - rec.lastRebootTs >= REBOOT_COOLDOWN_MS) {
                rec.lastRebootTs = now;
                _log('warn', `[mesh-recovery] ⚠️ Device ${deviceId} still reporting link loss after ${rec.probeAttempts} probes. Escalating to soft reboot.`);
                await rebootDevice(deviceId);
            }
        } else if (now - rec.lastProbeTs >= PROBE_COOLDOWN_MS) {
            rec.lastProbeTs = now;
            rec.probeAttempts++;
            await probeDevice(deviceId);
        }
    }
}

/**
 * Proactive route keep-alive: Called periodically (e.g. every 15m) by cron.
 * Sends lightweight CON GET /d/info to devices without recent contact to keep NUD cache alive.
 */
async function runProactiveKeepAlive() {
    const now = Date.now();
    if (now - lastKeepAliveTs < KEEP_ALIVE_INTERVAL_MS) return;
    lastKeepAliveTs = now;

    if (!_db) return;
    try {
        const pool = _db.getPool();
        // Target online physical devices in homes with active heating circuits
        const [devices] = await pool.execute(`
            SELECT d.serial_no, d.device_type, d.last_contact, d.ipv6_address
            FROM devices d
            LEFT JOIN emulated_devices ed ON d.serial_no = ed.serial_no
            WHERE ed.serial_no IS NULL
              AND d.connection_state = 'ONLINE'
              AND d.ipv6_address IS NOT NULL
              AND (d.device_type LIKE 'VA%' OR d.device_type LIKE 'RU%' OR d.device_type LIKE 'WR%')
        `);

        for (const dev of devices) {
            const lastContact = dev.last_contact ? new Date(dev.last_contact).getTime() : 0;
            if (now - lastContact >= DEVICE_INACTIVE_THRESHOLD_MS) {
                _log('debug', `[mesh-recovery] Keep-alive probe for inactive device ${dev.serial_no} (last contact ${Math.round((now - lastContact) / 60000)}m ago)`);
                await probeDevice(dev.serial_no);
                // Stagger keep-alive probes to prevent RF bursts
                await new Promise(r => setTimeout(r, 500));
            }
        }
    } catch (e) {
        _log('debug', `[mesh-recovery] runProactiveKeepAlive error: ${e.message}`);
    }
}

module.exports = {
    init,
    probeDevice,
    rebootDevice,
    onZoneFallback,
    onDeviceError,
    checkFallbackEscalation,
    runProactiveKeepAlive,
    _activeFallbacks: activeFallbacks,
    _deviceLinkLossMap: deviceLinkLossMap
};
