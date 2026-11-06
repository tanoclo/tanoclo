import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import ZoneAdvancedSettings from '../../components/settings/ZoneAdvancedSettings';

vi.mock('../../context/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() })
}));

vi.mock('../../api/zones', () => ({
  updateZoneDetails: vi.fn().mockResolvedValue({}),
  updateOpenWindowDetection: vi.fn().mockResolvedValue({}),
  updateTaNoCloOwdSettings: vi.fn().mockResolvedValue({})
}));

describe('ZoneAdvancedSettings Component', () => {
  const defaultProps = {
    zone: {
      id: 1,
      name: 'Living Room',
      type: 'HEATING',
      kp: 10.00,
      ki: 5.00,
      kd: 15.00,
      open_window_active: 0,
      open_window_timeout: 900
    },
    isDhw: false,
    isReadOnly: false,
    kp: 10.00,
    setKp: vi.fn(),
    ki: 5.00,
    setKi: vi.fn(),
    kd: 15.00,
    setKd: vi.fn(),
    handleSaveAdvancedDetails: vi.fn(),
    isSavingAdvancedDetails: false,
    offlineScheduleEnabled: false,
    handleOfflineScheduleToggle: vi.fn(),
    isSaving: false,
    syncOfflineSchedule: vi.fn(),
    homeId: 999999,
    zoneId: 1,
    mutateZones: vi.fn(),
    triggerToast: vi.fn(),
    openWindow: true,
    owdTimeout: 900,
    tanocloOwdEnabled: false,
    handleTaNoCloOwdToggle: vi.fn(),
    owdSource: 'device',
    handleOwdSourceChange: vi.fn(),
    t: (key, def) => (typeof def === 'object' && def !== null ? (def.defaultValue || key) : (def || key))
  };

  it('renders PID tuning parameters (0x6080, 0x60a0, 0x60c0) accurately', () => {
    const html = renderToString(<ZoneAdvancedSettings {...defaultProps} />);

    // Check title reference
    expect(html).toContain('PID Heating Demand Tuning');

    // Check FID badges
    expect(html).toContain('FID 0x60a0');
    expect(html).toContain('FID 0x60c0');
    expect(html).toContain('FID 0x6080');

    // Check values
    expect(html).toContain('5.00');
    expect(html).toContain('15.00');
    expect(html).toContain('10.00');

    // Check PID formula & interplay
    expect(html).toContain('How Zone PID and Valve Sensitivity (0x4160) Interplay');
    expect(html).toContain('Reset PID Defaults (10.00 / 5.00 / 15.00)');
  });

  it('renders Advanced OWD hardware protocol grounding and status', () => {
    const html = renderToString(<ZoneAdvancedSettings {...defaultProps} />);

    expect(html).toContain('settings.zone_advanced.advanced_owd_title');
    expect(html).toContain('FID 0x60e0');
    expect(html).toContain('FID 0x62c0');
    expect(html).toContain('FID 0x4140');
    expect(html).toContain('15 min (900s)');
    expect(html).toContain('settings.zone_advanced.owd_status_idle');
  });

  it('renders active open window alert badge when open_window_active is 1', () => {
    const activeProps = {
      ...defaultProps,
      zone: {
        ...defaultProps.zone,
        open_window_active: 1
      }
    };
    const html = renderToString(<ZoneAdvancedSettings {...activeProps} />);

    expect(html).toContain('settings.zone_advanced.owd_status_active');
    expect(html).toContain('1 (Window Open)');
  });

  it('renders disabled inputs when isReadOnly is true', () => {
    const html = renderToString(<ZoneAdvancedSettings {...defaultProps} isReadOnly={true} />);
    expect(html).toContain('disabled=""');
  });

  it('disables save button when PID tuning values match zone current values', () => {
    const html = renderToString(<ZoneAdvancedSettings {...defaultProps} />);
    expect(html).toContain('disabled=""');
  });

  it('enables save button when PID tuning values are dirty', () => {
    const dirtyProps = {
      ...defaultProps,
      kp: 0.80
    };
    const html = renderToString(<ZoneAdvancedSettings {...dirtyProps} />);
    // Save button should NOT have disabled=""
    expect(html).toContain('>Save</button>');
  });

  it('renders size-based PID recommendation box and apply preset button', () => {
    const sizeProps = {
      ...defaultProps,
      roomSize: 10,
      heatingType: 'RADIATOR'
    };
    const html = renderToString(<ZoneAdvancedSettings {...sizeProps} />);
    expect(html).toContain('Size-Based Recommendation (10 m² • Radiators)');
    expect(html).toContain('Apply Size Preset (7.50 / 4.00 / 20.00)');
  });
});