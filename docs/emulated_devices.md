# TaNoClo ESP32 Multi-Device Emulation & Integration Guide

This document details the architecture, firmware mechanics, REST API protocol, and end-to-end integration for emulating Tado hardware (Room Units & Wireless Temperature Sensors) using ESP32 microcontrollers, the TaNoClo WebSocket/REST server, the Setup Dashboard, `frontend-new`, and Home Assistant MQTT.

---

## 1. Architecture Overview

A single ESP32 development board (such as the **TTGO LoRa32 V1.6.1** with an SX1276 transceiver) running the `tado_emulator` ESPHome component can simultaneously emulate **multiple independent Tado devices** (e.g. `RU...` Room Units or Temperature Sensors) on your 868.3 MHz FSK RF network.

```
+---------------------------------------------------------------------------------------+
|                                    TaNoClo Ecosystem                                   |
|                                                                                       |
|  +------------------------+      +-----------------------+     +-------------------+  |
|  |     frontend-new       |      |    Setup Dashboard    |     |  Home Assistant   |  |
|  | (Main PWA & Settings)  |      |   (Admin Portal UI)   |     |    (MQTT / HA)    |  |
|  +-----------+------------+      +-----------+-----------+     +---------+---------+  |
|              |                               |                           |            |
|              +-----------------------+       |       +-------------------+            |
|                                      v       v       v                                |
|                              +-------------------------------+                        |
|                              |       TaNoClo ws-server       |                        |
|                              |   (Node.js API & WebSocket)   |                        |
|                              |  MariaDB: esp32_nodes,        |                        |
|                              |           emulated_devices    |                        |
|                              +---------------+---------------+                        |
|                                              |                                        |
|                     +------------------------+------------------------+               |
|                     | REST / HMAC (HTTP)                              | WebSocket     |
|                     v                                                 v               |
|       +----------------------------+                            +-----------+         |
|       |    ESP32 Hardware Node     |                            |  Tado IB  |         |
|       | (ESPHome: `tado_emulator`) |                            | (Bridge)  |         |
|       +--------------+-------------+                            +-----+-----+         |
|                      |                                                |               |
|                      +------------ 868.3 MHz FSK RF (6LoWPAN) --------+               |
|                                    CoAP / AES-128-CCM                                 |
+---------------------------------------------------------------------------------------+
```

---

## 2. Hardware & Firmware (`tado_emulator`)

### 2.1 Supported Hardware
- **MCU**: ESP32-D0WDQ6 / ESP32-WROOM-32
- **Transceiver**: Semtech SX1276 / SX1278 (SPI)
- **Reference Board**: TTGO LoRa32 V1.6.1 (868 MHz)
- **Pinout**:
  - `SCK`: GPIO 5
  - `MISO`: GPIO 19
  - `MOSI`: GPIO 27
  - `CS (NSS)`: GPIO 18
  - `DIO0`: GPIO 26
  - `RST`: GPIO 14

### 2.2 Device Personality & Firmware Alignment
Emulated devices mimic genuine Tado hardware specifications:
- **Device Type**: `RU01` / `RU02` (Room Unit / Temperature Sensor)
- **Firmware Version**: `13762` (Display: `215.2`)
- **Build Number**: `c54baf8`
- **Hardware Revision (`0x0180`)**: `4`
- **Supported Modes**:
  - `WIRELESS_SENSOR`: Operates as a measuring device for ambient temperature, humidity, and battery state. Cannot act as a zone controller or heating circuit driver.
  - `ZONE_CONTROLLER`: Operates as a heating circuit driver or zone controller.

### 2.3 Critical RF & CoAP Protocol Rules
1. **CoAP Option 12 (`Content-Format: 42` = `0xC1 0x2A`)**:
   Every `2.05 Content` or `2.04 Changed` response transmitted by an emulated device **must include Option 12**. Without Option 12, the Internet Bridge rejects the ACK/response, causing a 6x retransmission timeout and omitting the device from its active Neighbor Table (`DEV_NEIGHBORS`).
