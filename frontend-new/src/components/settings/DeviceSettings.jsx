/**
 * @file src/components/settings/DeviceSettings.jsx
 * @brief Consolidated manager details screen for a single physical hardware device.
 * 
 * Fetches real-time connection info, binds sub-components (DeviceSettingsGeneral, DeviceSettingsChild,
 * DeviceAdvancedSettings), handles device identification flashing triggers, pairs new/re-paired devices
 * via bridge link states, and coordinates zone membership migrations.
 */

import { SWR_KEYS } from '../../utils/swrKeys';
import { useState, useEffect } from 'react';
import useSWR from 'swr';
import Card from '../common/Card';
import Button from '../common/Button';
import Spinner from '../common/Spinner';
import Toggle from '../common/Toggle';
import Modal from '../common/Modal';
import ConfirmModal from '../common/ConfirmModal';
import { 
  getDevice, getDevices, identifyDevice, updateChildLock, 
  updateOrientation, deleteDevice, 
  startPairing, stopPairing, updateActuatorLimits,
  updateFriendlyName, updateDisplaySettings,
  rebootDevice, refreshRfKey, refreshDeviceConfig
} from '../../api/devices';
import { 
  addDeviceToZone, removeDeviceFromZone, createZone 
} from '../../api/zones';
import { 
  getDeviceBatteryData, getBridge, updateDeviceBatteryType, getCircuits
} from '../../api/tanoclo';
import { useHome } from '../../context/HomeContext';
import { 
  ArrowLeft, Eye, EyeOff, ShieldAlert, 
  Trash2, Radio 
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import logger from '../../utils/logger';
import { useToast } from '../../context/ToastContext';

import DeviceSettingsGeneral from './DeviceSettingsGeneral';
import DeviceSettingsChild from './DeviceSettingsChild';
import DeviceAdvancedSettings from './DeviceAdvancedSettings';
import DeviceNeighborsTable from './DeviceNeighborsTable';

/**
 * @brief Unified device settings page component.
 * @param {number} props.homeId - Active home identifier.
 * @param {number} props.deviceId - Target device serial number / identifier.
 * @param {function} props.onBack - Navigation back action callback.
 * @param {function} props.mutateDevices - Mutation hook to reload devices list.
 */
export default function DeviceSettings({ homeId, deviceId, onBack, mutateDevices }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [view, setView] = useState('main');
  const getDeviceTypeLabel = (type) => {
    if (!type) return '';
    if (type.startsWith('VA02')) return t('settings.va02_type');
    if (type.startsWith('RU')) return t('settings.ru02_type');
    if (type.startsWith('IB') || type === 'GW' || type === 'BRIDGE') return t('settings.ib01_type');
    if (type.startsWith('BU')) return t('settings.bu01_type');
    return `${type} ${t('settings.thermostat')}`;
  };
  const { data: device, error, mutate } = useSWR(
    homeId && deviceId ? SWR_KEYS.deviceDetails(homeId, deviceId) : null,
    () => getDevice(homeId, deviceId)
  );

  const isBridge = device?.deviceType?.startsWith('IB') || device?.deviceType === 'GW' || device?.deviceType === 'BRIDGE';

  // Fetch battery/metadata for all devices (to find this specific device's IP, battery type, last contact, etc.)
  const { data: batteryData, mutate: mutateBattery } = useSWR(
    homeId ? SWR_KEYS.batteryDevicesRaw(homeId) : null,
    () => getDeviceBatteryData(homeId)
  );

  // Fetch bridge details if it is a bridge
  const { data: bridge, mutate: mutateBridge } = useSWR(
    homeId && isBridge ? SWR_KEYS.bridge(homeId) : null,
    () => getBridge(homeId)
  );

  // Fetch all devices list
  const { data: allDevices } = useSWR(
    homeId ? SWR_KEYS.devices(homeId) : null,
    () => getDevices(homeId)
  );

  // Fetch all circuits in the home
  const { data: circuits } = useSWR(
    homeId ? `/homes/${homeId}/tanoclo/circuits` : null,
    () => getCircuits(homeId)
  );

  const { zones, mutateZones, homeInfo } = useHome();
  const isReadOnly = (homeInfo?.configReadonly ?? homeInfo?.zoneConfigReadonly) && !homeInfo?.devBypass;

  const [childLock, setChildLock] = useState(false);
  const [orientation, setOrientation] = useState('VERTICAL');
  const [isIdentifying, setIsIdentifying] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  
  const [lowSteps, setLowSteps] = useState(0);
  const [highSteps, setHighSteps] = useState(0);
  const [driveConstant, setDriveConstant] = useState(0);
  const [isSavingLimits, setIsSavingLimits] = useState(false);

  const [friendlyNameInput, setFriendlyNameInput] = useState('');
  const [isSavingFriendlyName, setIsSavingFriendlyName] = useState(false);

  // Display Settings States
  const [displayBrightness, setDisplayBrightness] = useState(112);
  const [displayContrast, setDisplayContrast] = useState(128);
  const [displayActiveTimeout, setDisplayActiveTimeout] = useState(0);
  const [isSavingDisplay, setIsSavingDisplay] = useState(false);

  // Zone assignment states
  const [assignedZoneId, setAssignedZoneId] = useState('none');
  const [isChangingZone, setIsChangingZone] = useState(false);

  // Create zone states
  const [isCreateZoneOpen, setIsCreateZoneOpen] = useState(false);
  const [newZoneName, setNewZoneName] = useState('');
  const [isCreatingZone, setIsCreatingZone] = useState(false);

  // RF configuration states
  const [showRfKey, setShowRfKey] = useState(false);
  const [isTogglingPairing, setIsTogglingPairing] = useState(false);

  const [isConfirmDeleteOpen, setIsConfirmDeleteOpen] = useState(false);
  const [confirmZoneChangeData, setConfirmZoneChangeData] = useState(null); // { targetValue, name }

  useEffect(() => {
    if (device) {
      setChildLock(prev => prev !== (device.childLockEnabled ?? false) ? (device.childLockEnabled ?? false) : prev);
      setOrientation(prev => prev !== (device.orientation ?? 'VERTICAL') ? (device.orientation ?? 'VERTICAL') : prev);
      const zoneIdStr = device.zoneId !== null && device.zoneId !== undefined ? device.zoneId.toString() : 'none';
      setAssignedZoneId(prev => prev !== zoneIdStr ? zoneIdStr : prev);
      setFriendlyNameInput(prev => prev !== (device.friendlyName || '') ? (device.friendlyName || '') : prev);
      setDisplayBrightness(prev => prev !== (device.displayBrightness ?? 112) ? (device.displayBrightness ?? 112) : prev);
      setDisplayContrast(prev => prev !== (device.displayContrast ?? 128) ? (device.displayContrast ?? 128) : prev);
      setDisplayActiveTimeout(prev => prev !== (device.displayActiveTimeout ?? 0) ? (device.displayActiveTimeout ?? 0) : prev);
      if (device.actuatorLimits) {
        setLowSteps(prev => prev !== (device.actuatorLimits.lowSteps ?? 0) ? (device.actuatorLimits.lowSteps ?? 0) : prev);
        setHighSteps(prev => prev !== (device.actuatorLimits.highSteps ?? 0) ? (device.actuatorLimits.highSteps ?? 0) : prev);
        setDriveConstant(prev => prev !== (device.actuatorLimits.driveConstant ?? 0) ? (device.actuatorLimits.driveConstant ?? 0) : prev);
      }
    }
  }, [device]);

  const handleSaveDisplay = async () => {
    if (isReadOnly) return;
    setIsSavingDisplay(true);
    try {
      await updateDisplaySettings(homeId, deviceId, {
        displayBrightness: Number(displayBrightness),
        displayContrast: Number(displayContrast),
        displayActiveTimeout: Number(displayActiveTimeout)
      });
      showToast(t('settings.display_saved_success'), 'success');
      mutate();
    } catch (e) {
      logger.error('Failed to save display settings:', e);
      showToast(t('settings.display_saved_error'), 'error');
    } finally {
      setIsSavingDisplay(false);
    }
  };

  const handleSaveFriendlyName = async () => {
    setIsSavingFriendlyName(true);
    try {
      await updateFriendlyName(homeId, device.serialNo, friendlyNameInput || null);
      showToast(t('settings.friendly_name_updated'));
      await Promise.all([
        mutate(),
        mutateDevices ? mutateDevices() : Promise.resolve()
      ]);
    } catch (err) {
      logger.error('Failed to update friendly name:', err);
      showToast(err.message || t('settings.failed_update_friendly_name'), 'error');
    } finally {
      setIsSavingFriendlyName(false);
    }
  };

  const handleZoneChange = (e) => {
    const targetValue = e.target.value;
    if (targetValue === 'create_new') {
      const heatingRoomsCount = (zones || []).filter(z => z.type === 'HEATING').length;
      if (heatingRoomsCount >= 25) {
        showToast(t('settings.error_max_rooms_reached'), 'error');
        return;
      }
      setIsCreateZoneOpen(true);
      return;
    }

    if (targetValue === 'none') {
      const isAssigned = device && device.zoneId !== null && device.zoneId !== undefined && device.zoneId !== 'none';
      if (isAssigned) {
        const currentZone = zones?.find(z => String(z.id) === String(device.zoneId));
        const isZoneController = Boolean(
          circuits?.some(c => (c.driver_serial_no === device.serialNo || c.driverSerialNo === device.serialNo)) ||
          currentZone?.devices?.some(d => d.serialNo === device.serialNo && d.duties?.includes('CIRCUIT_DRIVER')) ||
          device.duties?.includes('CIRCUIT_DRIVER')
        );
        const measuringLeader = currentZone?.devices?.find(d => d.duties?.includes('ZONE_LEADER'));
        const measuringSerial = currentZone?.measuringDeviceSerial || currentZone?.measuring_device_serial || measuringLeader?.serialNo;
        const isMeasuringDevice = Boolean(
          (measuringSerial && measuringSerial === device.serialNo) ||
          measuringLeader?.serialNo === device.serialNo ||
          device.duties?.includes('ZONE_LEADER')
        );
        const zoneDevices = (allDevices || currentZone?.devices || []).filter(
          d => String(d.zoneId) === String(device.zoneId) &&
               !d.deviceType?.startsWith('IB') &&
               !d.deviceType?.startsWith('GW') &&
               d.deviceType !== 'BRIDGE'
        );
        const isOnlyDeviceInZone = zoneDevices.length <= 1;

        if (isZoneController || isMeasuringDevice || isOnlyDeviceInZone) {
          showToast(t('settings.error_cannot_unassign_device', { defaultValue: 'Device cannot be unassigned from zone.' }), 'error');
          return;
        }
      }
    } else {
      const targetZoneId = parseInt(targetValue, 10);
      const roomDevCount = (allDevices || []).filter(d => d.zoneId === targetZoneId && !d.deviceType?.startsWith('IB') && !d.deviceType?.startsWith('GW') && d.deviceType !== 'BRIDGE').length;
      if (!isBridge && roomDevCount >= 7 && String(device.zoneId) !== String(targetZoneId)) {
        showToast(t('settings.error_max_room_devices_reached'), 'error');
        return;
      }
    }

    const targetName = targetValue === 'none'
      ? (t('settings.unassigned_none') || 'Unassigned')
      : (zones?.find(item => item.id.toString() === targetValue)?.name || 'Unknown');

    setConfirmZoneChangeData({ targetValue, name: targetName });
    // Keep selection visual state on original until confirmed
    setAssignedZoneId(device.zoneId !== null && device.zoneId !== undefined ? device.zoneId.toString() : 'none');
  };

  const handleCreateZoneAndAssign = (e) => {
    e.preventDefault();
    if (!newZoneName) return;
    const heatingRoomsCount = (zones || []).filter(z => z.type === 'HEATING').length;
    if (heatingRoomsCount >= 25) {
      showToast(t('settings.error_max_rooms_reached'), 'error');
      return;
    }
    setIsCreateZoneOpen(false);
    setConfirmZoneChangeData({ targetValue: 'create_new', name: newZoneName });
  };

  const handleConfirmZoneChange = async () => {
    if (!confirmZoneChangeData) return;
    const { targetValue, name } = confirmZoneChangeData;
    setConfirmZoneChangeData(null);

    setIsChangingZone(true);
    try {
      if (targetValue === 'create_new') {
        setIsCreatingZone(true);
        const newZone = await createZone(homeId, { name, type: 'HEATING' });
        const newZoneId = newZone.id;
        await addDeviceToZone(homeId, newZoneId, device.serialNo);
        setNewZoneName('');
      } else if (targetValue === 'none') {
        if (device.zoneId) {
          await removeDeviceFromZone(homeId, device.zoneId, device.serialNo);
        }
      } else {
        const targetZoneId = parseInt(targetValue, 10);
        await addDeviceToZone(homeId, targetZoneId, device.serialNo);
      }

      await Promise.all([
        mutate(),
        mutateZones(),
        mutateDevices ? mutateDevices() : Promise.resolve()
      ]);
      showToast(t('settings.zone_change_success'));
    } catch (err) {
      logger.error('Failed to change zone assignment:', err);
      showToast(err.message || t('settings.failed_change_zone'), 'error');
      // Revert selection state
      setAssignedZoneId(device.zoneId !== null && device.zoneId !== undefined ? device.zoneId.toString() : 'none');
    } finally {
      setIsChangingZone(false);
      setIsCreatingZone(false);
    }
  };

  const [showPairingWarningModal, setShowPairingWarningModal] = useState(false);

  const handleTogglePairing = async (enabled) => {
    if (enabled) {
      setShowPairingWarningModal(true);
      return;
    }
    setIsTogglingPairing(true);
    try {
      await stopPairing(homeId, device.serialNo);
      await mutateBridge();
    } catch (e) {
      logger.error('Failed to toggle bridge pairing:', e);
      showToast(e.message || t('settings.failed_disable_pairing'), 'error');
    } finally {
      setIsTogglingPairing(false);
    }
  };

  const handleConfirmPairing = async () => {
    setShowPairingWarningModal(false);
    setIsTogglingPairing(true);
    try {
      await startPairing(homeId, device.serialNo);
      showToast(t('tanoclo_ex.pairing_auto_timeout_active'), 'warning');
      await mutateBridge();
    } catch (e) {
      logger.error('Failed to enable bridge pairing:', e);
      showToast(e.message || t('settings.failed_enable_pairing'), 'error');
    } finally {
      setIsTogglingPairing(false);
    }
  };

  const handleIdentify = async () => {
    setIsIdentifying(true);
    try {
      await identifyDevice(homeId, deviceId);
      showToast(t('settings.led_blink_sent'));
      setTimeout(() => {
        setIsIdentifying(false);
      }, 10000);
    } catch (err) {
      logger.error('Failed to identify:', err);
      showToast(t('settings.failed_identify_device'), 'error');
      setIsIdentifying(false);
    }
  };

  const handleChildLockToggle = async (enabled) => {
    setChildLock(enabled);
    try {
      await updateChildLock(homeId, deviceId, enabled);
      mutate();
    } catch (err) {
      logger.error('Failed to toggle child lock:', err);
      setChildLock(!enabled);
    }
  };

  const handleOrientationChange = async (orient) => {
    const prev = orientation;
    setOrientation(orient);
    try {
      await updateOrientation(homeId, deviceId, orient);
      mutate();
    } catch (err) {
      logger.error('Failed to change orientation:', err);
      setOrientation(prev);
      showToast(err.message || t('settings.failed_change_orientation', 'Failed to change display orientation.'), 'error');
    }
  };

  const handleSaveActuatorLimits = async () => {
    const numLow = Number(lowSteps);
    const numHigh = Number(highSteps);
    const numDrive = Number(driveConstant);

    if (numLow < numHigh) {
      showToast(t('settings.actuator_limits.err_low_lt_high', 'Low Steps (close limit) cannot be lower than High Steps (open limit).'), 'error');
      return;
    }
    if (numHigh < numDrive || numLow < numDrive) {
      showToast(t('settings.actuator_limits.err_lt_drive', 'High and Low Steps cannot be lower than Drive Constant baseline.'), 'error');
      return;
    }

    setIsSavingLimits(true);
    try {
      await updateActuatorLimits(homeId, deviceId, {
        lowSteps: numLow,
        highSteps: numHigh,
        driveConstant: numDrive
      });
      showToast(t('settings.actuator_limits.saved'));
      mutate();
    } catch (err) {
      logger.error('Failed to save actuator limits:', err);
      showToast(err.message || t('settings.actuator_limits.save_failed'), 'error');
    } finally {
      setIsSavingLimits(false);
    }
  };

  const handleBatteryTypeChange = async (valOrEvent) => {
    const newBatteryType = typeof valOrEvent === 'string' ? valOrEvent : valOrEvent?.target?.value;
    if (!newBatteryType) return;
    try {
      const res = await updateDeviceBatteryType(homeId, device.serialNo, newBatteryType);
      if (res && res.batteryPercent !== undefined && batteryData) {
        mutateBattery(
          batteryData.map(b => b.serial_no === device.serialNo ? {
            ...b,
            battery_type: newBatteryType,
            battery_percent: res.batteryPercent,
            battery_state: res.batteryState ?? b.battery_state
          } : b),
          false
        );
      }
      await mutateBattery();
    } catch (err) {
      logger.error('Failed to update battery chemistry:', err);
      showToast(t('settings.failed_update_battery'), 'error');
    }
  };

  const handleDelete = () => {
    if (device?.deviceType?.startsWith('RU')) {
      showToast(t('settings.ru_reconfigure_remove_warning'), "error");
      return;
    }
    setIsConfirmDeleteOpen(true);
  };

  const handleConfirmDelete = async () => {
    setIsConfirmDeleteOpen(false);
    setIsDeleting(true);
    try {
      await deleteDevice(homeId, deviceId);
      if (mutateDevices) {
        await mutateDevices();
      }
      onBack();
    } catch (err) {
      logger.error('Failed to delete device:', err);
      setIsDeleting(false);
      showToast(err.message || t('settings.failed_delete_device'), 'error');
    }
  };

  if (error) return <div style={{ color: 'var(--danger)', padding: '1rem' }}>{t('settings.device_failed_load')}</div>;
  if (!device) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%', maxWidth: '800px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minHeight: '42px' }}>
          <Button variant="secondary" onClick={onBack} style={{ width: '32px', height: '32px', padding: 0, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <ArrowLeft size={16} />
          </Button>
          <div>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, lineHeight: 1.2 }}>{t('common.loading')}</h2>
          </div>
        </div>
        <div style={{ padding: '3rem', textAlign: 'center' }}><Spinner size={24} /></div>
      </div>
    );
  }

  const isValve = device.deviceType?.startsWith('VA');
  const hasChildLock = isValve;
  const hasOrientation = device.deviceType === 'VA02';

  const batteryInfo = batteryData?.find(b => b.serial_no === device.serialNo);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%', maxWidth: '800px' }}>
      
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minHeight: '42px' }}>
        <Button variant="secondary" onClick={view === 'advanced' ? () => setView('main') : onBack} style={{ width: '32px', height: '32px', padding: 0, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <ArrowLeft size={16} />
        </Button>
        <div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, lineHeight: 1.2 }}>
            {view === 'advanced' ? `Advanced Settings • ${device.friendlyName || device.serialNo}` : (device.friendlyName || device.serialNo)}
          </h2>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'block' }}>
            {view === 'advanced' ? "Tuning parameters and display options" : `${getDeviceTypeLabel(device.deviceType)} • ${t('settings.serial_label', { serial: device.serialNo })}`}
          </span>
        </div>
      </div>

      {/* Read-Only Notice */}
      {isReadOnly && (
        <div 
          role="status"
          style={{
            backgroundColor: 'rgba(234, 179, 8, 0.1)',
            border: '1px solid rgba(234, 179, 8, 0.3)',
            color: '#eab308',
            padding: '0.85rem 1rem',
            borderRadius: 'var(--radius-md, 8px)',
            fontSize: '0.875rem',
            lineHeight: '1.4',
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem'
          }}
        >
          <ShieldAlert size={18} style={{ flexShrink: 0 }} />
          <div>
            <strong style={{ fontWeight: 600 }}>{t('settings.readonly_notice_title')}</strong>: {t('settings.readonly_notice_desc')}
          </div>
        </div>
      )}

      {view === 'advanced' ? (
        <DeviceAdvancedSettings 
          homeId={homeId}
          deviceId={deviceId}
          isValve={isValve}
          device={device}
          lowSteps={lowSteps}
          setLowSteps={setLowSteps}
          highSteps={highSteps}
          setHighSteps={setHighSteps}
          driveConstant={driveConstant}
          setDriveConstant={setDriveConstant}
          handleSaveActuatorLimits={handleSaveActuatorLimits}
          isSavingLimits={isSavingLimits}
          displayBrightness={displayBrightness}
          setDisplayBrightness={setDisplayBrightness}
          displayContrast={displayContrast}
          setDisplayContrast={setDisplayContrast}
          displayActiveTimeout={displayActiveTimeout}
          setDisplayActiveTimeout={setDisplayActiveTimeout}
          handleSaveDisplay={handleSaveDisplay}
          isSavingDisplay={isSavingDisplay}
          isReadOnly={isReadOnly}
          t={t}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          
          {/* Friendly Name, Metadata, Zone Assignment */}
          <DeviceSettingsGeneral 
            device={device}
            friendlyNameInput={friendlyNameInput}
            setFriendlyNameInput={setFriendlyNameInput}
            handleSaveFriendlyName={handleSaveFriendlyName}
            isSavingFriendlyName={isSavingFriendlyName}
            batteryInfo={batteryInfo}
            handleBatteryTypeChange={handleBatteryTypeChange}
            isBridge={isBridge}
            assignedZoneId={assignedZoneId}
            handleZoneChange={handleZoneChange}
            isChangingZone={isChangingZone}
            isReadOnly={isReadOnly}
            zones={zones}
            devices={allDevices}
            circuits={circuits}
            t={t}
          />

          {/* RF Config (Bridges) */}
          {isBridge && bridge && (
            <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>{t('settings.rf_config')}</h3>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', fontSize: '0.85rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{t('settings.rf_encryption_key')}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <strong style={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>
                      {showRfKey ? (bridge.field_0155 || 'None') : '••••••••••••••••'}
                    </strong>
                    <button 
                      onClick={() => setShowRfKey(!showRfKey)}
                      style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', padding: 0 }}
                    >
                      {showRfKey ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                    <Button 
                      variant="secondary" 
                      onClick={async () => {
                        try {
                          await refreshRfKey(homeId, device.serialNo);
                          showToast(t('settings.rf_key_refresh_sent'));
                        } catch (e) {
                          showToast(e.message || t('settings.failed_refresh_rf_key'), 'error');
                        }
                      }}
                      style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}
                    >
                      {t('common.refresh')}
                    </Button>
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
                <div>
                  <strong>{t('settings.pairing_mode')}</strong>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                    {t('settings.allow_new_devices_desc')}
                  </p>
                </div>
                <Toggle 
                  checked={Boolean(bridge.in_pairing_mode)} 
                  onChange={handleTogglePairing} 
                  disabled={isTogglingPairing}
                />
              </div>
              
              <div style={{ 
                fontSize: '0.75rem', 
                color: bridge.in_pairing_mode ? 'var(--warning)' : 'var(--text-muted)',
                backgroundColor: bridge.in_pairing_mode ? 'var(--warning-glow)' : 'var(--bg-input)',
                padding: '0.5rem 0.75rem',
                borderRadius: 'var(--radius-sm)',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem'
              }}>
                <Radio size={14} className={bridge.in_pairing_mode ? 'pulse-icon' : ''} />
                <span>{bridge.in_pairing_mode ? t('tanoclo_ex.pairing_broadcasting') : t('tanoclo_ex.pairing_locked')}</span>
              </div>
            </Card>
          )}

          {/* IB Neighbors Table */}
          {isBridge && (
            <DeviceNeighborsTable
              homeId={homeId}
              ibDeviceId={deviceId}
              neighborData={device?.neighborData}
              allDevices={allDevices || []}
              onSelectDevice={(_targetSerial) => {
                // If callback provided by parent or route
                if (typeof window !== 'undefined' && window.location) {
                  // mutate SWR keys and re-render with new target device
                  mutateDevices && mutateDevices();
                  mutate && mutate();
                }
              }}
              isReadOnly={isReadOnly}
              mutateDevice={mutate}
            />
          )}

          {/* Diagnostic Actions */}
          {!device?.isEmulated && (
            <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>{t('settings.diagnostic_actions')}</h3>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <strong>{t('settings.identify_device')}</strong>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                    {t('settings.identify_device_desc')}
                  </p>
                </div>
                <Button variant="secondary" onClick={handleIdentify} disabled={isIdentifying}>
                  <Eye size={14} />
                  <span>{isIdentifying ? t('settings.identify_blinking') : t('settings.identify_blink_display')}</span>
                </Button>
              </div>

              {/* Reboot Button */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
                <div>
                  <strong>{t('settings.reboot_device', 'Reboot Device')}</strong>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                    {t('settings.reboot_device_desc', { name: device.friendlyName || device.serialNo })}
                  </p>
                </div>
                <Button 
                  variant="secondary" 
                  onClick={async () => {
                    try {
                      await rebootDevice(homeId, device.serialNo);
                      showToast(t('settings.reboot_sent'));
                    } catch (e) {
                      showToast(e.message || t('settings.failed_reboot'), 'error');
                    }
                  }}
                >
                  {t('settings.reboot')}
                </Button>
              </div>

              {/* Force Sync Config */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
                <div>
                  <strong>{t('settings.force_config_sync')}</strong>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                    {t('settings.force_config_sync_desc')}
                  </p>
                </div>
                <Button 
                  variant="secondary" 
                  onClick={async () => {
                    try {
                      await refreshDeviceConfig(homeId, device.serialNo);
                      showToast(t('settings.config_refresh_sent'));
                    } catch (e) {
                      showToast(e.message || t('settings.failed_config_refresh'), 'error');
                    }
                  }}
                >
                  {t('settings.sync_config')}
                </Button>
              </div>
            </Card>
          )}


          {/* Child Lock, Orientation */}
          <DeviceSettingsChild 
            hasChildLock={hasChildLock}
            childLock={childLock}
            handleChildLockToggle={handleChildLockToggle}
            hasOrientation={hasOrientation}
            orientation={orientation}
            handleOrientationChange={handleOrientationChange}
            isBridge={isBridge}
            isReadOnly={isReadOnly}
            t={t}
          />

          {/* Advanced Settings Click-through */}
          {!device?.isEmulated && (
            <Card 
              onClick={() => setView('advanced')} 
              style={{ 
                padding: '1.25rem', 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center',
                cursor: 'pointer',
                border: '1px solid var(--border-color)',
                transition: 'border-color var(--transition-fast), background-color var(--transition-fast)'
              }}
              className="advanced-settings-link"
            >
              <div>
                <strong style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <ShieldAlert size={16} style={{ color: 'var(--warning)' }} />
                  {t('settings.advanced_settings')}
                </strong>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                  {t('settings.device_advanced.warning_desc')}
                </p>
              </div>
              <span style={{ fontSize: '1.25rem', color: 'var(--text-muted)' }}>&rarr;</span>
            </Card>
          )}

          {/* Delete/Remove Device Card */}
          {!isBridge && (
            <Card style={{ padding: '1.25rem', border: '1px solid var(--danger-glow)', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0, color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <ShieldAlert size={16} />
                {t('settings.danger_zone')}
              </h3>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <strong>{t('settings.remove_device')}</strong>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                    {t('settings.remove_device_desc')}
                  </p>
                </div>
                <Button variant="destructive" onClick={handleDelete} disabled={isDeleting || (isReadOnly && !device?.deviceType?.startsWith('RU'))}>
                  <Trash2 size={14} />
                  <span>{isDeleting ? t('settings.deleting') : t('settings.delete_device')}</span>
                </Button>
              </div>
            </Card>
          )}

        </div>
      )}

      {/* Create Zone Modal */}
      <Modal isOpen={isCreateZoneOpen} onClose={() => setIsCreateZoneOpen(false)} title={t('settings.create_zone_title')}>
        <form onSubmit={handleCreateZoneAndAssign} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0 }}>
            {t('settings.create_zone_desc')}
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.zone_name')}</label>
            <input 
              type="text"
              placeholder={t('settings.zone_name_placeholder')}
              value={newZoneName}
              onChange={(e) => setNewZoneName(e.target.value)}
              required
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.5rem 0.75rem',
                borderRadius: 'var(--radius-sm)',
                outline: 'none',
                fontWeight: 600
              }}
            />
          </div>

          {/* Zone Type is always HEATING */}

          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
            <Button type="button" variant="secondary" onClick={() => setIsCreateZoneOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={isCreatingZone}>
              <span>{isCreatingZone ? t('settings.creating') : t('settings.create_assign')}</span>
            </Button>
          </div>
        </form>
      </Modal>

      {/* Confirm Delete Modal */}
      <ConfirmModal 
        isOpen={isConfirmDeleteOpen}
        onClose={() => setIsConfirmDeleteOpen(false)}
        onConfirm={handleConfirmDelete}
        title={t('settings.danger_zone')}
        message={t('settings.confirm_delete_device', { deviceId })}
        confirmText={t('settings.delete_device')}
        cancelText={t('common.cancel')}
        variant="destructive"
      />

      {/* Confirm Zone Change Modal */}
      <ConfirmModal
        isOpen={!!confirmZoneChangeData}
        onClose={() => {
          setConfirmZoneChangeData(null);
          setAssignedZoneId(device.zoneId !== null && device.zoneId !== undefined ? device.zoneId.toString() : 'none');
        }}
        onConfirm={handleConfirmZoneChange}
        title={t('settings.confirm_zone_change_title') || 'Confirm Zone Change'}
        message={confirmZoneChangeData ? (
          confirmZoneChangeData.targetValue === 'create_new'
            ? (t('settings.confirm_create_zone_assign', { zoneName: confirmZoneChangeData.name }) || `Are you sure you want to create the zone "${confirmZoneChangeData.name}" and assign this device to it?`)
            : (t('settings.confirm_change_zone', { zoneName: confirmZoneChangeData.name }) || `Are you sure you want to move this device to "${confirmZoneChangeData.name}"?`)
        ) : ''}
        confirmText={t('common.confirm') || 'Confirm'}
        cancelText={t('common.cancel')}
        variant="primary"
      />

      {/* Security Warning Modal for Pairing Mode */}
      <Modal
        isOpen={showPairingWarningModal}
        onClose={() => setShowPairingWarningModal(false)}
        title={t('tanoclo_ex.pairing_warning_title')}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={{
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid var(--warning, #ef4444)',
            borderRadius: 'var(--radius-md)',
            padding: '1rem',
            display: 'flex',
            gap: '0.75rem',
            alignItems: 'flex-start'
          }}>
            <ShieldAlert size={24} style={{ color: 'var(--warning, #ef4444)', flexShrink: 0, marginTop: '2px' }} />
            <div style={{ fontSize: '0.85rem', lineHeight: 1.5, color: 'var(--text-primary)' }}>
              <p style={{ margin: '0 0 0.5rem 0', fontWeight: 600 }}>
                {t('tanoclo_ex.pairing_warning_body_1')}
              </p>
              <p style={{ margin: '0 0 0.5rem 0' }}>
                {t('tanoclo_ex.pairing_warning_body_2')}
              </p>
              <p style={{ margin: 0, fontStyle: 'italic', color: 'var(--text-secondary)' }}>
                {t('tanoclo_ex.pairing_warning_timeout_note')}
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
            <Button type="button" variant="secondary" onClick={() => setShowPairingWarningModal(false)}>
              {t('tanoclo_ex.pairing_warning_cancel')}
            </Button>
            <Button type="button" variant="primary" style={{ backgroundColor: 'var(--warning, #ef4444)', borderColor: 'var(--warning, #ef4444)' }} onClick={handleConfirmPairing} disabled={isTogglingPairing}>
              <span>{t('tanoclo_ex.pairing_warning_confirm')}</span>
            </Button>
          </div>
        </div>
      </Modal>

    </div>
  );
}
