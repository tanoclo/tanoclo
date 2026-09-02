import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => opts?.defaultValue || key
  })
}));

vi.mock('../../components/settings/SupplyTempSettings', () => ({
  default: () => null
}));

vi.mock('../../components/settings/BoilerCircuitsSettings', () => ({
  default: () => null
}));

vi.mock('../../components/settings/RawExplorerSettings', () => ({
  default: () => null
}));

vi.mock('swr', () => ({
  default: (key) => {
    if (key && typeof key === 'string' && key.includes('battery')) {
      return {
        data: [
          { serial_no: 'VA1234567890', battery_percent: 85, battery_state: 'GOOD' },
          { serial_no: 'RU1234567890', battery_percent: 15, battery_state: 'LOW' }
        ]
      };
    }
    return { data: null };
  }
}));

import ServerSettingsPanel from '../../pages/settings/ServerSettingsPanel';

describe('ServerSettingsPanel', () => {
  const mockTranslate = (key, opts) => opts?.defaultValue || key;

  it('renders battery percentage for battery-powered devices and hides for bridge/emulated devices', () => {
    const devices = [
      {
        serialNo: 'VA1234567890',
        deviceType: 'VA02',
        friendlyName: 'Living Room TRV',
        currentFwVersion: '215.1',
        connectionState: { value: true }
      },
      {
        serialNo: 'RU1234567890',
        deviceType: 'RU02',
        friendlyName: 'Hallway Thermostat',
        currentFwVersion: '215.1',
        connectionState: { value: true }
      },
      {
        serialNo: 'IB1234567890',
        deviceType: 'IB01',
        friendlyName: 'Internet Bridge',
        currentFwVersion: '215.1',
        connectionState: { value: true }
      },
      {
        serialNo: 'VA9999999999',
        deviceType: 'VA02',
        friendlyName: 'Emulated Valve',
        isEmulated: true,
        currentFwVersion: '215.1',
        connectionState: { value: true }
      }
    ];

    const html = renderToString(
      <ServerSettingsPanel
        activeSection="devices"
        activeHomeId={1}
        zones={[]}
        devices={devices}
        searchParams={new URLSearchParams('section=devices')}
        setSearchParams={vi.fn()}
        setIsAddDeviceOpen={vi.fn()}
        isReadOnly={false}
        t={mockTranslate}
      />
    );

    // TRV battery percentage
    expect(html).toContain('85%');
    // Low battery percentage
    expect(html).toContain('15%');
    // Device names rendered
    expect(html).toContain('Living Room TRV');
    expect(html).toContain('Internet Bridge');
    expect(html).toContain('Emulated Valve');
  });
});
