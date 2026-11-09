# TaNoClo Device & Zone Fine-Tuning Specification

This document details the advanced configuration parameters, mechanical travel calculations, and integration API schemas used to fine-tune smart radiator valves (TRVs), thermostats, and climate zones on the TaNoClo server.

---

## 1. Stepper Motor Travel & Valve Position Logic

The Valve Actuator controls hot water flow dynamically by driving an internal stepper motor that linearly moves a piston pin outward from the gearbox home.

### 1.1 Mechanical Coordinate System & Step Progression

TRV radiator valves are **normally open** (an internal return spring pushes the valve pin out to allow 100% water flow). To close the valve or modulate flow, the actuator motor must travel outward (increasing step counts) to compress the pin inward.

```
[Gearbox Retraction Home]
      0
      |
      |-- (e.g. 205 steps) --> [Reference Point] (`0x01b5`: `va_mount_reference_steps`)
      |                        Internal mechanical offset where lead screw travel begins.
      |
      |-- (e.g. 1786 steps) -> [Drive Constant] (`0x0280`: `va_act_drive_cal_const`)
      |                        Factory baseline distance where a standard pin is expected.
      |
      |-- (e.g. 1894 steps) -> [Seat Point] (`0x01b6`: `va_mount_seatpoint_steps`)
      |                        Physical pin contact point learned during calibration.
      |                        Valve is 100% OPEN (pin fully uncompressed).
      |                        Current Position (e.g. 1897) rests here when no heat is demanded.
      |
      v-- (e.g. 2390 steps) -> [Piston Stroke]
                               Pin compressed down toward full closure.
                               Valve 100% CLOSED (flow completely shut off).
```

### 1.2 Calibration Limits & Motor Diagnostics
On VA02 hardware, motor step counts are absolute values tracked from internal physical retraction home.

*   **Motor Load Voltage (`motor_load_mv` - FID `0x0273`)**: Motor drive SAADC voltage in mV ($1.875 \times \text{raw}$, clamped $\le 4800\,\text{mV}$). Used by firmware for motor stall detection and triggering `0x01a3` hardware error codes.
*   **Running Minimum Motor Voltage (`motor_run_min_mv` - FID `0x027c`)**: Lowest running motor SAADC voltage observed across the stroke in mV ($1.875 \times \text{raw}$).
*   **Calibration Drive Constant (`va_act_drive_cal_const` - FID `0x0280`)**: An internal mechanical calibration reference value. On VA02 hardware, this typically lies between **1700 and 1900 steps** and represents the baseline calibration offset.
*   **Learned contact/seat point steps (`va_mount_seatpoint_steps` - FID `0x01b6`)**: Stored in `devices.field_01b6`. The learned stepper count where the piston makes physical contact with the valve pin.
*   **Learned calibration reference/offset steps (`va_mount_reference_steps` - FID `0x01b5`)**: Stored in `devices.field_01b5`. The learned base reference offset steps.

### 1.3 Actuator Status Flags & Mounting State Diagnostics
*   **Positioning Deviation (`va_act_status_flags_s16` - FID `0x028d`)**:
    *   *Calculation:* Calculated as the step deviation from the expected contact/seat point:
        $$\text{Deviation} = (\text{Current Position} - \text{Expected Seat Point})$$
    *   *Values:*
        *   `32767` (`0x7fff`): Inactive or not yet reporting.
        *   Small values (e.g. `-10` to `+10` steps): Normal operation; the motor is perfectly aligned with the valve seat point.
        *   Large negative or positive values (e.g. $< -100$ or $> 100$ steps): Piston contact occurred too early or travel was blocked. Indicates mechanical blockage (valve stuck) or mounting alignment issues.
*   **Mounting State (`va_mount_state` - FID `0x01b8`)**: Stored in `devices.field_016a` in the database. Represents the physical calibration phase:
    *   `0`: `CALIBRATING` / `UNMOUNTED` (running active calibration cycle or unmounted)
    *   `1`: `CALIBRATED` (mounting and calibration completed successfully)
    *   `2`: `MOUNTED` (device attached to bracket, awaiting calibration)
