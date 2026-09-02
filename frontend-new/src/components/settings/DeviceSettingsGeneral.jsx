/**
 * @file src/components/settings/DeviceSettingsGeneral.jsx
 * @brief Renders the general configuration panels for a hardware device.
 * 
 * Includes form settings for friendly display names, connection error flags parsing,
 * battery chemistry selectors (alkaline vs NiMH), battery level display percentages,
 * and current zone (room) membership assignment select selectors.
 */


import Card from '../common/Card';
import Button from '../common/Button';
import { ShieldAlert } from 'lucide-react';

/**
 * @brief General device configuration sub-panel.
 * @param {object} props.device - Target hardware device details.
 * @param {string} props.friendlyNameInput - Active input text for friendly name.
 * @param {function} props.setFriendlyNameInput - Friendly name input state setter.
 * @param {function} props.handleSaveFriendlyName - Saving friendly name callback.
 * @param {boolean} props.isSavingFriendlyName - Progress indicator for friendly name updates.
 * @param {object} props.batteryInfo - Battery metrics payload.
 * @param {function} props.handleBatteryTypeChange - Battery chemistry type selector callback.
 * @param {boolean} props.isBridge - Whether target device is the Internet Bridge.
 * @param {string} props.assignedZoneId - Zone ID that device is currently assigned to.
 * @param {function} props.handleZoneChange - Zone assignment change callback.
 * @param {boolean} props.isChangingZone - Progress indicator for zone assignment update requests.
 * @param {boolean} props.isReadOnly - Whether view is read-only.
 * @param {Array} props.zones - List of home zones (rooms).
 * @param {function} props.t - Translation resolver hook.
 */
