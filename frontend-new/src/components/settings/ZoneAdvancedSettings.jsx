/**
 * @file src/components/settings/ZoneAdvancedSettings.jsx
 * @brief Renders advanced tuning controls for heating zones.
 * 
 * Exposes hardware-calibrated parameters for heating zones:
 * - Closed-loop PID heating demand controller:
 *     * Demand (0x40a0) = clamp(P + I - D, 0, 100)%
 *     * FID 0x6080: Kp (proportional gain, default 0.50 / raw 50)
 *     * FID 0x60a0: Ki (integral gain with anti-windup cap, default 5.00 / raw 500)
 *     * FID 0x60c0: Kd (derivative damping factor, default 19.00 / raw 1900)
 * - Interplay with device valve sensitivity (FID 0x4160 stroke denominator).
 * - Advanced Open Window Detection (OWD):
 *     * FID 0x60e0: Hardware switch
 *     * FID 0x62c0: Shutoff duration (default 900s / 15m)
 *     * FID 0x4140: Active OWD state telemetry in /z/p
 * - Offline local scheduling syncs.
 */

import React from 'react';
import Card from '../common/Card';
import Button from '../common/Button';
import Toggle from '../common/Toggle';
import { ShieldAlert, Activity, Wind, CheckCircle2, AlertTriangle, RotateCcw } from 'lucide-react';
import ZoneSettingsSchedule from './ZoneSettingsSchedule';

/**
 * @brief Advanced zone settings controller sub-panel.
 */