2. **ICMPv6 Link Probing**:
   Upon bootup or pairing completion, the node immediately sends a Unicast ICMPv6 Echo Request (`0x80`) under the home Operational Key (`op_key`) to prime the Bridge's 6LoWPAN neighbor table.
3. **Proactive Firmware State Push**:
   On initialization, the node pushes `PUT /d/{serial}/fw` containing firmware `13762`, build `c54baf8`, and hardware rev `4` to ensure the server reflects current firmware metadata.
4. **Periodic Keepalive & Telemetry**:
   - `PUT /d/{serial}/sen`: Ambient temperature (0.01°C), relative humidity (0.01%), and battery voltage (mV) pushed every 15 minutes (or immediately on slider adjustments).
   - `PUT /z/p?lid=1`: Zone leader presence ping pushed every 15 minutes for assigned devices.

---

## 3. Server Architecture & Database Schema (`ws-server`)

### 3.1 Database Tables

#### `esp32_nodes`
Tracks physical ESP32 boards hosting the emulation firmware:
```sql
CREATE TABLE IF NOT EXISTS `esp32_nodes` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(64) NOT NULL,
  `ip_address` VARCHAR(45) NOT NULL,
  `port` INT DEFAULT 80,
  `api_key` VARCHAR(64) NOT NULL,
  `is_active` TINYINT(1) DEFAULT 1,
  `last_seen` DATETIME NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

#### `emulated_devices`
Tracks emulated virtual devices assigned to ESP32 nodes:
```sql
CREATE TABLE IF NOT EXISTS `emulated_devices` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `node_id` INT NOT NULL,
  `serial_no` VARCHAR(32) NOT NULL UNIQUE,
  `auth_code` VARCHAR(32) DEFAULT NULL,
  `home_id` INT DEFAULT NULL,
  `mode` VARCHAR(32) DEFAULT 'WIRELESS_SENSOR',
  `pairing_state` VARCHAR(32) DEFAULT 'UNPAIRED',
  `temp_celsius` DECIMAL(4,2) DEFAULT 21.00,
  `humidity_percent` DECIMAL(4,2) DEFAULT 50.00,
  `battery_mv` INT DEFAULT 3000,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`node_id`) REFERENCES `esp32_nodes`(`id`) ON DELETE CASCADE
);
```

### 3.2 Security & Authentication
All REST communication between `ws-server` and ESP32 hardware nodes is secured via HMAC-SHA256 request headers:
- Header: `X-ESP-API-Key: <256-bit-key>`
- Unauthorized requests return `401 Unauthorized`.

### 3.3 Server REST API Endpoints (`api/routes/setup/emulated.js`)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/setup/emulated/nodes` | List all registered ESP32 hardware nodes and their health status. |
| `POST` | `/setup/emulated/nodes` | Register a new ESP32 hardware node (generates secure API key). |
| `DELETE` | `/setup/emulated/nodes/:id` | Delete an ESP32 hardware node. |
| `GET` | `/setup/emulated/devices` | List all emulated virtual devices across all nodes. |
| `POST` | `/setup/emulated/devices` | Create a new emulated device record and provision it on the ESP32 node. |
| `POST` | `/setup/emulated/devices/pair` | Initiate automated RF pairing flow (places IB in pairing mode and triggers node). |
| `POST` | `/setup/emulated/devices/unpair` | Send unassociation command to remove device from IB and node NVRAM. |
| `POST` | `/setup/emulated/devices/sync` | Sync all emulated devices assigned to a node into the node's NVRAM. |
| `POST` | `/setup/emulated/devices/telemetry` | Dynamically update emulated temperature, humidity, or battery voltage. |
| `POST` | `/setup/emulated/notify-removed` | Node callback notifying server that device was erased from local NVRAM. |

---

## 4. Setup Dashboard Integration (`setup/index.html`)

The **Setup Portal** (`https://setup.tanoclo.YOUR_DOMAIN.com`) provides dedicated management panels:

1. **ESP32 Nodes Registry**:
   - Add nodes by specifying Name, IP, and Port.
   - Real-time **Ping Health Check** testing node connectivity and API key validity.
   - Shows active emulated device counts per node.
