/**
 * @file src/components/settings/ZoneSettingsOverlay.jsx
 * @brief Renders the defaults options form for manual overlay duration settings.
 * 
 * Allows users to choose between TADO_MODE (until next auto change), MANUAL (until user resumes schedule),
 * or TIMER (timed fallback duration selection in seconds).
 */


import Card from '../common/Card';

/**
 * @brief Manual control defaults settings sub-panel.
 * @param {string} props.overlayType - Target overlay type ('TADO_MODE', 'MANUAL', 'TIMER').
 * @param {number} props.overlayDuration - Timer length duration in seconds.
 * @param {function} props.handleOverlayTypeChange - Radio picker click callback hook.
 * @param {function} props.handleOverlayDurationChange - Duration select picker change hook.
 * @param {function} props.t - Translation resolver hook.
 */
export default function ZoneSettingsOverlay({
  overlayType,
  overlayDuration,
  handleOverlayTypeChange,
  handleOverlayDurationChange,
  t
}) {
  return (
    <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>{t('settings.manual_control_defaults')}</h3>
      <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
        {t('settings.manual_control_desc')}
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', cursor: 'pointer' }}>
          <input 
            type="radio" 
            name="overlayType" 
            value="TADO_MODE"
            checked={overlayType === 'TADO_MODE'}
            onChange={() => handleOverlayTypeChange('TADO_MODE')}
          />
          <span>{t('settings.until_next_auto_change')}</span>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', cursor: 'pointer' }}>
          <input 
            type="radio" 
            name="overlayType" 
            value="MANUAL"
            checked={overlayType === 'MANUAL'}
            onChange={() => handleOverlayTypeChange('MANUAL')}
          />
          <span>{t('settings.until_resume_manual')}</span>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', cursor: 'pointer' }}>
          <input 
            type="radio" 
            name="overlayType" 
            value="TIMER"
            checked={overlayType === 'TIMER'}
            onChange={() => handleOverlayTypeChange('TIMER')}
          />
          <span>{t('settings.timer_duration')}</span>
        </label>

        {overlayType === 'TIMER' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', paddingLeft: '1.25rem' }}>
            <select
              value={overlayDuration}
              onChange={(e) => handleOverlayDurationChange(Number(e.target.value))}
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.35rem 0.5rem',
                borderRadius: 'var(--radius-sm)',
                outline: 'none',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              <option value={900}>{t('settings.duration_15m')}</option>
              <option value={1800}>{t('settings.duration_30m')}</option>
              <option value={3600}>{t('settings.duration_1h')}</option>
              <option value={7200}>{t('settings.duration_2h')}</option>
              <option value={14400}>{t('settings.duration_4h')}</option>
            </select>
          </div>
        )}
      </div>
    </Card>
  );
}