export default function DeviceSettingsGeneral({
  device,
  friendlyNameInput,
  setFriendlyNameInput,
  handleSaveFriendlyName,
  isSavingFriendlyName,
  batteryInfo,
  handleBatteryTypeChange,
  isBridge,
  assignedZoneId,
  handleZoneChange,
  isChangingZone,
  isReadOnly,
  zones,
  devices,
  circuits,
  handleRoleSelect,
  isChangingRole,
  t
}) {
  const isRU = Boolean(device?.deviceType?.startsWith('RU'));
  const isAssigned = device && device.zoneId !== null && device.zoneId !== undefined && device.zoneId !== 'none';
  const currentZone = isAssigned ? zones?.find(z => String(z.id) === String(device.zoneId)) : null;

  const isZoneController = Boolean(
    circuits?.some(c => (c.driver_serial_no === device?.serialNo || c.driverSerialNo === device?.serialNo)) ||
    currentZone?.devices?.some(d => d.serialNo === device?.serialNo && d.duties?.includes('CIRCUIT_DRIVER')) ||
    device?.duties?.includes('CIRCUIT_DRIVER')
  );

  const measuringLeader = currentZone?.devices?.find(d => d.duties?.includes('ZONE_LEADER'));
  const measuringSerial = currentZone?.measuringDeviceSerial || currentZone?.measuring_device_serial || measuringLeader?.serialNo;
  const isMeasuringDevice = Boolean(
    (measuringSerial && measuringSerial === device?.serialNo) ||
    measuringLeader?.serialNo === device?.serialNo ||
    device?.duties?.includes('ZONE_LEADER')
  );

  const zoneDevices = (devices || currentZone?.devices || []).filter(
    d => String(d.zoneId) === String(device?.zoneId) &&
         !d.deviceType?.startsWith('IB') &&
         !d.deviceType?.startsWith('GW') &&
         d.deviceType !== 'BRIDGE'
  );
  const isOnlyDeviceInZone = zoneDevices.length <= 1;

  const canUnassign = !isAssigned || Boolean(device?.isEmulated) || (!isZoneController && !isMeasuringDevice && !isOnlyDeviceInZone);
  return (
    <>
      {/* Friendly Name Card */}
      <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>{t('settings.friendly_name') || 'Friendly Name'}</h3>
        <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
          {t('settings.friendly_name_desc') || 'Assign a custom friendly name to this device.'}
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.25rem', flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder={device?.serialNo}
            value={friendlyNameInput}
            onChange={(e) => setFriendlyNameInput(e.target.value)}
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
            onClick={handleSaveFriendlyName} 
            disabled={isSavingFriendlyName}
            style={{ flex: '1 0 auto', justifyContent: 'center', minWidth: '80px' }}
          >
            {isSavingFriendlyName ? t('settings.saving') : t('common.save')}
          </Button>
        </div>
      </Card>

      {/* Device Metadata Card */}
      <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>{t('settings.device_metadata_conn')}</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', fontSize: '0.85rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--text-secondary)' }}>{t('settings.ip_address')}</span>
            <strong style={{ fontFamily: 'monospace' }}>{batteryInfo?.ipv6_address || 'N/A'}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
            <span style={{ color: 'var(--text-secondary)' }}>{t('settings.last_contact')}</span>
            <strong>{batteryInfo?.last_contact ? new Date(batteryInfo.last_contact).toLocaleString() : t('settings.never')}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
            <span style={{ color: 'var(--text-secondary)' }}>{t('settings.connection_status', { defaultValue: 'Connection Status' })}</span>
            <strong style={{ color: device?.connectionState?.value ? 'var(--success)' : 'var(--danger)' }}>
              {device?.connectionState?.value ? t('common.connected') : t('common.disconnected')}
            </strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
            <span style={{ color: 'var(--text-secondary)' }}>{t('settings.error_flags', { defaultValue: 'Error Flags' })}</span>
            {device?.errorFlags && device?.errorFlags !== 0 ? (
              <strong style={{ color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', gap: '0.35rem', textAlign: 'right' }}>
                <ShieldAlert size={15} style={{ color: 'var(--danger)', flexShrink: 0 }} />
                <span>{device.friendlyErrorFlags}</span>
              </strong>
            ) : (
              <strong style={{ color: 'var(--success)' }}>
                {t('common.none', { defaultValue: 'None' })}
              </strong>
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
            <span style={{ color: 'var(--text-secondary)' }}>{t('settings.emulated_device', { defaultValue: 'Emulated Device' })}</span>
            <strong style={{ color: device?.isEmulated ? 'var(--primary)' : 'var(--text-primary)' }}>
              {device?.isEmulated ? t('common.yes', { defaultValue: 'Yes' }) : t('common.no', { defaultValue: 'No' })}
            </strong>
          </div>
          {!isBridge && !device?.isEmulated && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>{t('settings.battery_type')}</span>
                <select
                  value={batteryInfo?.battery_type || 'alkaline'}
                  onChange={(e) => handleBatteryTypeChange(e.target.value)}
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    border: '1px solid var(--border-color)',
                    color: 'var(--text-primary)',
                    padding: '0.25rem 0.5rem',
                    borderRadius: 'var(--radius-sm)',
                    outline: 'none',
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    cursor: 'pointer'
                  }}
                >
                  <option value="alkaline">{t('settings.alkaline')}</option>
                  <option value="nimh">{t('settings.nimh')}</option>
                </select>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>{t('settings.battery_percent')}</span>
                <strong>{batteryInfo?.battery_percent !== null && batteryInfo?.battery_percent !== undefined ? `${batteryInfo.battery_percent}%` : t('common.na')}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>{t('settings.battery_state')}</span>
                <span style={{
                  color: ['LOW', 'CRITICAL', 'DEPLETED'].includes(batteryInfo?.battery_state) ? 'var(--danger)' : 'var(--success)',
                  fontWeight: 700
                }}>
                  {
                    batteryInfo?.battery_state === 'LOW' ? t('common.low') :
                    batteryInfo?.battery_state === 'CRITICAL' ? t('common.critical') :
                    batteryInfo?.battery_state === 'DEPLETED' ? t('common.depleted') :
                    batteryInfo?.battery_state === 'GOOD' ? t('common.good') :
                    t('common.normal')
                  }
                </span>
              </div>
            </>
          )}
        </div>
      </Card>

      {/* Device Role Card (RU devices) */}
      {isRU && (
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>{t('settings.device_role', 'Device Role')}</h3>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
            {t('settings.device_role_desc', 'Configure whether this device acts as a Wired Thermostat (Heating & Boiler Controller) or a Wireless Temperature Sensor.')}
          </p>

          {device?.isEmulated ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', backgroundColor: 'var(--bg-input)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)' }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>{t('settings.role_wireless_sensor_emulated', 'Wireless Temperature Sensor (Emulated RU)')}</span>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <Button
                variant={(device?.field_015d === 71 || (!device?.field_015d && device?.deviceRole !== 'WIRELESS_SENSOR')) ? 'primary' : 'secondary'}
                onClick={() => handleRoleSelect && handleRoleSelect(71)}
                disabled={isChangingRole || isReadOnly}
                style={{ fontSize: '0.85rem', padding: '0.4rem 0.8rem' }}
              >
                {t('settings.role_wired_thermostat', 'Wired Thermostat (71)')}
              </Button>
              <Button
                variant={(device?.field_015d === 200 || device?.deviceRole === 'WIRELESS_SENSOR') ? 'primary' : 'secondary'}
                onClick={() => handleRoleSelect && handleRoleSelect(200)}
                disabled={isChangingRole || isReadOnly}
                style={{ fontSize: '0.85rem', padding: '0.4rem 0.8rem' }}
              >
                {t('settings.role_wireless_sensor', 'Wireless Sensor (200)')}
              </Button>
            </div>
          )}
        </Card>
      )}

      {/* Zone Assignment Card */}
      {!isBridge && (
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>{t('settings.zone_assignment')}</h3>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
            {t('settings.assign_zone_desc')}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <select
              value={assignedZoneId}
              onChange={handleZoneChange}
              disabled={isChangingZone || isReadOnly}
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.5rem',
                borderRadius: 'var(--radius-sm)',
                outline: 'none',
                fontWeight: 600,
                cursor: 'pointer',
                width: '100%'
              }}
            >
              {canUnassign && (
                <option value="none">{t('settings.unassigned_none')}</option>
              )}
              {zones
                ?.filter(z => z.type !== 'HOT_WATER')
                ?.map(z => {
                  const isCurrentZone = String(device?.zoneId) === String(z.id);
                  const roomDevCount = (devices || []).filter(d => d.zoneId === z.id && !d.deviceType?.startsWith('IB') && !d.deviceType?.startsWith('GW') && d.deviceType !== 'BRIDGE').length;
                  const isFull = !isCurrentZone && roomDevCount >= 7;
                  return (
                    <option key={z.id} value={z.id.toString()} disabled={isFull}>
                      {z.name} {isFull ? `- ${t('settings.room_full', 'Full (7 devices max)')}` : `(${roomDevCount}/7)`}
                    </option>
                  );
                })}
              {(() => {
                const heatingRoomsCount = (zones || []).filter(z => z.type === 'HEATING').length;
                const isRoomsFull = heatingRoomsCount >= 25;
                return (
                  <option value="create_new" disabled={isRoomsFull}>
                    {t('settings.create_new_zone_option')} {isRoomsFull ? `- (25/25 max)` : ''}
                  </option>
                );
              })()}
            </select>
          </div>
        </Card>
      )}
    </>
  );
}
