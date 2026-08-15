/**
 * @file src/components/settings/ZoneSettingsGeneral.jsx
 * @brief Renders the general configuration panels for a heating zone.
 * 
 * Includes fields for room display names, primary measuring device selection selectors,
 * temperature offset calibration inputs, and zone controller device assignments.
 */


import Card from '../common/Card';
import Button from '../common/Button';
import Slider from '../common/Slider';

/**
 * @brief General zone settings sub-panel.
 * @param {object} props.zone - Active zone (room) details.
 * @param {boolean} props.isDhw - Whether target zone is Domestic Hot Water.
 * @param {string} props.name - Current text value for name input.
 * @param {function} props.setName - Name input state setter.
 * @param {function} props.handleSaveName - Save name callback.
 * @param {boolean} props.isSavingName - Progress indicator for name updates.
 * @param {boolean} props.isReadOnly - Read-only view flag.
 * @param {string} props.measuringDeviceSerial - Serial number of primary measuring device.
 * @param {function} props.handleMeasuringDeviceChange - Measuring device selector change callback.
 * @param {function} props.getDeviceDisplayName - Device display name helper utility.
 * @param {number} props.offset - Temperature offset correction in Celsius.
 * @param {function} props.setOffset - Offset change callback.
 * @param {string} props.controllerSerial - Serial number of zone controller device.
 * @param {function} props.handleControllerChange - Zone controller change callback.
 * @param {Array} props.devices - Paired home devices.
 * @param {function} props.onNavigateToDevice - Navigation callback to focus on a single device page.
 * @param {function} props.t - Translation resolver hook.
 */
