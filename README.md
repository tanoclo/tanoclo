# TaNoClo (TadoNoCloud): Self-Hosted Tado Backend

TaNoClo is a self-hosted replacement backend for the Tado smart heating ecosystem. It replicates the Tado Cloud backend APIs and WebSocket server, allowing you to run your Tado Internet Bridge, smart radiator valves (TRVs), and frontend applications completely locally, without internet access or cloud dependencies.

> [!TIP]
> Follow the [Quick-start Guide](QUICKSTART.md) for a complete step-by-step setup walkthrough.

---

## 📚 Documentation Index

The repository is organized into specialized components. Each has its own dedicated documentation guide:

| Component | Guide | Purpose / Scope |
| :--- | :--- | :--- |
| **WebSocket & REST API Server** | [ws-server/README.md](ws-server/README.md) | Node.js backend architecture and setup portal. |
| **Modern React Frontend** | [frontend-new/README.md](frontend-new/README.md) | Vite + React web management interface, schedules, and Capacitor mobile app integration. |
| **Home Assistant Server App** | [tanoclo-ws-server/DOCS.md](tanoclo-ws-server/DOCS.md) | Configuration and deployment guide for the TaNoClo WebSocket Server as a Home Assistant OS app. |
| **Home Assistant RF Sniffer App** | [tanoclo-stream-receiver/DOCS.md](tanoclo-stream-receiver/DOCS.md) | Home Assistant companion app receiving live RF sniffer packet streams and publishing sensor telemetry to MQTT. |
| **Firmware Patcher** | [patch_ib_firmware/README.md](patch_ib_firmware/README.md) | OpenOCD scripts, memory stub, and automated tools for dumping, patching, and flashing the Internet Bridge. |
| **ESPHome Firmware Suite** | [esphome/README.md](esphome/README.md) | ESP32 + SX1276 firmware projects: passive RF sniffer, network key retrieval, and multi-device Tado emulator. |
| **Specifications & Reference** | [docs/](docs/) | Technical specifications for CoAP/TLV formats, device calibration, pairing flows, RF physical layer, and WebSocket framing. |

---

## 🏗️ Architecture Stack

TaNoClo replaces Tado's cloud infrastructure with a high-performance local stack:

* **WebSocket Gateway:** It handles binary WebSocket connections directly from patched Internet Bridges, decrypting bridge frames and routing encapsulated CoAP packets.
* **REST API Gateway:** An HTTP server that is automatically spawned. It exposes Tado compatible REST endpoints, authorizing mobile apps via OAuth2 and executing commands on connected devices.
* **Admin & Setup Portal:** A built-in web management interface for home administration, user credentials, database seeding, ESP32 emulator management, and real-time CoAP message decoding.
* **Database Layer:** A MariaDB database persisting measurements, device schedules, battery records, and system configurations.
* **RF Sniffing & Emulation Suite:**
  * **RF Sniffer & Receiver:** An ESP32 + SX1276 module running ESPHome captures over-the-air 868 MHz FSK packets, reassembles 6LoWPAN frames, and streams decrypted CoAP traffic to the Home Assistant Stream Receiver app or standalone MQTT publisher.
  * **Multi-Device Hardware Emulator:** Emulates physical Tado Room Units (`RU`) over sub-GHz RF on TTGO LoRa32 hardware, supporting automated pairing, dynamic telemetry injection (temperature, humidity, battery), and full Home Assistant MQTT discovery.

---

## 📂 Repository Structure

