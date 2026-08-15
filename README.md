# TaNoClo (TadoNoCloud): Self-Hosted Tado Backend

TaNoClo is a self-hosted replacement backend for the Tado smart heating ecosystem. It replicates the Tado Cloud backend APIs and WebSocket server, allowing you to run your Tado Internet Bridge, smart radiator valves (TRVs), and frontend applications completely locally, without internet access or cloud dependencies.

> [!TIP]
> Follow the [Quick-start Guide](QUICKSTART.md) for a complete step-by-step setup walkthrough.

---

## 📚 Documentation Index

The repository is organized into specialized components. Each has its own dedicated documentation guide:

| Component | Guide | Purpose / Scope |
| :--- | :--- | :--- |
| **Frontend/Backend Server** | [ws-server/README.md](ws-server/README.md) | Node.js backend architecture (uWebSockets.js gateway + Express REST API), database migrations, and setup portal. |
| **Modern React Frontend** | [frontend-new/README.md](frontend-new/README.md) | Vite + React web management interface, schedules, and Capacitor mobile app integration. |
| **Home Assistant OS App** | [tanoclo-ws-server/DOCS.md](tanoclo-ws-server/DOCS.md) | Configuration and integration guide for running TaNoClo as a Home Assistant OS app. |
| **Firmware Patcher** | [patch_ib_firmware/README.md](patch_ib_firmware/README.md) | OpenOCD scripts, memory stub, and tools for dumping, patching, and flashing the Internet Bridge. |
| **RF Sniffer** | [esphome/README.md](esphome/README.md) | ESPHome + SX1276 sniffer components and packet decryption helper scripts. |
| **Specifications Docs** | [docs/](docs/) | Reference specifications for Tado CoAP/TLV formats, FIDs, Pairing flow, RF protocol, and WebSocket frames. |

---

## 🏗️ Architecture Stack

TaNoClo replaces Tado's cloud infrastructure with a high-performance local stack:

* **WebSocket Gateway:** Built using **`uWebSockets.js`** (listening on port `988`). It handles high-concurrency binary WebSocket connections directly from patched Internet Bridges, decrypting the custom 28-byte bridge frames and routing encapsulated CoAP packets.
* **REST API Gateway:** An Express-based HTTP server (listening on port `3111`) that is automatically spawned as a child process by `server.js` using IPC. It replicates Tado's `api/v2/` REST endpoints, authorizing mobile apps via OAuth2 and executing commands on the connected devices.
* **Admin Portal:** A built-in web management interface (mounted under `/setup`) for home administration, user credentials, database seeding, and CoAP message decoding.
* **Database Layer:** A MariaDB database that persists measurements, device schedules, battery records, and system configurations.

Beside the TaNoClo application this repository also includes an ESPHome RF Sniffer project to analyze and decode the Tado wireless protocol.

* **RF Sniffer & Parser:** A hardware-based sniffer running ESPHome on an ESP32 with an SX1276 radio module. It passively captures FSK raw packets, reassembles 6LoWPAN fragments, and streams decrypted CoAP traffic to a Node.js-based TCP receiver and MQTT publisher.

---

## 📂 Repository Structure

