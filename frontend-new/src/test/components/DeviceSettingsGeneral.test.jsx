import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import DeviceSettingsGeneral from '../../components/settings/DeviceSettingsGeneral';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key) => key
  })
}));

describe('DeviceSettingsGeneral', () => {
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

  describe('Zone unassign option visibility', () => {
    const zones = [
      { id: 1, name: 'Living Room', type: 'HEATING', measuringDeviceSerial: 'VA01' }
    ];

    it('shows unassign option when device is unassigned', () => {
      const mockDevice = { serialNo: 'VA02', deviceType: 'VA02', zoneId: null };
      const html = renderToString(
        <DeviceSettingsGeneral
          device={mockDevice}
          friendlyNameInput=""
          setFriendlyNameInput={vi.fn()}
          handleSaveFriendlyName={vi.fn()}
          isSavingFriendlyName={false}
          batteryInfo={{}}
          handleBatteryTypeChange={vi.fn()}
          isBridge={false}
          assignedZoneId="none"
          handleZoneChange={vi.fn()}
          isChangingZone={false}
          isReadOnly={false}
          zones={zones}
          devices={[mockDevice]}
          circuits={[]}
          t={(k) => k}
        />
      );

      expect(html).toContain('value="none"');
    });

    it('shows unassign option when device is assigned to multi-device zone and is neither measuring device nor zone controller', () => {
      const mockDevice = { serialNo: 'VA02', deviceType: 'VA02', zoneId: 1, duties: ['ZONE_UI', 'ZONE_DRIVER'] };
      const otherDevice = { serialNo: 'VA01', deviceType: 'VA02', zoneId: 1, duties: ['ZONE_UI', 'ZONE_DRIVER', 'ZONE_LEADER'] };
      const html = renderToString(
        <DeviceSettingsGeneral
          device={mockDevice}
          friendlyNameInput=""
          setFriendlyNameInput={vi.fn()}
          handleSaveFriendlyName={vi.fn()}
          isSavingFriendlyName={false}
          batteryInfo={{}}
          handleBatteryTypeChange={vi.fn()}
          isBridge={false}
          assignedZoneId="1"
          handleZoneChange={vi.fn()}
          isChangingZone={false}
          isReadOnly={false}
          zones={zones}
          devices={[otherDevice, mockDevice]}
          circuits={[]}
          t={(k) => k}
        />
      );

      expect(html).toContain('value="none"');
    });

    it('hides unassign option when device is the only device in the zone', () => {
      const mockDevice = { serialNo: 'VA02', deviceType: 'VA02', zoneId: 1, duties: ['ZONE_UI'] };
      const html = renderToString(
        <DeviceSettingsGeneral
          device={mockDevice}
          friendlyNameInput=""
          setFriendlyNameInput={vi.fn()}
          handleSaveFriendlyName={vi.fn()}
          isSavingFriendlyName={false}
          batteryInfo={{}}
          handleBatteryTypeChange={vi.fn()}
          isBridge={false}
          assignedZoneId="1"
          handleZoneChange={vi.fn()}
          isChangingZone={false}
          isReadOnly={false}
          zones={zones}
          devices={[mockDevice]}
          circuits={[]}
          t={(k) => k}
        />
      );

      expect(html).not.toContain('value="none"');
    });

    it('hides unassign option when device is the measuring device in the zone', () => {
      const mockDevice = { serialNo: 'VA01', deviceType: 'VA02', zoneId: 1, duties: ['ZONE_UI', 'ZONE_LEADER'] };
      const otherDevice = { serialNo: 'VA02', deviceType: 'VA02', zoneId: 1, duties: ['ZONE_UI'] };
      const html = renderToString(
        <DeviceSettingsGeneral
          device={mockDevice}
          friendlyNameInput=""
          setFriendlyNameInput={vi.fn()}
          handleSaveFriendlyName={vi.fn()}
          isSavingFriendlyName={false}
          batteryInfo={{}}
          handleBatteryTypeChange={vi.fn()}
          isBridge={false}
          assignedZoneId="1"
          handleZoneChange={vi.fn()}
          isChangingZone={false}
          isReadOnly={false}
          zones={zones}
          devices={[mockDevice, otherDevice]}
          circuits={[]}
          t={(k) => k}
        />
      );

      expect(html).not.toContain('value="none"');
    });

    it('hides unassign option when device is set as a zone controller', () => {
      const mockDevice = { serialNo: 'RU01', deviceType: 'RU02', zoneId: 1, duties: ['ZONE_UI', 'CIRCUIT_DRIVER'] };
      const otherDevice = { serialNo: 'VA02', deviceType: 'VA02', zoneId: 1, duties: ['ZONE_UI', 'ZONE_LEADER'] };
      const circuits = [{ number: 1, driver_serial_no: 'RU01' }];
      const html = renderToString(
        <DeviceSettingsGeneral
          device={mockDevice}
          friendlyNameInput=""
          setFriendlyNameInput={vi.fn()}
          handleSaveFriendlyName={vi.fn()}
          isSavingFriendlyName={false}
          batteryInfo={{}}
          handleBatteryTypeChange={vi.fn()}
          isBridge={false}
          assignedZoneId="1"
          handleZoneChange={vi.fn()}
          isChangingZone={false}
          isReadOnly={false}
          zones={[{ id: 1, name: 'Living Room', type: 'HEATING', measuringDeviceSerial: 'VA02' }]}
          devices={[mockDevice, otherDevice]}
          circuits={circuits}
          t={(k) => k}
        />
      );

      expect(html).not.toContain('value="none"');
    });
  });
});