```text
tanoclo/
├── docs/                     # Technical specifications and guides
│   ├── coap_tlv.md           # CoAP options and TLV payload formats reference
│   ├── emulated_devices.md   # Room Unit (RU) virtual emulation architecture & REST RPC
│   ├── fine_tuning.md        # Stepper limits, displays, and open window tuning
│   ├── pairing.md            # Detailed pairing handshake specification
│   ├── rf_protocol.md        # Physical layer and 6LoWPAN adaptation specs
│   └── websocket.md          # WebSocket frame definitions and state machine
├── esphome/                  # ESP32 firmwares
│   ├── tado_pairing/         # ESPHome component to sniff network RF key
│   ├── tado_sniffer/         # ESPHome RF sniffer component
│   ├── tado_emulator/        # ESPHome based Tado Room Unit emulator component
│   └── README.md             # ESPHome firmware build, wiring, and operating guide
├── frontend-new/             # Modern React web management UI & Capacitor mobile app
│   └── README.md             # Web and mobile frontend development guide
├── patch_ib_firmware/        # Internet Bridge firmware patching utilities
│   ├── README.md             # Patcher wiring and operating guide
│   ├── read_patch_flash.sh   # Master read-patch-flash automation script (Linux/Bash)
│   └── read_patch_flash.ps1  # Master read-patch-flash automation script (Windows/PowerShell)
├── tanoclo-stream-receiver/  # Home Assistant RF Sniffer App
│   ├── DOCS.md               # Home Assistant deployment guide
│   └── README.md             # App configuration and MQTT receiver guide
├── tanoclo-ws-server/        # Home Assistant WebSocket Server App
│   ├── DOCS.md               # Home Assistant deployment guide
│   └── README.md             # App configuration guide
├── ws-server/                # WebSocket and REST API server
│   └── README.md             # Server deployment and configuration guide
└── README.md                 # Project root guide (this file)
```

---

## 🚀 Getting Started

Deploying TaNoClo requires a three-step process: patching the Internet Bridge, setting up local DNS routing, and running the backend server. The self-hosted TaNoClo frontend is served as part of the backend server.

### Step 1: Patch the Internet Bridge
To allow the Internet Bridge to trust your self-hosted server, it must be flashed with a patched firmware containing your cloned Root CA:
1. Connect an ST-Link v2 to the SWD pins of the Internet Bridge. This can be done solderlessly by using a clip-on adapter board. See the README in [patch_ib_firmware/README.md](patch_ib_firmware/README.md) for more details.
2. In the `patch_ib_firmware/` directory, run `./read_patch_flash.sh`.
3. This dumps the original firmware, extracts the Root CA, generates a custom Root CA and matching server certificates in `patch_ib_firmware/out/`, patches the firmware binary, and flashes it back to the device.

### Step 2: Deploy the Backend Server
The server runs in a containerized Docker environment:
1. Create the `certs/` directory inside `ws-server/` and copy the generated credentials:
   ```bash
   mkdir -p ws-server/certs
   cp patch_ib_firmware/original/tadoRootCA.cer ws-server/certs/
   cp patch_ib_firmware/out/tanoclo_key.pem ws-server/certs/
   cp patch_ib_firmware/out/tanoclo_cert.pem ws-server/certs/
   ```
2. Edit `docker-compose.yml` to set your desired database credentials and JWT secret.
3. Bring up the containers:
   ```bash
   docker-compose up -d --build
   ```
This deploys the NGINX server, Express REST API, the uWebSockets.js gateway, and a MariaDB database instance. You will also need to procure a valid SSL certificate for your chosen (wildcard) domain name if routing via NGINX.

### Step 3: Configure Local DNS Redirection
Configure your local DNS server (e.g. AdGuard Home, Pi-hole, or dnsmasq) to resolve the WebSocket endpoint domain (typically `tanoclo.tado.lan` configured during firmware patching) to point to the tanoclo-ws host, and your chosen wildcard domain (`*.tanoclo.yourdomain.com`) to the IP address of your Docker host running NGINX.

See [tanoclo-ws-server/DOCS.md](tanoclo-ws-server/DOCS.md) for a step-by-step setup guide and [ws-server/README.md](ws-server/README.md) for detailed information about the backend server and Setup Portal.

### Native Home Assistant App
A complete Home Assistant OS app is available in the `tanoclo-ws-server/` directory. It packages the uWebSockets.js gateway and the Express REST engine into a single container that runs locally alongside official HA add-ons (like MariaDB and Mosquitto), terminating TLS natively using your local certificate store. Read [tanoclo-ws-server/DOCS.md](tanoclo-ws-server/DOCS.md) for a step-by-step setup guide.

## 🔌 Integration & Usage Types

TaNoClo can be used in several ways depending on your preferences:

