# TaNoClo Virtual Sensor & Zone Coordinator Architecture

This document details the architecture, firmware mechanics, CoAP RFC 7641 Observe protocol, battery preservation rules, MQTT integration, and debugging procedures for configuring the **Internet Bridge (IB)** as a **Virtual Wireless Sensor / Zone Measuring Leader**.

---

## 1. Overview & Motivation

In genuine Tado systems, a heating zone typically measures temperature from one of two sources:
1. **Smart Radiator Thermostats (`VA...`)**: Mounted directly on the radiator. Heat radiation from the radiator itself distorts temperature readings, causing premature shutoff and cold rooms unless large manual offsets are calibrated.
2. **Wireless Temperature Sensors (`SU...`) or Smart Thermostats (`RU...`)**: Standalone wall-mounted battery/wired devices positioned away from radiators.

The **TaNoClo Virtual Sensor Coordinator** allows you to designate the **Internet Bridge** itself as the zone's primary measuring leader (`IB_VS_<homeId>_<zoneId>`). External temperature and humidity sensors (Zigbee, BLE, ESPHome, Home Assistant, etc.) publish ambient room readings over MQTT, and TaNoClo calculates valve demand and delivers firmware-true downlinks directly to all observing radiator valves.

```
+--------------------------------------------------------------------------------------------------+
|                                        TaNoClo Ecosystem                                         |
|                                                                                                  |
|   +-----------------------+      +-------------------------+      +---------------------------+  |
|   |    External Sensors   |      |     Home Assistant      |      |   TaNoClo frontend-new    |  |
|   |  (Zigbee / BLE / ESP) |      | (Automation / MQTT Pub) |      | (Zone Settings & Control) |  |
|   +-----------+-----------+      +------------+------------+      +-------------+-------------+  |
|               |                               |                                 |                |
|               +-----------------------+       |       +-------------------------+                |
|                                       v       v       v                                          |
|                               +-------------------------------+                                  |
|                               |       TaNoClo ws-server       |                                  |
|                               |   (Node.js API & WebSocket)   |                                  |
|                               |                               |                                  |
|                               |  Zone Coordinator Engine:     |                                  |
|                               |   - Proportional Demand Calc  |                                  |
|                               |   - RFC 7641 Observe Registry |                                  |
|                               |   - Battery Gating Filter     |                                  |
|                               +---------------+---------------+                                  |
|                                               |                                                  |
|                                               | CoAP Observe Push / PUT /z/p                     |
|                                               v                                                  |
|                                       +---------------+                                          |
|                                       |  Internet     |                                          |
|                                       |  Bridge (IB)  |                                          |
|                                       +-------+-------+                                          |
|                                               |                                                  |
|                                               | 868.3 MHz 6LoWPAN / CSL                          |
|                                               | (TLV: 0x4060, 0x40a0, 0x4000, 0x0135)            |
|                                               v                                                  |
|                               +-------------------------------+                                  |
|                               |   Smart Radiator Thermostats  |                                  |
|                               |         (VA01 / VA02)         |                                  |
|                               +-------------------------------+                                  |
+--------------------------------------------------------------------------------------------------+
```

---

## 2. Firmware-True CoAP Observe Architecture

### 2.1 The `/z/p` (Zone Parameters) Resource
Under Tado firmware architecture, zone leaders disseminate environmental parameters to radiator valves in the zone using the CoAP resource:
```
coap://[<leader_ipv6>]:5683/z/p
```

When a radiator valve (`VA...`) boots or joins a heating zone, it issues a **CoAP `GET /z/p`** request with the **RFC 7641 Observe** option (`Observe: 0`).

1. **Observe Registration**:
   - The Internet Bridge forwards the incoming CoAP frame to `ws-server`.
   - `zone-coordinator.js` records the valve's radio IPv6 address, UDP port, token, and request sequence number.
   - The server acknowledges with a `2.05 Content` ACK carrying `Observe: 1` and the initial parameter payload.

2. **Downlink Payload Framing (TLV)**:
   The payload transmitted to radiator valves conforms strictly to Tado binary Type-Length-Value encoding:

