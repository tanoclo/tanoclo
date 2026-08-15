# TaNoClo RF Sniffer Receiver Setup Guide

This guide details how to configure the **TaNoClo RF Sniffer Receiver** add-on, flash the ESP32 hardware using ESPHome, and integrate the sniffed telemetry into Home Assistant using MQTT Auto-Discovery.

---

## Architecture Overview

```
+--------------------------------------+      (RF Packets)      +-----------------------------+
| Tado Room Units / Valve Actuators    | . . . . . . . . . . .> |  ESP32 RF Sniffer Hardware  |
+--------------------------------------+                        +-----------------------------+
                                                                               |
                                                                               | (Raw TCP Stream on Port 9999)
                                                                               v
+-----------------------------------------------------------------------------------------------------+
| Home Assistant OS (Host)                                                                            |
|                                                                                                     |
|  +------------------------------+     +-------------------------------+     +--------------------+  |
|  |  ESPHome Add-on / Dashboard  |     |  Mosquitto Broker (MQTT Bus)  |     | MQTT Integration   |  |
|  |   (Device Firmware Builder)  |     |       (Discovery/States)      |     |  (Devices & Entity)|  |
|  +------------------------------+     +-------------------------------+     +--------------------+  |
|                                                      ^                                 ^            |
|                                                      | (Publishes Discovery & States)  |            |
|  +---------------------------------------------------+                                 |            |
|  | TaNoClo RF Sniffer Receiver Add-on (stream-receiver)                                |            |
|  |                                                                                     |            |
|  |  * Port 9999 (Listens to raw sniffer TCP connection)                                |            |
|  |  * Decrypts AES-128-CCM frames using configured keys                                |            |
|  |  * Generates Home Assistant Discovery configurations dynamically                    |            |
|  +-------------------------------------------------------------------------------------+            |
+-----------------------------------------------------------------------------------------------------+
```

---

## Setup Step-by-Step

### 1. Set Up ESPHome Dashboard
To compile and flash the firmware for your ESP32 RF Sniffer, you should use the ESPHome dashboard in Home Assistant.

1. Refer to the official [ESPHome Home Assistant Installation Guide](https://esphome.io/guides/getting_started_hassio/) to install and start the ESPHome add-on.
2. Open the ESPHome dashboard in your Home Assistant sidebar.
3. Setup the Wi-Fi secrets and an OTA password in ESPHome

---

### 2. Flash and Run Pairing Firmware
Before you can sniff and decrypt operational data, you must retrieve the active AES-128 RF network key of your Tado devices.

1. Ensure the ESP32 (e.g. TTGO LoRa32 V1.6) is connected to the device you are opening ESPHome Dashboard on.
2. Load/create a new device in ESPHome using the `tado_pairing.yaml` configuration from the repository.
3. Flash the `tado_pairing` firmware to your ESP32 sniffer board.
4. Open the web interface of the newly flashed device.
5. Enable pairing on the IB by long pressing the pairing button on the device.
6. Disconnect the ethernet cable of the internet bridge.
7. Wait for the IB MAC to be detected and shown.
8. Click "Retrieve RF key".
9. Wait for the RF key to be retrieved, if the key is not captured retry step 8.
10. Save the "Stored RF Key" to a secure location.
11. Disable pairing on the IB and reconnect the ethernet cable.

---

### 3. Flash and Run Sniffer Firmware
Once you have retrieved the key, configure the device to act as a raw RF sniffer.

1. Open the ESPHome dashboard.
2. Load the `tado_sniffer.yaml` configuration.
3. Flash the `tado_sniffer` firmware to the ESP32 sniffer board.
4. The ESP32 will connect to your local WiFi and open a TCP stream to transmit raw RF packets to the sniffer receiver server.

---

### 4. Configure MQTT Broker (Mosquitto)
The sniffer receiver uses MQTT to automatically register and update devices in Home Assistant.

1. Install the official **Mosquitto broker** add-on from the Add-on Store (if not already installed).
2. Go to **Settings** -> **Devices & Services** -> **Add Integration** -> select **MQTT** to configure the connection to the broker.
3. Make sure the MQTT integration is active.

---

### 5. Install and Configure TaNoClo RF Sniffer Receiver Add-on
Now you can install the sniffer receiver itself.

1. Go to **Settings** -> **Add-ons** -> **Add-on Store**.
2. Click the three dots in the top-right corner and select **Repositories**.
3. Add the URL of the Git repository: `https://github.com/tanoclo/tanoclo` (if not already added).
4. Reload the store list and find **TaNoClo RF Sniffer Receiver** under the repository category.
5. Click **Install**.
6. Go to the **Configuration** tab and configure options:
   * **TCP Port:** `9999` (Matches port configured in your sniffer ESP32 configuration)
   * **Tado Keys:** Add your operational keys here as comma-separated pairs, for example:
     `PAIRING=7461646f2070616972696e67206b6579,OPERATIONAL=your_sniffed_16byte_hex_key`
   * **MQTT Host:** `mqtt://core-mosquitto:1883`
   * **MQTT Topic:** `tado/sniffer` (Prefix for the raw state topics)
   * **MQTT HA Path:** `homeassistant` (Prefix for MQTT Discovery configs)
   * **File Logging:** `true` (Logs decrypted payloads to `/share/tanoclo/live_decrypted.log`, accessible via Samba Share or File Editor)
   * **Stats:** `true` (Enables periodic diagnostic logs and sensor metrics for the receiver itself)
   * **Auto Exclusion:** `true` (Automatically excludes PAN IDs that fail decryption with all configured keys to optimize processing)
7. Save settings and click **Start**.

---

### 6. Verify Discovery & Entities
Once started, the add-on will automatically:

1. Register the **TaNoClo RF Sniffer Receiver** device with diagnostic sensors (e.g. Total Packets, Bad CRC, Decryption Failures) in Home Assistant.
2. When the sniffer intercepts packets from Tado room devices:
   * It registers the Tado device (identified by its source MAC) in Home Assistant.
   * It dynamically adds entities like **Ambient Temperature**, **Humidity**, **Battery Voltage**, and **Heat Demand** as they are received.

Note that the **TaNoClo RF Sniffer Receiver** App is very much incomplete and currently not intended for production use.