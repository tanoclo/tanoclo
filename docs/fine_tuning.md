# TaNoClo Device & Zone Fine-Tuning Specification

This document details the advanced configuration parameters, mechanical travel calculations, and integration API schemas used to fine-tune smart radiator valves (TRVs), thermostats, and climate zones on the TaNoClo server.

---

## 1. Stepper Motor Travel & Valve Position Logic

The Valve Actuator controls hot water flow dynamically by driving a stepper motor that linearly moves a piston pin. The travel range is governed by three primary calibration parameters:

```
                  [Valve Fully Closed]                        [Valve Fully Open]
                  (Piston Pin Extended)                     (Piston Pin Retracted)
                     
                     va_act_limit_low_steps                   va_act_limit_high_steps
                     (FID 0x0273)                             (FID 0x027c)
                           |                                        |
                           v                                        v
  Stepper Steps: ----------|========================================|------------->
  Physical State:  [Pin Extended] <======== Active Travel ========> [Pin Retracted]
```

### 1.1 Calibration Limits & Step Calculations
On VA02 hardware, motor step counts are absolute values tracked from the internal physical retraction home. The active travel and calibration limits fall within the **1800 to 2600 steps** range:

*   **Fully Extended / Closed Limit (`va_act_limit_low_steps` - FID `0x0273`)**: The step position where the piston is fully extended (valve pin pressed down completely, closing the radiator valve). Typical values lie between **2100 and 2600 steps**.
    *   *Tuning Tip:* If the radiator leaks hot water when set to off, increasing this value (e.g. from 2300 to 2350) drives the stepper further out, compressing the valve pin more tightly.
*   **Fully Retracted / Open Limit (`va_act_limit_high_steps` - FID `0x027c`)**: The step position where the piston is fully drawn in (valve pin completely released, opening the radiator valve). Typical values lie between **1900 and 2500 steps**.
    *   *Tuning Tip:* Reducing this value constrains the maximum opening aperture, artificially restricting the maximum flow rate.
*   **Calibration Drive Constant (`va_act_drive_cal_const` - FID `0x0280`)**: An internal mechanical calibration reference value. On VA02 hardware, this typically lies between **1700 and 1900 steps** and represents the baseline calibration offset.
*   **Status/Error flags (`va_act_status_flags_s16` - FID `0x028d`)**: Stored in `devices.field_0283` in the database. Reports positioning step deviation or calibration faults.

### 1.2 Actuator Status Flags & Mounting State Diagnostics
*   **Positioning Deviation (`va_act_status_flags_s16` - FID `0x028d`)**:
    *   *Calculation:* The firmware calculates this value during motion calibration as the step deviation from the expected contact/seat point:
        $$\text{Deviation} = (\text{Current Position} - \text{Expected Seat Point})$$
    *   *Values:*
        *   `32767` (`0x7fff`): Inactive or not yet reporting.
        *   Small values (e.g. `-10` to `+10` steps): Normal operation; the motor is perfectly aligned with the valve seat point.
        *   Large negative or positive values (e.g. $< -100$ or $> 100$ steps): Piston contact occurred too early or travel was blocked. Indicates mechanical blockage (valve stuck) or mounting alignment issues.
*   **Mounting State (`va_mount_state` - FID `0x01b8`)**: Stored in `devices.field_016a` in the database. Represents the physical calibration phase:
    *   `0`: `CALIBRATED` (mounting and calibration completed successfully)
    *   `1`: `CALIBRATING` (running active calibration cycle)
    *   `2`: `MOUNTED` (device attached to bracket, awaiting calibration)
*   **Mounting Flags (`va_mount_flags` - FID `0x01fb`)**: Stored in `devices.field_01fb` in the database. Tracks internal execution flags during the calibration sequence.
*   **Learned contact/seat point steps (`va_mount_seatpoint_steps` - FID `0x01b6`)**: Stored in `devices.field_01b6`. The learned stepper count where the piston makes physical contact with the valve pin.
*   **Learned calibration reference/offset steps (`va_mount_reference_steps` - FID `0x01b5`)**: Stored in `devices.field_01b5`. The learned base reference offset steps.