| TLV Tag | Firmware Meaning | Type | Unit / Format | Description |
|---|---|---|---|---|
| `0x4060` | Ambient Temperature | `s16be` | $0.01^\circ\text{C}$ ($\times 100$) | E.g. $21.50^\circ\text{C} = 2150$ (`0x0866`) |
| `0x40a0` | Valve Heating Demand | `u8` | Percentage ($0\dots 100\%$) | Proportional opening required |
| `0x4000` | Target Setpoint | `s16be` | $0.01^\circ\text{C}$ ($\times 100$) | E.g. $20.00^\circ\text{C} = 2000$ (`0x07d0`) |
| `0x0135` | Relative Humidity | `u16be` | $0.01\% \text{ RH}$ ($\times 100$) | E.g. $50.00\% = 5000$ (`0x1388`) |

3. **Dual Dispatching Mechanics**:
   Whenever room telemetry updates and passes battery gating:
   - An Observe notification (`2.05 Content` with incrementing `Observe` counter) is sent to all registered tokens.
   - A direct `PUT /z/p` frame carrying the identical TLV payload is dispatched via `coapTransport.sendViaBridge` to ensure valves waking outside the active observe window receive the update.

---

## 3. Battery Preservation & Downlink Gating

Tado radiator valves operate on **2x AA alkaline batteries** with an expected lifespan of 6 months. Radiator valves spend over 99% of their time in ultra-low-power sleep, waking intermittently to listen for **CSL (Coordinated Sampled Listening)** radio bursts from the Internet Bridge.

Unconstrained downlinks (such as pushing every fraction-of-a-degree jitter from external sensors) will rapidly deplete valve batteries.

To prevent this, `ws-server/lib/zone-coordinator.js` enforces strict **battery-preserving downlink gating**:

```
+-------------------------------------------------------+
|                 New Telemetry Ingested                |
+---------------------------+---------------------------+
                            |
                            v
               +--------------------------+
               |  Is ΔT ≥ 0.2°C?          | ---- YES ----+
               +--------------------------+              |
                            | NO                         |
                            v                            |
               +--------------------------+              |
               |  Is ΔDemand ≥ 5%?        | ---- YES ----+
               +--------------------------+              |
                            | NO                         |
                            v                            |
               +--------------------------+              |
               |  Elapsed Time ≥ 10 min?  | ---- YES ----+
               +--------------------------+              |
                            | NO                         |
                            v                            v
               +--------------------------+    +-------------------+
               |  Gated / Throttled       |    | Dispatch Downlink |
               |  (Suppress RF Downlink)  |    | (Observe + PUT)   |
               +--------------------------+    +-------------------+
```

- **Temperature Deadband ($\Delta T \ge 0.2^\circ\text{C}$)**: Minor noise (e.g. $20.02^\circ\text{C} \to 20.06^\circ\text{C}$) is cached without triggering an RF transmission.
- **Demand Deadband ($\Delta\text{Demand} \ge 5\%$)**: Small valve adjustments are batched.
- **Keepalive Interval ($10\text{ minutes}$)**: If temperatures are completely static, a periodic push guarantees the valve's internal watchdog does not enter fallback failsafe mode.
- **Immediate Overrides**: Setpoint changes, schedule block transitions, and manual test injections bypass the deadband filter immediately.

---

## 4. Closed-Loop PID Heating Demand Calculation & Central Boiler Relay

When an external temperature is received, the zone coordinator calculates closed-loop heating demand adhering strictly to the PID laws:

### 4.1 Closed-Loop PID Control Law
The coordinator retrieves the zone's custom PID parameters from the database (`zones.field_6080` $K_p$, `zones.field_60a0` $K_i$, and `zones.field_60c0` $K_d$, corresponding to FIDs `0x6080`, `0x60a0`, and `0x60c0`):

$$\begin{aligned}
P &= \frac{K_p \times (\text{Setpoint} - \text{Ambient})}{2000} \\
I &= \frac{K_i \times \text{Accumulator}}{30000} \quad \text{with anti-windup: } \text{Accumulator} \le \frac{3,000,000}{K_i} \\
D &= \frac{K_d \times (\text{Ambient} - \text{Ambient}_{\text{prev}})}{2000} \quad \text{(dynamic rate-of-rise braking)} \\
\text{Demand} &= \operatorname{clamp}(P + I - D, 0\%, 100\%)
\end{aligned}$$

*(Note: Temperatures and setpoints are computed at $0.01^\circ\text{C}$ centidegree resolution, matching firmware integer arithmetic).*

