# CoAP Debug Endpoints & Memory Architecture

This document specifies the internal CoAP diagnostic and memory access endpoints supported by Tado devices across all hardware generations (Valve Actuators VA01/VA02, Room Units RU01/RU02, and Internet Bridges IB01/GW03)

---

## 1. Hardware Memory Maps per Device Family

| Device Family | Microcontroller (MCU) | Internal Flash (Code / ROM) | Internal SRAM (Live State) | External SPI Flash (Storage) |
| :--- | :--- | :--- | :--- | :--- |
| **VA01 / VA02**<br>*(Radiator Valve)* | **Nordic nRF52832**<br>(ARM Cortex-M4F @ 64MHz) | **`0x00000000`** (512 KB)<br>`0x00000000` – `0x0007FFFF` | **`0x20000000`** (64 KB)<br>`0x20000000` – `0x2000FFFF` | **`0x80000000`** (1 MB)<br>`0x80000000` – `0x800FFFFF` |
| **RU01 / RU02 / WR02**<br>*(Room Unit / Wireless Receiver)* | **STM32L0**<br>(ARM Cortex-M0+ ultra-low-power) | **`0x08000000`** (64 KB)<br>`0x08000000` – `0x0800FFFF` | **`0x20000000`** (8 KB – 20 KB)<br>`0x20000000` – `0x20004FFF` | *None / Not present* |
| **IB01 / GW03**<br>*(Internet Bridge)* | **STM32F411**<br>(ARM Cortex-M4 @ 100MHz) | **`0x08000000`** (512 KB)<br>`0x08000000` – `0x0807FFFF` | **`0x20000000`** (128 KB)<br>`0x20000000` – `0x2001FFFF` | **`0x80000000`** (2 MB)<br>`0x80000000` – `0x801FFFFF` |

---

## 2. `/d/dbg/m` — Direct Memory & Flash Reader

### Overview
- **CoAP Method**: `GET`
- **Path**: `d/dbg/m?adr={address_decimal}&len={length_bytes}`
- **CoAP Options**:
  - `Option 6 (Accept)`: `42` (`application/octet-stream`)
  - `Option 15 (Uri-Query)`: `adr={dec}`, `len={dec}`
- **Response**: `2.05 Content` (`0x45`) with raw binary octet-stream payload.

### Critical Radix Rule
The MCU parses query parameters with `strtoul(str, NULL, 10)` (base **10** / DECIMAL). Hex strings must be converted to base-10 before dispatch (e.g. `0x20000000` -> `536870912`).

### Bus Architecture
- **Addresses `< 0x80000000` (Direct Bus)**: Read via direct CPU. Accesses Internal Flash (ROM/Vectors) and Internal SRAM.
- **Addresses `>= 0x80000000` (External SPI Flash)**: Masked with `& 0x7FFFFFFF` and read via SPI opcode `0x03` (`READ_DATA`).
- **MTU & Chunking**: Max chunk size supported per single 802.15.4 frame without fragmentation is **64 bytes**.

---

## 3. `/d/dbg/st` — Live Diagnostic Reader & State Injector

### Overview
- **CoAP Methods**: `GET` (Status Query) and `PUT` (Live State Injection)
- **Path**: `d/dbg/st`
- **Query Params (GET)**: `?tag={dec}&len={dec}` -> Returns `2.05 Content` (`0x45`) with big-endian integer/bytes.
- **Query / Payload (PUT)**: `?tag={dec}&len={dec}` with binary value payload -> Returns `2.04 Changed` (`0x44`).

### Handler Control Flow
1. **GET**:
   - Queries the 43-entry diagnostic parameter table.
   - If not found in table, falls back to `rf_nvm_read(tag, len)`.
2. **PUT**:
   - Updates live RAM control structures.

### Complete 43-Entry Diagnostic Parameter Table