```text
tanoclo/
├── docs/                     # Tado specifications and guides
│   ├── coap_tlv.md           # CoAP options and TLV payload formats reference
│   ├── fine_tuning.md        # Stepper limits, displays, and open window tuning
│   ├── list_of_fids.md       # Comprehensive list of Tado Field IDs (FIDs)
│   ├── pairing.md            # Detailed pairing handshake specification
│   ├── rf_protocol.md        # Physical layer and 6LoWPAN adaptation specs
│   └── websocket.md          # WebSocket frame definitions and state machine
├── patch_ib_firmware/        # Internet Bridge firmware patching utilities
│   ├── spi_stub.c            # SRAM Accessor Stub source code (SPI Flash interface)
│   ├── build_all_and_patch.sh # Builds stub code and patches dumped firmware
│   ├── check_firmware.sh     # Audits firmware structures
│   ├── clone_chain.sh        # Generates certificate chains
│   ├── clone_rootca.sh       # Generates custom Root CA certificates
│   ├── dump_external_flash.tcl # OpenOCD script for SPI flash dump
│   ├── dump_internal_flash.tcl # OpenOCD script for internal MCU flash dump
│   ├── dump_ru.tcl           # OpenOCD script for room unit dump
│   ├── dump_va.tcl           # OpenOCD script for valve actuator dump
│   ├── extract_channel.js    # Extracts configured RF channels
│   ├── extract_rf_key.js     # Extracts the Operational Key from dump
│   ├── extract_rootca.sh     # Decodes Root CA certificates
│   ├── flash.sh              # OpenOCD flash patched binaries script
│   ├── patch.sh              # Patcher orchestrator script
│   ├── patch_crc.sh          # Computes and updates firmware CRCs
│   ├── patch_endpoint.sh     # Modifies domain names inside firmware
│   ├── patch_rootca_validate.sh # Inserts cloned Root CA public keys
│   ├── program_external_flash.tcl # OpenOCD program external flash script
│   ├── program_internal_flash.tcl # OpenOCD program MCU flash script
│   ├── read.sh               # OpenOCD read firmware script
│   ├── README.md             # Patcher wiring and operating guide
│   ├── read_patch_flash.sh   # Master read-patch-flash automation script (Bash)
│   └── read_patch_flash.ps1  # Master read-patch-flash automation script (PowerShell)
├── esphome/                  # ESP32 RF Sniffer firmware & analyzer scripts
│   ├── tado_pairing/         # ESPHome component to trigger device pairing mode
│   │   ├── tado_pairing.yaml # ESPHome configuration file for pairing
│   │   └── components/       # Custom FSK transmitter module for pairing solicitation
│   ├── tado_sniffer/         # ESPHome sniffer component and host receiver files
│   │   ├── components/       # Custom C++ FSK sniffer & 6LoWPAN/CoAP reassembler
│   │   ├── lib/              # Local copies of standalone parsing modules (coap, tlv)
│   │   ├── config.json.example # Configuration example for MQTT/TCP settings
│   │   ├── sync_tlv_labels.js # Static TLV database label synchronization script
│   │   ├── stream_receiver.js # Standalone host receiver & MQTT publisher daemon
│   │   └── tlv_labels.json   # Synced TLV Tag labels cache
│   └── README.md             # Sniffer build, wiring, and operating guide
├── tanoclo-ws-server/        # Home Assistant OS App Configuration
│   ├── addon-entrypoint.js   # App process coordinator
│   ├── Dockerfile            # Container image builder for HA app
│   ├── DOCS.md               # Home Assistant deployment guide
│   ├── run.sh                # Main HA entry script
│   ├── build.yaml            # Build configuration
│   └── config.yaml           # Application settings
├── ws-server/                # Replicated WebSocket and REST API server
│   ├── api/                  # Express app and route handlers
│   │   ├── middleware/       # Express security and authentication middleware
│   │   ├── routes/           # REST API routes (users, devices, setup, sse, etc.)
│   │   │   ├── homes/        # Subdivided home management endpoints (base, heating, energy, etc.)
│   │   │   ├── setup/        # Setup portal sub-routers (homes, settings, system, portal)
│   │   │   │   └── portal/   # Portal sub-routers (auth, tools, dashboard)
│   │   │   └── zones/        # Subdivided schedule and zone state endpoints (base, owd, schedule, etc.)
│   │   ├── openapi.yaml      # OpenAPI 3.0 specification definition
│   │   └── server.js         # REST Express server and route definitions
│   ├── certs/                # Local TLS certificates directory
│   │   └── ip_certs.json.example # Example mappings for IP-specific certificates
│   ├── frontend-dist/        # Compiled web management React UI assets (git-tracked)
│   ├── lib/                  # Shared library modules (coap, tlv, db, config, etc.)
│   ├── migrations/           # Database migration files (migrations run on startup)
│   ├── package-lock.json     # Node.js lockfile
│   ├── package.json          # Node.js project manifest
│   ├── server.js             # Central server entry point (uWS port 988 / spawns Express)
│   └── README.md             # Server deployment and configuration guide
├── docker-compose.yml        # Orchestrates ws-server and MariaDB deployment
├── Dockerfile.node           # Ubuntu 24.04 glibc-compatible Node container image
├── nginx.conf                # NGINX configuration for routing and SSL termination
└── README.md                 # Project root guide (this file)
```

---

## 🔌 TaNoClo and RF Sniffer differences

The **TaNoClo self-hosted backend** and **ESPHome RF Sniffer** serve distinct purposes:

### 1. TaNoClo Self-Hosted Backend (`ws-server/`)
TaNoClo is a full replacement for the Tado Cloud backend and requires patching your Internet Bridge's firmware.
* **What you can do with it:**
  * Eliminate all dependencies on Tado cloud servers and the internet.
  * Run the mobile app, smart schedules, and device configuration wholly on local hardware.
  * Control radiator valves and zones directly via a local REST API and Admin web portal.
  * Maintain complete data privacy by keeping all telemetry and schedules in a local database.

### 2. RF Sniffer (`esphome/`)
The RF Sniffer is a passive monitoring tool. It allows you to intercept, decrypt, and inspect the real-time RF communication between your Tado Internet Bridge (IB) and the radiator valves (TRVs) or thermostats.
* **What you can do with it:**
  * Read and log sensor telemetry (temperature, humidity, heating demand, battery reports) as it travels over the air.
  * Push raw and decoded CoAP events to a third-party smart home system (like Home Assistant) via MQTT topics.
  * The sniffer **does not modify Tado Cloud operations**. Your devices continue to communicate with the official Tado servers, and your mobile app works normally via the cloud. It is a non-invasive monitoring tool.
  * The sniffer does not require patching/modification of the Internet Bridge or any other Tado device.

