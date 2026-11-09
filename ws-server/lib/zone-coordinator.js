/**
 * @file lib/zone-coordinator.js
 * @brief Zone coordinator engine for gateway/IB-hosted virtual wireless sensors (Zone Leaders).
 * 
 * Manages virtual leader zone telemetry, observer registrations (CoAP GET /z/p with Observe),
 * proportional valve demand calculation, battery-preserving gated downlinks, and central boiler relay.
 */

'use strict';

const crypto = require('crypto');
const { getLogger } = require('./logger');
const log = getLogger('zone-coordinator');

let _db = null;
let _commandApi = null;
let _coapTransport = null;
let _coap = null;
let _tlv = null;
let _mqttPublisher = null;
let _wsBridge = null;

// Registry: zoneKey ('homeId:zoneId') -> Map<deviceSerial, { ipv6, udpPort, token, ws, registeredAt, lastSeq }>
const _zoneObservers = new Map();

// Zone State tracking: zoneKey -> { lastPushedTemp, lastPushedDemand, lastPushedTs, currentTemp, currentHumidity, currentDemand, targetTemp }
const _zoneStates = new Map();

function init(deps = {}) {
    _db = deps.db || require('./db');
    _commandApi = deps.commandApi || require('./command-api');
    _coapTransport = deps.coapTransport || require('./coap-transport');
    _coap = deps.coap || require('./coap');
    _tlv = deps.tlv || require('./tlv');
    _mqttPublisher = deps.mqttPublisher || null;
    _wsBridge = deps.wsBridge || require('./ws-bridge');
}

function getZoneKey(homeId, zoneId) {
    return `${homeId}:${zoneId}`;
}

/**
 * Register an observer device (e.g. VA) observing /z/p on a zone.
 */
function registerObserver({ homeId, zoneId, deviceSerial, ipv6, udpPort, token, ws }) {
    if (!homeId || zoneId == null || !deviceSerial) return;
    const key = getZoneKey(homeId, zoneId);

    if (!_zoneObservers.has(key)) {
        _zoneObservers.set(key, new Map());
    }

    const zoneMap = _zoneObservers.get(key);
    const existing = zoneMap.get(deviceSerial) || {};

    zoneMap.set(deviceSerial, {
        deviceSerial,
        ipv6: ipv6 || existing.ipv6,
        udpPort: udpPort || existing.udpPort || 5683,
        token: token != null ? (Buffer.isBuffer(token) ? token : Buffer.from(token)) : existing.token,
        ws: ws || existing.ws,
        registeredAt: Date.now(),
        lastSeq: existing.lastSeq || 0
    });

    log('info', `Registered observer ${deviceSerial} for zone ${zoneId} (home ${homeId})`);
}

/**
 * Unregister an observer.
 */
function unregisterObserver(homeId, zoneId, deviceSerial) {
    const key = getZoneKey(homeId, zoneId);
    if (_zoneObservers.has(key)) {
        _zoneObservers.get(key).delete(deviceSerial);
    }
}

/**
 * Retrieve active observers for a zone.
 */
function getObservers(homeId, zoneId) {
    const key = getZoneKey(homeId, zoneId);
    if (!_zoneObservers.has(key)) return [];
    return Array.from(_zoneObservers.get(key).values());
}

/**
 * Calculate valve demand % (0-100) using closed-loop PID control law (firmware FUN_08031970).
 * 
 * Target setpoint T_set, ambient temperature T_amb.
 * P = Kp * (T_set - T_amb) / 2000
 * I = Ki * accumulator / 30000 (anti-windup: max accumulator = 3,000,000 / Ki)
 * D = Kd * (T_amb - T_prev) / 2000 (rate-of-rise dynamic braking)
 * Demand = clamp(P + I - D, 0, 100)
 * 
 * If pidGains is a number, it is treated as legacy proportional band width (pBand).
 * 
 * @param {number|null} currentTemp - Current room temperature in °C
 * @param {number|null} targetTemp - Target setpoint in °C
 * @param {boolean} isPowerOn - Whether heating in zone is enabled
 * @param {Object|number} [pidGains] - { kp, ki, kd } or numeric pBand
 * @param {Object} [pidState] - State container to store accumulator & prevTempRaw
 * @returns {number} Demand percentage integer 0-100
 */
