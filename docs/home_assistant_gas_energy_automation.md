# Home Assistant Gas Energy & Costs Integration

TaNoClo tracks gas consumption ($m^3$), distinguishes gas burned for **Domestic Hot Water (DHW)** versus **Space Heating**, and apportions heating costs to each individual room.

This guide demonstrates how to configure Home Assistant (HA) to automatically publish gas meter readings and tariff prices to TaNoClo over MQTT.

---

## 1. MQTT Topics & Payloads

### Default Topics

| Function | Default MQTT Topic | Expected Payload |
|---|---|---|
| **Gas Meter Reading** | `tado/tanoclo/h/<homeId>/energy/gas_meter` | Cumulative reading in $m^3$ (e.g. `1450.628` or `{"value": 1450.628}`) |
| **Gas Unit Cost / Tariff** | `tado/tanoclo/h/<homeId>/energy/gas_cost_per_m3` | Unit price per $m^3$ (e.g. `1.45` or `{"value": 1.45}`) |

> [!NOTE]
> Replace `<homeId>` with your TaNoClo home ID.
> Both raw number strings (`1450.628`) and JSON objects containing `value`, `state`, or `meter_m3` are automatically recognized and parsed.

### Custom Topics
If you already have sensors publishing to custom MQTT topics, you can set custom topic names directly in TaNoClo:
**System Settings** $\rightarrow$ **Heating Activity & Energy** $\rightarrow$ **Tariff & MQTT (⚙️)**.

---

## 2. Currency Handling

Currency is configured per home in TaNoClo (**System Settings** $\rightarrow$ **Tariff & MQTT**):
- **Currency Symbol**: Choose your currency symbol (e.g. `€`, `£`, `$`, `CHF`, `kr`). Default is `€`.
- **Unit Cost**: Numeric value representing the cost per $m^3$ (e.g. `1.4500`).
- **Cost Calculation**:
  $$\text{Cost} = \text{Gas Consumed }(m^3) \times \text{Unit Cost}$$
- The currency symbol is formatted consistently across all summary cards, room breakdown tables, and historical reports.
- If dynamic tariffs are used (e.g., dynamic gas contracts in the Netherlands/Belgium/Germany), publishing the latest price to the MQTT topic immediately updates the active tariff used for ongoing intervals.

---

## 3. Home Assistant Automations

Add the following automations to your Home Assistant `automations.yaml` (or via **Settings** $\rightarrow$ **Automations & Scenes** in the HA UI).

### Automation 1: Sync Gas Meter Readings to TaNoClo

Triggers whenever your smart gas meter sensor updates (e.g., DSMR/P1 meter `sensor.gas_consumption` or Zigbee gas meter) and publishes the cumulative reading to TaNoClo.

```yaml
alias: "TaNoClo - Publish Gas Meter Reading"
description: "Publishes cumulative gas consumption to TaNoClo"
trigger:
  - platform: state
    entity_id: sensor.gas_consumption  # Change to your HA gas meter sensor
condition:
  - condition: template
    value_template: "{{ trigger.to_state.state not in ['unavailable', 'unknown', ''] }}"
action:
  - service: mqtt.publish
    data:
      topic: "tado/tanoclo/h/1/energy/gas_meter"
      payload: "{{ states('sensor.gas_consumption') }}"
      retain: true
      qos: 1
mode: single
```

---

### Automation 2: Sync Dynamic Gas Tariff to TaNoClo

Triggers whenever your energy provider publishes a new gas tariff (e.g., `sensor.gas_price_per_m3` or an `input_number.gas_tariff` helper).

```yaml
alias: "TaNoClo - Publish Gas Tariff"
description: "Publishes current gas unit rate per m3 to TaNoClo"
trigger:
  - platform: state
    entity_id: sensor.gas_price_per_m3  # Or input_number.gas_tariff
  - platform: homeassistant
    event: start
condition:
  - condition: template
    value_template: "{{ trigger.to_state.state not in ['unavailable', 'unknown', ''] }}"
action:
  - service: mqtt.publish
    data:
      topic: "tado/tanoclo/h/1/energy/gas_cost_per_m3"
      payload: "{{ states('sensor.gas_price_per_m3') }}"
      retain: true
      qos: 1
mode: single
```

---

## 4. How Calculations Work in TaNoClo

1. **DHW Differentiation**:
   - TaNoClo reads OpenTherm circuit telemetry in real-time.
   - Any boiler firing activity (`field_0457` active) with domestic hot water flow (`field_045e > 0`) is attributed 100% to **DHW**.
   - Remaining firing duration is attributed to **Central Heating (Space Heating)**.

2. **Per-Room Space Heating Apportionment**:
   - Each heating zone tracks heating power duty cycle (`field_40a0`) over time.
   - **Demand-Based (Default)**: Gas is distributed proportionally to each room's actual valve opening time:
     $$\text{Share}_i = \frac{\int \text{field\_40a0}_i(t)\,dt}{\sum_j \int \text{field\_40a0}_j(t)\,dt}$$
   - **Area-Weighted Demand**: You can enable room area weighting in settings. This multiplies each room's demand by its configured floor area (`room_size_sqm` in $m^2$), reflecting the thermodynamic requirement of larger rooms.
