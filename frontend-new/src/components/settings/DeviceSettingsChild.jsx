/**
 * @file src/components/settings/DeviceSettingsChild.jsx
 * @brief Renders hardware child lock, orientation, and valve sensitivity configurations for VA02/RU02 valves.
 */

import Card from '../common/Card';
import Toggle from '../common/Toggle';

/**
 * @brief Hardware child lock and orientation sub-panel.
 * @param {boolean} props.hasChildLock - Whether target device model supports lock features.
 * @param {boolean} props.childLock - Active child lock status.
 * @param {function} props.handleChildLockToggle - Callback handler for toggling child lock.
 * @param {boolean} props.hasOrientation - Whether target device model displays support orientation rotation.
 * @param {string} props.orientation - Active orientation mode (VERTICAL/HORIZONTAL).
 * @param {function} props.handleOrientationChange - Orientation change callback handler.
 * @param {boolean} props.isValve - Whether target device is a radiator valve actuator (VA).
 * @param {number} props.valveSensitivity - Valve demand scale denominator (50-100, default 100).
 * @param {function} props.setValveSensitivity - Setter for valve sensitivity local state.
 * @param {function} props.handleValveSensitivityChange - Callback handler for saving valve sensitivity.
 * @param {boolean} props.isSavingValveSensitivity - Whether valve sensitivity is currently saving.
 * @param {boolean} props.isBridge - Whether target device is a bridge.
 * @param {boolean} props.isReadOnly - Whether client view permission is read-only.
 * @param {function} props.t - Translation resolver hook.
 */
export default function DeviceSettingsChild({
  hasChildLock,
  childLock,
  handleChildLockToggle,
  hasOrientation,
  orientation,
  handleOrientationChange,
  isValve,
  valveSensitivity = 100,
  setValveSensitivity,
  handleValveSensitivityChange,
  isSavingValveSensitivity = false,
  isBridge,
  isReadOnly,
  t
}) {
  return (
    <>
      {/* Hardware Settings Card (Valves/Thermostats) */}
      {!isBridge && (hasChildLock || hasOrientation || isValve) && (
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>{t('settings.hardware_control')}</h3>

          {/* Child Lock (VA02 / RU02 only) */}
          {hasChildLock && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
              <div>
                <strong>{t('settings.child_lock')}</strong>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                  {t('settings.child_lock_desc')}
                </p>
              </div>
              <Toggle checked={childLock} onChange={handleChildLockToggle} />
            </div>
          )}

          {/* Orientation settings (VA02) */}
          {hasOrientation && (
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              borderTop: '1px solid var(--border-color)',
              paddingTop: '1rem',
              opacity: isReadOnly ? 0.6 : 1
            }}>
              <div>
                <strong>{t('settings.display_orientation')}</strong>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                  {t('settings.display_orientation_desc')}
                </p>
              </div>
              <div style={{
                display: 'flex',
                backgroundColor: 'var(--bg-input)',
                padding: '2px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-color)'
              }}>
                {['VERTICAL', 'HORIZONTAL'].map((o) => (
                  <button
                    key={o}
                    disabled={isReadOnly}
                    onClick={() => !isReadOnly && handleOrientationChange(o)}
                    style={{
                      padding: '0.3rem 0.6rem',
                      border: 'none',
                      backgroundColor: orientation === o ? 'var(--bg-card-hover)' : 'transparent',
                      color: orientation === o ? 'var(--text-primary)' : 'var(--text-secondary)',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      borderRadius: '4px',
                      cursor: isReadOnly ? 'not-allowed' : 'pointer'
                    }}
                  >
                    {o === 'VERTICAL' ? t('settings.orientation_vertical') : t('settings.orientation_horizontal')}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Valve Sensitivity Scaling (VA01 / VA02) */}
          {isValve && (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '0.75rem',
              borderTop: '1px solid var(--border-color)',
              paddingTop: '1rem',
              opacity: isReadOnly ? 0.6 : 1
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <strong>{t('settings.valve_sensitivity')}</strong>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                    {t('settings.valve_sensitivity_desc')}
                  </p>
                </div>
                <div style={{ textAlign: 'right', minWidth: '100px', flexShrink: 0 }}>
                  <span style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--primary-light)' }}>
                    {valveSensitivity === 100 ? '1.00× (100%)' : `${(100 / (valveSensitivity || 100)).toFixed(2)}× (${valveSensitivity}%)`}
                  </span>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                    {valveSensitivity === 100
                      ? t('settings.valve_sensitivity_standard')
                      : valveSensitivity < 100
                        ? `+${Math.round((100 / (valveSensitivity || 100) - 1) * 100)}% boost`
                        : `-${Math.round((1 - 100 / valveSensitivity) * 100)}% throttle`}
                  </div>
                </div>
              </div>

              {/* Quick Presets */}
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {[
                  { label: '50% (2.00×)', val: 50 },
                  { label: '70% (1.43×)', val: 70 },
                  { label: '85% (1.18×)', val: 85 },
                  { label: '100% (1.00×)', val: 100 },
                  { label: '125% (0.80×)', val: 125 },
                  { label: '150% (0.67×)', val: 150 },
                  { label: '200% (0.50×)', val: 200 },
                ].map((p) => (
                  <button
                    key={p.val}
                    type="button"
                    disabled={isReadOnly || isSavingValveSensitivity}
                    onClick={() => !isReadOnly && handleValveSensitivityChange && handleValveSensitivityChange(p.val)}
                    style={{
                      padding: '0.3rem 0.6rem',
                      border: '1px solid var(--border-color)',
                      backgroundColor: valveSensitivity === p.val ? 'var(--primary-dark, #2563eb)' : 'var(--bg-input)',
                      color: valveSensitivity === p.val ? '#fff' : 'var(--text-primary)',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      borderRadius: 'var(--radius-sm, 6px)',
                      cursor: isReadOnly || isSavingValveSensitivity ? 'not-allowed' : 'pointer',
                      transition: 'all 0.15s ease'
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              {/* Slider for fine adjustment */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <input
                  type="range"
                  min={25}
                  max={200}
                  step={1}
                  value={valveSensitivity || 100}
                  disabled={isReadOnly || isSavingValveSensitivity}
                  onChange={(e) => setValveSensitivity && setValveSensitivity(Number(e.target.value))}
                  onMouseUp={(e) => !isReadOnly && handleValveSensitivityChange && handleValveSensitivityChange(Number(e.target.value))}
                  onTouchEnd={(e) => !isReadOnly && handleValveSensitivityChange && handleValveSensitivityChange(Number(e.target.value))}
                  onKeyUp={(e) => !isReadOnly && handleValveSensitivityChange && handleValveSensitivityChange(Number(e.target.value))}
                  style={{
                    width: '100%',
                    height: '6px',
                    borderRadius: '3px',
                    backgroundColor: 'var(--bg-input)',
                    outline: 'none',
                    cursor: isReadOnly || isSavingValveSensitivity ? 'not-allowed' : 'pointer'
                  }}
                />
              </div>
            </div>
          )}
        </Card>
      )}
    </>
  );
}