// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ZoneSettings from '../../components/settings/ZoneSettings';
import * as useHomeModule from '../../context/HomeContext';

// Mock dependencies
vi.mock('../../context/HomeContext', () => ({
  useHome: () => ({
    _zones: [],
    homeInfo: { configReadonly: false }
  })
}));

vi.mock('../../context/ToastContext', () => ({
  useToast: () => ({
    showToast: vi.fn()
  })
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, options) => {
      if (key === 'settings.zone_settings_header') return `Settings • ${options?.name || ''}`;
      return key;
    }
  })
}));

vi.mock('../../api/zones', () => ({
  updateZoneDetails: vi.fn(),
  updateEarlyStart: vi.fn(),
  updateDazzle: vi.fn(),
  updateOpenWindowDetection: vi.fn(),
  updateDefaultOverlay: vi.fn(),
  getDefaultOverlay: vi.fn().mockResolvedValue({ type: 'TADO_MODE' }),
  getZoneControl: vi.fn().mockResolvedValue({}),
  updateMeasuringDevice: vi.fn(),
  updateHeatingCircuit: vi.fn(),
  updateOfflineSchedule: vi.fn(),
  syncOfflineSchedule: vi.fn(),
  updateTaNoCloOwdSettings: vi.fn()
}));

vi.mock('../../api/devices', () => ({
  getDevices: vi.fn().mockResolvedValue([]),
  updateTemperatureOffset: vi.fn()
}));

vi.mock('../../api/tanoclo', () => ({
  getCircuits: vi.fn().mockResolvedValue([])
}));

vi.mock('../../api/heating', () => ({
  updateHeatingCircuitDriver: vi.fn()
}));

describe('ZoneSettings - Advanced Settings Visibility', () => {
  it('renders Advanced Settings card for HEATING zones', () => {
    const heatingZone = { id: 1, name: 'Living Room', type: 'HEATING' };
    render(
      <ZoneSettings
        homeId={1}
        zoneId={1}
        zone={heatingZone}
        onBack={vi.fn()}
        mutateZones={vi.fn()}
        onNavigateToDevice={vi.fn()}
      />
    );
    expect(screen.getByText('Advanced Settings')).toBeInTheDocument();
  });

  it('does NOT render Advanced Settings card for HOT_WATER (DHW) zones', () => {
    const dhwZone = { id: 2, name: 'Hot Water', type: 'HOT_WATER' };
    render(
      <ZoneSettings
        homeId={1}
        zoneId={2}
        zone={dhwZone}
        onBack={vi.fn()}
        mutateZones={vi.fn()}
        onNavigateToDevice={vi.fn()}
      />
    );
    expect(screen.queryByText('Advanced Settings')).toBeNull();
  });

  it('does NOT render Advanced Settings card for DHW typed zones', () => {
    const dhwZone = { id: 3, name: 'DHW Zone', type: 'DHW' };
    render(
      <ZoneSettings
        homeId={1}
        zoneId={3}
        zone={dhwZone}
        onBack={vi.fn()}
        mutateZones={vi.fn()}
        onNavigateToDevice={vi.fn()}
      />
    );
    expect(screen.queryByText('Advanced Settings')).toBeNull();
  });
});

describe('ZoneSettings - Read-Only Notice', () => {
  it('renders read-only notice when homeInfo.configReadonly is true', () => {
    vi.spyOn(useHomeModule, 'useHome').mockReturnValue({
      _zones: [],
      homeInfo: { configReadonly: true }
    });

    const heatingZone = { id: 1, name: 'Living Room', type: 'HEATING' };
    render(
      <ZoneSettings
        homeId={1}
        zoneId={1}
        zone={heatingZone}
        onBack={vi.fn()}
        mutateZones={vi.fn()}
        onNavigateToDevice={vi.fn()}
      />
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