- **Proportional Response ($P$)**: Controlled by $K_p$ (default $10.00$ / raw $1000$). For a $1.0^\circ\text{C}$ deficit, $P = 50\%$. Lower gains (e.g. $K_p = 3.00\dots 5.50$) configure soft, gradual response for radiant underfloor heating with high thermal inertia.
- **Integral Accumulation ($I$)**: Controlled by $K_i$ (default $5.00$ / raw $500$). Eradicates persistent steady-state offset and heat loss through building fabric, with hard anti-windup clamping to prevent overshoot.
- **Derivative Braking ($D$)**: Controlled by $K_d$ (default $15.00$ / raw $1500$). Senses rapid temperature rise and throttles back valve opening before the target setpoint is reached, preventing room temperature overshoot.

### 4.2 Central Boiler Circuit Integration
If the zone is assigned to a heating circuit governed by a Central Boiler Driver (`RU` or `WR` extension kit):
- `zoneCoordinator.relayBoilerCircuitDemand()` automatically forwards the calculated demand to `boilerDemandAggregator.updateCircuitDemandFromZoneDemand()`.
- The central boiler turns on or modulates flame height accordingly without requiring physical room thermostats.

---

## 5. Web UI Configuration

### 5.1 Enabling Virtual Sensor for a Zone
1. Open **TaNoClo Web App**.
2. Go to **Settings** $\to$ **Heating Zones** $\to$ Select Zone.
3. Scroll to the **Measuring Device** section.
4. Select `🌐 Internet Bridge (Virtual Sensor Leader - MQTT)` from the dropdown or click **Use Internet Bridge as Virtual Sensor (MQTT)**.
5. The system automatically creates device `IB_VS_<homeId>_<zoneId>`, binds the Internet Bridge radio IPv6, and sets `is_virtual_leader = 1`.

### 5.2 Live Diagnostics & Control Panel
Once enabled, the **Virtual Sensor Diagnostics & MQTT Telemetry** panel appears in Zone Settings:
- **Live Telemetry & Demand**: Displays current ambient temperature, active setpoint, calculated valve opening demand (with visual duty cycle bar), and relative humidity.
- **Downlink Status**: Shows the timestamp of the last dispatched downlink, the exact values sent (`T`, `Demand`, `Setpoint`), and whether downlinks are currently gated.
- **Subscribed Observers**: Lists all radiator valves (`VA...`) listening to this zone, their radio IPv6 addresses, UDP ports, and the current CoAP sequence counter.
- **MQTT Integration Guide**: Copyable topics for easy configuration in Home Assistant or Node-RED.
- **Manual Telemetry Injector**: Real-time test input allowing you to inject arbitrary temperatures and humidities to instantly verify demand calculation and downlink transmission.

---

## 6. MQTT Integration & Topic Reference

### 6.1 Topic Scheme
The TaNoClo MQTT handler (`ws-server/lib/mqtt-commands.js`) subscribes to the following topics:

| Topic | Description | Expected Payload | Example |
|---|---|---|---|
| `tado/tanoclo/h/<homeId>/d/<serial>/cmd/temperature` | Inject temperature for zone leader | Raw number or JSON | `21.5` or `{"temperature": 21.5}` |
| `tado/tanoclo/h/<homeId>/d/<serial>/cmd/humidity` | Inject humidity for zone leader | Raw number or JSON | `50` or `{"humidity": 50}` |
| `tado/tanoclo/virtual/<serial>/telemetry` | Combined virtual leader telemetry | JSON object | `{"temperature": 21.5, "humidity": 50}` |
| `tado/tanoclo/h/<homeId>/d/<serial>/telemetry` | Standard device telemetry channel | JSON object | `{"temperature": 21.5, "humidity": 50}` |

*(Where `<serial>` is the virtual device identifier, e.g. `IB_VS_814294_1`)*.

### 6.2 Home Assistant Automation Example
To forward readings from an existing Home Assistant temperature sensor (e.g. Aqara, Sonoff, Shelly) to TaNoClo:

```yaml
alias: Forward Living Room Temperature to TaNoClo
description: Sends room temperature to TaNoClo Virtual Sensor Leader
trigger:
  - platform: state
    entity_id: sensor.living_room_temperature
action:
  - action: mqtt.publish
    data:
      topic: "tado/tanoclo/h/123456/d/IB_VS_123456_1/cmd/temperature"
      payload: "{{ states('sensor.living_room_temperature') }}"
      retain: false
mode: single
```

