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
import { Layers, Flame, Maximize2, Sparkles } from 'lucide-react';
import { calculatePidPreset, ROOM_SIZE_PRESETS } from '../../utils/pidPresets';

/**
 * @brief General zone settings sub-panel.
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
  t
}) {
  const isInherited = insulationFactor === null || insulationFactor === undefined;
  const currentVal = !isInherited ? parseFloat(insulationFactor) : 0.70;

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