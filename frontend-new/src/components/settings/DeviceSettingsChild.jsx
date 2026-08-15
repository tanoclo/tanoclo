/**
 * @file src/components/settings/DeviceSettingsChild.jsx
 * @brief Renders hardware child lock and orientation configurations for VA02/RU02 valves.
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
  isBridge,
  isReadOnly,
  t
}) {
  return (
    <>
      {/* Hardware Settings Card (Valves/Thermostats) */}
      {!isBridge && (hasChildLock || hasOrientation) && (
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
        </Card>
      )}
    </>
  );
}