### 1. Home Assistant via MQTT
TaNoClo includes an integrated MQTT client that automatically registers devices with Home Assistant via **MQTT Discovery**. Once enabled, the following entities are exposed:
- **Climate Entities**: Dual control for standard heating zones and hot water zones (`water_heater`).
- **Detailed Sensors**: Room temperatures, humidity, current heating power %, battery levels, real battery voltage (`battery_mv`), reset reasons, error flags, valve positions/steps, and OpenTherm voltage levels (for RUs).
- **Boiler/Circuit Telemetry**: Modulation %, flow/return/exhaust temperatures, CH/DHW pump starts, CH/DHW burner hours, and water pressure.
- **Binary Sensors**: System presence, zone overlays, early start status, open windows, battery warnings, and boiler/actuator activity.
- **Switches & Controls**: Child lock toggle, proxy mode toggles, offline schedule enable switches, and select controls for Home/Away presence.
- **Interactive Entities**: Number selectors for actuator travel limits, buttons to trigger immediate offline schedule sync, or manual calibration runs.
- **Geofencing trackers**: Maps registered mobile devices to `device_tracker` entities.
 
### 2. Smart Climate Portal (frontend-new)
The repository features a modern, clean-room React web management interface located in `frontend-new/`. Built with Vite and Tailwind/CSS:
- **Climate Controls**: Dynamic climate cards.
- **Schedules**: A complete editor to configure smart heating/cooling schedules.
- **Capacitor Mobile App**: Bundled with Capacitor to build native Android/iOS apps.
- **PWA Support**: Installable directly onto mobile home screens as a Progressive Web App.

### 3. Tado REST API Parity
TaNoClo maintains backward compatibility with Tado API client libraries:
- **Tado V2 REST Parity**: Parity with Tado's official `api/v2` endpoints. Existing tools (like the Python `pytado` library or Node-RED nodes) can interface locally simply by pointing their base URLs to your TaNoClo instance (e.g. `https://{subdomain}.tanoclo.yourdomain.com`).
- **OAuth2 compatibility**: Supports Password and Device Code Authorization flows.

---

## 🔮 Future Directions & Help Needed

TaNoClo is an ongoing active project. Contribution and testing are highly appreciated in the following areas:

* **Testing and Ecosystem Coverage**: Verification of TaNoClo with the entire Tado V2, V3, and V3(+) hardware ecosystem (various TRV revisions, Extension Kits, Smart Thermostats).
* **Testing Device Commissioning**: Testing device pairing, unpairing, adding, and removing procedures via the local portal and database.
* **Complete Internet Bridge Emulation**: Working towards a pure hardware/software emulator for the Internet Bridge (e.g. ESP32-based RF to MQTT bridge) to eliminate the need for patching the physical IB firmware.
* **App Distribution**: Package and deploy the patched mobile apps into the Google Play Store and Apple Store.
* **Translation Audit**: Human verification and refinement of multi-lingual translations.
* **Documentation**: Maintain documentation to a level that is understandable for the average user.

---

## ☕ Support the Project

If you find TaNoClo useful, consider donating:

* **Bitcoin (BTC):** `bc1qvcgn5fvfqq5v75ya53v08sussfvepqxz6f6r3p`

---

## ⚠️ Disclaimer

This project is an independent, community-driven recreation and is not affiliated with, authorized, sponsored, or endorsed by Tado GmbH. Tado is a registered trademark of Tado GmbH. Modifying the firmware of your Internet Bridge may void device warranties.

**Product Liability & Safety Warning**: This software controls physical heating and boiler equipment. Faulty configurations or software bugs could result in property damage, freezing, or overheating. Use this software entirely at your own risk. The authors and contributors provide this software "as is" without warranties of any kind.

## AI Usage Disclaimer

This project was **HEAVILY** AI assisted, with most of the code generated by AI. The project has had many AI-performed audits and re-audits and partial human-performed code reviews. If that is not your cup of tea either help improve the project by opening issues and pull requests, improving documentation, doing manual code review or just take whatever is useful to you, fork the project and/or do whatever you want with it where allowed by the license.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.