<p align="center">
  <img src="https://raw.githubusercontent.com/tanoclo/tanoclo/main/tanoclo-ws-server/logo.png" alt="TaNoClo WebSocket Server Logo" width="250">
</p>

# Home Assistant Add-on: TaNoClo WebSocket Server

![Version](https://img.shields.io/badge/version-v0.2.4-blue.svg)
![Supports aarch64 Architecture](https://img.shields.io/badge/aarch64-yes-green.svg)
![Supports amd64 Architecture](https://img.shields.io/badge/amd64-yes-green.svg)

## Intro

**TaNoClo WebSocket Server** is a self-hosted replacement for the Tado Cloud API and Internet Bridge backend server. It allows your modified Tado Internet Bridge devices to connect directly to your local Home Assistant instance over encrypted WebSockets (port 988), storing device state in MariaDB and publishing live status and controls to Mosquitto MQTT.

## Key Features

- **Local Cloud Emulation**: Full native replacement of Tado Internet Bridge WebSocket binary framing protocol (TLV over WSS).
- **REST & Admin API**: Local web management interface and HTTP API endpoints on port 3111.
- **MariaDB Integration**: Direct, high-performance database storage for room configurations, device telemetry, and pairing keys.
- **MQTT Support**: Automatic discovery and state publishing for seamless Home Assistant dashboard control.
- **TLS Termination**: Native TLS handshake support using patched Internet Bridge Root CA certificates.

## Quick Start & Setup

For full installation instructions, database configuration, certificate setup, and DNS rewrites, see the [DOCS.md](DOCS.md) file.

## Support & Issues

If you encounter bugs or have feature requests, please submit an issue on the [TaNoClo GitHub Repository](https://github.com/tanoclo/tanoclo).
