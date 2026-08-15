import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/client', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../api/client';
import {
  getRawBoilerData, getDeviceBatteryData, getRawDeviceData, getRawZoneData,
  getCircuits, getBridge, updateDeviceBatteryType,
  getHomeTimezone, updateHomeTimezone
} from '../../api/tanoclo';

describe('api/tanoclo.js', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({});
  });

  it('getRawBoilerData → GET', async () => {
    await getRawBoilerData(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/tanoclo/boiler/raw');
  });

  it('getDeviceBatteryData → GET', async () => {
    await getDeviceBatteryData(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/tanoclo/devices/battery');
  });

  it('getRawDeviceData → GET with deviceId', async () => {
    await getRawDeviceData(1, 'DEV1');
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/tanoclo/devices/DEV1/raw');
  });

  it('getRawZoneData → GET with zoneId', async () => {
    await getRawZoneData(1, 3);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/tanoclo/zones/3/raw');
  });

  it('getCircuits → GET', async () => {
    await getCircuits(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/tanoclo/circuits');
  });

  it('getBridge → GET', async () => {
    await getBridge(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/tanoclo/bridge');
  });

  it('updateDeviceBatteryType → PUT', async () => {
    await updateDeviceBatteryType(1, 'SN001', 'LITHIUM');
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/tanoclo/devices/SN001/battery', {
      method: 'PUT', body: { batteryType: 'LITHIUM' }
    });
  });

  it('getHomeTimezone → GET', async () => {
    await getHomeTimezone(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/tanoclo/timezone');
  });

  it('updateHomeTimezone → PUT', async () => {
    await updateHomeTimezone(1, 'Europe/Amsterdam');
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/tanoclo/timezone', {
      method: 'PUT', body: { dateTimeZone: 'Europe/Amsterdam' }
    });
  });
});
