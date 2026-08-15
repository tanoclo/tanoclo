/**
 * @file src/components/settings/DeviceAdvancedSettings.jsx
 * @brief Renders hardware actuator limits and screen screensaver configurations.
 * 
 * Exposes low-level micro-parameters including Display Brightness, Contrast, Screensaver timeouts,
 * and physical valve Actuator calibration step boundaries (low/high limits, drive constants) for motor tuning.
 */


import { useState } from 'react';
import Card from '../common/Card';
import Button from '../common/Button';
import { ShieldAlert, Wrench, Bug } from 'lucide-react';
import { useToast } from '../../context/ToastContext';
import {
  triggerSelftest, triggerMountCalibration, triggerDeviceDebug
} from '../../api/devices';

/**
 * @brief Advanced device configuration tuning sub-panel.
 * @param {string|number} props.homeId - Active home ID.
 * @param {string} props.deviceId - Target device serial number.
 * @param {boolean} props.isValve - Whether target device is a radiator valve.
 * @param {object} props.device - Target hardware device details.
 * @param {number} props.lowSteps - Calibration low actuator steps offset.
 * @param {function} props.setLowSteps - Low step offset state setter.
 * @param {number} props.highSteps - Calibration high actuator steps offset.
 * @param {function} props.setHighSteps - High step offset state setter.
 * @param {number} props.driveConstant - Actuator motor drive current constant.
 * @param {function} props.setDriveConstant - Drive constant state setter.
 * @param {function} props.handleSaveActuatorLimits - Save calibration limits callback.
 * @param {boolean} props.isSavingLimits - Progress indicator for actuator limits updates.
 * @param {number} props.displayBrightness - Display brightness index (0-255).
 * @param {function} props.setDisplayBrightness - Display brightness state setter.
 * @param {number} props.displayContrast - Display contrast index (0-255).
 * @param {function} props.setDisplayContrast - Display contrast state setter.
 * @param {number} props.displayActiveTimeout - Active display screen saver timeout in seconds.
 * @param {function} props.setDisplayActiveTimeout - Active timeout state setter.
 * @param {function} props.handleSaveDisplay - Save display settings callback.
 * @param {boolean} props.isSavingDisplay - Progress indicator for display parameters updates.
 * @param {boolean} props.isReadOnly - Whether view is read-only.
 * @param {function} props.t - Translation resolver hook.
 */