export default function ZoneAdvancedSettings({
  zone,
  isDhw,
  isReadOnly,
  kp = 0.50,
  setKp,
  ki = 5.00,
  setKi,
  kd = 19.00,
  setKd,
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
  const currentKp = zone?.kp ?? zone?.pidTuning?.kp ?? 0.50;
  const currentKi = zone?.ki ?? zone?.pidTuning?.ki ?? 5.00;
  const currentKd = zone?.kd ?? zone?.pidTuning?.kd ?? 19.00;

  const isTuningDirty = (
    kp !== currentKp ||
    ki !== currentKi ||
    kd !== currentKd
  );

  const isOpenWindowActive = Boolean(zone?.open_window_active);
  const activeDurationMinutes = Math.round(owdTimeout / 60);

  const handleResetPidDefaults = () => {
    if (setKp) setKp(0.50);
    if (setKi) setKi(5.00);
    if (setKd) setKd(19.00);
    if (triggerToast) {
      triggerToast(t('settings.zone_advanced.pid_reset', 'PID parameters reset to default (0.50 / 5.00 / 19.00)'), 'info');
    }
  };

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

      {/* PID Loop Heating Demand Calibration Card (FID 0x6080, 0x60a0, 0x60c0) */}
      <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Activity size={18} style={{ color: 'var(--primary)' }} />
              <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>
                {t('settings.zone_advanced.tuning_temps_title', 'PID Heating Demand Tuning')}
              </h3>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '4px 0 0', lineHeight: '1.4' }}>
              {t('settings.zone_advanced.tuning_temps_desc', 'Configures closed-loop PID controller parameters in firmware to calculate heating demand (0–100%): Demand = clamp(P + I − D, 0, 100)%.')}
            </p>
          </div>
        </div>

        {/* Firmware Formula Badge */}
        <div style={{
          padding: '0.75rem 1rem',
          backgroundColor: 'var(--bg-input, rgba(0,0,0,0.2))',
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-sm, 6px)',
          fontFamily: 'monospace',
          fontSize: '0.85rem',
          color: 'var(--text-primary)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '0.5rem'
        }}>
          <div>
            <span style={{ color: 'var(--text-secondary)' }}>{t('settings.zone_advanced.pid_formula_title', 'Firmware Control Law')}: </span>
            <strong style={{ color: 'var(--primary-light, #3b82f6)' }}>{t('settings.zone_advanced.pid_formula_badge', 'Demand = clamp(P + I − D, 0, 100)%')}</strong>
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {t('settings.zone_advanced.pid_formula_sub', 'P = ΔT × (Kp / 2) | I = acc × Ki / 300 | D = Kd × ΔṪ / 20')}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {/* Proportional Gain Kp (FID 0x6080) */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <strong>{t('settings.zone_advanced.deviation_limit_title', 'Proportional Gain (Kp)')}</strong>
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
                {Number(kp).toFixed(2)}
              </span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
              {t('settings.zone_advanced.deviation_limit_desc')} <strong>0.50</strong>.
              <br />
              • <em>{t('common.interpretation', 'Interpretation')}</em>: {t('settings.zone_advanced.deviation_limit_interpretation')}
            </p>
            <input
              type="range"
              min="0.05"
              max="2.00"
              step="0.05"
              value={kp}
              onChange={(e) => setKp && setKp(Number(e.target.value))}
              disabled={isReadOnly}
              style={{ cursor: isReadOnly ? 'not-allowed' : 'pointer', width: '100%', marginTop: '0.25rem' }}
            />
          </div>

          {/* Integral Gain Ki (FID 0x60a0) */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <strong>{t('settings.zone_advanced.frost_protection_title', 'Integral Gain (Ki)')}</strong>
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
                {Number(ki).toFixed(2)}
              </span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
              {t('settings.zone_advanced.frost_protection_desc')} <strong>5.00</strong>.
              <br />
              • <em>{t('common.interpretation', 'Interpretation')}</em>: {t('settings.zone_advanced.frost_protection_interpretation')}
            </p>
            <input
              type="range"
              min="0.50"
              max="20.00"
              step="0.50"
              value={ki}
              onChange={(e) => setKi && setKi(Number(e.target.value))}
              disabled={isReadOnly}
              style={{ cursor: isReadOnly ? 'not-allowed' : 'pointer', width: '100%', marginTop: '0.25rem' }}
            />
          </div>

          {/* Derivative Gain Kd (FID 0x60c0) */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <strong>{t('settings.zone_advanced.baseline_temp_title', 'Derivative Gain (Kd)')}</strong>
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
                {Number(kd).toFixed(2)}
              </span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
              {t('settings.zone_advanced.baseline_temp_desc')}
              <br />
              • <em>{t('common.interpretation', 'Interpretation')}</em>: {t('settings.zone_advanced.baseline_temp_interpretation')} <strong>19.00</strong>.
            </p>
            <input
              type="range"
              min="0.00"
              max="40.00"
              step="0.50"
              value={kd}
              onChange={(e) => setKd && setKd(Number(e.target.value))}
              disabled={isReadOnly}
              style={{ cursor: isReadOnly ? 'not-allowed' : 'pointer', width: '100%', marginTop: '0.25rem' }}
            />
          </div>
        </div>

        {/* Interplay with Valve Sensitivity Callout */}
        <div style={{
          padding: '1rem',
          borderRadius: 'var(--radius-sm, 6px)',
          backgroundColor: 'rgba(59, 130, 246, 0.06)',
          border: '1px solid rgba(59, 130, 246, 0.25)',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--primary)' }}>
            <Activity size={16} />
            <strong style={{ fontSize: '0.85rem' }}>
              {t('settings.zone_advanced.pid_vs_valve_title', 'How Zone PID and Valve Sensitivity (0x4160) Interplay')}
            </strong>
          </div>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.5' }}>
            {t('settings.zone_advanced.pid_vs_valve_desc')}
          </p>
        </div>

        {/* Card Actions */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-color)', paddingTop: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
          <Button
            variant="secondary"
            onClick={handleResetPidDefaults}
            disabled={isReadOnly}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem' }}
          >
            <RotateCcw size={14} />
            {t('settings.zone_advanced.reset_pid_defaults', 'Reset PID Defaults (0.50 / 5.00 / 19.00)')}
          </Button>

          <Button
            variant="primary"
            onClick={handleSaveAdvancedDetails}
            disabled={isSavingAdvancedDetails || !isTuningDirty || isReadOnly}
            style={{ justifyContent: 'center', minWidth: '120px' }}
          >
            {isSavingAdvancedDetails ? t('settings.saving', 'Saving...') : t('common.save', 'Save')}
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