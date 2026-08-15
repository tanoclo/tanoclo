/**
 * @file src/pages/settings/ServerSettingsPanel.jsx
 * @brief Dispatcher settings component grouping server/physical environment attributes.
 * 
 * Groups sub-panels for Zone configurations, Device registries (pairing physical TRVs/valves/bridges),
 * Boiler Circuits settings, Flow/Supply Temperature configurations (SupplyTempSettings),
 * and Raw Object DB inspectors (RawExplorerSettings).
 */

import React from 'react';
import Card from '../../components/common/Card';
import ListItem from '../../components/common/ListItem';
import Button from '../../components/common/Button';
import { Settings, Calendar, Smartphone, AlertTriangle, Plus } from 'lucide-react';
import SupplyTempSettings from '../../components/settings/SupplyTempSettings';
import BoilerCircuitsSettings from '../../components/settings/BoilerCircuitsSettings';
import RawExplorerSettings from '../../components/settings/RawExplorerSettings';

const MemoizedSupplyTempSettings = React.memo(SupplyTempSettings);
const MemoizedBoilerCircuitsSettings = React.memo(BoilerCircuitsSettings);
const MemoizedRawExplorerSettings = React.memo(RawExplorerSettings);

/**
 * @brief Renders the Server/Hardware Settings panel selector.
 * @param {string} props.activeSection - Currently active tab key.
 * @param {string} props.activeHomeId - Target home identifier.
 * @param {Array} props.zones - List of home zones.
 * @param {Array} props.devices - List of physical devices.
 * @param {URLSearchParams} props.searchParams - Active window search params.
 * @param {function} props.setSearchParams - React search params setter.
 * @param {function} props.setIsAddDeviceOpen - Trigger function to open AddDeviceModal.
 * @param {boolean} props.isReadOnly - Whether configuration is read-only.
 * @param {function} props.t - Internationalization translation resolver.
 */
export default function ServerSettingsPanel({
  activeSection,
  activeHomeId,
  zones,
  devices,
  searchParams,
  setSearchParams,
  setIsAddDeviceOpen,
  isReadOnly,
  t
}) {
  switch (activeSection) {
    case 'zones': {
      const heatingRoomsCount = (zones || []).filter(z => z.type === 'HEATING').length;
      const zcRoomsCount = (zones || []).filter(z => z.type === 'HEATING' && (z.heatingCircuit !== null && z.heatingCircuit !== undefined && z.heatingCircuit !== '')).length;
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%', maxWidth: '800px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: '42px' }}>
            <div>
              <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, lineHeight: 1.2 }}>{t('settings.zones_settings')}</h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
                {t('settings.manage_zones_desc')} • {heatingRoomsCount}/25 {t('settings.heating_zones', { defaultValue: 'Zones' })} ({zcRoomsCount}/10 {t('settings.zone_controllers_assigned', { defaultValue: 'with Zone Controller' })})
              </p>
            </div>
          </div>

          <Card style={{ padding: 0, overflow: 'hidden' }}>
            {zones?.map(zone => (
              <div key={zone.id} style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--border-color)' }}>
                <div style={{ flex: 1 }}>
                  <ListItem
                    icon={<Settings size={18} style={{ color: zone.type === 'HOT_WATER' ? 'var(--secondary)' : 'var(--primary)' }} />}
                    title={zone.name}
                    subtitle={`${zone.type === 'HOT_WATER' ? t('settings.hot_water_zone') : t('settings.heating_zone')} • ${zone.devices?.length || 0} ${(zone.devices?.length || 0) === 1 ? t('settings.device_count_singular') : t('settings.device_count_plural')}`}
                    onClick={() => {
                      const nextParams = new URLSearchParams(searchParams);
                      nextParams.set('roomId', zone.id);
                      setSearchParams(nextParams);
                    }}
                    style={{ borderBottom: 'none' }}
                  />
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const nextParams = new URLSearchParams(searchParams);
                    nextParams.set('section', 'smart-schedule');
                    nextParams.set('scheduleZoneId', zone.id);
                    setSearchParams(nextParams);
                  }}
                  title={t('schedule.title')}
                  style={{
                    padding: '0.75rem 1rem',
                    background: 'none',
                    border: 'none',
                    color: 'var(--primary)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'color var(--transition-fast)'
                  }}
                >
                  <Calendar size={20} />
                </button>
              </div>
            ))}
            {(!zones || zones.length === 0) && (
              <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                {t('settings.no_zones_configured')}
              </div>
            )}
          </Card>
        </div>
      );
    }

    case 'devices': {
      const heatingDevicesCount = (devices || []).filter(d => !d.deviceType?.startsWith('IB') && !d.deviceType?.startsWith('GW') && d.deviceType !== 'BRIDGE').length;
      const isMaxHeatingDevices = heatingDevicesCount >= 25;
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%', maxWidth: '800px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: '42px' }}>
            <div>
              <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, lineHeight: 1.2 }}>{t('settings.devices_settings')}</h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
                {t('settings.register_devices_desc')} • {heatingDevicesCount}/25 {t('settings.heating_devices', { defaultValue: 'Heating Devices' })}
              </p>
            </div>
            <Button variant="primary" onClick={() => setIsAddDeviceOpen(true)} style={{ padding: '0.4rem 0.85rem', fontSize: '0.85rem' }} disabled={isReadOnly || isMaxHeatingDevices}>
              <Plus size={16} />
              <span>{t('settings.add_device')}</span>
            </Button>
          </div>

          <Card style={{ padding: 0, overflow: 'hidden' }}>
            {devices?.map(d => {
              const isBridge = d.deviceType?.startsWith('IB') || d.deviceType === 'GW' || d.deviceType === 'BRIDGE';
              const assignedZone = zones?.find(z => z.id === d.zoneId);
              const subtitleParts = [];
              if (!isBridge) {
                subtitleParts.push(assignedZone ? t('settings.assigned_to', { name: assignedZone.name }) : t('settings.unassigned'));
              }
              subtitleParts.push(t('settings.firmware_version', { version: d.currentFwVersion }));
              const subtitle = subtitleParts.join(' • ');
              const hasError = Boolean(d.errorFlags && d.errorFlags !== 0);
              const title = (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                  <span>{d.friendlyName ? `${d.friendlyName} (${d.serialNo})` : d.serialNo}</span>
                  {hasError && (
                    <AlertTriangle 
                      size={15} 
                      style={{ color: 'var(--error)', flexShrink: 0 }} 
                      title={d.friendlyErrorFlags} 
                    />
                  )}
                </span>
              );
              return (
                <ListItem
                  key={d.serialNo}
                  icon={<Smartphone size={18} style={{ color: d.connectionState?.value ? 'var(--success)' : 'var(--text-muted)' }} />}
                  title={title}
                  subtitle={subtitle}
                  onClick={() => {
                    const nextParams = new URLSearchParams(searchParams);
                    nextParams.set('deviceId', d.serialNo);
                    setSearchParams(nextParams);
                  }}
                />
              );
            })}
            {(!devices || devices.length === 0) && (
              <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                {t('settings.no_devices_registered')}
              </div>
            )}
          </Card>
        </div>
      );
    }

    case 'flow-temp':
      return <MemoizedSupplyTempSettings homeId={activeHomeId} />;

    case 'boiler-circuits':
      return <MemoizedBoilerCircuitsSettings />;

    case 'raw-explorer':
      return <MemoizedRawExplorerSettings />;

    default:
      return null;
  }
}
