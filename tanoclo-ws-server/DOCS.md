# TaNoClo WebSocket Server Setup Guide

This guide details how to configure the **TaNoClo WebSocket Server** app and its required companion services inside your Home Assistant ecosystem.

---

## Architecture Overview

```
                        +----------------------------+
                        |  Internet Bridge (Client)  |
                        +----------------------------+
                                      |
                                      | (WSS/TCP Port 988)
                                      v
+---------------------------------------------------------------------------------+
| Home Assistant OS (Host)                                                        |
|                                                                                 |
|  +--------------------+    +---------------------+     +---------------------+  |
|  |   AdGuard / PiHole |    |   Mosquitto Broker  |     |   MariaDB App    |  |
|  |   (DNS Redirects)  |    |     (MQTT Bus)      |     |     (Database)      |  |
|  +--------------------+    +---------------------+     +---------------------+  |
|            |                          ^                           ^             |
|            | (DNS Resolves)           | (Discovery/States)        | (SQL)       |
|            v                          |                           |             |
|  +---------------------------------------------------------------------------+  |
|  | TaNoClo App (ws-server)                                                 |  |
|  |                                                                           |  |
|  |  * Port 988 (WSS Native Server terminating TLS using certs in /ssl)       |  |
|  |  * Port 3111 (REST HTTP API & setup web interface)                        |  |
|  +---------------------------------------------------------------------------+  |
|                                       ^                                         |
|                                       | (HTTP Proxy)                            |
|                                       v                                         |
|                           +-----------------------+                             |
|                           |  Nginx Proxy Manager  |                             |
|                           |  (External Setup API) |                             |
|                           +-----------------------+                             |
+---------------------------------------------------------------------------------+
```

---

## Setup Step-by-Step

### 1. SSL Certificates Preparation
The physical Internet Bridge verifies connections using an embedded Root CA certificate chain. 
During the firmware patching process, a cloned Root CA key is used to sign a leaf certificate for the local server (Default `tanoclo.tado.lan`).

1. Locate the output folder of your firmware patching script (normally `./out/` or `./original/`).
2. Copy the following three files into the Home Assistant `/ssl/` shared partition (using Samba or SSH app):
   * `tanoclo_key.pem`
   * `tanoclo_cert.pem`
   * `tadoRootCA.cer`
3. Confirm that these files are present at the root of the Home Assistant `/ssl` directory.

---

### 2. DNS Redirection Configuration (AdGuard Home or Pi-Hole)
Your network must be setup (using DHCP) such that the Internet Bridge and clients can resolve the TaNoClo domain (`tanoclo.tado.lan`) to the IP address of your Home Assistant host machine. If you want to access the TaNoClo frontend externally you should also setup your edge router to handle this (outside of the scope of this guide).

#### Option A: AdGuard Home
1. Open the **AdGuard Home** UI.
2. Go to **Filters** -> **DNS Rewrites**.
3. Click **Add DNS Rewrite** and add the following records:
   * **Domain:** `tanoclo.tado.lan` -> **IP:** `<Home Assistant Host IP>`
   * **Domain:** `*.tanoclo.yourdomain.com` -> **IP:** `<Home Assistant Host IP>`
   * **(Optional for using the official Tado integration) Domain:** `login.tado.com` -> **IP:** `<Home Assistant Host IP>`
   * **(Optional for using the official Tado integration) Domain:** `my.tado.com` -> **IP:** `<Home Assistant Host IP>`

#### Option B: Pi-Hole
1. Open the **Pi-Hole** Admin Console.
2. Go to **Local DNS** -> **DNS Records**.
3. Add mappings for the domains `tanoclo.tado.lan`, `*.tanoclo.yourdomain.com` and optionally `login.tado.com`, and `my.tado.com` to the IP address of your Home Assistant host.

---

### 3. Database Configuration (MariaDB App)
TaNoClo requires a MariaDB database to store configuration records, telemetry measurements, and device pairings.

1. Install the **MariaDB** app from the Home Assistant App Store.
2. In the **Configuration** tab of the MariaDB app, define the database `tanoclo` and user `tanoclo` with a strong password:
   ```yaml
   databases:
     - tanoclo
   logins:
     - password: [PASSWORD]
       username: tanoclo
   rights:
     - database: tanoclo
       username: tanoclo
   ```
3. (Re-)Start the MariaDB app.
4. The TaNoClo Node server will automatically create the database `tanoclo` and seed the tables if the connection user has rights to do so and the database is empty on first boot.

---

### 4. MQTT Configuration (Mosquitto Broker)
TaNoClo publishes device states and metadata dynamically to MQTT to support Home Assistant Auto-Discovery.

1. Install the **Mosquitto broker** app from the Home Assistant App Store and start it.
2. In Home Assistant, go to **Settings** -> **Devices & Services** -> **Add Integration** -> select **MQTT** to configure the connection to the local broker.
3. Make sure the MQTT integration is running.

---

### 5. TaNoClo Installation & Configuration
Now you can install and configure the TaNoClo app itself.

1. Go to **Settings** -> **Apps** -> **App Store**.
2. Click the three dots in the top-right corner and select **Repositories**.
3. Add the URL of your Git repository: `https://github.com/tanoclo/tanoclo`.
4. The list will reload, and you will see **TaNoClo WebSocket Server** under the repository category.
5. Click **Install**. The Supervisor will automatically compile native dependencies for your hardware architecture (AMD64 or AARCH64).
6. Go to the **Configuration** tab and configure options:
   * **Database Host:** `core-mariadb` (internal HA hostname)
   * **Database User:** `tanoclo`
   * **Database Password:** `[PASSWORD]` (matching password defined in step 3)
   * **Database Name:** `tanoclo`
   * **MQTT Host:** `mqtt://core-mosquitto:1883`
   * **JWT Secret:** Leave blank (will auto-generate and persist to `/data/jwt_secret.txt` on startup)
7. Save settings and click **Start**.

---

### 6. Reverse Proxy Configuration (Nginx Proxy Manager)
You will need secure external HTTPS access to the TaNoClo Frontend, Setup & Management API (e.g. `https://app.tanoclo.yourdomain.com`).
You can use Nginx Proxy Manager for this.

1. Install the **Nginx Proxy Manager** app and open its Admin UI.
2. Go to **Hosts** -> **Proxy Hosts** -> **Add Proxy Host**.
3. Enter your domain details:
   * **Domain Names:** `*.tanoclo.yourdomain.com`
   * **Scheme:** `http`
   * **Forward Host IP:** `homeassistant`
   * **Forward Port:** `3111`
4. In the **SSL** tab, request a Let's Encrypt certificate (ACME) or upload your custom certificate. Since you need a wildcard certificate you will have to use DNS challenge. Save the settings.

*(Note: The Internet Bridge TLS connections on port `988` bypass this proxy and connect directly to the app on port `988` which terminates TLS natively).*

### 7. Configure TaNoClo

Follow the steps in the README file (section 5.1 and 5.2) in the `ws-server` directory to configure TaNoClo.