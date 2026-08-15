/**
 * @file src/components/settings/ZoneSettings.jsx
 * @brief Consolidated manager details screen for Zone settings.
 * 
 * Fetches and configures zone parameters (room name, early start adaptation heating,
 * LED dazzle modes, offline schedule caches, open window detection sources, default overlay options,
 * temperature offsets, and heating circuits assignments).
 */

import { SWR_KEYS } from '../../utils/swrKeys';
import { useState, useEffect, useCallback } from 'react';
import useSWR from 'swr';
import Card from '../common/Card';
import Button from '../common/Button';
import Spinner from '../common/Spinner';
import Toggle from '../common/Toggle';

import {
  updateZoneDetails, updateEarlyStart, updateDazzle,
  updateOpenWindowDetection, updateDefaultOverlay, getDefaultOverlay,
  getZoneControl, updateMeasuringDevice, updateHeatingCircuit,
  updateOfflineSchedule, syncOfflineSchedule, updateTaNoCloOwdSettings
} from '../../api/zones';
import { getDevices, updateTemperatureOffset } from '../../api/devices';
import { getCircuits } from '../../api/tanoclo';
import { updateHeatingCircuitDriver } from '../../api/heating';
import { useHome } from '../../context/HomeContext';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import logger from '../../utils/logger';
import { useToast } from '../../context/ToastContext';

import ZoneSettingsGeneral from './ZoneSettingsGeneral';

import ZoneSettingsOverlay from './ZoneSettingsOverlay';
import ZoneAdvancedSettings from './ZoneAdvancedSettings';

/**
 * @brief Unified zone settings page component.
 * @param {number} props.homeId - Active home identifier.
 * @param {number} props.zoneId - Target zone identifier.
 * @param {object} props.zone - Current zone metadata payload.
 * @param {function} props.onBack - Navigation back action callback.
 * @param {function} props.mutateZones - Mutation hook callback to reload zones context lists.
 * @param {function} props.onNavigateToDevice - Focus view redirection to device settings pages.
 */
