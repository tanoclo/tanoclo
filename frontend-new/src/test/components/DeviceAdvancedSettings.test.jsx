import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import DeviceAdvancedSettings, {
  DIAG_FIDS, NVM_SLOTS, formatFriendlyValue, parseFriendlyToRaw, validateDebugValue
} from '../../components/settings/DeviceAdvancedSettings';

vi.mock('../../context/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() })
}));

vi.mock('../../api/devices', () => ({
  triggerSelftest: vi.fn().mockResolvedValue({}),
  triggerMountCalibration: vi.fn().mockResolvedValue({}),
  triggerDeviceDebug: vi.fn().mockResolvedValue({}),
  startMemoryDump: vi.fn().mockResolvedValue({}),
  getMemoryDumpStatus: vi.fn().mockResolvedValue({}),
  cancelMemoryDump: vi.fn().mockResolvedValue({}),
  downloadMemoryDumpFile: vi.fn().mockResolvedValue({})
}));

describe('DeviceAdvancedSettings Component', () => {
  const defaultProps = {
    homeId: 999999,
    deviceId: 'VA1234567890',
    isValve: true,
    device: {
      serialNo: 'VA1234567890',
      deviceType: 'VA02',
      actuatorLimits: {
        active: 1,
        mountingState: 'CALIBRATING',
        position1: 1700,
        position2: 1704,
        seatPoint: 1704,
        referencePoint: 210,
        mode: 2,
        flags: 0,
        deviation: 3
      }
    },
    lowSteps: 2200,
    setLowSteps: vi.fn(),
    highSteps: 2100,
    setHighSteps: vi.fn(),
    driveConstant: 1750,
    setDriveConstant: vi.fn(),
    handleSaveActuatorLimits: vi.fn(),
    isSavingLimits: false,
    displayBrightness: 112,
    setDisplayBrightness: vi.fn(),
    displayContrast: 128,
    setDisplayContrast: vi.fn(),
    displayActiveTimeout: 0,
    setDisplayActiveTimeout: vi.fn(),
    handleSaveDisplay: vi.fn(),
    isSavingDisplay: false,
    isReadOnly: false,
    t: (key, def) => def || key
  };

  it('renders display settings, actuator limits, and telemetry correctly', () => {
    const html = renderToString(<DeviceAdvancedSettings {...defaultProps} />);

    expect(html).toContain('settings.device_advanced.display_screensaver_title');
    expect(html).toContain('settings.device_advanced.actuator_motor_title');

    // Check diagnostic telemetry values
    expect(html).toContain('Active (Calibrated)');
    expect(html).toContain('CALIBRATING');
    expect(html).toContain('1700');
    expect(html).toContain('1704');
    expect(html).toContain('210');
    expect(html).toContain('Deviation');

    // Check save buttons
    expect(html).toContain('Save Display Settings');
    expect(html).toContain('Save Limits');
  });

  it('renders disabled inputs when isReadOnly is true', () => {
    const html = renderToString(<DeviceAdvancedSettings {...defaultProps} isReadOnly={true} />);
    expect(html).toContain('disabled=""');
  });

  it('exposes accurate firmware labels for NVM slots', () => {
    const slot0001 = NVM_SLOTS.find(s => s.fid === '0x0001');
    expect(slot0001.label).toContain('RF Channel & Band Mode');
    expect(slot0001.access).toBe('rw');

    const slot0002 = NVM_SLOTS.find(s => s.fid === '0x0002');
    expect(slot0002.label).toContain('Hardware Calibration Status Mask');
    expect(slot0002.access).toBe('ro');

    const slot0004 = NVM_SLOTS.find(s => s.fid === '0x0004');
    expect(slot0004.label).toContain('Hardware IEEE EUI-64 MAC Address');
    expect(slot0004.access).toBe('ro');

    const slot0006 = NVM_SLOTS.find(s => s.fid === '0x0006');
    expect(slot0006.label).toContain('CoAP Auth Token Seed');
    expect(slot0006.access).toBe('ro');

    const slot0007 = NVM_SLOTS.find(s => s.fid === '0x0007');
    expect(slot0007.label).toContain('Commissioning & Pairing Secret Key');
    expect(slot0007.access).toBe('rw');

    const slot0008 = NVM_SLOTS.find(s => s.fid === '0x0008');
    expect(slot0008.label).toContain('Commissioning State & Network Flags');
    expect(slot0008.access).toBe('ro');

    const slot000B = NVM_SLOTS.find(s => s.fid === '0x000B');
    expect(slot000B.label).toContain('AES-128 Network Encryption Key');
    expect(slot000B.access).toBe('wo_protected');
  });

  it('exposes accurate firmware labels for diagnostic state FIDs', () => {
    const fid03ED = DIAG_FIDS.find(d => d.fid === '0x03ED');
    expect(fid03ED.label).toContain('Stepper Motor Step Target / Override');
    expect(fid03ED.access).toBe('rw');
    expect(fid03ED.deviceScope).toBe('va');

    const fid0FA3 = DIAG_FIDS.find(d => d.fid === '0x0FA3');
    expect(fid0FA3.label).toContain('Watchdog Reset Diagnostic Trace Code');
    expect(fid0FA3.access).toBe('ro');

    const fid62E0 = DIAG_FIDS.find(d => d.fid === '0x62E0');
    expect(fid62E0.label).toContain('Simulation Sensor Injection Hook');
    expect(fid62E0.access).toBe('wo');
  });

  it('formats true values correctly in formatFriendlyValue', () => {
    // EUI-64 MAC Address from hardware
    const mac = formatFriendlyValue('0x0004', '001bc51234567890ffff', null);
    expect(mac).toBe('00:1B:C5:12:34:56:78:90 (EUI-64 MAC)');

    // CoAP Auth Token Seed
    const tokenSeed = formatFriendlyValue('0x0006', '1122334455667788', null);
    expect(tokenSeed).toBe('11:22:33:44:55:66:77:88 (Auth Seed)');

    // Commissioning State Bitmask
    expect(formatFriendlyValue('0x0008', 'c9', 201)).toBe('Commissioned & Paired (0xC9)');
    expect(formatFriendlyValue('0x0008', '00', 0)).toBe('0 - Unpaired (Factory Default)');

    // Calibration status bitmask
    expect(formatFriendlyValue('0x0002', '27', 39)).toBe('Calibrated (0x27 - VA Lock)');
    expect(formatFriendlyValue('0x0002', '6b', 107)).toBe('Calibrated (0x6B - RU Lock)');
    expect(formatFriendlyValue('0x0002', '9f', 159)).toBe('Calibrated (0x9F - IB Lock)');

    // RF Band Modes
    expect(formatFriendlyValue('0x0001', '41', 65)).toBe('Channel 26 (Band A / 868.325 MHz - VA)');
    expect(formatFriendlyValue('0x0001', '42', 66)).toBe('Channel 26 (Band B / 868.325 MHz - IB)');
    expect(formatFriendlyValue('0x0001', '55', 85)).toBe('868 MHz Sub-GHz Band (0x55 - RU)');

    // PAN ID
    expect(formatFriendlyValue('0x000A', 'ffff', 65535)).toBe('0xFFFF (Coordinator / All PANs)');
    expect(formatFriendlyValue('0x000A', '00ff', 255)).toBe('255 (0x00FF - Paired PAN)');

    // Temperature feed
    expect(formatFriendlyValue('0x0294', null, 1822)).toBe('18.22 °C');

    // Motor steps
    expect(formatFriendlyValue('0x03ED', null, 1850)).toBe('1850 steps');
  });

  it('validates debug values accurately with validateDebugValue', () => {
    // 16B Hex Keys (0x0007, 0x000B)
    expect(validateDebugValue('0x0007', '0123456789abcdef0123456789abcdef', true).isValid).toBe(true);
    expect(validateDebugValue('0x0007', 'shortkey', true).isValid).toBe(false);

    // RF Band Mode
    expect(validateDebugValue('0x0001', '41', true).isValid).toBe(true);
    expect(validateDebugValue('0x0001', '55', true).isValid).toBe(true);
    expect(validateDebugValue('0x0001', '999', true).isValid).toBe(false);

    // Motor Steps (0..3500)
    expect(validateDebugValue('0x03ED', '1800', false).isValid).toBe(true);
    expect(validateDebugValue('0x03ED', '4000', false).isValid).toBe(false);

    // Temperature Feed (-4000..8500)
    expect(validateDebugValue('0x0294', '1822', false).isValid).toBe(true);
    expect(validateDebugValue('0x0294', '99999', false).isValid).toBe(false);

    // Read-only slot rejection
    expect(validateDebugValue('0x0004', 'anything', true).isValid).toBe(false);
  });

  it('renders IB-specific architecture notice and disables GET for /d/dbg/st', () => {
    const ibProps = {
      ...defaultProps,
      deviceId: 'IB9999999999',
      isValve: false,
      device: {
        serialNo: 'IB9999999999',
        deviceType: 'IB01'
      }
    };
    const html = renderToString(<DeviceAdvancedSettings {...ibProps} />);
    expect(html).toContain('Firmware Notice (IB01)');
    expect(html).toContain('handler_get = NULL');
    expect(html).toContain('GET Unsupported (IB)');
  });
});