2. **Emulated Devices Registry**:
   - Create new emulated devices with custom or auto-generated `RU...` serials.
   - One-click **Pair Device** button that puts the Bridge in pairing mode and starts RF negotiation.
   - Real-time pairing state indicators (`PAIRED`, `PAIRING_RF`, `UNPAIRED`).
   - Dynamic **Telemetry Sliders** for ambient temperature, humidity, and battery voltage.
   - **Send Telemetry Push** button triggering immediate RF transmission.
   - **Delete Device** button triggering graceful unassociation over RF and NVRAM purge.

---

## 5. Main Application Integration (`frontend-new`)

The main TaNoClo frontend integrates emulated devices seamlessly into normal room heating workflows while enforcing hardware fidelity:

### 5.1 Device Settings (`DeviceSettingsGeneral.jsx` & `DeviceSettings.jsx`)
- **Emulated Device Badge**: Displays `Emulated Device: Yes` in device metadata.
- **Suppressed Battery Fields**: Hides Battery Type, Battery Percentage, and Battery State since emulated hardware is virtual and powered continuously.
- **Suppressed Maintenance Panels**: Hides `Diagnostic Actions` and `Advanced Settings` cards that apply only to real physical valves/relays.

### 5.2 Zone Controller Filtering (`ZoneSettingsGeneral.jsx`)
- Emulated devices in `WIRELESS_SENSOR` mode are automatically filtered out from the **Zone Controller** selection dropdown, preventing sensor-only emulators from being improperly assigned to drive heating circuits.

### 5.3 Raw Explorer (`RawExplorerSettings.jsx`)
- Unassigned emulated devices (`zone_id: null`) appear in the device measurement selector, allowing inspection of raw measurements even before zone assignment.

---

## 6. Home Assistant MQTT Integration

When Home Assistant MQTT discovery is enabled in `ws-server`:

### 6.1 Entity Discovery

| Entity Name | Domain | Description |
|---|---|---|
| `Emulated Device` | `binary_sensor` | Returns `ON` for emulated devices, `OFF` for physical hardware. |
| `Emulated Temperature` | `number` | Dynamic slider (5.0°C – 30.0°C) to set ambient temperature. |
| `Emulated Humidity` | `number` | Dynamic slider (10% – 95%) to set ambient relative humidity. |
| `Battery Voltage` | `sensor` | Voltage reading in mV. |
| `Send Telemetry Push` | `button` | Triggers immediate RF `PUT /d/{serial}/sen` push. |

*Note: Standard battery level and battery state entities are automatically suppressed for emulated devices.*

### 6.2 MQTT Control Topics

```bash
# Set ambient temperature
mosquitto_pub -h localhost -t "tado/tanoclo/emulated/RU4729433753/set/temp" -m "21.5"

# Set ambient humidity
mosquitto_pub -h localhost -t "tado/tanoclo/emulated/RU4729433753/set/humidity" -m "55.0"

# Set battery voltage
mosquitto_pub -h localhost -t "tado/tanoclo/emulated/RU4729433753/set/battery" -m "3000"

# Send full JSON telemetry
mosquitto_pub -h localhost -t "tado/tanoclo/emulated/RU4729433753/telemetry" -m '{"temp_celsius":21.5,"humidity_percent":55.0,"battery_mv":3000}'
```

---

## 7. Troubleshooting & Verification

1. **Device Missing from `DEV_NEIGHBORS`**:
   - Verify that the firmware includes CoAP Option 12 (`0xC1 0x2A`) in all `send_coap_ack()` calls.
   - Verify that the node transmits a Unicast ICMPv6 Echo Request (`0x80`) under `op_key` upon boot.
2. **Pairing State Stays in `PAIRING_RF`**:
   - Check ESP32 serial logs (`[RF RX]` and `[CoAP RX]`). Ensure the node extracts `op_key` from `/d/pair` or `0x0262` and receives `0x025E` session token on `POST auth/token`.
   - Once active telemetry arrives at `ws-server`, `updateDeviceConnectionState` automatically promotes the state to `PAIRED`.
3. **AST & Syntax Verification**:
   - In `ws-server`, run `node check.js` to ensure zero AST or reference errors.
   - Run `npx vitest run` to verify full test suite passes.
