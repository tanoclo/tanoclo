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
