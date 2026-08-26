import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import DeviceAdvancedSettings from '../../components/settings/DeviceAdvancedSettings';

vi.mock('../../context/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() })
}));

vi.mock('../../api/devices', () => ({
  triggerSelftest: vi.fn().mockResolvedValue({}),
  triggerMountCalibration: vi.fn().mockResolvedValue({}),
  triggerDeviceDebug: vi.fn().mockResolvedValue({})
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
});