| Index | FID / Tag | Data Type | Field Name / Function | Description |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `0x01AC` | `u16be` | `diag_packet_counter` | Diagnostic packet transmission counter / trigger mode |
| 2–33 | `0x62E0` – `0x62FF` | `u16be` / `s16be` | `sim_env_hook_00` – `sim_env_hook_1F` | Block of 32 simulation hooks for virtual environmental sensor feeds, PID loop tuning, and simulated temperature/valve responses |
| 34 | `0x0289` | `u16be` | `va_motor_stall_threshold` | Motor current stall detection threshold during calibration |
| 35 | `0x03ED` | `u16be` | `va_motor_step_override` | Direct stepper motor absolute step coordinate position override |
| 36 | `0x024B` | `u8` | `rf_channel_override` | Live radio channel test override / LQI evaluation |
| 37 | `0x01C6` | `u16be` | `batt_impedance_threshold` | Battery internal resistance and loaded voltage drop threshold |
| 38 | `0x01FA` | `u8` | `rf_carrier_test_mode` | Radio continuous wave (CW) transmission / RF carrier diagnostic flag |
| 39 | `0x0FA3` | `u32be` | `watchdog_trace_code` | Watchdog timer reset trace / MCU fault diagnostic code |
| 40 | `0x028B` | `u16be` | `va_valve_seat_torque_limit` | Maximum valve seat torque / compression force limit |
| 41 | `0x0294` | `s16be` | `temp_comp_ambient_feed` | Ambient room temperature compensation sensor feed |
| 42 | `0x016D` | `u16be` | `humidity_raw_adc_feed` | Relative humidity sensor raw ADC capacitance measurement feed |
| 43 | `0x0290` | `u8` | `accel_tamper_sensitivity` | Accelerometer mounting tamper detection sensitivity threshold |

---

## 4. `/d/dbg2/tlvs` — Whitelisted NVM Direct Store

### Overview
- **CoAP Method**: `PUT`
- **Path**: `d/dbg2/tlvs`
- **Payload**: Standard TLV binary payload (FID `u16be` + Len `u8` + Value bytes).
- **Response**: `2.04 Changed` (`0x44`) / `2.05 Content` (`0x45`) with Content-Format 42 on success, or `4.00 Bad Request` on empty payload / error.

### Whitelist Architecture
Unlike `/d/dbg/st` which modifies live RAM state variables, `/d/dbg2/tlvs` writes directly to device Non-Volatile Memory (NVM / Flash storage).
The device parses the TLV payload in the PUT body against the whitelisted setter callbacks.

### Complete 12-Entry Whitelist Table

| Whitelist Slot | Param Index / FID | Setter Callback | Description & Stored Parameter |
| :---: | :---: | :---: | :--- |
| **1** | `0x0001` (1) | `0x0803538b` / `0x080201f7` | **RF Frequency / Channel Config**: Configures 802.15.4 channel (11–26) in NVM. |
| **2** | `0x000A` (10) | `0x0803534d` / `0x080201d9` | **802.15.4 PAN ID**: Stored 16-bit mesh network Personal Area Network Identifier. |
| **3** | `0x000B` (11) | `0x0803532f` / `0x080201bb` | **Link Security / Factory Key**: Active 128-bit AES network encryption key in NVM. |
| **4** | `0x0009` (9) | `0x08035381` / `0x0802019d` | **TX Power & Attenuation**: Stored PA transmission power level (dBm). |
| **5** | `0x0005` (5) | `0x0803531d` / `0x0802017f` | **Short Node ID**: Stored 16-bit mesh device node address. |
| **6** | `0x0006` (6) | `0x08034a31` / `0x08020161` | **EUI-64 MAC Address**: Hardware 64-bit IEEE MAC address in NVM. |
| **7** | `0x0002` (2) | `0x0802682d` / `0x08020143` | **NVM Lock & Calibration State**: Calibration validity flags and storage write-lock. |
| **8** | `0x0003` (3) | `0x080267e5` / `0x08020125` | **Hardware Revision / Board Variant**: Stored PCB revision and variant identifier. |
| **9** | `0x0004` (4) | `0x08026c75` / `0x08020107` | **Device Serial Number**: Full ASCII/binary device serial identifier. |
| **10** | `0x0007` (7) | `0x080352f5` / `0x080200e9` | **Gateway / Bridge Mesh Route**: Primary IPv6 route to coordinator/Internet Bridge. |
| **11** | `0x0008` (8) | `0x08026cc9` / `0x080200cb` | **Installation & Commissioning State**: Factory paired vs standalone operating state. |
| **12** | `0x000C` (12) | `0x08026791` / `0x080200ad` | **Factory Reset / NVM Erase**: Trigger for restoring NVM parameters to factory defaults. |