*   **Mounting Flags (`va_mount_flags` - FID `0x01fb`)**: Stored in `devices.field_01fb` in the database. Tracks internal execution flags during the calibration sequence.
*   **Current Position (`va_act_position_steps` - FID `0x0265`)**: The primary active step count showing current piston extension (`devices.field_0265`).
*   **Target Position (`va_act_position2_steps` - FID `0x0266`)**: Secondary target steps commanded by the heating controller (`devices.field_0266`). When idle/no heat demand, target rests at the open pin contact point (`0x01b5`). When heating, target modulates between open (`0x01b5`) and fully compressed endstop (`0x01b6`).

---

## 2. Advanced Tuning Parameters

In addition to mechanical travel limits, the TaNoClo server supports several hidden or advanced tuning parameters to configure display behaviors, temperature baseline offsets, and Open Window Detection (OWD) rules:

### 2.1 Display & UI Control Settings
*   **`display_orientation` (FID `0x0149`)**: Stored in `devices.field_0149` in the database. Controls whether the LED matrix renders vertically (`0`) or horizontally (`1`).
*   **`device_ui_flags_0158` (`0x0158`)**: Big-endian bitmask (`u16be`) controlling screen wake notification behaviors:
    *   **Bit 9 (`0x0200`)**: *Dazzle Mode*. Enables/disables waking the display when a manual remote overlay change is received.
    *   **Bit 10 (`0x0400`)**: Wakes the display when ANY zone change notification is received.
*   **`utc_offset_minutes` (`0x02b2`)**: Device UTC offset in minutes applied to RTC epoch (`(short)uVar1 * 60000`). Configured to match the home's local timezone.

### 2.2 Dynamic Open Window Detection (OWD) Tuning
*   **`zone_open_window_detection_enabled` (`0x60e0`)**: Boolean toggle enabling hardware open window detection on devices in the zone.
*   **`zone_open_window_shutoff_duration` (`0x62c0`)**: Shutoff duration in seconds (raw seconds, default `900` / 15 minutes). Represents how long the heating is paused when an open window event triggers.
*   **`owd_state` (`0x4140`)**: Active detection telemetry status flag reported in `/z/p` pings (1 = open window active, 0 = normal).

### 2.3 Closed-Loop PID Heating Demand Control Law & Valve Sensitivity
The hardware devices execute a closed-loop PID controller to calculate heating demand (0–100%) and scale physical valve stroke:

#### Zone Control Law:
$$\text{Demand}(0\text{x}40a0) = \text{clamp}(P + I - D, 0, 100)\%$$

All temperatures are processed in centidegrees ($0.01^\circ\text{C}$, e.g. $1.00^\circ\text{C} = 100$).

1. **$K_p$ Proportional Gain (`0x6080`)**:
   $$P = (T_{\text{setpoint}} - T_{\text{current}})_{0.01} \times \frac{\text{raw}(0\text{x}6080)}{2000} = \Delta T_{^\circ\text{C}} \times \frac{K_p \times 100}{20} = \Delta T_{^\circ\text{C}} \times 5 \times K_p$$
   - *Default:* `10.00` (raw 1000 / `0x3e8`).
   - *Impact:* Direct proportional response to room temperature deficit. With default 10.00, a 1.0°C shortfall produces 50% demand (2.0°C shortfall = 100%).
2. **$K_i$ Integral Gain (`0x60a0`)**:
   $$I = \frac{\text{raw}(0\text{x}60a0) \times \text{Accumulator}}{30000} = \frac{\text{Accumulator} \times K_i}{300}$$
   - *Default:* `5.00` (raw 500 / `0x1f4`).
   - *Anti-Windup:* Accumulator clamped to $3\,000\,000 / \text{raw}(0\text{x}60a0)$, capping the integral term contribution strictly at 100%.
   - *Impact:* Eliminates steady-state error in drafty or high-heat-loss rooms.
3. **$K_d$ Derivative Gain (`0x60c0`)**:
   $$D = \frac{\text{raw}(0\text{x}60c0) \times (T_{\text{current}} - T_{\text{previous}})_{0.01}}{2000} = \frac{K_d \times \Delta\dot{T}_{^\circ\text{C}} \times 100}{20} = K_d \times 5 \times \Delta\dot{T}_{^\circ\text{C}}$$
   - *Default:* `15.00` (raw 1500 / `0x5dc`, hardcoded fallback). Subtracted from demand ($P + I - D$).
   - *Impact:* Dynamic braking factor based on rate of temperature rise. Suppresses demand before reaching setpoint to prevent overshoot in high-inertia radiator systems.

