import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import DeviceSettingsGeneral from '../../components/settings/DeviceSettingsGeneral';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key) => key
  })
}));

describe('DeviceSettingsGeneral - Read-Only Battery Type', () => {
  it('keeps battery type selector enabled even when isReadOnly is true', () => {
    const mockDevice = { serialNo: 'VA123456789', deviceType: 'VA02' };
    const mockBatteryInfo = { battery_type: 'alkaline', battery_percent: 85, battery_state: 'GOOD' };

    const html = renderToString(
      <DeviceSettingsGeneral
        device={mockDevice}
        friendlyNameInput="Test Valve"
        setFriendlyNameInput={vi.fn()}
        handleSaveFriendlyName={vi.fn()}
        isSavingFriendlyName={false}
        batteryInfo={mockBatteryInfo}
        handleBatteryTypeChange={vi.fn()}
        isBridge={false}
        assignedZoneId="1"
        handleZoneChange={vi.fn()}
        isChangingZone={false}
        isReadOnly={true}
        zones={[]}
        devices={[]}
        t={(k) => k}
      />
    );

    expect(html).toContain('<select');
    expect(html).toContain('alkaline');
  });
});
