/**
 * @file src/components/settings/ZoneAdvancedSettings.jsx
 * @brief Renders advanced tuning controls for heating zones.
 * 
 * Configures sensitive micro-adjustments: frost protection thresholds (standard 5.0°C), temperature
 * baseline offsets, local offline scheduling syncs, and open window detection (OWD) algorithms.
 * Integrates both hardware-based OWD registers and custom backend software-based detection models.
 */


import Card from '../common/Card';
import Button from '../common/Button';
import Toggle from '../common/Toggle';
import { ShieldAlert } from 'lucide-react';
import ZoneSettingsSchedule from './ZoneSettingsSchedule';

/**
 * @brief Advanced zone settings controller sub-panel.
 * @param {object} props.zone - Target zone details.
 * @param {boolean} props.isDhw - Whether target zone is Domestic Hot Water.
 * @param {boolean} props.isReadOnly - Whether view is read-only.
 * @param {number} props.frostMinTemperature - Frost protection minimum temperature limit.
 * @param {function} props.setFrostMinTemperature - Frost min temperature state setter.
 * @param {number} props.temperatureBaseline - Temperature calibration baseline offset.
 * @param {function} props.setTemperatureBaseline - Temperature baseline state setter.
 * @param {function} props.handleSaveAdvancedDetails - Save advanced calibration details dispatcher.
 * @param {boolean} props.isSavingAdvancedDetails - Progress indicator for tuning adjustments.
 * @param {boolean} props.offlineScheduleEnabled - Active offline schedule state.
 * @param {function} props.handleOfflineScheduleToggle - Offline schedule toggle callback.
 * @param {boolean} props.isSaving - Offline schedule saving progress indicator.
 * @param {function} props.syncOfflineSchedule - Push offline rules to physical valve memory callback.
 * @param {number} props.homeId - Active home identifier.
 * @param {number} props.zoneId - Active zone identifier.
 * @param {function} props.mutateZones - SWR mutate callback to reload zones metadata.
 * @param {function} props.triggerToast - Callback function to show notification toast.
 * @param {object} props.openWindow - Active open window metadata details.
 * @param {number} props.temperatureDeviationLimit - OWD trigger deviation threshold in Celsius.
 * @param {function} props.handleOwdDeviationChange - OWD deviation slider callback.
 * @param {boolean} props.owdNvmState - Active physical hardware OWD register state.
 * @param {function} props.handleOwdNvmStateToggle - Hardware OWD register toggle callback.
 * @param {boolean} props.tanocloOwdEnabled - Custom backend software OWD feature state.
 * @param {function} props.handleTaNoCloOwdToggle - Software OWD toggle callback.
 * @param {string} props.owdSource - Active OWD evaluation source ('NONE', 'LOCAL', 'CLOUD').
 * @param {function} props.handleOwdSourceChange - OWD evaluation source selector callback.
 * @param {function} props.t - Translation resolver hook.
 */
