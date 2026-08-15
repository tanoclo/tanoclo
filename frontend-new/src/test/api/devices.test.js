import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/client', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../api/client';
import {
  getDevices, createDevice, getDevice, deleteDevice,
  getTemperatureOffset, updateTemperatureOffset,
  identifyDevice, updateChildLock, updateOrientation,
  startPairing, stopPairing, updateActuatorLimits,
  updateFriendlyName, updateDisplaySettings
} from '../../api/devices';

describe('api/devices.js', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({});
  });

  it('getDevices → GET /api/v2/homes/{homeId}/devices', async () => {
    await getDevices(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/devices');
  });

  it('createDevice → POST with body', async () => {
    const data = { serialNo: 'ABC', deviceType: 'VA01' };
    await createDevice(1, data);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/devices', {
      method: 'POST', body: data
    });
  });

  it('getDevice → GET with homeId + deviceId', async () => {
    await getDevice(1, 'DEV1');
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/devices/DEV1');
  });

  it('deleteDevice → DELETE', async () => {
    await deleteDevice(1, 'DEV1');
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/devices/DEV1', { method: 'DELETE' });
  });

  it('getTemperatureOffset → GET', async () => {
    await getTemperatureOffset(1, 'DEV1');
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/devices/DEV1/temperatureOffset');
  });

  it('updateTemperatureOffset → PUT with celsius', async () => {
    await updateTemperatureOffset(1, 'DEV1', 2.5);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/devices/DEV1/temperatureOffset', {
      method: 'PUT', body: { celsius: 2.5 }
    });
  });

  it('identifyDevice → POST', async () => {
    await identifyDevice(1, 'DEV1');
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/devices/DEV1/identify', { method: 'POST' });
  });

  it('updateChildLock → PUT with childLockEnabled', async () => {
    await updateChildLock(1, 'DEV1', true);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/devices/DEV1/childLock', {
      method: 'PUT', body: { childLockEnabled: true }
    });
  });

  it('updateOrientation → POST with orientation', async () => {
    await updateOrientation(1, 'DEV1', 'HORIZONTAL');
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/devices/DEV1/orientation', {
      method: 'POST', body: { orientation: 'HORIZONTAL' }
    });
  });

  it('startPairing → POST', async () => {
    await startPairing(1, 'DEV1');
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/devices/DEV1/pairing', { method: 'POST' });
  });

  it('stopPairing → DELETE', async () => {
    await stopPairing(1, 'DEV1');
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/devices/DEV1/pairing', { method: 'DELETE' });
  });

  it('updateActuatorLimits → PUT with limits', async () => {
    const limits = { lowSteps: 10, highSteps: 200 };
    await updateActuatorLimits(1, 'DEV1', limits);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/devices/DEV1/actuatorLimits', {
      method: 'PUT', body: limits
    });
  });

  it('updateFriendlyName → PUT to tanoclo endpoint', async () => {
    await updateFriendlyName(1, 'DEV1', 'Living Room');
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/tanoclo/devices/DEV1/friendlyName', {
      method: 'PUT', body: { friendlyName: 'Living Room' }
    });
  });

  it('updateDisplaySettings → PUT with settings', async () => {
    const settings = { displayBrightness: 80 };
    await updateDisplaySettings(1, 'DEV1', settings);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/devices/DEV1/displaySettings', {
      method: 'PUT', body: settings
    });
  });
});