### 1.3 Positioning Telemetry FIDs
*   `0x0265` (`va_act_position_steps`): The primary active step count showing current piston extension.
*   `0x0294` (`va_act_position2_steps`): Secondary target steps (mapped to `devices.field_0266` in the database).

---

## 2. Advanced Tuning Parameters

In addition to mechanical travel limits, the TaNoClo server supports several hidden or advanced tuning parameters to configure display behaviors, temperature baseline offsets, and Open Window Detection (OWD) rules:

### 2.1 Display & UI Control Settings
*   **`display_orientation` (FID `0x0149`)**: Stored in `devices.field_0149` in the database. Controls whether the LED matrix renders vertically (`0`) or horizontally (`1`).
*   **`device_ui_flags_0158` (`0x0158`)**: Big-endian bitmask (`u16be`) controlling screen behaviors:
    *   **Bit 9 (`0x0200`)**: *Dazzle Mode* (Dynamic Ambient Light-Sensitive Brightness scaling). Enables/disables automatic brightness adjustments based on the photodiode sensor.
    *   **Bit 10 (`0x0400`)**: *Display Always-On* override.
*   **`display_active_timeout` (`0x02b2`)**: Timeout duration in minutes before display panel turns off. Default is `0`.

### 2.2 Dynamic Open Window Detection (OWD) Tuning
*   **`zone_open_window_shutoff_duration` (`0x62c0`)**: Shutoff duration in seconds. Represents how long the heating is paused when an open window event triggers.
*   **`zone_temperature_deviation_limit` (`0x6080`)**: Temperature deviation threshold (`u16be`, scaled by `0.01` °C). Defines how quickly a drop in temperature registers as an open window (default: `0.5°C`).

### 2.3 Dynamic Temperature Constraints & Offsets
*   **`temperature_offset` (`0x0140`)**: Calibration offset (`s16be`, scaled by `0.01` °C) to adjust readings affected by local draft patterns or heat pockets.

---

## 3. Viewing & Changing Fine-Tuning Settings

To protect the system from accidental misconfigurations, all advanced tuning and calibration limits have been relocated to a dedicated, click-through **Advanced Settings** view.

### 3.1 React Frontend (frontend-new) UI Access
1. Open the TaNoClo Smart Climate Portal in your browser.
2. **For Device Limits and Display Settings:**
   - Go to **Settings** -> **Devices**.
   - Click on the target device to view its detail page.
   - Click the **Advanced Settings** button to open the configuration panel. Here you can adjust:
     - Display Orientation (Vertical / Horizontal)
     - Screensaver Timeout (Minutes)
     - Valve Travel Limits (Zero-Level Steps, Full-Travel Steps, Calibration Constant)
3. **For OWD Sensitivity and Temperature Offsets:**
   - Go to the **Climate Zone** page for the target room.
   - Click **Zone Settings** -> **Advanced Settings**. Here you can adjust:
     - OWD Temperature Drop Limit (°C)
     - OWD Shutoff Duration (Minutes)
     - Calibration Temperature Offset (°C)

### 3.2 Raw API Endpoints

#### Pushing Actuator Limits via `/d/act`
*   **Endpoint:** `PUT /api/devices/:id/actuatorLimits` (or `/devices/:id/actuatorLimits`)
*   **Headers:** `Content-Type: application/json`
*   **Body Schema:**
    ```json
    {
      "lowSteps": 2200,
      "highSteps": 1950,
      "driveConstant": 1800
    }
    ```
*   **Result:** Pushes the values to the device under `d/{deviceId}/act` via CoAP and updates `devices.field_0273`, `field_027c`, and `field_0280` in the database.

#### Pushing Display Settings via `/d/display`
*   **Endpoint:** `PUT /api/devices/:id/display`
*   **Body Schema:**
    ```json
    {
      "orientation": 0,
      "timeout": 5
    }
    ```
*   **Result:** Updates display orientation and timeout FIDs in NVM.

#### Pushing Zone OWD Settings via `/z/owd`
*   **Endpoint:** `PUT /api/homes/:homeId/zones/:zoneId/owd`
*   **Body Schema:**
    ```json
    {
      "deviationLimit": 50,
      "shutoffDuration": 900
    }
    ```
*   **Result:** Updates OWD temperature drop limits and timer thresholds.
