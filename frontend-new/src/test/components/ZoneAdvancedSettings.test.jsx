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
      frostMinTemperature: 5.0,
      temperatureBaseline: 15.0,
      temperatureDeviationLimit: 10.0,
      open_window_active: 0,
      open_window_timeout: 900
    },
    isDhw: false,
    isReadOnly: false,
    frostMinTemperature: 5.0,
    setFrostMinTemperature: vi.fn(),
    temperatureBaseline: 15.0,
    setTemperatureBaseline: vi.fn(),
    temperatureDeviationLimit: 10.0,
    setTemperatureDeviationLimit: vi.fn(),
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
    t: (key, def) => def || key
  };

  it('renders firmware tuning temperatures (0x60a0, 0x60c0, 0x6080) accurately', () => {
    const html = renderToString(<ZoneAdvancedSettings {...defaultProps} />);

    // Check title & firmware reference
    expect(html).toContain('settings.zone_advanced.tuning_temps_title');

    // Check FID badges
    expect(html).toContain('FID 0x60a0');
    expect(html).toContain('FID 0x60c0');
    expect(html).toContain('FID 0x6080');

    // Check values
    expect(html).toContain('5.0°C');
    expect(html).toContain('15.0°C');
    expect(html).toContain('10.0°C');
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

  it('disables save button when tuning temperatures match zone current values', () => {
    const html = renderToString(<ZoneAdvancedSettings {...defaultProps} />);
    expect(html).toContain('disabled=""');
  });

  it('enables save button when tuning temperatures are dirty', () => {
    const dirtyProps = {
      ...defaultProps,
      frostMinTemperature: 6.5
    };
    const html = renderToString(<ZoneAdvancedSettings {...dirtyProps} />);
    // Save button should NOT have disabled=""
    expect(html).toContain('common.save');
  });
});
