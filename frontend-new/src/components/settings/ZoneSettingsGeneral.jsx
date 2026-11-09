import { useState } from 'react';
import useSWR from 'swr';
import Card from '../common/Card';
import Button from '../common/Button';
import Badge from '../common/Badge';
import Slider from '../common/Slider';
import { 
  Layers, Flame, Maximize2, Sparkles, Radio, Activity, 
  Copy, Check, Send, RefreshCw, ChevronDown, ChevronRight
} from 'lucide-react';
import { calculatePidPreset, ROOM_SIZE_PRESETS } from '../../utils/pidPresets';
import { SWR_KEYS } from '../../utils/swrKeys';
import { 
  createVirtualSensor, 
  removeVirtualSensor, 
  getVirtualSensorStatus, 
  injectDeviceTemperature 
} from '../../api/zones';

/**
 * @brief General zone settings sub-panel.
 */
export default function ZoneSettingsGeneral({
  homeId,
  zoneId,
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
  insulationFactor = null,
  handleInsulationFactorChange,
  heatingType = 'RADIATOR',
  handleHeatingTypeChange,
  underfloorMass = 'SCREED',
  roomSize = null,
  handleRoomSizeChange,
  setKp,
  setKi,
  setKd,
  handleSaveAdvancedDetails,
  triggerToast,
  mutateDevices,
  mutateControl,
  t
}) {
  const isInherited = insulationFactor === null || insulationFactor === undefined;
  const currentVal = !isInherited ? parseFloat(insulationFactor) : 0.70;

  const [isUpdatingVs, setIsUpdatingVs] = useState(false);
  const [testTemp, setTestTemp] = useState('21.5');
  const [testHum, setTestHum] = useState('50');
  const [isSendingTest, setIsSendingTest] = useState(false);
  const [copiedKey, setCopiedKey] = useState(null);
  const [showHaSnippet, setShowHaSnippet] = useState(false);

  const { data: vsData, mutate: mutateVs, isValidating: isVsValidating } = useSWR(
    !isDhw && homeId && zoneId ? SWR_KEYS.virtualSensor(homeId, zoneId) : null,
    () => getVirtualSensorStatus(homeId, zoneId),
    { refreshInterval: 5000 }
  );

  const isVirtualLeader = Boolean(
    vsData?.isVirtualLeader ||
    (measuringDeviceSerial && measuringDeviceSerial.startsWith('IB_VS_'))
  );

  const handleEnableVirtualSensor = async () => {
    try {
      setIsUpdatingVs(true);
      await createVirtualSensor(homeId, zoneId);
      await Promise.all([
        mutateVs ? mutateVs() : Promise.resolve(),
        mutateControl ? mutateControl() : Promise.resolve(),
        mutateDevices ? mutateDevices() : Promise.resolve()
      ]);
      if (triggerToast) triggerToast(t('settings.zone_updated_success'), 'success');
    } catch (err) {
      if (triggerToast) triggerToast(err.message || t('settings.failed_save_settings'), 'error');
    } finally {
      setIsUpdatingVs(false);
    }
  };

  const handleDisableVirtualSensor = async () => {
    try {
      setIsUpdatingVs(true);
      await removeVirtualSensor(homeId, zoneId);
      await Promise.all([
        mutateVs ? mutateVs() : Promise.resolve(),
        mutateControl ? mutateControl() : Promise.resolve(),
        mutateDevices ? mutateDevices() : Promise.resolve()
      ]);
      if (triggerToast) triggerToast(t('settings.zone_updated_success'), 'success');
    } catch (err) {
      if (triggerToast) triggerToast(err.message || t('settings.failed_save_settings'), 'error');
    } finally {
      setIsUpdatingVs(false);
    }
  };

  const handleSendTestTelemetry = async () => {
    const tVal = parseFloat(testTemp);
    const hVal = parseFloat(testHum);
    if (isNaN(tVal)) return;
    try {
      setIsSendingTest(true);
      const targetSerial = vsData?.measuringDeviceSerial || `IB_VS_${homeId}_${zoneId}`;
      await injectDeviceTemperature(homeId, targetSerial, {
        temperature: tVal,
        humidity: isNaN(hVal) ? null : hVal
      });
      await mutateVs();
      if (triggerToast) triggerToast(t('settings.test_telemetry_sent', { defaultValue: 'Test telemetry injected successfully' }), 'success');
    } catch (err) {
      if (triggerToast) triggerToast(err.message || 'Failed to inject telemetry', 'error');
    } finally {
      setIsSendingTest(false);
    }
  };

  const copyToClipboard = (text, key) => {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
      if (triggerToast) triggerToast(t('settings.copied_to_clipboard', { defaultValue: 'Copied to clipboard!' }), 'info');
    }
  };

  const roomPresets = [
    { label: t('settings.insulation_inherit', { defaultValue: 'Inherit Home' }), value: null },
    { label: t('settings.insulation_poor', { defaultValue: 'Poor (0.55)' }), value: 0.55 },
    { label: t('settings.insulation_standard', { defaultValue: 'Standard (0.70)' }), value: 0.70 },
    { label: t('settings.insulation_high', { defaultValue: 'High (0.85)' }), value: 0.85 }
  ];

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

      {/* Heating Emitter Type (Heating only) */}
      {!isDhw && (
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Layers size={18} style={{ color: 'var(--primary)' }} />
            <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>
              {t('settings.heating_emitter_title', { defaultValue: 'Heating System Emitter' })}
            </h3>
          </div>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
            {t('settings.heating_emitter_desc', { defaultValue: 'Select whether this room uses conventional radiators or radiant underfloor heating. TaNoClo automatically adapts boiler flow temperatures, hydraulic balancing, and PID regulation.' })}
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', marginTop: '0.25rem' }}>
            <button
              type="button"
              disabled={isReadOnly}
              onClick={() => handleHeatingTypeChange && handleHeatingTypeChange('RADIATOR', underfloorMass)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '0.75rem 1rem',
                borderRadius: 'var(--radius-sm, 8px)',
                border: heatingType === 'RADIATOR' ? '2px solid var(--primary, #00b4d8)' : '1px solid var(--border-color)',
                backgroundColor: heatingType === 'RADIATOR' ? 'var(--primary-glow, rgba(0,180,216,0.12))' : 'var(--bg-input)',
                color: 'var(--text-primary)',
                cursor: isReadOnly ? 'not-allowed' : 'pointer',
                textAlign: 'left'
              }}
            >
              <Flame size={20} style={{ color: heatingType === 'RADIATOR' ? 'var(--primary)' : 'var(--text-secondary)', flexShrink: 0 }} />
              <div>
                <strong style={{ display: 'block', fontSize: '0.85rem' }}>{t('settings.emitter_radiators', { defaultValue: 'Radiators' })}</strong>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{t('settings.emitter_radiators_sub', { defaultValue: 'Fast response, higher flow temp' })}</span>
              </div>
            </button>

            <button
              type="button"
              disabled={isReadOnly}
              onClick={() => handleHeatingTypeChange && handleHeatingTypeChange('UNDERFLOOR', underfloorMass)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '0.75rem 1rem',
                borderRadius: 'var(--radius-sm, 8px)',
                border: heatingType === 'UNDERFLOOR' ? '2px solid var(--primary, #00b4d8)' : '1px solid var(--border-color)',
                backgroundColor: heatingType === 'UNDERFLOOR' ? 'var(--primary-glow, rgba(0,180,216,0.12))' : 'var(--bg-input)',
                color: 'var(--text-primary)',
                cursor: isReadOnly ? 'not-allowed' : 'pointer',
                textAlign: 'left'
              }}
            >
              <Layers size={20} style={{ color: heatingType === 'UNDERFLOOR' ? 'var(--primary)' : 'var(--text-secondary)', flexShrink: 0 }} />
              <div>
                <strong style={{ display: 'block', fontSize: '0.85rem' }}>{t('settings.emitter_underfloor', { defaultValue: 'Underfloor Heating' })}</strong>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{t('settings.emitter_underfloor_sub', { defaultValue: 'Low temp, high thermal inertia' })}</span>
              </div>
            </button>
          </div>

          {heatingType === 'UNDERFLOOR' && (
            <div style={{ marginTop: '0.25rem', padding: '0.75rem', backgroundColor: 'var(--bg-card, rgba(255,255,255,0.02))', borderRadius: '6px', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                {t('settings.underfloor_mass_title', { defaultValue: 'Floor Construction / Thermal Inertia' })}
              </label>
              <select
                value={underfloorMass}
                disabled={isReadOnly}
                onChange={(e) => handleHeatingTypeChange && handleHeatingTypeChange('UNDERFLOOR', e.target.value)}
                style={{
                  backgroundColor: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)',
                  padding: '0.5rem',
                  borderRadius: 'var(--radius-sm)',
                  outline: 'none',
                  fontWeight: 600,
                  fontSize: '0.85rem',
                  cursor: isReadOnly ? 'not-allowed' : 'pointer'
                }}
              >
                <option value="SCREED">{t('settings.underfloor_mass_screed', { defaultValue: 'Concrete Slab / Wet Screed (2–4h response, high inertia)' })}</option>
                <option value="DRY_SYSTEM">{t('settings.underfloor_mass_dry', { defaultValue: 'Dry Panels / Timber Floor (45–90m response, medium inertia)' })}</option>
              </select>
            </div>
          )}
        </Card>
      )}

      {/* Room Wall Insulation Factor (Heating only) */}
      {!isDhw && (
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div>
            <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>
              {t('settings.room_insulation_title', { defaultValue: 'Room Wall Insulation Factor' })}
            </h3>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '4px 0 0 0' }}>
              {t('settings.room_insulation_desc', { defaultValue: 'Override building insulation for rooms with colder exterior walls, thermal bridges, or modern extensions (ISO 13788 f_Rsi factor).' })}
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '0.5rem' }}>
            {roomPresets.map((preset) => {
              const isSelected = preset.value === null
                ? isInherited
                : (!isInherited && Math.abs(currentVal - preset.value) < 0.01);

              return (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => handleInsulationFactorChange && handleInsulationFactorChange(preset.value)}
                  style={{
                    padding: '0.6rem 0.75rem',
                    borderRadius: '8px',
                    backgroundColor: isSelected ? 'var(--primary-glow, rgba(0, 180, 216, 0.15))' : 'var(--bg-tertiary, rgba(255,255,255,0.03))',
                    border: isSelected ? '2px solid var(--primary, #00b4d8)' : '1px solid var(--border-color, rgba(255,255,255,0.1))',
                    color: isSelected ? 'var(--primary, #00b4d8)' : 'var(--text-primary)',
                    cursor: 'pointer',
                    fontSize: '0.8rem',
                    fontWeight: isSelected ? 700 : 500,
                    textAlign: 'center',
                    transition: 'all 0.15s ease'
                  }}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>

          {!isInherited && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginTop: '0.25rem' }}>
              <input
                type="range"
                min="0.40"
                max="0.95"
                step="0.05"
                value={currentVal}
                onChange={(e) => handleInsulationFactorChange && handleInsulationFactorChange(parseFloat(e.target.value))}
                style={{ flex: 1, accentColor: 'var(--primary, #00b4d8)' }}
              />
              <span style={{
                fontSize: '0.85rem',
                fontWeight: 700,
                padding: '3px 8px',
                borderRadius: '6px',
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                minWidth: '50px',
                textAlign: 'center'
              }}>
                {currentVal.toFixed(2)}
              </span>
            </div>
          )}
        </Card>
      )}

      {/* Room Size / Floor Area & Suggested PID Tuning (Heating only) */}
      {!isDhw && (
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.5rem' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Maximize2 size={18} style={{ color: 'var(--primary)' }} />
                <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>
                  {t('settings.room_size_title', { defaultValue: 'Room Size / Floor Area' })}
                </h3>
              </div>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '4px 0 0 0' }}>
                {t('settings.room_size_desc', { defaultValue: 'Configure room floor area (m²) to determine thermal air volume and inertia for instant, physics-grounded PID heating demand control.' })}
              </p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{
                fontSize: '0.9rem',
                fontWeight: 700,
                color: 'var(--primary)',
                padding: '2px 8px',
                borderRadius: '6px',
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)'
              }}>
                {roomSize ? `${Number(roomSize).toFixed(0)} m²` : t('settings.room_size_not_set', { defaultValue: 'Not set (20 m² default)' })}
              </span>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '0.5rem', marginTop: '0.25rem' }}>
            {ROOM_SIZE_PRESETS.map((preset) => {
              const isSelected = roomSize !== null && Math.abs(Number(roomSize) - preset.value) < 1.0;
              return (
                <button
                  key={preset.tier}
                  type="button"
                  disabled={isReadOnly}
                  onClick={() => handleRoomSizeChange && handleRoomSizeChange(preset.value)}
                  style={{
                    padding: '0.6rem 0.75rem',
                    borderRadius: '8px',
                    backgroundColor: isSelected ? 'var(--primary-glow, rgba(0, 180, 216, 0.15))' : 'var(--bg-tertiary, rgba(255,255,255,0.03))',
                    border: isSelected ? '2px solid var(--primary, #00b4d8)' : '1px solid var(--border-color, rgba(255,255,255,0.1))',
                    color: isSelected ? 'var(--primary, #00b4d8)' : 'var(--text-primary)',
                    cursor: isReadOnly ? 'not-allowed' : 'pointer',
                    fontSize: '0.8rem',
                    fontWeight: isSelected ? 700 : 500,
                    textAlign: 'center',
                    transition: 'all 0.15s ease'
                  }}
                >
                  <strong style={{ display: 'block' }}>{t(preset.labelKey, { defaultValue: preset.defaultLabel })}</strong>
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}>{t(preset.descKey, { defaultValue: preset.defaultDesc })}</span>
                </button>
              );
            })}
          </div>

          {/* Custom Size Slider */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginTop: '0.25rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', minWidth: '45px' }}>5 m²</span>
            <input
              type="range"
              min="5"
              max="100"
              step="1"
              value={roomSize || 20}
              disabled={isReadOnly}
              onChange={(e) => handleRoomSizeChange && handleRoomSizeChange(Number(e.target.value))}
              style={{ flex: 1, accentColor: 'var(--primary, #00b4d8)', cursor: isReadOnly ? 'not-allowed' : 'pointer' }}
            />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', minWidth: '55px', textAlign: 'right' }}>100 m²</span>
          </div>

          {/* Size-Based PID Suggestion Callout Card */}
          {(() => {
            const calculated = calculatePidPreset({
              roomSizeSqm: roomSize || 20,
              heatingType,
              underfloorMass
            });

            const handleApplyThisPreset = async () => {
              if (setKp) setKp(calculated.kp);
              if (setKi) setKi(calculated.ki);
              if (setKd) setKd(calculated.kd);
              if (handleSaveAdvancedDetails) {
                await handleSaveAdvancedDetails();
              }
            };

            return (
              <div style={{
                marginTop: '0.25rem',
                padding: '0.85rem 1rem',
                borderRadius: '8px',
                backgroundColor: 'rgba(59, 130, 246, 0.08)',
                border: '1px solid rgba(59, 130, 246, 0.25)',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--primary)' }}>
                    <Sparkles size={16} />
                    <strong style={{ fontSize: '0.85rem' }}>
                      {t('settings.pid_size_suggestion_title', { defaultValue: 'Thermodynamic PID Tuning Recommendation' })}
                    </strong>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontFamily: 'monospace', fontSize: '0.85rem' }}>
                    <span>Kp: <strong>{calculated.kp.toFixed(2)}</strong></span>
                    <span>Ki: <strong>{calculated.ki.toFixed(2)}</strong></span>
                    <span>Kd: <strong>{calculated.kd.toFixed(2)}</strong></span>
                  </div>
                </div>

                <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
                  {t(calculated.explanationKey, { defaultValue: calculated.defaultExplanation })}
                </p>

                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.25rem' }}>
                  <Button
                    variant="secondary"
                    disabled={isReadOnly}
                    onClick={handleApplyThisPreset}
                    style={{ fontSize: '0.75rem', padding: '0.35rem 0.75rem' }}
                  >
                    <Sparkles size={13} style={{ marginRight: '4px' }} />
                    {t('settings.apply_size_pid', { defaultValue: 'Apply Suggested PID ({{kp}} / {{ki}} / {{kd}})', kp: calculated.kp.toFixed(2), ki: calculated.ki.toFixed(2), kd: calculated.kd.toFixed(2) })}
                  </Button>
                </div>
              </div>
            );
          })()}
        </Card>
      )}

      {/* Measuring Device (Heating only) */}
      {!isDhw && (
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
              {t('settings.measuring_device')}
            </label>
            {isVirtualLeader && (
              <Badge variant="success">
                {t('settings.virtual_sensor_active', { defaultValue: 'Virtual Leader Active' })}
              </Badge>
            )}
          </div>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
            {t('settings.measuring_device_desc')}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <select
              value={isVirtualLeader ? '__VIRTUAL_IB__' : (measuringDeviceSerial || '')}
              onChange={async (e) => {
                const val = e.target.value;
                if (val === '__VIRTUAL_IB__') {
                  await handleEnableVirtualSensor();
                } else {
                  if (isVirtualLeader) {
                    await handleDisableVirtualSensor();
                  }
                  handleMeasuringDeviceChange(val);
                }
              }}
              disabled={isReadOnly || isUpdatingVs}
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.5rem',
                borderRadius: 'var(--radius-sm)',
                outline: 'none',
                fontWeight: 600,
                cursor: isReadOnly || isUpdatingVs ? 'not-allowed' : 'pointer',
                width: '100%'
              }}
            >
              <option value="" disabled>{t('settings.select_measuring_device')}</option>
              <option value="__VIRTUAL_IB__">
                🌐 {t('settings.virtual_sensor_ib', { defaultValue: 'Internet Bridge (Virtual Sensor Leader - MQTT)' })}
              </option>
              {zone?.devices?.filter(d => !d.serialNo?.startsWith('IB_VS_')).map(d => (
                <option key={d.serialNo} value={d.serialNo}>
                  {getDeviceDisplayName(d.serialNo)}
                </option>
              ))}
            </select>

            {/* Quick action buttons */}
            {!isVirtualLeader ? (
              <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                <Button
                  variant="secondary"
                  disabled={isReadOnly || isUpdatingVs}
                  onClick={handleEnableVirtualSensor}
                  style={{ fontSize: '0.75rem', padding: '0.4rem 0.75rem' }}
                >
                  <Radio size={14} style={{ marginRight: '6px' }} />
                  {t('settings.enable_virtual_sensor', { defaultValue: 'Use Internet Bridge as Virtual Sensor (MQTT)' })}
                </Button>
              </div>
            ) : (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button
                  variant="secondary"
                  disabled={isReadOnly || isUpdatingVs}
                  onClick={handleDisableVirtualSensor}
                  style={{ fontSize: '0.75rem', padding: '0.35rem 0.65rem', color: 'var(--danger)' }}
                >
                  {t('settings.disable_virtual_sensor', { defaultValue: 'Revert to Physical Measuring Device' })}
                </Button>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Virtual Zone Leader (MQTT & Diagnostics Card) */}
      {!isDhw && isVirtualLeader && (
        <Card style={{
          padding: '1.25rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '1.25rem',
          border: '1px solid var(--primary, #00b4d8)',
          backgroundColor: 'rgba(0, 180, 216, 0.03)'
        }}>
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
              <Radio size={20} style={{ color: 'var(--primary)' }} />
              <div>
                <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  {t('settings.virtual_sensor_diagnostics', { defaultValue: 'Virtual Sensor Diagnostics & MQTT Telemetry' })}
                </h3>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  {measuringDeviceSerial || `IB_VS_${homeId}_${zoneId}`} • CoAP RFC 7641 Observe Leader
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Badge variant="success">
                {t('settings.virtual_sensor_active', { defaultValue: 'Active Virtual Leader' })}
              </Badge>
              <button
                type="button"
                onClick={() => mutateVs && mutateVs()}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  padding: '4px',
                  display: 'flex',
                  alignItems: 'center'
                }}
                title="Refresh Status"
              >
                <RefreshCw size={14} className={isVsValidating ? 'spin' : ''} />
              </button>
            </div>
          </div>

          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.4 }}>
            {t('settings.virtual_sensor_desc', { defaultValue: 'The Internet Bridge acts as the virtual measuring leader for this zone. It receives ambient telemetry via MQTT, calculates valve demand, and downlinks firmware-true CoAP observe frames to the radiator valves.' })}
          </p>

          {/* 1. Live Telemetry & Demand Row */}
          <div>
            <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
              {t('settings.live_metrics', { defaultValue: 'Live Telemetry & Demand' })}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '0.75rem' }}>
              {/* Temperature */}
              <div style={{ padding: '0.75rem', backgroundColor: 'var(--bg-input)', borderRadius: 'var(--radius-sm, 8px)', border: '1px solid var(--border-color)' }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', display: 'block' }}>Ambient Temp</span>
                <strong style={{ fontSize: '1.25rem', color: 'var(--primary)', fontWeight: 800 }}>
                  {vsData?.state?.temperature !== undefined && vsData?.state?.temperature !== null ? `${Number(vsData.state.temperature).toFixed(1)}°C` : '--'}
                </strong>
                <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', display: 'block', marginTop: '2px' }}>From MQTT</span>
              </div>

              {/* Setpoint */}
              <div style={{ padding: '0.75rem', backgroundColor: 'var(--bg-input)', borderRadius: 'var(--radius-sm, 8px)', border: '1px solid var(--border-color)' }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', display: 'block' }}>Target Setpoint</span>
                <strong style={{ fontSize: '1.25rem', color: 'var(--text-primary)', fontWeight: 800 }}>
                  {vsData?.state?.setpoint !== undefined && vsData?.state?.setpoint !== null ? `${Number(vsData.state.setpoint).toFixed(1)}°C` : '--'}
                </strong>
                <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', display: 'block', marginTop: '2px' }}>Schedule / Override</span>
              </div>

              {/* Demand */}
              <div style={{ padding: '0.75rem', backgroundColor: 'var(--bg-input)', borderRadius: 'var(--radius-sm, 8px)', border: '1px solid var(--border-color)' }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', display: 'block' }}>Valve Demand</span>
                <strong style={{ fontSize: '1.25rem', color: (vsData?.state?.demand || 0) > 0 ? 'var(--warning, #f59e0b)' : 'var(--text-secondary)', fontWeight: 800 }}>
                  {vsData?.state?.demand !== undefined && vsData?.state?.demand !== null ? `${Math.round(vsData.state.demand)}%` : '--'}
                </strong>
                <div style={{ width: '100%', height: '4px', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: '2px', marginTop: '4px', overflow: 'hidden' }}>
                  <div style={{
                    width: `${Math.min(100, Math.max(0, vsData?.state?.demand || 0))}%`,
                    height: '100%',
                    backgroundColor: (vsData?.state?.demand || 0) > 0 ? 'var(--warning, #f59e0b)' : 'var(--primary)'
                  }} />
                </div>
              </div>

              {/* Humidity */}
              <div style={{ padding: '0.75rem', backgroundColor: 'var(--bg-input)', borderRadius: 'var(--radius-sm, 8px)', border: '1px solid var(--border-color)' }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', display: 'block' }}>Rel. Humidity</span>
                <strong style={{ fontSize: '1.25rem', color: 'var(--text-primary)', fontWeight: 800 }}>
                  {vsData?.state?.humidity !== undefined && vsData?.state?.humidity !== null ? `${Math.round(vsData.state.humidity)}%` : '--'}
                </strong>
                <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', display: 'block', marginTop: '2px' }}>TLV 0x0135</span>
              </div>
            </div>
          </div>

          {/* 2. Downlink Gating & Battery Preservation State */}
          <div style={{
            padding: '0.85rem 1rem',
            borderRadius: '8px',
            backgroundColor: 'var(--bg-card, rgba(255,255,255,0.02))',
            border: '1px solid var(--border-color)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Activity size={16} style={{ color: 'var(--primary)' }} />
                <strong style={{ fontSize: '0.8rem' }}>
                  {t('settings.downlink_status', { defaultValue: 'Downlink Gating & Battery Preservation' })}
                </strong>
              </div>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {t('settings.last_push', { defaultValue: 'Last Push' })}: {vsData?.state?.lastPushTimestamp ? new Date(vsData.state.lastPushTimestamp).toLocaleTimeString() : t('settings.never', { defaultValue: 'Never' })}
              </span>
            </div>

            {vsData?.state?.lastPushedValues && (
              <div style={{ fontSize: '0.75rem', fontFamily: 'monospace', color: 'var(--text-secondary)', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                <span>Pushed T: <strong>{vsData.state.lastPushedValues.temperature !== undefined ? `${vsData.state.lastPushedValues.temperature}°C` : '--'}</strong></span>
                <span>Pushed Demand: <strong>{vsData.state.lastPushedValues.demand !== undefined ? `${vsData.state.lastPushedValues.demand}%` : '--'}</strong></span>
                <span>Pushed Setpoint: <strong>{vsData.state.lastPushedValues.setpoint !== undefined ? `${vsData.state.lastPushedValues.setpoint}°C` : '--'}</strong></span>
              </div>
            )}

            <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.35 }}>
              {t('settings.downlink_gating_desc', { defaultValue: 'Downlinks are battery-gated (RFC 7641 Observe / CSL beacons). Pushes are dispatched only when ΔT ≥ 0.2°C, ΔDemand ≥ 5%, or every 10 minutes keepalive to preserve valve battery life.' })}
            </p>
          </div>

          {/* 3. Subscribed Observers (Listening Radiator Valves) */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)' }}>
                {t('settings.registered_valves', { defaultValue: 'Subscribed Radiator Valves (Observers)' })}
              </div>
              <Badge variant={vsData?.observers?.length > 0 ? 'info' : 'secondary'}>
                {vsData?.observers?.length || 0} {vsData?.observers?.length === 1 ? 'Valve' : 'Valves'}
              </Badge>
            </div>

            {vsData?.observers && vsData.observers.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                {vsData.observers.map(obs => (
                  <div key={obs.deviceSerial || obs.ipv6} style={{
                    padding: '0.5rem 0.75rem',
                    backgroundColor: 'var(--bg-input)',
                    borderRadius: '6px',
                    border: '1px solid var(--border-color)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: '0.5rem'
                  }}>
                    <div>
                      <strong style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                        {obs.deviceSerial ? getDeviceDisplayName(obs.deviceSerial) : 'Radiator Valve'}
                      </strong>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                        {obs.ipv6 ? `${obs.ipv6}:${obs.udpPort || 5683}` : 'IPv6 Mesh Radio'}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                        Seq #{obs.lastSeq || 0}
                      </span>
                      <Badge variant="success">Listening</Badge>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ padding: '0.75rem', backgroundColor: 'var(--bg-input)', borderRadius: '6px', border: '1px dashed var(--border-color)', fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center' }}>
                {t('settings.no_observers', { defaultValue: 'No valves currently subscribed. Valves subscribe automatically via CoAP GET /z/p on their wake cycle.' })}
              </div>
            )}
          </div>

          {/* 4. MQTT Integration Guide & Copyable Topics */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)' }}>
              {t('settings.mqtt_integration', { defaultValue: 'MQTT Integration Guide' })}
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
              {t('settings.mqtt_integration_desc', { defaultValue: 'Publish temperature and humidity readings from your external sensor or home automation platform (Home Assistant, Zigbee2MQTT, Node-RED) to the topics below:' })}
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.25rem' }}>
              {/* Temperature Topic */}
              <div style={{
                padding: '0.5rem 0.75rem',
                backgroundColor: 'var(--bg-input)',
                borderRadius: '6px',
                border: '1px solid var(--border-color)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '0.5rem'
              }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', display: 'block', textTransform: 'uppercase' }}>
                    {t('settings.topic_temp', { defaultValue: 'Temperature Topic' })} (Payload: 21.5 or {`{"temperature": 21.5}`})
                  </span>
                  <code style={{ fontSize: '0.75rem', color: 'var(--primary)', wordBreak: 'break-all' }}>
                    {vsData?.mqttTopics?.cmdTemperature || `tado/tanoclo/h/${homeId}/d/${measuringDeviceSerial || `IB_VS_${homeId}_${zoneId}`}/cmd/temperature`}
                  </code>
                </div>
                <button
                  type="button"
                  onClick={() => copyToClipboard(vsData?.mqttTopics?.cmdTemperature || `tado/tanoclo/h/${homeId}/d/${measuringDeviceSerial || `IB_VS_${homeId}_${zoneId}`}/cmd/temperature`, 'temp')}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: copiedKey === 'temp' ? 'var(--success)' : 'var(--text-secondary)',
                    cursor: 'pointer',
                    padding: '4px'
                  }}
                  title="Copy topic"
                >
                  {copiedKey === 'temp' ? <Check size={16} /> : <Copy size={16} />}
                </button>
              </div>

              {/* Humidity Topic */}
              <div style={{
                padding: '0.5rem 0.75rem',
                backgroundColor: 'var(--bg-input)',
                borderRadius: '6px',
                border: '1px solid var(--border-color)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '0.5rem'
              }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', display: 'block', textTransform: 'uppercase' }}>
                    {t('settings.topic_humidity', { defaultValue: 'Humidity Topic' })} (Payload: 50 or {`{"humidity": 50}`})
                  </span>
                  <code style={{ fontSize: '0.75rem', color: 'var(--primary)', wordBreak: 'break-all' }}>
                    {vsData?.mqttTopics?.cmdHumidity || `tado/tanoclo/h/${homeId}/d/${measuringDeviceSerial || `IB_VS_${homeId}_${zoneId}`}/cmd/humidity`}
                  </code>
                </div>
                <button
                  type="button"
                  onClick={() => copyToClipboard(vsData?.mqttTopics?.cmdHumidity || `tado/tanoclo/h/${homeId}/d/${measuringDeviceSerial || `IB_VS_${homeId}_${zoneId}`}/cmd/humidity`, 'hum')}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: copiedKey === 'hum' ? 'var(--success)' : 'var(--text-secondary)',
                    cursor: 'pointer',
                    padding: '4px'
                  }}
                  title="Copy topic"
                >
                  {copiedKey === 'hum' ? <Check size={16} /> : <Copy size={16} />}
                </button>
              </div>

              {/* Combined Telemetry Topic */}
              <div style={{
                padding: '0.5rem 0.75rem',
                backgroundColor: 'var(--bg-input)',
                borderRadius: '6px',
                border: '1px solid var(--border-color)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '0.5rem'
              }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', display: 'block', textTransform: 'uppercase' }}>
                    {t('settings.topic_telemetry', { defaultValue: 'Combined Telemetry Topic' })} (Payload: {`{"temperature": 21.5, "humidity": 50}`})
                  </span>
                  <code style={{ fontSize: '0.75rem', color: 'var(--primary)', wordBreak: 'break-all' }}>
                    {vsData?.mqttTopics?.virtualTelemetry || `tado/tanoclo/virtual/${measuringDeviceSerial || `IB_VS_${homeId}_${zoneId}`}/telemetry`}
                  </code>
                </div>
                <button
                  type="button"
                  onClick={() => copyToClipboard(vsData?.mqttTopics?.virtualTelemetry || `tado/tanoclo/virtual/${measuringDeviceSerial || `IB_VS_${homeId}_${zoneId}`}/telemetry`, 'all')}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: copiedKey === 'all' ? 'var(--success)' : 'var(--text-secondary)',
                    cursor: 'pointer',
                    padding: '4px'
                  }}
                  title="Copy topic"
                >
                  {copiedKey === 'all' ? <Check size={16} /> : <Copy size={16} />}
                </button>
              </div>
            </div>

            {/* Collapsible Home Assistant Example */}
            <div style={{ marginTop: '0.25rem' }}>
              <button
                type="button"
                onClick={() => setShowHaSnippet(prev => !prev)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--primary)',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: 0
                }}
              >
                {showHaSnippet ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {t('settings.ha_example', { defaultValue: 'View Home Assistant Automation Example' })}
              </button>

              {showHaSnippet && (
                <div style={{ marginTop: '0.5rem', padding: '0.75rem', backgroundColor: 'var(--bg-input)', borderRadius: '6px', border: '1px solid var(--border-color)', position: 'relative' }}>
                  <pre style={{ margin: 0, fontSize: '0.7rem', color: 'var(--text-secondary)', overflowX: 'auto', fontFamily: 'monospace' }}>
{`alias: Forward Temp to TaNoClo Zone ${zoneId}
trigger:
  - platform: state
    entity_id: sensor.room_temperature
action:
  - action: mqtt.publish
    data:
      topic: "${vsData?.mqttTopics?.cmdTemperature || `tado/tanoclo/h/${homeId}/d/${measuringDeviceSerial || `IB_VS_${homeId}_${zoneId}`}/cmd/temperature`}"
      payload: "{{ states('sensor.room_temperature') }}"`}
                  </pre>
                </div>
              )}
            </div>
          </div>

          {/* 5. Manual Telemetry Injector / Debugger */}
          <div style={{
            padding: '0.85rem 1rem',
            borderRadius: '8px',
            backgroundColor: 'var(--bg-card, rgba(255,255,255,0.02))',
            border: '1px solid var(--border-color)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Send size={16} style={{ color: 'var(--primary)' }} />
              <strong style={{ fontSize: '0.8rem' }}>
                {t('settings.test_telemetry', { defaultValue: 'Manual Telemetry Injector' })}
              </strong>
            </div>
            <p style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', margin: 0 }}>
              {t('settings.test_telemetry_desc', { defaultValue: 'Inject test values to immediately verify that the virtual sensor coordinator receives data, recalculates demand, and prepares downlinks.' })}
            </p>

            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.25rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>°C:</label>
                <input
                  type="number"
                  step="0.1"
                  value={testTemp}
                  onChange={(e) => setTestTemp(e.target.value)}
                  disabled={isSendingTest}
                  style={{
                    width: '70px',
                    backgroundColor: 'var(--bg-input)',
                    border: '1px solid var(--border-color)',
                    color: 'var(--text-primary)',
                    padding: '0.35rem 0.5rem',
                    borderRadius: '4px',
                    fontSize: '0.8rem',
                    outline: 'none'
                  }}
                />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>%:</label>
                <input
                  type="number"
                  step="1"
                  min="0"
                  max="100"
                  value={testHum}
                  onChange={(e) => setTestHum(e.target.value)}
                  disabled={isSendingTest}
                  style={{
                    width: '60px',
                    backgroundColor: 'var(--bg-input)',
                    border: '1px solid var(--border-color)',
                    color: 'var(--text-primary)',
                    padding: '0.35rem 0.5rem',
                    borderRadius: '4px',
                    fontSize: '0.8rem',
                    outline: 'none'
                  }}
                />
              </div>

              <Button
                variant="primary"
                disabled={isSendingTest || !testTemp}
                onClick={handleSendTestTelemetry}
                style={{ fontSize: '0.75rem', padding: '0.35rem 0.75rem' }}
              >
                <Send size={12} style={{ marginRight: '4px' }} />
                {isSendingTest ? t('common.sending', { defaultValue: 'Sending...' }) : t('settings.send_test_telemetry', { defaultValue: 'Send Test Telemetry' })}
              </Button>
            </div>
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
                const zoneControllers = devices?.filter(d =>
                  (d.deviceType?.startsWith('RU') || d.deviceType?.startsWith('WR')) &&
                  d.emulatedMode !== 'WIRELESS_SENSOR'
                ) || [];
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