# TaNoClo Tado Device Emulator (ESPHome)

Firmware component for ESP32 with Semtech SX1276/SX1278 transceiver (such as TTGO LoRa32 V1.6.1) to emulate multiple Tado devices (e.g. Room Units `RU...`) simultaneously over 868.3 MHz FSK.

---

## Configuration (`tado_emulator.yaml`)

```yaml
tado_emulator:
  id: tado_rf_emulator
  cs_pin: 18
  rst_pin: 23
  dio0_pin: 26
  channel: 26
  server_url: "http://192.168.0.10:3111"
  auto_mac_ack: true
  api_key: "your_secret_api_key" # Optional API key securing inbound HTTP endpoints
  fast_fifo_drain: true
```

---

## HTTP REST & API Key Authentication

The emulator runs a local HTTP REST endpoint on port 80 (or configured `web_server` port) to receive commands from `ws-server` and report status.

### Endpoints
* `GET /api/status`: Returns current node status and emulated devices.
* `POST /api/cmd`: Dispatches commands to the emulator (`pair`, `unpair`, `telemetry`, `sync_devices`, `channel`, etc.).

### API Key Security
* If `api_key` in `tado_emulator.yaml` is left empty (`""`), authentication is disabled. Any client on the local network can query status and send commands.
* If `api_key` is set, every incoming request must include the key via either:
  * **HTTP Header:** `X-ESP-API-Key: <api_key>`
  * **Query Parameter:** `?key=<api_key>` or `?api_key=<api_key>`
* Requests with missing or incorrect keys receive `401 Unauthorized` with JSON `{"error": "Unauthorized"}`.
* The API key configured here must match the key entered when registering or editing the hardware node in the TaNoClo Setup Portal (`https://setup.{domain}/`).

---

## Hardware Pinout (TTGO LoRa32 V1.6.1)

| SX1276 Pin | ESP32 GPIO | Role | Configuration in YAML |
| :--- | :--- | :--- | :--- |
| **SCK** | GPIO 5 | SPI Clock | `spi.clk_pin: 5` |
| **MISO** | GPIO 19 | SPI Master-In Slave-Out | `spi.miso_pin: 19` |
| **MOSI** | GPIO 27 | SPI Master-Out Slave-In | `spi.mosi_pin: 27` |
| **NSS / CS** | GPIO 18 | SPI Chip Select | `tado_emulator.cs_pin: 18` |
| **DIO0** | GPIO 26 | TX/RX Done Interrupt | `tado_emulator.dio0_pin: 26` |
| **RST** | GPIO 23 (or 14) | Transceiver Reset | `tado_emulator.rst_pin: 23` |

---

## Home Assistant Integration & Automation

When Home Assistant MQTT Auto-Discovery is active in TaNoClo, each emulated Room Unit exposes dynamic control entities:

| Entity Name | Domain | Description |
|---|---|---|
| `Emulated Device` | `binary_sensor` | Returns `ON` for emulated devices. |
| `Emulated Temperature` | `number` | Slider (5.0°C – 30.0°C) to set ambient temperature. |
| `Emulated Humidity` | `number` | Slider (10% – 95%) to set ambient relative humidity. |
| `Send Telemetry Push` | `button` | Triggers immediate RF `PUT /d/{serial}/sen` push. |

### Home Assistant Automation: External Sensor Sync

You can feed telemetry from any existing room sensor (Zigbee, BLE, Z-Wave, ESPHome, or other Tado devices) directly into an emulated Room Unit.

Whenever the source sensor changes, the automation updates the emulated device's temperature and humidity sliders and triggers an immediate RF telemetry transmission to the Internet Bridge:

```yaml
alias: "Tado Emulated: Sync External Sensor to Emulated RU"
description: "Sync temperature and humidity from an external room sensor to an emulated Tado Room Unit"
triggers:
  - trigger: state
    entity_id:
      - sensor.living_room_temperature
      - sensor.living_room_humidity
    not_to:
      - unavailable
      - unknown
conditions:
  - condition: template
    value_template: >-
      {{ states('sensor.living_room_temperature') not in ['unavailable', 'unknown'] and
         states('sensor.living_room_humidity') not in ['unavailable', 'unknown'] }}
actions:
  - action: number.set_value
    target:
      entity_id: number.emulated_ru02_ru0000000000_emulated_temperature
    data:
      value: "{{ states('sensor.living_room_temperature') }}"
  - action: number.set_value
    target:
      entity_id: number.emulated_ru02_ru0000000000_emulated_humidity
    data:
      value: "{{ states('sensor.living_room_humidity') }}"
  - action: button.press
    target:
      entity_id: button.emulated_ru02_ru0000000000_send_telemetry_push
    data: {}
mode: restart
max_exceeded: silent
```

> [!TIP]
> - Replace `sensor.living_room_temperature` and `sensor.living_room_humidity` with your actual room sensor entities (any device type supported by Home Assistant).
> - Replace `number.emulated_ru02_ru0000000000_emulated_temperature`, `number.emulated_ru02_ru0000000000_emulated_humidity`, and `button.emulated_ru02_ru0000000000_send_telemetry_push` with your emulated device's entity IDs.

For complete architectural details, REST endpoints, and protocol specifications, see [docs/emulated_devices.md](../../docs/emulated_devices.md).