function calculateZoneDemand(currentTemp, targetTemp, isPowerOn = true, pidGains = {}, pidState = null) {
    if (!isPowerOn || targetTemp == null || currentTemp == null) {
        if (pidState) {
            pidState.pidAccumulator = 0;
            pidState.pidPrevTempRaw = null;
        }
        return 0;
    }

    const curTemp = Number(currentTemp);
    const tgtTemp = Number(targetTemp);

    // Support legacy numeric pBand call signature for backward compatibility
    if (typeof pidGains === 'number') {
        const pBand = pidGains > 0 ? pidGains : 1.5;
        const error = tgtTemp - curTemp;
        if (error <= 0) return 0;
        return Math.min(100, Math.max(0, Math.round((error / pBand) * 100)));
    }

    const currentRaw = Math.round(curTemp * 100);
    const setpointRaw = Math.round(tgtTemp * 100);
    const prevRaw = (pidState && pidState.pidPrevTempRaw != null)
        ? pidState.pidPrevTempRaw
        : currentRaw;

    // Normalize gains (convert float scale <= 50 to raw integer scale * 100)
    let kp = (pidGains && pidGains.kp != null) ? Number(pidGains.kp) : 10.00;
    if (kp <= 50) kp = Math.round(kp * 100);
    let ki = (pidGains && pidGains.ki != null) ? Number(pidGains.ki) : 5.00;
    if (ki <= 50) ki = Math.round(ki * 100);
    let kd = (pidGains && pidGains.kd != null) ? Number(pidGains.kd) : 15.00;
    if (kd <= 50) kd = Math.round(kd * 100);

    // Anti-windup accumulator clamp: 3,000,000 / Ki
    const maxAcc = (ki > 0) ? Math.floor(3000000 / ki) : 0;
    const currentAcc = (pidState && pidState.pidAccumulator != null) ? Number(pidState.pidAccumulator) : 0;
    const err = setpointRaw - currentRaw;
    let newAcc = currentAcc + err;
    if (newAcc > maxAcc) {
        newAcc = maxAcc;
    } else if (newAcc < 0) {
        newAcc = 0;
    }

    // I term = (Ki * accumulator) / 30000
    const iTerm = Math.floor((ki * newAcc) / 30000);
    // D term = (Kd * (current - previous)) / 2000 (dynamic braking on rate of rise)
    const dTerm = Math.floor((kd * (currentRaw - prevRaw)) / 2000);
    // P term = (Kp * (setpoint - current)) / 2000
    const pTerm = Math.floor((kp * err) / 2000);

    // Closed loop: clamp(P + I - D, 0, 100)
    let demand = (pTerm + iTerm) - dTerm;
    if (demand > 100) demand = 100;
    if (demand < 0) demand = 0;

    if (pidState) {
        pidState.pidAccumulator = newAcc;
        pidState.pidPrevTempRaw = currentRaw;
        pidState.pidIState = iTerm;
        pidState.pidDState = dTerm;
        pidState.pidPTerm = pTerm;
        pidState.pidGains = { kp, ki, kd };
    }

    return demand;
}

/**
 * Check whether a downlink should be dispatched to member VAs, preserving battery life.
 * 
 * Dispatches only when:
 * 1. Forced (e.g. manual setpoint / overlay change).
 * 2. First push after startup (lastPushedTs == null).
 * 3. Temperature delta >= 0.2°C.
 * 4. Demand delta >= 5%.
 * 5. Keepalive period elapsed (10 minutes = 600,000 ms).
 */
function shouldDispatchDownlink(zoneState, newTemp, newDemand, force = false) {
    if (force) return true;
    if (!zoneState || zoneState.lastPushedTs == null) return true;

    if (newTemp != null && zoneState.lastPushedTemp != null) {
        if (Math.abs(Number(newTemp) - Number(zoneState.lastPushedTemp)) >= 0.2 - 1e-6) {
            return true;
        }
    }

    if (newDemand != null && zoneState.lastPushedDemand != null) {
        if (Math.abs(Number(newDemand) - Number(zoneState.lastPushedDemand)) >= 5) {
            return true;
        }
    }

    const elapsed = Date.now() - zoneState.lastPushedTs;
    if (elapsed >= 600000) { // 10 minutes
        return true;
    }

    return false;
}

