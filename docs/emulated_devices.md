# TaNoClo ESP32 Multi-Device Emulation & Integration Guide

This document details how to setup, manage, and control emulated Tado Room Unit (RU) devices using single/multiple ESP32 nodes, the Admin Setup Portal, and Home Assistant / MQTT.

---

## 1. Architecture Overview

A single ESP32 node running the `tado_emulator` ESPHome component can act as **multiple emulated RU devices** simultaneously on your home network.

```
+--------------------------+       HMAC REST API       +-------------------------+
|   Admin Setup Portal /   | <-----------------------> |    ESP32 Node (ESPHome) |
|      TaNoClo Server      |       (Port 80/443)       |  (tado_emulator component)|
+--------------------------+                           +-------------------------+
             |                                                      |
             | WebSocket                                            | 868.3 MHz FSK RF
             v                                                      v
+--------------------------+                           +-------------------------+
|  Internet Bridge (IB)    | <-----------------------> |  Virtual Device NVRAM   |
|   (Cloud/Local Replica)  |   Paired RF / CoAP Link   | (serials, keys, tokens) |
+--------------------------+                           +-------------------------+
```

---

## 2. Registering ESP32 Hardware Nodes

1. Open the **Admin Setup Portal**: `https://setup.tanoclo.YOUR_DOMAIN.com`
2. Navigate to the **Emulated Devices & ESP32 Nodes** tab.
3. Under **Add ESP32 Node**, enter:
   - **Node Name**: (e.g. `LivingRoom-ESP32`)
   - **IP Address**: (e.g. `192.168.1.150`)
   - **API Port**: `80` (default)
4. Click **Add Node**. The server automatically generates a secure **256-bit HMAC API Key** for request verification.

---

## 3. Creating & Pairing Emulated RU Devices

1. On the **Emulated Devices & ESP32 Nodes** tab, locate **Create New Emulated Device**.
2. Select target **ESP32 Node**, **Target Home**, and optionally enter a custom serial number (`RU...`).
3. Click **Create & Initiate Pairing**.
4. **Automated Pairing Workflow**:
   - The server places the Internet Bridge in pairing mode over WebSocket (`pushDevicePair`).
   - The server issues a signed HTTP JSON command to the ESP32 node.
   - The ESP32 executes RF pairing over 868.3 MHz FSK (`POST auth/key` and `POST auth/token`).
   - Operational keys and session tokens are saved directly to ESP32 NVRAM (`Preferences`).

---

## 4. Controlling Telemetry from Home Assistant & MQTT

### Strict Registration Guard
For security and network integrity, **only registered emulated devices** listed in the server database (`emulated_devices` table) can be selected or controlled via MQTT. Commands sent for unknown serials are automatically rejected.

### Automatic Home Assistant Discovery
When Home Assistant MQTT integration is enabled, all registered emulated devices are automatically discovered as native Home Assistant entities:

| Entity Name | Domain | Description |
|-------------|--------|-------------|
| `Emulated Temperature` | `number` | Adjustable slider (5.0°C to 30.0°C) to dynamically set ambient temperature. |
| `Emulated Humidity` | `number` | Adjustable slider (10% to 95%) to set relative humidity. |
| `Battery Voltage` | `sensor` | Voltage reading (mV). |
| `Send Telemetry Push` | `button` | Triggers immediate RF telemetry transmission (`d/sen`) to the Internet Bridge. |

### Direct MQTT Topics

#### Control Topics
To update temperature or humidity for an emulated device via MQTT, publish to:

```bash
# Set ambient temperature to 22.5°C
mosquitto_pub -h localhost -t "tado/tanoclo/emulated/RU1234567890/set/temp" -m "22.5"

# Set relative humidity to 48%
mosquitto_pub -h localhost -t "tado/tanoclo/emulated/RU1234567890/set/humidity" -m "48.0"

# Send full JSON telemetry payload
mosquitto_pub -h localhost -t "tado/tanoclo/emulated/RU1234567890/telemetry" -m '{"temp_celsius":22.5,"humidity_percent":48.0,"battery_mv":3050}'
```

#### State Topic
Subscribing to `tado/tanoclo/emulated/<serial>/state` streams live telemetry state updates:

```json
{
  "serial": "RU1234567890",
  "temp_celsius": 22.5,
  "humidity_percent": 48.0,
  "battery_mv": 3050,
  "updated_at": "2026-08-14T09:00:00.000Z"
}
```

---

## 5. Device Unassociation & Removal

To remove an emulated device:
1. Click **Del** next to the device in the Admin Setup Portal.
2. The server sends an unassociation update (`d/config` containing `0x0158 == 0`) to the Internet Bridge.
3. The IB pushes unassociation over RF to the ESP32 node.
4. The ESP32 ACKs over RF, erases the device from NVRAM, and notifies the server to purge database records.
