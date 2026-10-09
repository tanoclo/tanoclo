/**
 * @file src/components/settings/ZoneAdvancedSettings.jsx
 * @brief Renders advanced tuning controls for heating zones.
 * 
 * Configures sensitive micro-adjustments:
 * - Tuning Temperatures triad:
 *     * FID 0x60a0 (zone_frost_min_temperature, default 5.00°C)
 *     * FID 0x60c0 (zone_temperature_baseline, default 15.00°C)
 *     * FID 0x6080 (zone_temperature_deviation_limit, default 10.00°C)
 * - Advanced Open Window Detection (OWD):
 *     * FID 0x60e0 (zone_open_window_detection_enabled)
 *     * FID 0x62c0 (zone_open_window_shutoff_duration, default 900s / 15m)
 *     * FID 0x4140 (owd_state telemetry flag in /z/p pings)
 *     * TaNoClo server-side drop rate heuristics & external sensor routing.
 * - Offline local scheduling syncs.
 */

import React from 'react';
import Card from '../common/Card';
import Button from '../common/Button';
import Toggle from '../common/Toggle';
import { ShieldAlert, Thermometer, Wind, CheckCircle2, AlertTriangle, Activity } from 'lucide-react';
import ZoneSettingsSchedule from './ZoneSettingsSchedule';