export default function ZoneSettings({ homeId, zoneId, zone, onBack, mutateZones, onNavigateToDevice }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const triggerToast = useCallback((msg, type = 'success') => showToast(msg, type), [showToast]);
  const { zones, mutateZones: _mutateZones, homeInfo } = useHome();
  const isReadOnly = (homeInfo?.configReadonly ?? homeInfo?.zoneConfigReadonly) && !homeInfo?.devBypass;

  const [view, setView] = useState('main');
  const [isSavingAdvancedDetails, setIsSavingAdvancedDetails] = useState(false);

  const handleSaveAdvancedDetails = async () => {
    try {
      setIsSavingAdvancedDetails(true);
      await updateZoneDetails(homeId, zoneId, {
        name: zone?.name || name,
        type: zone?.type,
        frostMinTemperature: parseFloat(frostMinTemperature),
        temperatureBaseline: parseFloat(temperatureBaseline)
      });
      if (mutateZones) await mutateZones();
      triggerToast(t('settings.zone_updated_success'), 'success');
    } catch (err) {
      logger.error(err);
      triggerToast(err.message || t('settings.failed_save_settings'), 'error');
    } finally {
      setIsSavingAdvancedDetails(false);
    }
  };


  const getDeviceDisplayName = (serial) => {
    const d = devices?.find(x => x.serialNo === serial);
    if (d?.friendlyName) {
      return `${d.friendlyName} (${serial})`;
    }
    return serial;
  };
  const isDhw = zone?.type === 'HOT_WATER' || zone?.type === 'DHW';
  const [name, setName] = useState(zone?.name || '');
  const [earlyStart, setEarlyStart] = useState(zone?.earlyStartEnabled || false);
  const [dazzle, setDazzle] = useState(zone?.dazzleEnabled || false);
  const [offlineScheduleEnabled, setOfflineScheduleEnabled] = useState(zone?.offlineScheduleEnabled || false);
  const [openWindow, setOpenWindow] = useState(zone?.openWindowDetection?.enabled ?? true);
  const [owdTimeout, setOwdTimeout] = useState(900); // 15 mins default
  const [temperatureDeviationLimit, setTemperatureDeviationLimit] = useState(0.50);
  const [owdNvmState, setOwdNvmState] = useState(1);
  const [frostMinTemperature, setFrostMinTemperature] = useState(5.00);
  const [temperatureBaseline, setTemperatureBaseline] = useState(19.00);
  const [tanocloOwdEnabled, setTaNoCloOwdEnabled] = useState(zone?.tanocloOwdEnabled || false);
  const [owdSource, setOwdSource] = useState(zone?.tanocloOwdSource || 'device');

  const [overlayType, setOverlayType] = useState('TADO_MODE'); // TADO_MODE | TIMER | MANUAL
  const [overlayDuration, setOverlayDuration] = useState(1800); // 30 mins default

  const [measuringDeviceSerial, setMeasuringDeviceSerial] = useState('');
  const [controllerSerial, setControllerSerial] = useState('none');
  const [offset, setOffset] = useState(0);

  const [isSaving, setIsSaving] = useState(false);

  // Fetch zone default overlay settings
  const { data: defaultOverlayData } = useSWR(
    homeId && (zoneId !== null && zoneId !== undefined) ? SWR_KEYS.defaultOverlay(homeId, zoneId) : null,
    () => getDefaultOverlay(homeId, zoneId)
  );

  // Fetch all devices in the home
  const { data: devices, mutate: mutateDevices } = useSWR(
    homeId ? SWR_KEYS.devices(homeId) : null,
    () => getDevices(homeId)
  );

  // Fetch all circuits in the home
  const { data: circuits } = useSWR(
    homeId ? `/homes/${homeId}/tanoclo/circuits` : null,
    () => getCircuits(homeId)
  );

  // Fetch zone control configuration (heating circuit info & duties.leader)
  const { data: controlData, mutate: mutateControl } = useSWR(
    homeId && (zoneId !== null && zoneId !== undefined) ? SWR_KEYS.zoneControl(homeId, zoneId) : null,
    () => getZoneControl(homeId, zoneId)
  );

  useEffect(() => {
    if (zone) {
      setName(prev => prev !== zone.name ? zone.name : prev);
      setEarlyStart(prev => prev !== (zone.earlyStartEnabled || false) ? (zone.earlyStartEnabled || false) : prev);
      setDazzle(prev => prev !== (zone.dazzleEnabled || false) ? (zone.dazzleEnabled || false) : prev);
      setOpenWindow(prev => prev !== (zone.openWindowDetection?.enabled ?? true) ? (zone.openWindowDetection?.enabled ?? true) : prev);
      setOwdTimeout(prev => prev !== (zone.openWindowDetection?.timeoutInSeconds || 900) ? (zone.openWindowDetection?.timeoutInSeconds || 900) : prev);
      setTemperatureDeviationLimit(prev => prev !== (zone.openWindowDetection?.temperatureDeviationLimit ?? 0.50) ? (zone.openWindowDetection?.temperatureDeviationLimit ?? 0.50) : prev);
      setOwdNvmState(prev => prev !== (zone.openWindowDetection?.owdNvmState ?? 1) ? (zone.openWindowDetection?.owdNvmState ?? 1) : prev);
      setFrostMinTemperature(prev => prev !== (zone.frostMinTemperature ?? 5.00) ? (zone.frostMinTemperature ?? 5.00) : prev);
      setTemperatureBaseline(prev => prev !== (zone.temperatureBaseline ?? 19.00) ? (zone.temperatureBaseline ?? 19.00) : prev);
      setTaNoCloOwdEnabled(prev => prev !== (zone.tanocloOwdEnabled || false) ? (zone.tanocloOwdEnabled || false) : prev);
      setOwdSource(prev => prev !== (zone.tanocloOwdSource || 'device') ? (zone.tanocloOwdSource || 'device') : prev);
      setOfflineScheduleEnabled(prev => prev !== (zone.offlineScheduleEnabled || false) ? (zone.offlineScheduleEnabled || false) : prev);
    }
  }, [zone]);

  useEffect(() => {
    const term = defaultOverlayData?.terminationCondition || defaultOverlayData?.termination;
    if (term) {
      setOverlayType(prev => prev !== (term.type || 'TADO_MODE') ? (term.type || 'TADO_MODE') : prev);
      setOverlayDuration(prev => prev !== (term.durationInSeconds || 1800) ? (term.durationInSeconds || 1800) : prev);
    }
  }, [defaultOverlayData]);

  useEffect(() => {
    if (controlData && circuits) {
      const leaderSerial = controlData.duties?.leader?.serialNo || '';
      setMeasuringDeviceSerial(prev => prev !== leaderSerial ? leaderSerial : prev);
      const activeCircuitNum = controlData.heatingCircuit;
      if (activeCircuitNum !== null && activeCircuitNum !== undefined) {
        const activeCirc = circuits.find(c => c.number === activeCircuitNum);
        const targetSerial = (activeCirc && activeCirc.driver_serial_no) ? activeCirc.driver_serial_no : 'none';
        setControllerSerial(prev => prev !== targetSerial ? targetSerial : prev);
      } else {
        setControllerSerial(prev => prev !== 'none' ? 'none' : prev);
      }
    } else if (zone) {
      const leader = zone.devices?.find(d => d.duties?.includes('ZONE_LEADER'));
      const leaderSerial = leader?.serialNo || '';
      setMeasuringDeviceSerial(prev => prev !== leaderSerial ? leaderSerial : prev);
      const leaderCtrl = zone.devices?.find(d => d.deviceType?.startsWith('RU') || d.deviceType?.startsWith('WR'));
      const ctrlSerial = leaderCtrl?.serialNo || 'none';
      setControllerSerial(prev => prev !== ctrlSerial ? ctrlSerial : prev);
    }
  }, [controlData, zone, circuits]);

  // Check if selected measuring device is a leader type (RU or WR)
  const selectedDeviceObj = devices?.find(d => d.serialNo === measuringDeviceSerial);
  const isLeaderDeviceType = selectedDeviceObj && (
    selectedDeviceObj.deviceType?.startsWith('RU') ||
    selectedDeviceObj.deviceType?.startsWith('WR')
  );

  useEffect(() => {
    if (selectedDeviceObj) {
      const targetOffset = selectedDeviceObj.temperatureOffset ?? 0;
      setOffset(prev => prev !== targetOffset ? targetOffset : prev);
    }
  }, [selectedDeviceObj]);

  const handleSaveName = async () => {
    if (!name || name.trim() === '' || name === zone?.name) return;
    try {
      setIsSaving(true);
      await updateZoneDetails(homeId, zoneId, { name: name.trim(), type: zone.type });
      if (mutateZones) await mutateZones();
      triggerToast(t('settings.zone_updated_success'), 'success');
    } catch (err) {
      logger.error(err);
      triggerToast(err.message || t('settings.failed_save_settings'), 'error');
      setName(zone?.name || '');
    } finally {
      setIsSaving(false);
    }
  };

  const [_isSavingDetails, setIsSavingDetails] = useState(false);

  const _handleSaveDetails = async () => {
    if (!name || name.trim() === '') return;
    try {
      setIsSavingDetails(true);
      await updateZoneDetails(homeId, zoneId, {
        name: name.trim(),
        type: zone.type,
        frostMinTemperature: parseFloat(frostMinTemperature),
        temperatureBaseline: parseFloat(temperatureBaseline)
      });
      if (mutateZones) await mutateZones();
      triggerToast(t('settings.zone_updated_success'), 'success');
    } catch (err) {
      logger.error(err);
      triggerToast(err.message || t('settings.failed_save_settings'), 'error');
    } finally {
      setIsSavingDetails(false);
    }
  };

  const handleOwdDeviationChange = async (val) => {
    const prev = temperatureDeviationLimit;
    setTemperatureDeviationLimit(val);
    try {
      setIsSaving(true);
      await updateOpenWindowDetection(homeId, zoneId, openWindow, owdTimeout, val, owdNvmState);
      if (mutateZones) await mutateZones();
      triggerToast(t('settings.zone_updated_success'), 'success');
    } catch (err) {
      logger.error(err);
      setTemperatureDeviationLimit(prev);
      triggerToast(err.message || t('settings.failed_save_settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleOwdNvmStateToggle = async (val) => {
    const prev = owdNvmState;
    setOwdNvmState(val);
    try {
      setIsSaving(true);
      await updateOpenWindowDetection(homeId, zoneId, openWindow, owdTimeout, temperatureDeviationLimit, val);
      if (mutateZones) await mutateZones();
      triggerToast(t('settings.zone_updated_success'), 'success');
    } catch (err) {
      logger.error(err);
      setOwdNvmState(prev);
      triggerToast(err.message || t('settings.failed_save_settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleEarlyStartToggle = async (checked) => {
    setEarlyStart(checked);
    try {
      setIsSaving(true);
      await updateEarlyStart(homeId, zoneId, checked);
      if (mutateZones) await mutateZones();
      triggerToast(t('settings.zone_updated_success'), 'success');
    } catch (err) {
      logger.error(err);
      triggerToast(err.message || t('settings.failed_save_settings'), 'error');
      setEarlyStart(!checked);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDazzleToggle = async (checked) => {
    setDazzle(checked);
    try {
      setIsSaving(true);
      await updateDazzle(homeId, zoneId, checked);
      if (mutateZones) await mutateZones();
      triggerToast(t('settings.zone_updated_success'), 'success');
    } catch (err) {
      logger.error(err);
      triggerToast(err.message || t('settings.failed_save_settings'), 'error');
      setDazzle(!checked);
    } finally {
      setIsSaving(false);
    }
  };

  const handleOfflineScheduleToggle = async (checked) => {
    setOfflineScheduleEnabled(checked);
    try {
      setIsSaving(true);
      await updateOfflineSchedule(homeId, zoneId, checked);
      if (mutateZones) await mutateZones();
      triggerToast(t('settings.zone_updated_success'), 'success');
    } catch (err) {
      logger.error(err);
      triggerToast(err.message || t('settings.failed_save_settings'), 'error');
      setOfflineScheduleEnabled(!checked);
    } finally {
      setIsSaving(false);
    }
  };

  const handleOwdToggle = async (checked) => {
    setOpenWindow(checked);
    try {
      setIsSaving(true);
      await updateOpenWindowDetection(homeId, zoneId, checked, owdTimeout);
      if (mutateZones) await mutateZones();
      triggerToast(t('settings.zone_updated_success'), 'success');
    } catch (err) {
      logger.error(err);
      triggerToast(err.message || t('settings.failed_save_settings'), 'error');
      setOpenWindow(!checked);
    } finally {
      setIsSaving(false);
    }
  };

  const handleOwdTimeoutChange = async (timeout) => {
    const prev = owdTimeout;
    setOwdTimeout(timeout);
    try {
      setIsSaving(true);
      await updateOpenWindowDetection(homeId, zoneId, openWindow, timeout);
      if (mutateZones) await mutateZones();
      triggerToast(t('settings.zone_updated_success'), 'success');
    } catch (err) {
      logger.error(err);
      setOwdTimeout(prev);
      triggerToast(err.message || t('settings.failed_save_settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleTaNoCloOwdToggle = async (checked) => {
    setTaNoCloOwdEnabled(checked);
    try {
      setIsSaving(true);
      await updateTaNoCloOwdSettings(homeId, zoneId, checked, owdSource);
      if (mutateZones) await mutateZones();
      triggerToast(t('settings.zone_updated_success'), 'success');
    } catch (err) {
      logger.error(err);
      triggerToast(err.message || t('settings.failed_save_settings'), 'error');
      setTaNoCloOwdEnabled(!checked);
    } finally {
      setIsSaving(false);
    }
  };

  const handleOwdSourceChange = async (source) => {
    const prev = owdSource;
    setOwdSource(source);
    try {
      setIsSaving(true);
      await updateTaNoCloOwdSettings(homeId, zoneId, tanocloOwdEnabled, source);
      if (mutateZones) await mutateZones();
      triggerToast(t('settings.zone_updated_success'), 'success');
    } catch (err) {
      logger.error(err);
      setOwdSource(prev);
      triggerToast(err.message || t('settings.failed_save_settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleOverlayTypeChange = async (type) => {
    const prev = overlayType;
    setOverlayType(type);
    try {
      setIsSaving(true);
      const overlayPayload = {
        termination: {
          type,
          durationInSeconds: type === 'TIMER' ? overlayDuration : null
        }
      };
      await updateDefaultOverlay(homeId, zoneId, overlayPayload);
      triggerToast(t('settings.zone_updated_success'), 'success');
    } catch (err) {
      logger.error(err);
      setOverlayType(prev);
      triggerToast(err.message || t('settings.failed_save_settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleOverlayDurationChange = async (duration) => {
    const prev = overlayDuration;
    setOverlayDuration(duration);
    try {
      setIsSaving(true);
      const overlayPayload = {
        termination: {
          type: overlayType,
          durationInSeconds: duration
        }
      };
      await updateDefaultOverlay(homeId, zoneId, overlayPayload);
      triggerToast(t('settings.zone_updated_success'), 'success');
    } catch (err) {
      logger.error(err);
      setOverlayDuration(prev);
      triggerToast(err.message || t('settings.failed_save_settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleMeasuringDeviceChange = async (serial) => {
    const prev = measuringDeviceSerial;
    setMeasuringDeviceSerial(serial);
    try {
      setIsSaving(true);
      await updateMeasuringDevice(homeId, zoneId, serial);
      await Promise.all([mutateControl(), mutateDevices()]);
      triggerToast(t('settings.zone_updated_success'), 'success');
    } catch (err) {
      logger.error(err);
      setMeasuringDeviceSerial(prev);
      triggerToast(err.message || t('settings.failed_save_settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleControllerChange = async (newVal) => {
    if (!isDhw && isLeaderDeviceType && newVal === 'none') {
      triggerToast(t('settings.failed_disable_circuit_leader_alert'), 'error');
      return;
    }
    if (newVal !== 'none' && (!controllerSerial || controllerSerial === 'none')) {
      const zcRoomsCount = (zones || []).filter(z => z.type === 'HEATING' && (z.heatingCircuit !== null && z.heatingCircuit !== undefined && z.heatingCircuit !== '') && z.id !== zoneId).length;
      if (zcRoomsCount >= 10) {
        triggerToast(t('settings.error_max_zc_rooms_reached'), 'error');
        return;
      }
    }
    const prev = controllerSerial;
    setControllerSerial(newVal);
    try {
      setIsSaving(true);
      let circuitVal = null;
      if (newVal !== 'none') {
        const existingCirc = circuits?.find(c => c.driver_serial_no === newVal);
        if (existingCirc) {
          circuitVal = existingCirc.number;
        } else {
          // Find next unused circuit number
          const existingNumbers = circuits?.map(c => c.number) || [];
          let nextNum = 1;
          while (existingNumbers.includes(nextNum)) {
            nextNum++;
          }
          await updateHeatingCircuitDriver(homeId, nextNum, newVal);
          circuitVal = nextNum;
        }
      }
      await updateHeatingCircuit(homeId, zoneId, circuitVal);
      if (mutateZones) await mutateZones();
      await mutateControl();
      triggerToast(t('settings.zone_updated_success'), 'success');
    } catch (err) {
      logger.error(err);
      setControllerSerial(prev);
      triggerToast(err.message || t('settings.failed_save_settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  };

  // Debounce temperature offset updates
  useEffect(() => {
    if (!measuringDeviceSerial || !selectedDeviceObj) return;
    const initialOffset = selectedDeviceObj.temperatureOffset ?? 0;
    if (offset === initialOffset) return;

    const timer = setTimeout(async () => {
      try {
        setIsSaving(true);
        await updateTemperatureOffset(homeId, measuringDeviceSerial, offset);
        if (mutateDevices) await mutateDevices();
        triggerToast(t('settings.zone_updated_success'), 'success');
      } catch (err) {
        logger.error(err);
        triggerToast(err.message || t('settings.failed_save_settings'), 'error');
      } finally {
        setIsSaving(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [offset, measuringDeviceSerial, homeId, selectedDeviceObj, mutateDevices, t, triggerToast]);

  if (!zone) {
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%', maxWidth: '800px' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minHeight: '42px' }}>
        <Button variant="secondary" onClick={view === 'advanced' ? () => setView('main') : onBack} style={{ width: '32px', height: '32px', padding: 0, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <ArrowLeft size={16} />
        </Button>
        <div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, lineHeight: 1.2 }}>
            {view === 'advanced' ? `Advanced Settings • ${zone.name}` : t('settings.zone_settings_header', { name: zone.name })}
          </h2>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'block' }}>
            {view === 'advanced' ? "Tuning parameters and special options" : t('settings.zone_settings_header_desc')}
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

      {view === 'advanced' && !isDhw ? (
        <ZoneAdvancedSettings
          zone={zone}
          isDhw={isDhw}
          isReadOnly={isReadOnly}
          frostMinTemperature={frostMinTemperature}
          setFrostMinTemperature={setFrostMinTemperature}
          temperatureBaseline={temperatureBaseline}
          setTemperatureBaseline={setTemperatureBaseline}
          handleSaveAdvancedDetails={handleSaveAdvancedDetails}
          isSavingAdvancedDetails={isSavingAdvancedDetails}
          offlineScheduleEnabled={offlineScheduleEnabled}
          handleOfflineScheduleToggle={handleOfflineScheduleToggle}
          isSaving={isSaving}
          syncOfflineSchedule={syncOfflineSchedule}
          homeId={homeId}
          zoneId={zoneId}
          mutateZones={mutateZones}
          triggerToast={triggerToast}
          openWindow={openWindow}
          temperatureDeviationLimit={temperatureDeviationLimit}
          handleOwdDeviationChange={handleOwdDeviationChange}
          owdNvmState={owdNvmState}
          handleOwdNvmStateToggle={handleOwdNvmStateToggle}
          tanocloOwdEnabled={tanocloOwdEnabled}
          handleTaNoCloOwdToggle={handleTaNoCloOwdToggle}
          owdSource={owdSource}
          handleOwdSourceChange={handleOwdSourceChange}
          t={t}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

          {/* General settings (Name, offsets, Measuring Device, Controller, Devices list) */}
          <ZoneSettingsGeneral
            zone={zone}
            isDhw={isDhw}
            name={name}
            setName={setName}
            handleSaveName={handleSaveName}
            isSavingName={isSaving}
            isReadOnly={isReadOnly}
            measuringDeviceSerial={measuringDeviceSerial}
            handleMeasuringDeviceChange={handleMeasuringDeviceChange}
            getDeviceDisplayName={getDeviceDisplayName}
            offset={offset}
            setOffset={setOffset}
            controllerSerial={controllerSerial}
            handleControllerChange={handleControllerChange}
            devices={devices}
            zones={zones}
            onNavigateToDevice={onNavigateToDevice}
            t={t}
          />

          {/* Manual Control Defaults overlay settings */}
          <ZoneSettingsOverlay
            overlayType={overlayType}
            overlayDuration={overlayDuration}
            handleOverlayTypeChange={handleOverlayTypeChange}
            handleOverlayDurationChange={handleOverlayDurationChange}
            t={t}
          />

          {/* Open Window Detection (Heating only) */}
          {!isDhw && (
            <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <strong>{t('settings.open_window_det')}</strong>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                    {t('settings.open_window_det_desc')}
                  </p>
                </div>
                <Toggle checked={openWindow} onChange={handleOwdToggle} disabled={isReadOnly} />
              </div>

              {openWindow && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
                  <span>{t('settings.turn_off_heating_for')}</span>
                  <select
                    value={owdTimeout}
                    onChange={(e) => handleOwdTimeoutChange(Number(e.target.value))}
                    disabled={isReadOnly}
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      border: '1px solid var(--border-color)',
                      color: 'var(--text-primary)',
                      padding: '0.25rem 0.5rem',
                      borderRadius: 'var(--radius-sm)',
                      outline: 'none',
                      fontWeight: 600,
                      cursor: isReadOnly ? 'not-allowed' : 'pointer'
                    }}
                  >
                    <option value={300}>{t('settings.duration_5m')}</option>
                    <option value={600}>{t('settings.duration_10m')}</option>
                    <option value={900}>{t('settings.duration_15m')}</option>
                    <option value={1800}>{t('settings.duration_30m')}</option>
                    <option value={3600}>{t('settings.duration_1h')}</option>
                  </select>
                </div>
              )}
            </Card>
          )}

          {/* Early Start (Heating only) */}
          {!isDhw && (
            <Card style={{ padding: '1.25rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <strong>{t('settings.early_start')}</strong>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                  {t('settings.early_start_desc')}
                </p>
              </div>
              <Toggle checked={earlyStart} onChange={handleEarlyStartToggle} />
            </Card>
          )}

          {/* Dazzle Mode (Heating only) */}
          {!isDhw && (
            <Card style={{ padding: '1.25rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <strong>{t('settings.dazzle_mode')}</strong>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                  {t('settings.dazzle_mode_desc')}
                </p>
              </div>
              <Toggle checked={dazzle} onChange={handleDazzleToggle} disabled={isReadOnly} />
            </Card>
          )}

          {/* Advanced Settings Click-through */}
          {!isDhw && (
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
                  Advanced Settings
                </strong>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                  Configure dangerous and untested tuning parameters (frost/baseline temps, advanced OWD limits, offline schedule).
                </p>
              </div>
              <span style={{ fontSize: '1.25rem', color: 'var(--text-muted)' }}>&rarr;</span>
            </Card>
          )}

        </div>
      )}
    </div>
  );
}