export default function DeviceAdvancedSettings({
  homeId,
  deviceId,
  isValve,
  device,
  lowSteps,
  setLowSteps,
  highSteps,
  setHighSteps,
  driveConstant,
  setDriveConstant,
  handleSaveActuatorLimits,
  isSavingLimits,
  displayBrightness,
  setDisplayBrightness,
  displayContrast,
  setDisplayContrast,
  displayActiveTimeout,
  setDisplayActiveTimeout,
  handleSaveDisplay,
  isSavingDisplay,
  isReadOnly,
  t
}) {
  const { showToast } = useToast();
  const [dbgAdr, setDbgAdr] = useState('20000000');
  const [dbgFid, setDbgFid] = useState('320');
  const [dbgLen, setDbgLen] = useState('16');
  const targetSerial = device?.serialNo || deviceId;
  const isStat = device?.deviceType?.startsWith('SU') || device?.deviceType?.startsWith('WR') || device?.deviceType?.startsWith('RU');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

      {/* Warning Banner */}
      <Card style={{
        padding: '1.25rem',
        border: '1px solid var(--danger-glow)',
        backgroundColor: 'var(--danger-glow)',
        color: 'var(--text-primary)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--danger)' }}>
          <ShieldAlert size={20} />
          <strong style={{ fontSize: '1rem', fontWeight: 700 }}>{t('settings.device_advanced.warning_title')}</strong>
        </div>
        <p style={{ fontSize: '0.85rem', lineHeight: '1.4', margin: 0 }}>
          {t('settings.device_advanced.warning_desc')}
        </p>
      </Card>

      {/* Display & Screensaver Settings Card */}
      <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>{t('settings.device_advanced.display_screensaver_title')}</h3>

        {/* Brightness */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>{t('settings.device_advanced.display_brightness')}</strong>
            <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--primary)' }}>
              {Math.round((displayBrightness / 255) * 100)}% ({displayBrightness})
            </span>
          </div>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
            Controls the active LED matrix light intensity on the physical device screen.
            <br />
            • <em>Interpretation</em>: Value range 0 (off) to 255 (max brightness). Lower brightness (e.g. 80-112) is highly recommended to extend battery life. Setting it to 255 makes the screen very clear in bright rooms but drains batteries rapidly.
          </p>
          <input
            type="range"
            min="0"
            max="255"
            value={displayBrightness}
            onChange={(e) => setDisplayBrightness(Number(e.target.value))}
            disabled={isReadOnly}
            style={{ width: '100%', cursor: 'pointer', marginTop: '0.25rem' }}
          />
        </div>

        {/* Contrast */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>{t('settings.device_advanced.display_contrast', 'Display Contrast')}</strong>
            <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--primary)' }}>
              {displayContrast}
            </span>
          </div>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
            Adjusts the voltage supply gradient for active LED segments.
            <br />
            • <em>Interpretation</em>: Value range 0 to 255. High values sharpen segment edges but can cause ghosting (retained glow after display clears). Setting it too low makes text faint. recommended baseline is 128.
          </p>
          <input
            type="range"
            min="0"
            max="255"
            value={displayContrast}
            onChange={(e) => setDisplayContrast(Number(e.target.value))}
            disabled={isReadOnly}
            style={{ width: '100%', cursor: 'pointer', marginTop: '0.25rem' }}
          />
        </div>

        {/* Screensaver Standby Timeout */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-color)', paddingTop: '1.25rem', gap: '1rem' }}>
          <div style={{ flex: 1 }}>
            <strong>{t('settings.device_advanced.display_off_timeout')}</strong>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '2px 0 0', lineHeight: '1.4' }}>
              Specifies the active duration (in minutes) the display remains illuminated after a physical scroll or tap before turning off.
              <br />
              • <em>Interpretation</em>: 0 represents default behavior (turns off within 5-10 seconds). Setting to any non-zero value keeps the screen fully illuminated for that duration.
              <br />
              • <strong>Warning</strong>: Keeping the screen on for long intervals will deplete alkaline batteries in a matter of weeks.
            </p>
          </div>
          <input
            type="number"
            min="0"
            max="255"
            value={displayActiveTimeout}
            onChange={(e) => setDisplayActiveTimeout(Number(e.target.value))}
            disabled={isReadOnly}
            style={{
              backgroundColor: 'var(--bg-input)',
              border: '1px solid var(--border-color)',
              color: 'var(--text-primary)',
              padding: '0.4rem 0.6rem',
              borderRadius: 'var(--radius-sm)',
              width: '80px',
              textAlign: 'center',
              fontWeight: 600
            }}
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
          <Button
            onClick={handleSaveDisplay}
            disabled={isSavingDisplay || isReadOnly}
            variant="primary"
          >
            {isSavingDisplay ? t('settings.saving', 'Saving...') : t('settings.save_display', 'Save Display Settings')}
          </Button>
        </div>
      </Card>

      {/* Actuator Limits (VA devices only) */}
      {isValve && (
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>{t('settings.device_advanced.actuator_motor_title')}</h3>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
            Configure custom calibration ranges for low/high steps and motor drive constants on the valve piston drive.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '0.75rem' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.low_steps', 'Low Steps (Close Limit)')}</label>
              <input
                type="number"
                value={lowSteps}
                onChange={(e) => setLowSteps(e.target.value)}
                style={{
                  backgroundColor: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)',
                  padding: '0.4rem 0.5rem',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '0.85rem',
                  outline: 'none',
                  width: '100%',
                  boxSizing: 'border-box'
                }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.high_steps', 'High Steps (Open Limit)')}</label>
              <input
                type="number"
                value={highSteps}
                onChange={(e) => setHighSteps(e.target.value)}
                style={{
                  backgroundColor: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)',
                  padding: '0.4rem 0.5rem',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '0.85rem',
                  outline: 'none',
                  width: '100%',
                  boxSizing: 'border-box'
                }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.drive_constant', 'Drive Constant')}</label>
              <input
                type="number"
                value={driveConstant}
                onChange={(e) => setDriveConstant(e.target.value)}
                style={{
                  backgroundColor: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)',
                  padding: '0.4rem 0.5rem',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '0.85rem',
                  outline: 'none',
                  width: '100%',
                  boxSizing: 'border-box'
                }}
              />
            </div>
          </div>

          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: '1.4', backgroundColor: 'var(--bg-input)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', marginTop: '0.5rem' }}>
            <h4 style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.25rem' }}>How to Interpret Actuator Settings:</h4>
            • <strong>Low Steps</strong>: Represents the closed valve state. If set too low, the motor will push past the valve seat, straining the gears and draining battery. If too high, the radiator won't shut off completely.
            <br />
            • <strong>High Steps</strong>: Represents the fully open state. Set too low, hot water flow is restricted, leading to cold radiators. Set too high, the motor drives unnecessarily far.
            <br />
            • <strong>Drive Constant</strong>: Dictates steps-to-voltage scaling. Incorrect numbers cause positioning noise, motor stalls, or calibration errors.
          </div>

          {/* Actuator Diagnostics */}
          <div style={{
            borderTop: '1px solid var(--border-color)',
            paddingTop: '1rem',
            marginTop: '0.5rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem'
          }}>
            <h4 style={{ fontSize: '0.85rem', fontWeight: 600, margin: 0 }}>Actuator Diagnostics & Telemetry</h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.75rem', fontSize: '0.8rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.02)', paddingBottom: '0.25rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Status</span>
                <span style={{ fontWeight: 600, color: device?.actuatorLimits?.active ? 'var(--success)' : 'var(--text-muted)' }}>
                  {device?.actuatorLimits?.active ? 'Active (Calibrated)' : 'Inactive (Uncalibrated)'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.02)', paddingBottom: '0.25rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Mounting State</span>
                <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                  {device?.actuatorLimits?.mountingState || 'UNKNOWN'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.02)', paddingBottom: '0.25rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Position 1 / 2</span>
                <span style={{ fontWeight: 600, fontFamily: 'monospace' }}>
                  {device?.actuatorLimits?.position1 !== null ? device.actuatorLimits.position1 : '-'} / {device?.actuatorLimits?.position2 !== null ? device.actuatorLimits.position2 : '-'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.02)', paddingBottom: '0.25rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Seat / Reference</span>
                <span style={{ fontWeight: 600, fontFamily: 'monospace' }}>
                  {device?.actuatorLimits?.seatPoint !== null ? device.actuatorLimits.seatPoint : '-'} / {device?.actuatorLimits?.referencePoint !== null ? device.actuatorLimits.referencePoint : '-'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.02)', paddingBottom: '0.25rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Mode / Flags</span>
                <span style={{ fontWeight: 600, fontFamily: 'monospace' }}>
                  {device?.actuatorLimits?.mode !== null ? device.actuatorLimits.mode : '-'} / {device?.actuatorLimits?.flags !== null ? device.actuatorLimits.flags : '-'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.02)', paddingBottom: '0.25rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Deviation</span>
                {device?.actuatorLimits?.deviation !== null && device?.actuatorLimits?.deviation !== undefined && device?.actuatorLimits?.deviation !== 32767 ? (
                  <span style={{
                    fontWeight: 700,
                    color: (device.actuatorLimits.deviation < -100 || device.actuatorLimits.deviation > 100)
                      ? 'var(--danger)'
                      : (Math.abs(device.actuatorLimits.deviation) > 10 ? 'var(--warning)' : 'var(--success)')
                  }}>
                    {device.actuatorLimits.deviation > 0 ? '+' : ''}{device.actuatorLimits.deviation}
                    {(device.actuatorLimits.deviation < -100 || device.actuatorLimits.deviation > 100) && ' (Stuck / Blocked)'}
                  </span>
                ) : (
                  <span style={{ color: 'var(--text-muted)' }}>N/A</span>
                )}
              </div>
            </div>
            <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', margin: 0 }}>
              <em>Interpretation of Diagnostics</em>: Mounting state reports structural coupling. Seat point details the physical contact depth. A high positive/negative deviation value (e.g. &gt; 100) indicates valve adaptation binding, stuck pins, or low battery motor slips.
            </p>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.25rem' }}>
            <Button variant="primary" onClick={handleSaveActuatorLimits} disabled={isSavingLimits}>
              <span>{isSavingLimits ? t('settings.saving') : t('settings.save_limits', 'Save Limits')}</span>
            </Button>
          </div>
        </Card>
      )}

      {/* Valve Mount Calibration (Radiator Valves only) */}
      {isValve && (
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Wrench size={16} />
            {t('settings.device_advanced.calibrate_title')}
          </h3>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
            {t('settings.device_advanced.calibrate_desc')}
          </p>
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  await triggerMountCalibration(homeId, targetSerial, 'start');
                  showToast('Mount calibration sequence started.');
                } catch (e) {
                  showToast(e.message || 'Failed to start mount calibration.', 'error');
                }
              }}
            >
              {t('settings.device_advanced.start_calibration')}
            </Button>
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  await triggerMountCalibration(homeId, targetSerial, 'cancel');
                  showToast('Mount calibration cancelled.');
                } catch (e) {
                  showToast(e.message || 'Failed to cancel mount calibration.', 'error');
                }
              }}
            >
              {t('common.cancel')}
            </Button>
          </div>
        </Card>
      )}

      {/* Hardware Self-Test (Valves & Thermostats only) */}
      {(isValve || isStat) && (
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Wrench size={16} />
            {t('settings.hardware_selftest', 'Hardware Self-Test')}
          </h3>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
            Requests the physical device to perform internal self-diagnostics (sensor verification, battery load test, display check).
          </p>
          <div>
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  await triggerSelftest(homeId, targetSerial);
                  showToast('Hardware self-test request sent.');
                } catch (e) {
                  showToast(e.message || 'Failed to trigger self-test.', 'error');
                }
              }}
            >
              {t('settings.run_selftest', 'Run Self-Test')}
            </Button>
          </div>
        </Card>
      )}

      {/* CoAP Debug Endpoints (All devices) */}
      <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Bug size={16} />
          {t('settings.coap_debug', 'CoAP Debug Endpoints')}
        </h3>
        <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
          {"Send low-level CoAP GET queries to device debug subpaths (/d/dbg/st, /d/dbg2/tlvs?fid={fid}&len={len}, /d/dbg/m?adr={adr}&len={len}). Received debug payloads are logged to server debug.log."}
        </p>

        {/* Debug Parameters Input Controls */}
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center', backgroundColor: 'var(--bg-secondary)', padding: '0.75rem', borderRadius: '0.5rem' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: 1, minWidth: '120px' }}>
            <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>RAM Address (Hex)</label>
            <input
              type="text"
              value={dbgAdr}
              onChange={(e) => setDbgAdr(e.target.value)}
              placeholder="20000000"
              style={{ fontSize: '0.85rem', padding: '0.35rem 0.5rem', borderRadius: '0.25rem', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', width: '90px' }}>
            <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Field ID (FID)</label>
            <input
              type="text"
              value={dbgFid}
              onChange={(e) => setDbgFid(e.target.value)}
              placeholder="320"
              style={{ fontSize: '0.85rem', padding: '0.35rem 0.5rem', borderRadius: '0.25rem', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', width: '80px' }}>
            <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Length (B)</label>
            <input
              type="text"
              value={dbgLen}
              onChange={(e) => setDbgLen(e.target.value)}
              placeholder="16"
              style={{ fontSize: '0.85rem', padding: '0.35rem 0.5rem', borderRadius: '0.25rem', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}
            />
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          <Button
            variant="secondary"
            onClick={async () => {
              try {
                await triggerDeviceDebug(homeId, targetSerial, 'st');
                showToast('Debug status query sent (/d/dbg/st)');
              } catch (e) {
                showToast(e.message || 'Failed to query /d/dbg/st', 'error');
              }
            }}
            style={{ fontSize: '0.75rem', padding: '0.35rem 0.65rem' }}
          >
            /d/dbg/st (Status)
          </Button>

          <Button
            variant="secondary"
            onClick={async () => {
              try {
                await triggerDeviceDebug(homeId, targetSerial, 'tlvs', { fid: dbgFid, len: dbgLen });
                showToast(`Debug TLV query sent (/d/dbg2/tlvs?fid=${dbgFid}&len=${dbgLen})`);
              } catch (e) {
                showToast(e.message || 'Failed to query /d/dbg2/tlvs', 'error');
              }
            }}
            style={{ fontSize: '0.75rem', padding: '0.35rem 0.65rem' }}
          >
            /d/dbg2/tlvs (TLVs)
          </Button>

          <Button
            variant="secondary"
            onClick={async () => {
              try {
                await triggerDeviceDebug(homeId, targetSerial, 'm', { adr: dbgAdr, len: dbgLen });
                showToast(`Debug memory query sent (/d/dbg/m?adr=${dbgAdr}&len=${dbgLen})`);
              } catch (e) {
                showToast(e.message || 'Failed to query /d/dbg/m', 'error');
              }
            }}
            style={{ fontSize: '0.75rem', padding: '0.35rem 0.65rem' }}
          >
            /d/dbg/m (Memory)
          </Button>
        </div>
      </Card>
    </div>
  );
}