#### Device Valve Stroke Sensitivity (`0x4160`):
$$\text{Physical Valve Opening} = \text{clamp}\left(\frac{\text{Demand} \times 100}{\text{raw}(0\text{x}4160)}, 0, 100\right)\%$$
If `0x4160 > 100`, the firmware clamps the denominator to `100`. Therefore, values $> 100$ do not throttle and are capped at 1.00× passthrough by device hardware. Valid denominator range is 25–100:
- Denominator `100` = 1.00× standard passthrough
- Denominator `50` = 2.00× (+100% boost for slow/undersized radiators)
- Denominator `25` = 4.00× (+300% maximum stroke amplification)

- **Bypass Flag**: If a runtime bypass flag is non-zero, sensitivity scaling is bypassed entirely and raw unscaled demand is passed through directly.

*   **`temperature_offset` (`0x0140`)**: Calibration offset (`s16be`, scaled by `0.01` °C) to adjust readings affected by local draft patterns or heat pockets.

### 2.4 Advisory Hydraulic Balancing
The server includes an automated hydraulic balancing analyzer (`ws-server/lib/balancing-analyzer.js`) that analyzes heating cycles over a rolling time window (default 72 hours):
*   **Rise-Rate Analysis**: Evaluates the median rate of temperature rise (°C/hour) across all radiator zones when active demand is asserted.
*   **Reference Baseline**: Selects the slowest heating room (or user-defined reference zone) and calculates rate ratios for all other zones.
*   **Sensitivity Calculation**: Translates rate disparities into recommended valve sensitivity denominators (`0x4160`, range 25–100):
    $$\text{Target Sensitivity} = \text{clamp}\left(\text{round}\left(100 \times \frac{\text{Baseline Rate}}{\text{Zone Rate}}\right), 25, 100\right)$$
*   **REST API Endpoints**:
    *   `GET /api/v2/homes/{homeId}/balancing/analysis?hours=72`: Computes live balancing recommendations and saves a snapshot.
    *   `POST /api/v2/homes/{homeId}/balancing/apply`: Batch-applies suggested sensitivities to physical TRVs and pushes config refresh commands.
    *   `GET /api/v2/homes/{homeId}/balancing/history`: Retrieves the last 10 balancing analysis snapshots.

### 2.5 Thermodynamic PID Tuning
Correlated with hydraulic balancing, the thermodynamic PID analyzer (`ws-server/lib/pid-analyzer.js`) tunes the room-level closed-loop controller gains:
*   **Transient Response Evaluation**: Analyzes temperature overshoot, steady-state error, and rise speed during heat calls.
*   **Adaptive Gain Synthesis**: Calculates recommended gains:
    *   $K_p$ (`0x6080`): Scaled to match room thermal mass and prevent under-heating or excessive oscillation.
    *   $K_i$ (`0x60a0`): Adjusted to eliminate steady-state error without provoking integrator windup.
    *   $K_d$ (`0x60c0`): Calibrated based on radiator thermal inertia to provide proportional damping before setpoint arrival.
*   **REST API Endpoints**:
    *   `GET /api/v2/homes/{homeId}/pid-tuning/analysis?hours=72`: Analyzes thermal response curves and generates PID gain recommendations.
    *   `POST /api/v2/homes/{homeId}/pid-tuning/apply`: Applies gains (`0x6080`, `0x60a0`, `0x60c0`) to zone configurations and dispatches device refreshes.
    *   `GET /api/v2/homes/{homeId}/pid-tuning/history`: Returns historical PID tuning snapshots and application timestamps.