/**
 * Build TLV buffer containing zone parameter fields for /z/p.
 * 
 * Standard fields:
 * - 0x4060: zone_temperature_4060 (s16be, scale 0.01)
 * - 0x40a0: demand_percent (u8, 0-100)
 * - 0x4000: target_temperature (s16be, scale 0.01)
 * - 0x0135: humidity_percent (u16be, scale 0.01)
 */
function buildZoneParamsTLV({ temp, demand, targetTemp, humidity }) {
    const tlv = _tlv || require('./tlv');
    const entries = [];

    if (temp != null && !isNaN(temp)) {
        entries.push({
            fid: 0x4060,
            value: tlv.encodeValue(Math.round(Number(temp) * 100), 's16be')
        });
    }

    if (demand != null && !isNaN(demand)) {
        entries.push({
            fid: 0x40a0,
            value: tlv.encodeValue(Math.min(100, Math.max(0, Math.round(Number(demand)))), 'u8')
        });
    }

    if (targetTemp != null && !isNaN(targetTemp)) {
        entries.push({
            fid: 0x4000,
            value: tlv.encodeValue(Math.round(Number(targetTemp) * 100), 's16be')
        });
    }

    if (humidity != null && !isNaN(humidity)) {
        entries.push({
            fid: 0x0135,
            value: tlv.encodeValue(Math.round(Number(humidity) * 100), 'u16be')
        });
    }

    return tlv.encode(entries);
}

/**
 * Notify all zone observers (and member VAs) of updated temperature and demand.
 */