### 🚀 Summary of Differences

| Feature / Capability | Tado RF Sniffer (Passive) | TaNoClo Backend (Active) |
| :--- | :---: | :---: |
| **Cloud Independence** | No (Devices still require Tado Cloud) | **Yes (100% Offline/Local)** |
| **Requires Hardware Mods** | No (Uses external ESP32 sniffer board) | **Yes (Must flash Internet Bridge)** |
| **Allows Device Control** | No (Passive monitoring only) | **Yes (Full API control and overlays)** |
| **Web and Mobile App Support** | No | **Yes** |
| **MQTT Integration** | **Partial (Pushes states to MQTT)** | **Yes, with full Home Assistant discovery support** |
| **Setup Complexity** | Low (Flash ESP32, run receiver script) | High (OpenOCD SWD debug flashing, DNS setup) |

---

## 🚀 Getting Started

Deploying TaNoClo requires a three-step process: patching the Internet Bridge, setting up local DNS routing, and running the backend server. The self-hosted TaNoClo Smart Climate Portal is built from source and hosted directly by the server.

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

---

## 🔌 Integration & Usage Types

TaNoClo can be utilized in several ways depending on your smart home setup:

### 1. Native Home Assistant App
A complete Home Assistant OS app is available in the `tanoclo-ws-server/` directory. It packages the uWebSockets.js gateway and the Express REST engine into a single container that runs locally alongside official HA add-ons (like MariaDB and Mosquitto), terminating TLS natively using your local certificate store. Read [tanoclo-ws-server/DOCS.md](tanoclo-ws-server/DOCS.md) for step-by-step setup guides.

### 2. Home Assistant via MQTT
TaNoClo includes an integrated MQTT client that automatically registers devices with Home Assistant via **MQTT Discovery** (using the `homeassistant/` configuration prefix). Once enabled, the following entities are exposed:
- **Climate Entities**: Dual control for standard heating zones and hot water zones (`water_heater`).
- **Detailed Sensors**: Room temperatures, humidity, current heating power %, battery levels, real battery voltage (`battery_mv`), reset reasons, error flags, valve positions/steps, and OpenTherm voltage levels (for RUs).
- **Boiler/Circuit Telemetry**: Modulation %, flow/return/exhaust temperatures, CH/DHW pump starts, CH/DHW burner hours, and water pressure.
- **Binary Sensors**: System presence, zone overlays, early start status, open windows, battery warnings, and boiler/actuator activity.
- **Switches & Controls**: Child lock toggle, proxy mode toggles, offline schedule enable switches, and select controls for Home/Away presence.
- **Interactive Entities**: Number selectors for actuator travel limits, buttons to trigger immediate offline schedule sync, or manual calibration runs.
- **Geofencing trackers**: Maps registered mobile devices to GPS `device_tracker` entities, exposing location, distance, bearing, and last seen timestamps.
 
### 3. Recreated Smart Climate Portal (frontend-new)
The repository features a modern, clean-room React web management interface located in `frontend-new/`. Built with Vite and Tailwind/CSS:
- **Climate Controls**: Dynamic climate cards that change colors and gradients using HSL linear interpolation based on target temperature ranges.
- **Boiler Settings**: Search and select boiler manufacturers and models dynamically via internal GraphQL stubs and toggle underfloor heating parameters.
- **Schedules**: A complete editor to configure smart heating/cooling schedules.
- **Capacitor Mobile App**: Bundled with Capacitor to build native Android/iOS apps.
- **PWA Support**: Installable directly onto mobile home screens as a Progressive Web App.

### 4. Legacy Tado REST API Parity
TaNoClo maintains backward compatibility with legacy client libraries:
- **Tado V2 REST Parity**: Emulates Tado's official `api/v2` endpoints. Existing tools (like the Python `pytado` library or Node-RED nodes) can interface locally simply by pointing their base URLs to your TaNoClo instance (e.g. `https://{subdomain}.tanoclo.yourdomain.com`).
- **OAuth2 compatibility**: Supports Password and Device Code Authorization flows.

---

## 🔮 Future Directions & Help Needed

TaNoClo is an ongoing active project. Contribution and testing are highly appreciated in the following areas:

* **Testing and Ecosystem Coverage**: Verification of TaNoClo with the entire Tado V2, V3, and V3(+) hardware ecosystem (various TRV revisions, Extension Kits, Smart Thermostats).
* **Testing Device Commissioning**: Testing device pairing (`POST d/pair`), unpairing, adding, and removing procedures via the local portal and database.
* **Testing Changing Zone Topologies**: Testing functionality to dynamically move or bind devices to new or existing zones without cloud sync dependencies.
* **Complete Internet Bridge Emulation**: Working towards a pure hardware/software emulator for the Internet Bridge (e.g. ESP32-based RF to MQTT bridge) to eliminate the need for patching the physical IB firmware.
* **Setup Portal Completion**: Implementing administrative pages for all (documented and undocumented) Tado endpoints and functions.
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