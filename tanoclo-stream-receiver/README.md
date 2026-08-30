<p align="center">
  <img src="https://raw.githubusercontent.com/tanoclo/tanoclo/main/tanoclo-stream-receiver/logo.png" alt="TaNoClo RF Sniffer Receiver Logo" width="250">
</p>

# Home Assistant App: TaNoClo RF Sniffer Receiver

![Version](https://img.shields.io/badge/version-v0.2.7-blue.svg)
![Supports aarch64 Architecture](https://img.shields.io/badge/aarch64-yes-green.svg)
![Supports amd64 Architecture](https://img.shields.io/badge/amd64-yes-green.svg)

## Intro

**TaNoClo RF Sniffer Receiver** is a dedicated Home Assistant add-on that ingests raw 868MHz wireless RF packet streams from ESP32 sniffer hardware (flashed via ESPHome), decrypts AES-128-CCM encrypted payloads using retrieved RF network keys, and publishes live device status directly into Mosquitto MQTT using Home Assistant Auto-Discovery.

## Key Features

- **Raw Stream Ingestion**: TCP listener on port 9999 for ESP32 sniffer boards running `tado_sniffer.yaml` ESPHome firmware.
- **On-the-Fly AES Decryption**: Decrypts 868MHz wireless frames using RF network operational keys.
- **Home Assistant Auto-Discovery**: Automatically creates climate entities, temperature/humidity sensors, battery states, and diagnostic metrics in HA.
- **Configurable Logging**: Live decrypted packet stream dumps to `/share/tanoclo/live_decrypted.log` for debugging (accessible via Samba / File Editor).

## Quick Start & Setup

For full installation instructions, ESP32 flashing steps, key retrieval, and MQTT configuration, see the [DOCS.md](DOCS.md) file.

## Support & Issues

If you encounter bugs or have feature requests, please submit an issue on the [TaNoClo GitHub Repository](https://github.com/tanoclo/tanoclo).