async function notifyZoneObservers(homeId, zoneId, options = {}) {
    const key = getZoneKey(homeId, zoneId);
    let state = _zoneStates.get(key);
    if (!state) {
        state = {
            lastPushedTemp: null,
            lastPushedDemand: null,
            lastPushedTs: null,
            currentTemp: options.temp ?? null,
            currentDemand: options.demand ?? null,
            targetTemp: options.targetTemp ?? null,
            currentHumidity: options.humidity ?? null
        };
        _zoneStates.set(key, state);
    }

    const temp = options.temp !== undefined ? options.temp : state.currentTemp;
    const demand = options.demand !== undefined ? options.demand : state.currentDemand;
    const targetTemp = options.targetTemp !== undefined ? options.targetTemp : state.targetTemp;
    const humidity = options.humidity !== undefined ? options.humidity : state.currentHumidity;
    const force = !!options.force;

    if (!shouldDispatchDownlink(state, temp, demand, force)) {
        log('debug', `[zone-coord] Gated push for zone ${zoneId}: temp=${temp}°C, demand=${demand}% (skipped)`);
        return { dispatched: false, reason: 'gated' };
    }

    const pool = _db.getPool();
    const [vaRows] = await pool.execute(
        "SELECT serial_no, ipv6_address, udp_port FROM devices WHERE home_id = ? AND zone_id = ? AND device_type LIKE 'VA%' AND ipv6_address IS NOT NULL",
        [homeId, zoneId]
    );

    const payloadBuffer = buildZoneParamsTLV({ temp, demand, targetTemp, humidity });
    const bridge = _coapTransport ? _coapTransport.findBridgeForHome(homeId) : null;
    let dispatchedCount = 0;

    const registeredMap = _zoneObservers.get(key) || new Map();

    for (const va of vaRows) {
        const obs = registeredMap.get(va.serial_no);

        // 1. Send Observe Notification if active observer registered
        if (obs && obs.ws && obs.token && _coap) {
            obs.lastSeq = ((obs.lastSeq || 0) + 1) & 0xFFFFFF;
            const observeBytes = _coap.buildResponse({
                type: _coap.TYPE_NON,
                code: _coap.CODE_CONTENT,
                mid: _coapTransport.getNextMid ? _coapTransport.getNextMid() : 0,
                token: obs.token,
                options: [
                    { num: _coap.OPT_OBSERVE, value: _coap.encOptUint(obs.lastSeq) },
                    { num: _coap.OPT_CONTENT_FORMAT, value: _coap.encOptUint(42) }
                ],
                payload: payloadBuffer
            });

            try {
                const coapHelpers = require('./handlers/coap-helpers');
                coapHelpers.sendWrappedCoAP(obs.ws, observeBytes, {
                    ipv6: obs.ipv6,
                    udpPort: obs.udpPort
                }, _wsBridge ? _wsBridge.DIR_SERVER_TO_CLIENT : 2);
                dispatchedCount++;
            } catch (err) {
                log('warn', `Failed to send observe notification to ${va.serial_no}: ${err.message}`);
            }
        }

        // 2. Dispatch PUT /z/p to ensure reliable parameter update
        if (bridge && _coap && _coapTransport) {
            const mid = _coapTransport.getNextMid ? _coapTransport.getNextMid() : 0;
            const token = crypto.randomBytes(4);

            const coapBytes = _coap.buildRequest({
                code: _coap.CODE_PUT,
                path: 'z/p',
                token,
                mid,
                type: _coap.TYPE_CON,
                payload: payloadBuffer,
                contentFormat: 42,
                query: `id=${zoneId}`
            });

            _coapTransport.sendViaBridge(
                bridge.bridgeId,
                bridge.bridgeClient,
                va.ipv6_address,
                va.udp_port || 5683,
                coapBytes,
                `z/p:push:z${zoneId}`
            );
            dispatchedCount++;
        }
    }

    // Update state tracking
    state.lastPushedTemp = temp;
    state.lastPushedDemand = demand;
    state.lastPushedTs = Date.now();
    state.currentTemp = temp;
    state.currentDemand = demand;
    state.targetTemp = targetTemp;
    state.currentHumidity = humidity;

    // 3. Central Boiler Circuit Demand Relay
    relayBoilerCircuitDemand(homeId).catch(err => {
        log('warn', `[zone-coord] Relay boiler demand failed for home ${homeId}: ${err.message}`);
    });

    log('info', `[zone-coord] Dispatched telemetry to Z:${zoneId} (${dispatchedCount} targets): temp=${temp}°C, demand=${demand}%`);
    return { dispatched: true, dispatchedCount };
}

/**
 * Relay highest active zone demand to central boiler circuit driver if configured.
 */
async function relayBoilerCircuitDemand(homeId) {
    if (!_db) return;
    const pool = _db.getPool();

    const [circuits] = await pool.execute(
        'SELECT number, driver_serial_no FROM heating_circuits WHERE home_id = ? AND driver_serial_no IS NOT NULL',
        [homeId]
    );
    if (circuits.length === 0) return;

    // Find maximum current demand across all zones in the home
    const [demandRows] = await pool.execute(`
        SELECT zm.zone_id, zm.field_40a0 AS demand
        FROM zone_measurements zm
        INNER JOIN (
            SELECT zone_id, MAX(id) AS max_id 
            FROM zone_measurements 
            WHERE home_id = ? 
            GROUP BY zone_id
        ) latest ON zm.id = latest.max_id
    `, [homeId]);

    let maxDemand = 0;
    for (const r of demandRows) {
        if (r.demand != null && !isNaN(r.demand)) {
            maxDemand = Math.max(maxDemand, Number(r.demand));
        }
    }

    for (const c of circuits) {
        await pool.execute(
            'UPDATE heating_circuits SET field_4080 = ? WHERE home_id = ? AND number = ?',
            [maxDemand, homeId, c.number]
        ).catch(() => {});

        if (_mqttPublisher) {
            _mqttPublisher.publishCircuitTelemetry(homeId, c.number, { '0x4080': maxDemand })
                .catch(e => log('debug', `[MQTT] Relay boiler circuit demand failed: ${e.message}`));
        }
    }
}

/**
 * Ingest external temperature and humidity telemetry for a virtual zone leader.
 */