### 2.6 Custom Battery Discharge Curves & Motor Error Detection
Battery monitoring (`ws-server/lib/battery.js`) supports custom non-linear discharge curves:
*   **Multi-Point Calibration**: Accepts an array of 2 to 20 `[millivolts, percentage]` coordinates. Voltages between points are linearly interpolated.
*   **Default Chemistries**: Standard curves provided for `alkaline`, `rechargeable` (NiMH), and `lithium` chemistries across VA, RU, and IB devices.
*   **Motor Error Detection (VA only)**: Optional toggle (`va_motor_error_detection`) controlling whether hardware motor stall error flags (`0x01a3` / `0x0289`) trigger user alerts.
*   **REST API Endpoints**:
    *   `PUT /api/v2/homes/{homeId}/tanoclo/devices/{serial}/battery`: Updates battery type, custom discharge curve JSON, or motor error detection.
    *   `GET /api/v2/homes/{homeId}/tanoclo/devices/{serial}/battery/defaultCurve?chemistry=alkaline`: Returns default curve points for the device family.

### 2.7 Seasonal Heating Schedule Profiles
Homes support multiple named schedule profiles (`ws-server/lib/db-schedule-profiles.js`) for different seasons:
*   **Profile Storage**: Each profile encapsulates complete timetable definitions (`ONE_DAY`, `THREE_DAY`, `SEVEN_DAY`) and temperature blocks across all home zones.
*   **Automated Calendar Transitions**: Profiles can specify an `auto_start_date` (`MM-DD` format, e.g. `10-15` for mid-October). The background cron evaluator automatically activates the matching seasonal profile.
*   **REST API Endpoints**:
    *   `GET /api/v2/homes/{homeId}/scheduleProfiles`: Lists all profiles and indicates the active profile ID.
    *   `POST /api/v2/homes/{homeId}/scheduleProfiles`: Creates a new profile (supports copying existing timetables).
    *   `GET /api/v2/homes/{homeId}/scheduleProfiles/{profileId}`: Retrieves full timetable blocks for all zones in the profile.
    *   `PUT /api/v2/homes/{homeId}/scheduleProfiles/{profileId}`: Updates profile name, icon, description, or auto-start date.
    *   `DELETE /api/v2/homes/{homeId}/scheduleProfiles/{profileId}`: Deletes a profile.
    *   `POST /api/v2/homes/{homeId}/scheduleProfiles/{profileId}/activate`: Activates profile and applies all zone timetables to live database and devices.
    *   `POST /api/v2/homes/{homeId}/scheduleProfiles/{profileId}/capture`: Snapshots the current live zone timetables into this profile.
    *   `PUT /api/v2/homes/{homeId}/scheduleProfiles/{profileId}/zones/{zoneId}/blocks`: Updates schedule blocks for a specific zone within the profile.

### 2.8 Boiler Flow Temperature Optimization & Auto-Adaptation
For OpenTherm boiler systems, the flow temperature optimizer (`ws-server/lib/flow-optimizer.js`) automatically regulates water supply temperature:
*   **Demand-Based Curves**: Regulates max flow temperature (`0x2040`) between configured minimum (e.g. 30°C) and maximum (e.g. 70°C) limits based on weather and aggregate room demand.
*   **REST API Endpoints**:
    *   `GET /api/v2/homes/{homeId}/flowTemperatureOptimization`: Returns current limits, OpenTherm device info, and auto-adaptation telemetry.
    *   `PUT /api/v2/homes/{homeId}/flowTemperatureOptimization`: Updates min/max limits and toggles auto-adaptation.
    *   `GET /api/v2/homes/{homeId}/flowTemperatureHistory`: Returns timestamped logs of flow temperature optimization decisions.

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
     - Valve Stroke Sensitivity Denominator (25–100)
     - Custom Battery Discharge Curve & Motor Error Detection
3. **For Zone PID Gains and OWD Settings:**
   - Go to the **Climate Zone** page for the target room.
   - Click **Zone Settings** -> **Advanced Settings**. Here you can adjust:
     - Closed-Loop PID Proportional Gain ($K_p$, default `10.00`)
     - Closed-Loop PID Integral Gain ($K_i$, default `5.00`)
     - Closed-Loop PID Derivative Gain ($K_d$, default `15.00`)
     - OWD Shutoff Duration (Minutes)
     - Calibration Temperature Offset (°C)
4. **For System Optimization & Schedules:**
   - Go to **Settings** -> **Server** to access **Hydraulic Balancing** and **Thermodynamic PID Tuning** advisors.
   - Go to **Settings** -> **Schedules** to create, edit, capture, and switch **Seasonal Schedule Profiles**.