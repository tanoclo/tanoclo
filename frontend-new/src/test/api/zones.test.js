import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/client', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../api/client';
import {
  getZones, getZoneStates, getZoneState, getZoneCapabilities,
  setZoneOverlay, resumeZoneSchedule, setHomeOverlay, resumeHomeSchedule,
  activateOpenWindow, dismissOpenWindow,
  getActiveTimetable, setActiveTimetable, getTimetables,
  getTimetableBlocks, getDayBlocks, updateDayBlocks,
  copySchedule, updateZoneDetails, updateEarlyStart,
  updateDazzle, updateOpenWindowDetection, updateDefaultOverlay, getDefaultOverlay,
  addDeviceToZone, removeDeviceFromZone, updateMeasuringDevice,
  updateHeatingCircuit, createZone, getZoneControl,
  updateOfflineSchedule, syncOfflineSchedule, updateTaNoCloOwdSettings
} from '../../api/zones';

describe('api/zones.js', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({});
  });

  it('getZones → GET', async () => {
    await getZones(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones');
  });

  it('getZoneStates → GET', async () => {
    await getZoneStates(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zoneStates');
  });

  it('getZoneState → GET with zoneId', async () => {
    await getZoneState(1, 5);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/5/state');
  });

  it('getZoneCapabilities → GET', async () => {
    await getZoneCapabilities(1, 2);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/2/capabilities');
  });

  it('setZoneOverlay → PUT with nested overlay', async () => {
    const overlay = {
      setting: { type: 'HEATING', temperature: { celsius: 21.0 } },
      termination: { type: 'TADO_MODE' }
    };
    await setZoneOverlay(1, 2, overlay);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/2/overlay', {
      method: 'PUT', body: overlay
    });
  });

  it('resumeZoneSchedule → DELETE', async () => {
    await resumeZoneSchedule(1, 2);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/2/overlay', { method: 'DELETE' });
  });

  it('setHomeOverlay → POST', async () => {
    const overlay = { type: 'MANUAL' };
    await setHomeOverlay(1, overlay);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/overlay', {
      method: 'POST', body: overlay
    });
  });

  it('resumeHomeSchedule → DELETE', async () => {
    await resumeHomeSchedule(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/overlay', { method: 'DELETE' });
  });

  it('activateOpenWindow → POST', async () => {
    await activateOpenWindow(1, 3);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/3/state/openWindow/activate', { method: 'POST' });
  });

  it('dismissOpenWindow → DELETE', async () => {
    await dismissOpenWindow(1, 3);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/3/state/openWindow', { method: 'DELETE' });
  });

  it('getActiveTimetable → GET', async () => {
    await getActiveTimetable(1, 2);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/2/schedule/activeTimetable');
  });

  it('setActiveTimetable → PUT with id', async () => {
    await setActiveTimetable(1, 2, 1);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/2/schedule/activeTimetable', {
      method: 'PUT', body: { id: 1 }
    });
  });

  it('getTimetables → GET', async () => {
    await getTimetables(1, 2);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/2/schedule/timetables');
  });

  it('getTimetableBlocks → GET', async () => {
    await getTimetableBlocks(1, 2, 0);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/2/schedule/timetables/0/blocks');
  });

  it('getDayBlocks → GET with dayType', async () => {
    await getDayBlocks(1, 2, 0, 'MONDAY');
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/2/schedule/timetables/0/blocks/MONDAY');
  });

  it('updateDayBlocks → PUT with array body', async () => {
    const blocks = [{ start: '06:00', end: '22:00', temperature: 21 }];
    await updateDayBlocks(1, 2, 0, 'MONDAY', blocks);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/2/schedule/timetables/0/blocks/MONDAY', {
      method: 'PUT', body: blocks
    });
  });

  it('copySchedule → POST with targetZoneIds', async () => {
    await copySchedule(1, 2, [3, 4]);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/2/schedule/copy', {
      method: 'POST', body: { targetZoneIds: [3, 4] }
    });
  });

  it('updateZoneDetails → PUT', async () => {
    await updateZoneDetails(1, 2, { name: 'Room' });
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/2/details', {
      method: 'PUT', body: { name: 'Room' }
    });
  });

  it('updateEarlyStart → PUT', async () => {
    await updateEarlyStart(1, 2, true);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/2/earlyStart', {
      method: 'PUT', body: { enabled: true }
    });
  });

  it('updateDazzle → PUT', async () => {
    await updateDazzle(1, 2, false);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/2/dazzle', {
      method: 'PUT', body: { enabled: false }
    });
  });

  it('updateOpenWindowDetection → PUT with all params including defaults', async () => {
    await updateOpenWindowDetection(1, 2, true);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/2/openWindowDetection', {
      method: 'PUT', body: { enabled: true, timeoutInSeconds: 900, temperatureDeviationLimit: 0.50, owdNvmState: 1 }
    });
  });

  it('updateOpenWindowDetection → PUT with custom params', async () => {
    await updateOpenWindowDetection(1, 2, false, 1800, 1.0, 0);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/2/openWindowDetection', {
      method: 'PUT', body: { enabled: false, timeoutInSeconds: 1800, temperatureDeviationLimit: 1.0, owdNvmState: 0 }
    });
  });

  it('updateDefaultOverlay → PUT', async () => {
    const overlay = { termination: { type: 'MANUAL' } };
    await updateDefaultOverlay(1, 2, overlay);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/2/defaultOverlay', {
      method: 'PUT', body: overlay
    });
  });

  it('getDefaultOverlay → GET', async () => {
    await getDefaultOverlay(1, 2);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/2/defaultOverlay');
  });

  it('addDeviceToZone → POST', async () => {
    await addDeviceToZone(1, 2, 'ABC123');
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/2/devices', {
      method: 'POST', body: { serialNo: 'ABC123' }
    });
  });

  it('removeDeviceFromZone → DELETE', async () => {
    await removeDeviceFromZone(1, 2, 'ABC123');
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/2/devices/ABC123', { method: 'DELETE' });
  });

  it('updateMeasuringDevice → PUT', async () => {
    await updateMeasuringDevice(1, 2, 'SN001');
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/2/measuringDevice', {
      method: 'PUT', body: { serialNo: 'SN001' }
    });
  });

  it('updateHeatingCircuit → PUT', async () => {
    await updateHeatingCircuit(1, 2, 0);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/2/control/heatingCircuit', {
      method: 'PUT', body: { circuitNumber: 0 }
    });
  });

  it('createZone → POST', async () => {
    await createZone(1, { name: 'New', type: 'HEATING' });
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones', {
      method: 'POST', body: { name: 'New', type: 'HEATING' }
    });
  });

  it('getZoneControl → GET', async () => {
    await getZoneControl(1, 2);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/2/control');
  });

  it('updateOfflineSchedule → PUT', async () => {
    await updateOfflineSchedule(1, 2, true);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/2/offline-schedule', {
      method: 'PUT', body: { enabled: true }
    });
  });

  it('syncOfflineSchedule → POST', async () => {
    await syncOfflineSchedule(1, 2);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/2/offline-schedule/sync', { method: 'POST' });
  });

  it('updateTaNoCloOwdSettings → PUT', async () => {
    await updateTaNoCloOwdSettings(1, 2, true, 'server');
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zones/2/tanoclo/owd', {
      method: 'PUT', body: { enabled: true, source: 'server' }
    });
  });
});