async function onExternalTelemetry(homeId, zoneId, temp, humidity = null) {
    if (!homeId || zoneId == null) return;
    const pool = _db.getPool();

    // 1. Resolve virtual leader device & PID settings for zone
    const [zoneRows] = await pool.execute(
        'SELECT measuring_device_serial, type, field_6080, field_60a0, field_60c0 FROM zones WHERE id = ? AND home_id = ?',
        [zoneId, homeId]
    );
    if (zoneRows.length === 0) return;
    const measuringSerial = zoneRows[0].measuring_device_serial;

    // 2. Fetch current active target setpoint & power state
    let targetTemp = null;
    let isPowerOn = true;

    // Check overlay first
    const [overlayRows] = await pool.execute(
        'SELECT setting_power, setting_temp_celsius FROM zone_overlays WHERE zone_id = ? AND home_id = ? LIMIT 1',
        [zoneId, homeId]
    );

    if (overlayRows.length > 0) {
        isPowerOn = (overlayRows[0].setting_power !== 'OFF');
        targetTemp = overlayRows[0].setting_temp_celsius != null ? Number(overlayRows[0].setting_temp_celsius) : null;
    } else {
        // Fall back to schedule block
        const currentBlock = await _db.getCurrentScheduleBlock(homeId, zoneId).catch(() => null);
        if (currentBlock && currentBlock.setting) {
            isPowerOn = (currentBlock.setting.power !== 'OFF');
            targetTemp = currentBlock.setting.temperature?.celsius != null ? Number(currentBlock.setting.temperature.celsius) : 20.0;
        } else {
            targetTemp = 20.0;
        }
    }

    // 3. Compute demand using closed-loop PID control law
    const key = getZoneKey(homeId, zoneId);
    let zoneState = _zoneStates.get(key);
    if (!zoneState) {
        zoneState = {};
        _zoneStates.set(key, zoneState);
    }

    const pidGains = {
        kp: zoneRows[0].field_6080,
        ki: zoneRows[0].field_60a0,
        kd: zoneRows[0].field_60c0
    };
    const demand = calculateZoneDemand(temp, targetTemp, isPowerOn, pidGains, zoneState);

    // 4. Record measurements in DB
    const updates = {};
    if (temp != null) updates['0x012d'] = Number(temp);
    if (humidity != null) updates['0x0135'] = Number(humidity);
    updates['0x40a0'] = demand;

    await _db.insertMergedZoneMeasurement(homeId, zoneId, updates);

    if (measuringSerial) {
        await pool.execute(
            'INSERT INTO device_measurements (device_serial, field_012d, field_0135) VALUES (?, ?, ?)',
            [measuringSerial, temp != null ? Number(temp) : null, humidity != null ? Number(humidity) : null]
        ).catch(() => {});
    }

    // 5. Notify zone observers with gating
    await notifyZoneObservers(homeId, zoneId, {
        temp: Number(temp),
        humidity: humidity != null ? Number(humidity) : null,
        targetTemp,
        demand
    });

    // 6. Publish telemetry via MQTT
    if (_mqttPublisher) {
        const [mRows] = await pool.execute(
            'SELECT * FROM zone_measurements WHERE zone_id = ? AND home_id = ? ORDER BY id DESC LIMIT 1',
            [zoneId, homeId]
        );
        if (mRows.length > 0) {
            _mqttPublisher.publishZoneTelemetry(homeId, zoneId, mRows[0])
                .catch(e => log('debug', `[MQTT] External telemetry publish failed: ${e.message}`));
        }
    }
}

function getZoneState(homeId, zoneId) {
    const key = getZoneKey(homeId, zoneId);
    return _zoneStates.get(key) || null;
}

function setZoneState(homeId, zoneId, state) {
    const key = getZoneKey(homeId, zoneId);
    _zoneStates.set(key, state);
}

function clearAll() {
    _zoneObservers.clear();
    _zoneStates.clear();
}

module.exports = {
    init,
    registerObserver,
    unregisterObserver,
    getObservers,
    calculateZoneDemand,
    shouldDispatchDownlink,
    buildZoneParamsTLV,
    notifyZoneObservers,
    relayBoilerCircuitDemand,
    onExternalTelemetry,
    getZoneState,
    setZoneState,
    clearAll
};