/**
 * @brief Advanced zone settings controller sub-panel.
 * @param {object} props.zone - Target zone details.
 * @param {boolean} props.isDhw - Whether target zone is Domestic Hot Water.
 * @param {boolean} props.isReadOnly - Whether view is read-only.
 * @param {number} props.frostMinTemperature - Frost protection minimum temperature limit (FID 0x60a0).
 * @param {function} props.setFrostMinTemperature - Frost min temperature state setter.
 * @param {number} props.temperatureBaseline - Temperature baseline setpoint (FID 0x60c0).
 * @param {function} props.setTemperatureBaseline - Temperature baseline state setter.
 * @param {number} props.temperatureDeviationLimit - Temperature deviation limit (FID 0x6080).
 * @param {function} props.setTemperatureDeviationLimit - Temperature deviation limit state setter.
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
 * @param {boolean} props.openWindow - Active open window setting (FID 0x60e0).
 * @param {number} props.owdTimeout - OWD shutoff duration in seconds (FID 0x62c0).
 * @param {boolean} props.tanocloOwdEnabled - Custom backend software OWD feature state.
 * @param {function} props.handleTaNoCloOwdToggle - Software OWD toggle callback.
 * @param {string} props.owdSource - Active OWD evaluation source ('device', 'server', 'both', 'external').
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
  temperatureDeviationLimit,
  setTemperatureDeviationLimit,
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
  owdTimeout = 900,
  tanocloOwdEnabled,
  handleTaNoCloOwdToggle,
  owdSource = 'device',
  handleOwdSourceChange,
  t
}) {
  const currentFrost = zone?.frostMinTemperature ?? 5.00;
  const currentBaseline = zone?.temperatureBaseline ?? 15.00;
  const currentDeviation = zone?.temperatureDeviationLimit ?? zone?.openWindowDetection?.temperatureDeviationLimit ?? 10.00;

  const isTuningDirty = (
    frostMinTemperature !== currentFrost ||
    temperatureBaseline !== currentBaseline ||
    temperatureDeviationLimit !== currentDeviation
  );

  const isOpenWindowActive = Boolean(zone?.open_window_active);
  const activeDurationMinutes = Math.round(owdTimeout / 60);

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

      {/* Firmware Tuning Temperatures Card (FID 0x6080, 0x60a0, 0x60c0) */}
      <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Thermometer size={18} style={{ color: 'var(--primary)' }} />
              <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>
                {t('settings.zone_advanced.tuning_temps_title')}
              </h3>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '4px 0 0', lineHeight: '1.4' }}>
              {t('settings.zone_advanced.tuning_temps_desc')}
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {/* Frost Protection Minimum (FID 0x60a0) */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <strong>{t('settings.zone_advanced.frost_protection_title')}</strong>
                <span style={{
                  fontSize: '0.65rem',
                  padding: '1px 6px',
                  borderRadius: '4px',
                  backgroundColor: 'rgba(59, 130, 246, 0.1)',
                  color: '#3b82f6',
                  fontWeight: 700
                }}>
                  FID 0x60a0
                </span>
              </div>
              <span style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--primary)' }}>
                {Number(frostMinTemperature).toFixed(1)}°C
              </span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
              {t('settings.zone_advanced.frost_protection_desc')} <strong>5.0°C</strong>.
              <br />
              • <em>{t('common.interpretation')}</em>: {t('settings.zone_advanced.frost_protection_interpretation')}
            </p>
            <input
              type="range"
              min="0"
              max="15"
              step="0.5"
              value={frostMinTemperature}
              onChange={(e) => setFrostMinTemperature(Number(e.target.value))}
              disabled={isReadOnly}
              style={{ cursor: isReadOnly ? 'not-allowed' : 'pointer', width: '100%', marginTop: '0.25rem' }}
            />
          </div>

          {/* Baseline Target Temperature (FID 0x60c0) */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <strong>{t('settings.zone_advanced.baseline_temp_title')}</strong>
                <span style={{
                  fontSize: '0.65rem',
                  padding: '1px 6px',
                  borderRadius: '4px',
                  backgroundColor: 'rgba(16, 185, 129, 0.1)',
                  color: '#10b981',
                  fontWeight: 700
                }}>
                  FID 0x60c0
                </span>
              </div>
              <span style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--primary)' }}>
                {Number(temperatureBaseline).toFixed(1)}°C
              </span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
              {t('settings.zone_advanced.baseline_temp_desc')}
              <br />
              • <em>{t('common.interpretation')}</em>: {t('settings.zone_advanced.baseline_temp_interpretation')} <strong>15.0°C</strong>.
            </p>
            <input
              type="range"
              min="5"
              max="25"
              step="0.5"
              value={temperatureBaseline}
              onChange={(e) => setTemperatureBaseline(Number(e.target.value))}
              disabled={isReadOnly}
              style={{ cursor: isReadOnly ? 'not-allowed' : 'pointer', width: '100%', marginTop: '0.25rem' }}
            />
          </div>

          {/* Temperature Deviation Limit (FID 0x6080) */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <strong>{t('settings.zone_advanced.deviation_limit_title')}</strong>
                <span style={{
                  fontSize: '0.65rem',
                  padding: '1px 6px',
                  borderRadius: '4px',
                  backgroundColor: 'rgba(245, 158, 11, 0.1)',
                  color: '#f59e0b',
                  fontWeight: 700
                }}>
                  FID 0x6080
                </span>
              </div>
              <span style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--primary)' }}>
                {Number(temperatureDeviationLimit).toFixed(1)}°C
              </span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
              {t('settings.zone_advanced.deviation_limit_desc')}
              <br />
              • <em>{t('common.interpretation')}</em>: {t('settings.zone_advanced.deviation_limit_interpretation')} <strong>10.0°C</strong>.
            </p>
            <input
              type="range"
              min="1"
              max="20"
              step="0.5"
              value={temperatureDeviationLimit}
              onChange={(e) => setTemperatureDeviationLimit(Number(e.target.value))}
              disabled={isReadOnly}
              style={{ cursor: isReadOnly ? 'not-allowed' : 'pointer', width: '100%', marginTop: '0.25rem' }}
            />
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
          <Button
            variant="primary"
            onClick={handleSaveAdvancedDetails}
            disabled={isSavingAdvancedDetails || !isTuningDirty || isReadOnly}
            style={{ justifyContent: 'center', minWidth: '120px' }}
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

      {/* Advanced Open Window Detection (OWD) */}
      {!isDhw && (
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Wind size={18} style={{ color: 'var(--primary)' }} />
              <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>
                {t('settings.zone_advanced.advanced_owd_title')}
              </h3>
            </div>
            {/* Live Detection Status Badge */}
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.35rem',
              fontSize: '0.75rem',
              fontWeight: 700,
              padding: '3px 10px',
              borderRadius: '999px',
              backgroundColor: isOpenWindowActive ? 'rgba(239, 68, 68, 0.15)' : 'rgba(16, 185, 129, 0.15)',
              color: isOpenWindowActive ? '#ef4444' : '#10b981',
              border: `1px solid ${isOpenWindowActive ? '#ef4444' : '#10b981'}`
            }}>
              {isOpenWindowActive ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}
              {isOpenWindowActive ? t('settings.zone_advanced.owd_status_active') : t('settings.zone_advanced.owd_status_idle')}
            </span>
          </div>

          {/* Section 1: Firmware Hardware Protocol Grounding Grid */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '0.75rem'
          }}>
            <div style={{
              backgroundColor: 'var(--bg-input)',
              padding: '0.85rem',
              borderRadius: 'var(--radius-sm, 6px)',
              border: '1px solid var(--border-color)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.25rem'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Hardware Detection</span>
                <span style={{ fontSize: '0.65rem', padding: '1px 5px', borderRadius: '3px', backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-muted)' }}>FID 0x60e0</span>
              </div>
              <strong style={{ fontSize: '0.9rem', color: openWindow ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                {openWindow ? 'Enabled (Active)' : 'Disabled'}
              </strong>
            </div>

            <div style={{
              backgroundColor: 'var(--bg-input)',
              padding: '0.85rem',
              borderRadius: 'var(--radius-sm, 6px)',
              border: '1px solid var(--border-color)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.25rem'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Shutoff Duration</span>
                <span style={{ fontSize: '0.65rem', padding: '1px 5px', borderRadius: '3px', backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-muted)' }}>FID 0x62c0</span>
              </div>
              <strong style={{ fontSize: '0.9rem', color: 'var(--text-primary)' }}>
                {`${activeDurationMinutes} min (${owdTimeout}s)`}
              </strong>
            </div>

            <div style={{
              backgroundColor: 'var(--bg-input)',
              padding: '0.85rem',
              borderRadius: 'var(--radius-sm, 6px)',
              border: '1px solid var(--border-color)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.25rem'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Live Telemetry Flag</span>
                <span style={{ fontSize: '0.65rem', padding: '1px 5px', borderRadius: '3px', backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-muted)' }}>FID 0x4140</span>
              </div>
              <strong style={{ fontSize: '0.9rem', color: isOpenWindowActive ? '#ef4444' : 'var(--text-primary)' }}>
                {isOpenWindowActive ? '1 (Window Open)' : '0 (Normal / Standby)'}
              </strong>
            </div>
          </div>

          {/* Section 2: TaNoClo Server-Side Assisted OWD */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', borderTop: '1px solid var(--border-color)', paddingTop: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <strong style={{ fontSize: '0.9rem' }}>{t('settings.zone_advanced.assisted_owd_title')}</strong>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '2px 0 0', lineHeight: '1.4' }}>
                  {t('settings.zone_advanced.assisted_owd_desc')}
                </p>
              </div>
              <Toggle checked={tanocloOwdEnabled} onChange={handleTaNoCloOwdToggle} disabled={isReadOnly} />
            </div>

            {tanocloOwdEnabled && (
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem',
                marginTop: '0.5rem',
                backgroundColor: 'var(--bg-input)',
                padding: '0.85rem',
                borderRadius: 'var(--radius-sm, 6px)',
                border: '1px solid var(--border-color)'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                  <span style={{ fontSize: '0.8rem', fontWeight: 700 }}>
                    {t('settings.zone_advanced.detection_source_title')}
                  </span>
                  <select
                    value={owdSource}
                    onChange={(e) => handleOwdSourceChange(e.target.value)}
                    disabled={isReadOnly}
                    style={{
                      backgroundColor: 'var(--bg-card-solid)',
                      border: '1px solid var(--border-color)',
                      color: 'var(--text-primary)',
                      padding: '0.35rem 0.65rem',
                      borderRadius: 'var(--radius-sm)',
                      outline: 'none',
                      fontWeight: 600,
                      cursor: isReadOnly ? 'not-allowed' : 'pointer'
                    }}
                  >
                    <option value="device">{t('settings.zone_advanced.source_device_only')}</option>
                    <option value="server">{t('settings.zone_advanced.source_server_heuristics')}</option>
                    <option value="both">{t('settings.zone_advanced.source_both')}</option>
                    <option value="external">{t('settings.zone_advanced.source_external_api')}</option>
                  </select>
                </div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', lineHeight: '1.4', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                  <div>• <strong>{t('settings.zone_advanced.source_device_only')}</strong>: {t('settings.zone_advanced.source_device_only_desc')}</div>
                  <div>• <strong>{t('settings.zone_advanced.source_server_heuristics')}</strong>: {t('settings.zone_advanced.source_server_heuristics_desc')}</div>
                  <div>• <strong>{t('settings.zone_advanced.source_both')}</strong>: {t('settings.zone_advanced.source_both_desc')}</div>
                  <div>• <strong>{t('settings.zone_advanced.source_external_api')}</strong>: {t('settings.zone_advanced.source_external_api_desc')}</div>
                </div>
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}