### 6.3 Command Line Testing (`mosquitto_pub`)
You can publish test telemetry directly from your terminal:

```bash
# Publish temperature only
mosquitto_pub -h <mqtt-broker-ip> -t "tado/tanoclo/h/123456/d/IB_VS_123456_1/cmd/temperature" -m "20.8"

# Publish combined telemetry
mosquitto_pub -h <mqtt-broker-ip> -t "tado/tanoclo/virtual/IB_VS_123456_1/telemetry" -m '{"temperature": 21.2, "humidity": 55}'
```

---

## 7. REST API Endpoints

TaNoClo provides complete programmatic control over virtual sensors via REST:

### 1. Create or Assign Virtual Sensor
- **Method**: `POST`
- **Path**: `/api/v2/homes/:homeId/zones/:zoneId/virtual-sensor`
- **Body**: `{ "name": "Living Room Virtual Sensor" }` (optional)
- **Response**: `201 Created` with device representation.

### 2. Remove Virtual Sensor
- **Method**: `DELETE`
- **Path**: `/api/v2/homes/:homeId/zones/:zoneId/virtual-sensor`
- **Response**: `200 OK` (reverts measuring device to the first physical device in the zone).

### 3. Get Virtual Sensor Status & Observers
- **Method**: `GET`
- **Path**: `/api/v2/homes/:homeId/zones/:zoneId/virtual-sensor`
- **Response**:
```json
{
  "isVirtualLeader": true,
  "measuringDeviceSerial": "IB_VS_123456_1",
  "state": {
    "temperature": 21.5,
    "humidity": 50,
    "setpoint": 20.0,
    "demand": 0,
    "lastPushTimestamp": 1731182400000,
    "lastPushedValues": {
      "temperature": 21.5,
      "demand": 0,
      "setpoint": 20.0,
      "humidity": 50
    }
  },
  "observers": [
    {
      "deviceSerial": "VA0123456789",
      "ipv6": "fe80::2c4a:ffff:fe12:3456",
      "udpPort": 5683,
      "lastSeq": 4,
      "registeredAt": 1731181200000
    }
  ],
  "mqttTopics": {
    "cmdTemperature": "tado/tanoclo/h/123456/d/IB_VS_123456_1/cmd/temperature",
    "cmdHumidity": "tado/tanoclo/h/123456/d/IB_VS_123456_1/cmd/humidity",
    "telemetry": "tado/tanoclo/h/123456/d/IB_VS_123456_1/telemetry",
    "virtualTelemetry": "tado/tanoclo/virtual/IB_VS_123456_1/telemetry"
  }
}
```

### 4. Inject Telemetry via HTTP
- **Method**: `POST`
- **Path**: `/api/v2/homes/:homeId/devices/:deviceId/temperature`
- **Body**: `{ "temperature": 21.5, "humidity": 50 }`
- **Response**: `200 OK`.

---

## 8. Verification & Troubleshooting

1. **Verify Observer Registration**:
   - In the Web UI **Virtual Sensor Diagnostics**, check that your radiator valve appears under **Subscribed Radiator Valves**.
   - If no valves appear, trigger a wake cycle on the valve (press the button on the valve or turn the dial slightly). The valve will send `GET /z/p` to the Internet Bridge and immediately appear in the observer table.

2. **Verify Downlink Dispatches**:
   - Use the **Manual Telemetry Injector** in the UI to send `18.0°C` when the setpoint is `21.0°C`.
   - Observe that **Valve Demand** jumps to `100%`, and **Last Push** updates with `Pushed Demand: 100%`.
   - Within seconds, the radiator valve motor will audibly engage to open the valve.

3. **Check Logs**:
   In `ws-server` logs:
   ```
   [ZONE-COORD] Registered observer for home 123456 zone 1: VA0123456789 (fe80::...:5683)
   [ZONE-COORD] External telemetry for home 123456 zone 1: T=21.5C, H=50% -> Demand=0%
   [ZONE-COORD] Dispatching downlink to 1 observers for zone 1 (T=21.5C, Demand=0%, SP=20.0C)
   ```
