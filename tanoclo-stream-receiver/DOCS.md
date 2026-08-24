# TaNoClo RF Sniffer Receiver Setup Guide

This guide details how to configure the **TaNoClo RF Sniffer Receiver** app, flash ESP32 sniffer hardware via ESPHome, and ingest live RF telemetry into Home Assistant using passive MQTT Auto-Discovery.

---

## Architecture Overview

```
+--------------------------------------+      (868MHz RF)       +-----------------------------+
| Tado Radiator Valves / Thermostats   | . . . . . . . . . . .> |  ESP32 RF Sniffer Hardware  |
+--------------------------------------+                        +-----------------------------+
                                                                               |
                                                                               | (Raw TCP Stream on Port 9999)
                                                                               v
+-----------------------------------------------------------------------------------------------------+
| Home Assistant OS (Host)                                                                            |
|                                                                                                     |
|  +------------------------------+     +-------------------------------+     +--------------------+  |
|  |  ESPHome App / Dashboard     |     |  Mosquitto Broker (MQTT Bus)  |     | MQTT Integration   |  |
|  |   (Device Firmware Builder)  |     |       (Discovery/States)      |     |  (Devices & Entity)|  |
|  +------------------------------+     +-------------------------------+     +--------------------+  |
|                                                      ^                                 ^            |
|                                                      | (Publishes Discovery & States)  |            |
|  +---------------------------------------------------+                                 |            |
|  | TaNoClo RF Sniffer Receiver App (stream-receiver)                                   |            |
|  |                                                                                     |            |
|  |  * Port 9999 (Ingests raw IEEE 802.15.4 frame stream)                               |            |
|  |  * AES-128-CCM Multi-Key Decryption (Pairing & Operational Keys)                    |            |
|  |  * 6LoWPAN Multi-Fragment Reassembly (FRAG1 / FRAGN datagrams)                       |            |
|  |  * Full CoAP RFC 7252 Parser & TLV Bitfield Decoder                                |            |
|  |  * 100% Read-Only Home Assistant Auto-Discovery in Segregated Namespace             |            |
|  +-------------------------------------------------------------------------------------+            |
+-----------------------------------------------------------------------------------------------------+
```

---

## Passive Sniffing & Namespace Segregation

To ensure that passive RF sniffing never disrupts your physical devices or conflicts with devices managed by your primary websocket server:

1. **Strictly Read-Only (Passive)**:
   - The sniffer exposes **no writable command entities** (`switch`, `number`, `button`, `select`).
   - Device configurations (child lock, display orientation, actuator drive limits) are published purely as diagnostic `sensor` or `binary_sensor` entities.
2. **Segregated Namespace**:
   - **MQTT State Topics**: `tado/sniffer/d/{serial}/...` (or fallback `tado/sniffer/m/{cleanMac}/...`).
   - **HA Device ID**: `tanoclo_sniffer_dev_{serial}` (named `Sniffed {deviceType} ({serial})` with `via_device: tanoclo_sniffer_receiver`).
   - **HA Entity IDs**: `tanoclo_sniffer_{serial}_{sensorKey}`.

---

## Setup Step-by-Step

### 1. Set Up ESPHome Dashboard
To compile and flash the firmware for your ESP32 RF Sniffer, use the ESPHome dashboard in Home Assistant.

