# TaNoClo (TadoNoCloud) Quick-start Guide

This guide details the step-by-step process to set up a fully self-hosted, offline Tado climate control environment using **TaNoClo**. This guide is written for **Home Assistant OS (HAOS)** users.

---

## 1. Requirements & Prerequisites

### Hardware Requirements
* **Server/Host:** A machine capable of running Home Assistant OS or Docker (e.g., Raspberry Pi 4/5, Intel NUC, or mini PC). Both ARM64 and AMD64 architectures are supported.
* **ST-Link V2 Debugger:** Standard programmer/emulator to read and flash the Internet Bridge firmware. Example option:
  * [Amazon.de — AZDelivery ST-Link V2](https://www.amazon.de/-/en/AZDelivery-V2-Debugger-Programmer-Emulator/dp/B086TWZNMM)
* **10-Pin Clip-on Pogo Programmer:** Allows connection to the test points on the PCB without soldering. Example options:
  * [AliExpress Option 1](https://de.aliexpress.com/item/1005007887384238.html)
  * [AliExpress Option 2](https://de.aliexpress.com/item/1005006609750088.html)
  * **CRITICAL:** You must select the **5 Pin / 5P, Double Row, 1.27mm spacing** version when ordering.
* **Opening/Pry Tools:** A small plastic spudger or guitar pick to open the Internet Bridge casing.

### Software Requirements
* **Home Assistant OS (HAOS)** or standard Linux OS.
* **Local DNS Server:** AdGuard Home or Pi-Hole (both available as official Home Assistant Apps).
* **MQTT Broker:** Mosquitto Broker (available as an HA App).
* **Database:** MariaDB (available as an HA App).
* **HTTP Reverse Proxy:** Nginx Proxy Manager (available as an HA App).
* **Domain Name:** A domain name with wildcard DNS and SSL support. You can use a free service like **DuckDNS** if you do not own a domain.

---

## 2. Patching the Internet Bridge (IB) Firmware

To redirect the Tado Internet Bridge (IB) to your local server, you must dump its original firmware, patch the endpoint and certificate checks, and flash it back. All of this is automated using included scripts.

### 2.1 Install Debugging Tools on your PC
Before connecting the hardware, install the necessary flashing utility (`openocd`) and security engine (`openssl`) on your computer:

* **Windows (PowerShell):**
  ```powershell
  winget install -e --id OpenOCD.OpenOCD
  winget install -e --id ShiningLight.OpenSSL
  ```
* **Ubuntu/Debian (Bash):**
  ```bash
  sudo apt update
  sudo apt install -y openocd openssl coreutils gawk grep
  ```

### 2.2 Modifying the Clip-on Programmer
> [!WARNING]
> The bottom clear plastic housing on the clip-on programmer interferes with the physical reset button on the Internet Bridge board.
>
> 1. Optionally disassemble the clip-on programmer by removing the small screw.
> 2. File down the corner plastic on the bottom edge using a Dremel/multitool or a small hand saw. Refer to the photo in [patch_ib_firmware/README.md](patch_ib_firmware/README.md#53-solderless-method-clip-on-programmer) for the exact corner layout.
> 3. If you disassembled in step 1 reassemble the clip-on. The spring-loaded clamp mechanism should still work perfectly.

### 2.3 Opening the IB and Connecting Wires

For detailed instructions and photos see [patch_ib_firmware/README.md](patch_ib_firmware/README.md)

1. Pry open the plastic shell of the Internet Bridge using thin pry tools. There are no screws, only clips at the short and long ends.
2. Remove the PCB from the shell by popping the 3 plastic clips along the long edges.
3. Place the PCB on a flat surface. Identify the 10-pin (5x2) test point grid in the middle.
4. Align the clip-on programmer with the programmer tail/wires pointing downwards orient the PCB holes in the following manner: Single orientation hole on the **LEFT**, double orientation holes on the **RIGHT**.
5. Connect the clip-on programmer to the ST-Link V2 according to this pin layout:
   * **Board ① (top-left)** → ST-Link Pin 7 (3.3V)
   * **Board ⑤ (top-right)** → ST-Link Pin 5 (GND)
   * **Board ⑦ (bottom row, 2nd from left)** → ST-Link Pin 4 (SWDIO)
   * **Board ⑧ (bottom row, 3rd from left)** → ST-Link Pin 2 (SWCLK)
6. Firmly attach the clip-on to the test points. Bend the wires slightly to ensure the PCB stays flat and stable. Use a USB extension cable if needed to avoid dragging the board.

### 2.4 Running the Patching Script

***DO NOT connect the IB to USB or ethernet while having the programmer connected. Having the IB powered through both USB and the programmer can brick the IB.***

1. Download or clone this repository.
2. Connect the ST-Link to your PC USB port. 
3. With the ST-Link connected to your PC, open a terminal in the `/patch_ib_firmware` directory:

* **Windows:**
  ```powershell
  .\read_patch_flash.ps1
  ```
* **Linux:**
  ```bash
  ./read_patch_flash.sh
  ```

The script will dump the internal and external flash memory, locate/extract the Root CA certificate, generate your local clone, patch the server endpoints to `tanoclo.tado.lan`, and flash the patched binary back onto the STM32 chip.

> [!IMPORTANT]
> **Backup your files!** Once finished, save a copy of the newly generated `patch_ib_firmware/out/` and `patch_ib_firmware/original/` directories. These contain your unique cryptographic server keys and factory firmware backup.

> [!IMPORTANT]
> **No direct connectivity with the Tado cloud after patching** Because the endpoint and Root CA have been changed, the Internet Bridge will no longer be able to communicate with the official Tado cloud without going through your TaNoClo WebSocket server, which can proxy connections to the cloud if configured to do so.

---

## 3. Setting Up Home Assistant

Deploy the companion containers and reverse proxies inside your Home Assistant OS instance.

### 3.1 Install the App Repository
1. Go to **Settings** → **Apps** → **App Store**.
2. Click the three dots in the top-right corner and select **Repositories**.
3. Add the TaNoClo repository URL: `https://github.com/tanoclo/tanoclo`
4. Search for **TaNoClo WebSocket Server** in the App store list and click **Install**.

### 3.2 Prepare SSL Certificates
The patched Internet Bridge checks certificates against your cloned Root CA. Copy the credentials to Home Assistant's secure storage:
1. Copy the following files from your `patch_ib_firmware/out/` and `patch_ib_firmware/original/` directories:
   * `tanoclo_key.pem`
   * `tanoclo_cert.pem`
   * `tadoRootCA.cer`
2. Place them into the `/ssl/` directory on your Home Assistant OS host (accessible via Samba, SSH, or the File Editor add-on).

### 3.3 Set Up the Database (MariaDB Add-on)
1. Install and start the official **MariaDB** Add-on from the Add-on Store.
2. In the **Configuration** tab of MariaDB, define a custom database database user and permissions:
   ```yaml
   databases:
     - tanoclo
   logins:
     - password: [YOUR_SECURE_PASSWORD]
       username: tanoclo
   rights:
     - database: tanoclo
       username: tanoclo
   ```
3. Restart the MariaDB Add-on.

### 3.4 Set Up the MQTT Broker (Mosquitto Add-on)
1. Install and start the official **Mosquitto broker** Add-on.
2. In Home Assistant, go to **Settings** → **Devices & Services** → **Add Integration** → **MQTT** to hook it up. Ensure auto-discovery is active.

### 3.5 DNS Redirection (AdGuard Home / Pi-Hole)
You must force the Tado domains and your custom subdomain to resolve to your Home Assistant machine's IP address.

#### Option A: AdGuard Home (HA Add-on)
1. Open the AdGuard Home Web UI.
2. Go to **Filters** → **DNS Rewrites**.
3. Add the following records, replacing `<HA_IP>` with your Home Assistant host local IP:
   * `tanoclo.tado.lan` → `<HA_IP>`
   * `*.tanoclo.yourdomain.com` → `<HA_IP>`

#### Option B: Pi-Hole (HA Add-on)
1. Open the Pi-Hole Admin Console.
2. Go to **Local DNS** → **DNS Records**.
3. Map `tanoclo.tado.lan` and `*.tanoclo.yourdomain.com` to your Home Assistant host IP.

> [IMPORTANT]
> Ensure your network DHCP configuration is set to distribute the AdGuard/Pi-Hole IP address as the primary DNS server on your home network.

### 3.6 Configure HTTP Reverse Proxy (Nginx Proxy Manager)
For secure client access (web portal & mobile apps), configure a reverse proxy to handle external TLS termination.
1. Install and open the **Nginx Proxy Manager** Add-on.
2. Add a new **Proxy Host**:
   * **Domain Names:** `*.tanoclo.yourdomain.com` (or `*.yoursubdomain.duckdns.org`)
   * **Scheme:** `http`
   * **Forward Host IP:** `homeassistant` (or your local HA IP)
   * **Forward Port:** `3111`
3. Under the **SSL** tab:
   * Select or request a (Let's Encrypt) Wildcard certificate. You must enable the **DNS Challenge** option to request wildcard (`*`) certificates.

### 3.7 Configure and Start the TaNoClo Add-on
1. Navigate back to **Settings** → **Add-ons** → **TaNoClo WebSocket Server**.
2. Select the **Configuration** tab and fill in options:
   * **db_host:** `core-mariadb`
   * **db_name:** `tanoclo`
   * **db_user:** `tanoclo`
   * **db_password:** `[YOUR_SECURE_PASSWORD]` (from Step 3.3)
   * **mqtt_host:** `mqtt://core-mosquitto:1883`
   * **tanoclo_domain:** `tanoclo.yourdomain.com`
   * **jwt_secret:** *(Leave blank to let the add-on generate one automatically)*
3. Save settings and click **Start**.
4. Check the logs to see if TaNoClo started successfully.

---

## 4. Initial Configuration (Setup Portal)

With the server running, you can connect the components together.

### 4.1 First Login & Security Setup
1. Open your browser and navigate to the Setup Portal: `https://setup.tanoclo.yourdomain.com` (or the local address configured).
2. Log in using the default administrator credentials:
   * **Username:** `admin`
   * **Password:** `admin123`
   * **2FA Code (TOTP Secret):** `JBSWY3DPEHPK3PXP` (Use an authenticator app like Google Authenticator to load this secret key to generate the 6-digit TOTP code).
3. **Change the credentials immediately!** Go to the system settings page in the dashboard and change the administrator password and generate a new TOTP secret.

### 4.2 Seed Data from Tado Cloud
Before running offline, import your existing Tado installation settings (homes, rooms, valves, smart schedules).
1. Go to the portal dashboard's **Homes** section.
2. Click **Start Tado Import**. An OAuth Device Authorization code and link will be displayed on screen.
3. Click the link, log in with your official Tado Cloud account, and authorize the device connection.
4. TaNoClo will automatically replicate your home layout, device records, temperature schedules, and user structures into your local MariaDB database.
5. **Connect the IB to the network and power** by plugging the ethernet and power cable back in.

---

## 5. Proxy Mode & State Capture Flow

Now we capture the dynamic, active operational states of the valves as they communicate with the server.

1. **Enable Proxy Mode:** Log into the Setup Portal, navigate to the Home settings dashboard, and toggle **Proxy to cloud**. This forces TaNoClo to transparently relay incoming Internet Bridge signals to the official Tado Cloud while capturing the data flow.
2. **Start State Capture:** Go to the **State Backup & Recovery** tab and click **Start Capture**.
3. **Wait for sync:** Let the Internet Bridge and devices communicate through the proxy for a couple of hours. This ensures all schedules, limits, and dynamic settings from the devices are successfully recorded by the local engine.
4. **Disable Proxy Mode:** Once the backup state indicates all devices have checked in and their states are verified, turn **off** proxy mode.
5. Your Tado heating system is now running **100% offline**, decoupled from the Tado cloud.

---

## 6. Accessing the Frontend & Apps

### Web Management UI
Access your climate portal at `https://app.tanoclo.yourdomain.com` to manage temperatures, set overlays and adjust schedules. Login with the home's Tado administrator email address (imported while seeding) and password (default for all imported users: tanoclo2026). You can (and should) change the passwords on the user page of the frontend or the setup portal. 

### Android Application
1. Download the pre-built APK:
   * [Android APK Download](https://raw.githubusercontent.com/tanoclo/tanoclo/ota/tanoclo.apk)
2. Install it on your mobile device (you may need to enable "Install from Unknown Sources").
3. Set your server endpoint inside the app configuration window to `https://app.tanoclo.yourdomain.com`.
4. Login with your credentials

### Home Assistant Integration (MQTT)
When MQTT discovery is active, Home Assistant will automatically discover your zones and valves. Go to **Settings** → **Devices & Services** → **MQTT** to find your heating devices. You can control target temperatures, view current temperatures, humidity levels, battery reports, and track geofenced users natively. It is advisable to remove the official Tado integration from HA when using this integration, to prevent mixups with simmarly named devices.

### iOS
As we don't currently build for iOS you can use the web app for now to control the system on Apple devices. You can try to build for iOS using the following instructions (untested):

1. **Requirements**: You must have a macOS machine with Xcode installed.
2. **Install iOS Integration**: Install the Capacitor iOS dependency inside `frontend-new`:
   ```bash
   cd frontend-new
   npm install @capacitor/ios
   ```
3. **Add iOS Platform**: Add the iOS platform support to create the native project files:
   ```bash
   npx cap add ios
   ```
4. **Compile Web Assets**: Build the production React frontend assets:
   ```bash
   npm run build
   ```
5. **Sync to Capacitor**: Sync the compiled web assets into the iOS project:
   ```bash
   npx cap sync ios
   ```
6. **Open Xcode & Compile**: Open the workspace in Xcode to configure code signing and run or build the app:
   ```bash
   npx cap open ios
   ```

Note that you will need to have a jailbroken iOS device to install custom patched builds without an Apple Developer Account, or run the app via Xcode in developer mode on your own device.