export default function ZoneAdvancedSettings({
  zone,
  isDhw,
  isReadOnly,
  frostMinTemperature,
  setFrostMinTemperature,
  temperatureBaseline,
  setTemperatureBaseline,
  handleSaveAdvancedDetails,
  isSavingAdvancedDetails,
  offlineScheduleEnabled,
  handleOfflineScheduleToggle,
  isSaving,
  syncOfflineSchedule,
  homeId,
  zoneId,
  mutateZones,
  triggerToast,
  openWindow,
  temperatureDeviationLimit,
  handleOwdDeviationChange,
  owdNvmState,
  handleOwdNvmStateToggle,
  tanocloOwdEnabled,
  handleTaNoCloOwdToggle,
  owdSource,
  handleOwdSourceChange,
  t
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Danger/Warning Banner */}
      <Card style={{
        padding: '1.25rem',
        border: '1px solid var(--danger-glow)',
        backgroundColor: 'var(--danger-glow)',
        color: 'var(--text-primary)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--danger)' }}>
          <ShieldAlert size={20} />
          <strong style={{ fontSize: '1rem', fontWeight: 700 }}>{t('settings.zone_advanced.warning_title')}</strong>
        </div>
        <p style={{ fontSize: '0.85rem', lineHeight: '1.4', margin: 0 }}>
          {t('settings.zone_advanced.warning_desc')}
        </p>
      </Card>

      {/* Frost and Baseline Temperature Card */}
      <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>Tuning Temperatures</h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {/* Frost Protection */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>Frost Protection Temp</strong>
              <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--primary)' }}>
                {frostMinTemperature}°C
              </span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
              The minimum temperature maintained to prevent water in the pipes and radiator chambers from freezing when heating is turned off or in standby.
              Standard Tado systems hardcode this value to <strong>5.0°C</strong>.
              <br />
              • <em>Interpretation</em>: Setting this lower (5.0°C) conserves energy but increases frost risk in poorly insulated rooms/corners.
              Setting this higher (e.g. 8.0°C - 10.0°C) adds a safety buffer against local freezing at the cost of slight standby energy consumption.
            </p>
            <input
              type="range"
              min="0"
              max="15"
              step="0.5"
              value={frostMinTemperature}
              onChange={(e) => setFrostMinTemperature(Number(e.target.value))}
              disabled={isReadOnly}
              style={{ cursor: 'pointer', width: '100%', marginTop: '0.25rem' }}
            />
          </div>

          {/* Baseline Target Temperature */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>Baseline Target Temp</strong>
              <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--primary)' }}>
                {temperatureBaseline}°C
              </span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
              The fallback target temperature utilized when no schedule is active or when the controller defaults back to basic standby mode.
              <br />
              • <em>Interpretation</em>: Serves as the default target when scheduling rules do not explicitly override it. Adjusting this influences the default base target. Recommended default is 19.0°C.
            </p>
            <input
              type="range"
              min="10"
              max="25"
              step="0.5"
              value={temperatureBaseline}
              onChange={(e) => setTemperatureBaseline(Number(e.target.value))}
              disabled={isReadOnly}
              style={{ cursor: 'pointer', width: '100%', marginTop: '0.25rem' }}
            />
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
          <Button
            variant="primary"
            onClick={handleSaveAdvancedDetails}
            disabled={isSavingAdvancedDetails || (frostMinTemperature === (zone?.frostMinTemperature ?? 5) && temperatureBaseline === (zone?.temperatureBaseline ?? 19))}
            style={{ justifyContent: 'center', minWidth: '100px' }}
          >
            {isSavingAdvancedDetails ? t('settings.saving') : t('common.save')}
          </Button>
        </div>
      </Card>

      {/* Offline Schedule Card */}
      <ZoneSettingsSchedule
        isDhw={isDhw}
        zone={zone}
        isReadOnly={isReadOnly}
        offlineScheduleEnabled={offlineScheduleEnabled}
        handleOfflineScheduleToggle={handleOfflineScheduleToggle}
        isSaving={isSaving}
        syncOfflineSchedule={syncOfflineSchedule}
        homeId={homeId}
        zoneId={zoneId}
        mutateZones={mutateZones}
        triggerToast={triggerToast}
        t={t}
      />

      {/* Advanced OWD settings (Only if heating and OWD is enabled in main settings) */}
      {!isDhw && openWindow && (
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>Advanced Open Window Detection (OWD)</h3>

          {/* OWD Sensitivity / Deviation Limit */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>Trigger Temperature Drop (Sensitivity)</strong>
              <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--primary)' }}>
                {temperatureDeviationLimit}°C
              </span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
              The rate of temperature drop (in °C) within a short window required to trigger the Open Window shut-off response.
              <br />
              • <em>Interpretation</em>: If set too low (e.g. 0.1°C), standard room drafts or starting ventilation can cause false triggers, shutting down your heating prematurely. If set too high (e.g. 1.5°C), a very rapid and freezing drop is required, meaning small window openings won't be caught and energy is wasted. The default recommendation is <strong>0.50°C</strong>.
            </p>
            <input
              type="range"
              min="0.05"
              max="2.00"
              step="0.05"
              value={temperatureDeviationLimit}
              onChange={(e) => handleOwdDeviationChange(Number(e.target.value))}
              disabled={isReadOnly}
              style={{ width: '100%', cursor: 'pointer', marginTop: '0.25rem' }}
            />
          </div>

          {/* NVM Persistent OWD State */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <strong>NVM Persistent Hardware OWD</strong>
              </div>
              <Toggle
                checked={owdNvmState === 1}
                onChange={(checked) => handleOwdNvmStateToggle(checked ? 1 : 0)}
                disabled={isReadOnly}
              />
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
              Saves the window detection state directly to the thermostat's Non-Volatile Memory (NVM).
              <br />
              • <em>Interpretation</em>: When enabled (default/Tado standard behavior), if a window is detected open, that state survives a thermostat reboot or a battery pull. If disabled, power-cycling the device or rebooting it will immediately clear the open window shutdown state. Enabling is recommended for preventing child tamper workarounds.
            </p>
          </div>

          {/* TaNoClo Server OWD */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', borderTop: '1px solid var(--border-color)', paddingTop: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <strong>TaNoClo Assisted OWD</strong>
              </div>
              <Toggle checked={tanocloOwdEnabled} onChange={handleTaNoCloOwdToggle} />
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
              Enables custom server-side heuristics on the TaNoClo server to assist or override the local thermostat device OWD logic.
            </p>

            {tanocloOwdEnabled && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem', backgroundColor: 'var(--bg-input)', padding: '0.75rem', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>Detection Source</span>
                  <select
                    value={owdSource}
                    onChange={(e) => handleOwdSourceChange(e.target.value)}
                    style={{
                      backgroundColor: 'var(--bg-card-solid)',
                      border: '1px solid var(--border-color)',
                      color: 'var(--text-primary)',
                      padding: '0.25rem 0.5rem',
                      borderRadius: 'var(--radius-sm)',
                      outline: 'none',
                      fontWeight: 600,
                      cursor: 'pointer'
                    }}
                  >
                    <option value="device">Device Only</option>
                    <option value="server">Server Heuristics</option>
                    <option value="both">Both (Device & Server)</option>
                    <option value="external">External API Trigger</option>
                  </select>
                </div>
                <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', margin: '4px 0 0 0', lineHeight: '1.3' }}>
                  • <strong>Device Only</strong>: Uses only the thermostat's internal sensor algorithm.
                  <br />
                  • <strong>Server Heuristics</strong>: Uses server analytics, comparing room sensors and weather drop speeds.
                  <br />
                  • <strong>Both</strong>: Heating turns off if either the device or server detects a drop.
                  <br />
                  • <strong>External API Trigger</strong>: Disables auto-detection on both thermostat and server. Relies strictly on external door/window contacts (e.g. Zigbee contacts integrated via Home Assistant API calls).
                </p>
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