1. Refer to the official [ESPHome Home Assistant Installation Guide](https://esphome.io/guides/getting_started_hassio/) to install and start the ESPHome app.
2. Open the ESPHome dashboard in your Home Assistant sidebar.
3. Configure Wi-Fi credentials and OTA passwords in ESPHome.

---

### 2. Flash and Run Pairing Firmware
Before you can sniff and decrypt operational data, you must retrieve the active AES-128 RF network key of your Tado installation.

1. Ensure the ESP32 (e.g. TTGO LoRa32 V1.6 with CC1101/SX1276 radio) is connected to your computer.
2. Create a new device in ESPHome using the `tado_pairing.yaml` configuration from the repository.
3. Flash the `tado_pairing` firmware to your ESP32 board.
4. Open the web interface of the newly flashed device.
5. Put your Internet Bridge (IB) into pairing mode by holding the pairing button until the pairing LED blinks.
6. Disconnect the Ethernet cable from the Internet Bridge.
7. Wait for the bridge MAC address to appear on the ESP32 web interface.
8. Click **Retrieve RF Key**.
9. Wait for the operational RF key to be captured. (If not captured within 30 seconds, click **Retrieve RF Key** again).
10. Copy and save the 16-byte hex key (`Stored RF Key`) to a secure place.
11. Exit pairing mode on the bridge and reconnect its Ethernet cable.

---

### 3. Flash and Run Sniffer Firmware
Once you have the operational key, configure the ESP32 to act as a raw RF sniffer.

1. In ESPHome dashboard, load the `tado_sniffer.yaml` configuration.
2. Verify the target IP and port (`9999`) point to the host running the **TaNoClo RF Sniffer Receiver**.
3. Flash the firmware to your ESP32 sniffer board.
4. The ESP32 will connect to Wi-Fi and open a TCP stream to transmit raw IEEE 802.15.4 RF frames to the receiver server.

---

### 4. Configure MQTT Broker (Mosquitto)
The sniffer receiver uses MQTT to automatically register and update devices in Home Assistant.

1. Install the official **Mosquitto broker** app from the App Store (if not already installed).
2. Go to **Settings** -> **Devices & Services** -> **Add Integration** -> select **MQTT** to configure the connection to the broker.
3. Make sure the MQTT integration is active.

---

### 5. Install and Configure TaNoClo RF Sniffer Receiver App
Install and configure the receiver daemon:

1. Go to **Settings** -> **Apps** -> **App Store**.
2. Click the three dots in the top-right corner and select **Repositories**.
3. Add the URL of the Git repository: `https://github.com/tanoclo/tanoclo` (if not already added).
4. Reload the store list and select **TaNoClo RF Sniffer Receiver**.
5. Click **Install**.
6. Go to the **Configuration** tab and configure options:
   * **TCP Port:** `9999` (Port matching the ESP32 sniffer firmware)
   * **Tado Keys:** Comma-separated key pairs. Always include the static pairing key and your captured operational key:
     `PAIRING=7461646f2070616972696e67206b6579,OPERATIONAL=YOUR_16BYTE_OPERATIONAL_HEX_KEY`
   * **MQTT Host:** `mqtt://core-mosquitto:1883`
   * **MQTT Topic:** `tado/sniffer` (Base topic for discrete states)
   * **MQTT HA Path:** `homeassistant` (Base prefix for Home Assistant Auto-Discovery)
   * **File Logging:** `true` (Logs live decrypted packets to `/share/tanoclo/live_decrypted.log`)
   * **Max Log Size (MB):** `5` (Maximum log size before automatic rotation)
   * **Max Rotated Logs:** `1` (Number of rotated log backups to retain)
   * **Stats:** `true` (Enables diagnostic metrics and 60-second throughput summaries)
   * **Auto Exclusion:** `true` (Automatically excludes PAN IDs that fail decryption across all keys)
7. Save settings and click **Start**.

---

### 6. Verify Discovery & Sniffed Entities

Once running, the sniffer automatically performs:

1. **Receiver Node Discovery**:
   - Publishes the `tanoclo_sniffer_receiver` diagnostic device with packet counters (Total Received, Bad CRC, Decryption Failures, Decoded CoAP, Active PANs).
2. **Device Discovery & Telemetry**:
   - As soon as encrypted 802.15.4 frames arrive, the engine decrypts them, reassembles multi-fragment 6LoWPAN payloads, and binds MAC addresses to device serial numbers (`VA...`, `RU...`, `IB...`).
   - Automatically registers Home Assistant read-only sensors:
     - **Environmental**: Temperature (°C), Humidity (%), Light Level, Aux Temperature.
     - **Battery & Diagnostics**: Battery Voltage (V), Battery Level (%), Battery Low warning, RSSI (dBm), Reset Reason (POR/PDR, PIN, IWDG), Error Flags.
     - **Radiator Actuators (VA)**: Valve Position (%), Raw Steps, Actuator Active, Mounting State, Child Lock, Display Orientation, Drive Limits.
     - **Boiler & HVAC (RU/IB)**: Flow/Return Temperature, Water Pressure (bar), DHW Target/Measured Temperature, Boiler Active, Outside Temperature.