export default function ZoneSettingsGeneral({
  zone,
  isDhw,
  name,
  setName,
  handleSaveName,
  isSavingName,
  isReadOnly,
  measuringDeviceSerial,
  handleMeasuringDeviceChange,
  getDeviceDisplayName,
  offset,
  setOffset,
  controllerSerial,
  handleControllerChange,
  devices,
  zones,
  onNavigateToDevice,
  t
}) {
  return (
    <>
      {/* Name input */}
      <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>{t('settings.room_name') || 'Zone Name'}</h3>
        <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
          {t('settings.room_name_desc') || 'Assign a custom name to this zone.'}
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.25rem', flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder={zone?.name}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            style={{
              flex: '1 1 200px',
              backgroundColor: 'var(--bg-input)',
              border: '1px solid var(--border-color)',
              color: 'var(--text-primary)',
              padding: '0.5rem 0.75rem',
              borderRadius: 'var(--radius-sm)',
              outline: 'none',
              fontWeight: 600,
              fontSize: '0.9rem',
              minWidth: '150px'
            }}
          />
          <Button 
            variant="primary" 
            onClick={handleSaveName} 
            disabled={isSavingName || !name.trim() || name === zone?.name}
            style={{ flex: '1 0 auto', justifyContent: 'center', minWidth: '80px' }}
          >
            {isSavingName ? t('settings.saving') : t('common.save')}
          </Button>
        </div>
      </Card>

      {/* Measuring Device (Heating only) */}
      {!isDhw && (
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.measuring_device')}</label>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
            {t('settings.measuring_device_desc')}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <select
              value={measuringDeviceSerial}
              onChange={(e) => handleMeasuringDeviceChange(e.target.value)}
              disabled={isReadOnly}
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.5rem',
                borderRadius: 'var(--radius-sm)',
                outline: 'none',
                fontWeight: 600,
                cursor: isReadOnly ? 'not-allowed' : 'pointer',
                width: '100%'
              }}
            >
              <option value="" disabled>{t('settings.select_measuring_device')}</option>
              {zone?.devices?.map(d => (
                <option key={d.serialNo} value={d.serialNo}>
                  {getDeviceDisplayName(d.serialNo)}
                </option>
              ))}
            </select>
          </div>
        </Card>
      )}

      {/* Temperature Offset (Heating only) - Saves to active measuring device */}
      {!isDhw && measuringDeviceSerial && (
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <strong>{t('settings.temp_offset')}</strong>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                {t('settings.temp_offset_desc')}
              </p>
            </div>
            <span style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--primary)' }}>
              {offset > 0 ? `+${offset}` : offset}°C
            </span>
          </div>
          <Slider
            min={-9.9}
            max={9.9}
            step={0.1}
            value={offset}
            onChange={setOffset}
            disabled={isReadOnly}
          />
        </Card>
      )}

      {/* Zone controller (Heating only) */}
      {!isDhw && (
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.zone_controller')}</label>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
            {t('settings.zone_controller_desc')}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <select
              value={controllerSerial}
              onChange={(e) => handleControllerChange(e.target.value)}
              disabled={isReadOnly}
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.5rem',
                borderRadius: 'var(--radius-sm)',
                outline: 'none',
                fontWeight: 600,
                cursor: isReadOnly ? 'not-allowed' : 'pointer',
                width: '100%'
              }}
            >
              <option value="none">{t('settings.none_no_controller')}</option>
              {(() => {
                const zoneControllers = devices?.filter(d => d.deviceType?.startsWith('RU') || d.deviceType?.startsWith('WR')) || [];
                const zcRoomsCount = (zones || []).filter(z => z.type === 'HEATING' && (z.heatingCircuit !== null && z.heatingCircuit !== undefined && z.heatingCircuit !== '') && z.id !== zone?.id).length;
                const isZcFull = zcRoomsCount >= 10 && (!controllerSerial || controllerSerial === 'none');
                return zoneControllers.map(ctrl => (
                  <option key={ctrl.serialNo} value={ctrl.serialNo} disabled={isZcFull}>
                    {getDeviceDisplayName(ctrl.serialNo)} {isZcFull ? `- (10/10 max)` : ''}
                  </option>
                ));
              })()}
            </select>
          </div>
        </Card>
      )}

      {/* Linked Device Card (DHW only) */}
      {isDhw && (
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>{t('settings.linked_device')}</h3>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
            {t('settings.linked_device_desc')}
          </p>
          
          {((isDhw ? zone?.devices : devices?.filter(d => d.zoneId === zone?.id)) || []).map(d => (
            <div 
              key={d.serialNo}
              onClick={() => onNavigateToDevice && onNavigateToDevice(d.serialNo)}
              className="device-link-card"
              style={{ 
                padding: '0.75rem 1rem', 
                border: '1px solid var(--border-color)', 
                borderRadius: 'var(--radius-sm)',
                backgroundColor: 'var(--bg-input)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                cursor: onNavigateToDevice ? 'pointer' : 'default'
              }}
            >
              <div>
                <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>{getDeviceDisplayName(d.serialNo)}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('settings.status_connected_role')}</div>
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              </div>
            </div>
          ))}

          {((isDhw ? zone?.devices : devices?.filter(d => d.zoneId === zone?.id)) || []).length === 0 && (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center', padding: '1rem' }}>
              {t('settings.no_controller_linked')}
            </div>
          )}
        </Card>
      )}

      {/* Devices list registered to zone (Heating only) */}
      {!isDhw && (
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>{t('settings.devices')}</h3>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
            {t('settings.zone_devices_desc')}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {devices?.filter(d => d.zoneId === zone?.id).map(d => (
              <div 
                key={d.serialNo}
                onClick={() => onNavigateToDevice && onNavigateToDevice(d.serialNo)}
                className="device-link-card"
                style={{ 
                  padding: '0.75rem 1rem', 
                  border: '1px solid var(--border-color)', 
                  borderRadius: 'var(--radius-sm)',
                  backgroundColor: 'var(--bg-input)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  cursor: onNavigateToDevice ? 'pointer' : 'default'
                }}
              >
                <div>
                  <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>{getDeviceDisplayName(d.serialNo)}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('settings.firmware_version', { version: d.currentFwVersion })}</div>
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                </div>
              </div>
            ))}
            {devices?.filter(d => d.zoneId === zone?.id).length === 0 && (
              <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center', padding: '1rem' }}>
                {t('settings.no_devices_linked')}
              </div>
            )}
          </div>
        </Card>
      )}
    </>
  );
}
