import { describe, it, expect } from 'vitest';
import { SWR_KEYS } from '../utils/swrKeys';

describe('utils/swrKeys.js', () => {
  describe('home-level keys', () => {
    it('homeInfo', () => {
      expect(SWR_KEYS.homeInfo(42)).toBe('/homes/42/info');
    });
    it('homeState', () => {
      expect(SWR_KEYS.homeState(1)).toBe('/homes/1/state');
    });
    it('homeDetails', () => {
      expect(SWR_KEYS.homeDetails(1)).toBe('/homes/1/details');
    });
    it('weather', () => {
      expect(SWR_KEYS.weather(5)).toBe('/homes/5/weather');
    });
    it('climateQuality', () => {
      expect(SWR_KEYS.climateQuality(3)).toBe('/homes/3/climateQuality');
    });
    it('timezone', () => {
      expect(SWR_KEYS.timezone(1)).toBe('/homes/1/tanoclo/timezone');
    });
  });

  describe('zone keys', () => {
    it('zones', () => {
      expect(SWR_KEYS.zones(1)).toBe('/homes/1/zones');
    });
    it('zoneStates', () => {
      expect(SWR_KEYS.zoneStates(1)).toBe('/homes/1/zoneStates');
    });
    it('zoneState', () => {
      expect(SWR_KEYS.zoneState(1, 5)).toBe('/homes/1/zones/5/state');
    });
    it('defaultOverlay', () => {
      expect(SWR_KEYS.defaultOverlay(1, 3)).toBe('/homes/1/zones/3/defaultOverlay');
    });
    it('zoneControl', () => {
      expect(SWR_KEYS.zoneControl(2, 4)).toBe('/homes/2/zones/4/control');
    });
  });

  describe('schedule keys', () => {
    it('activeTimetable', () => {
      expect(SWR_KEYS.activeTimetable(1, 2)).toBe('/homes/1/zones/2/schedule/activeTimetable');
    });
    it('timetableBlocks with 3 params', () => {
      expect(SWR_KEYS.timetableBlocks(1, 2, 3)).toBe('/homes/1/zones/2/schedule/timetables/3/blocks');
    });
  });

  describe('device keys', () => {
    it('devices', () => {
      expect(SWR_KEYS.devices(1)).toBe('/homes/1/devices');
    });
    it('deviceDetails', () => {
      expect(SWR_KEYS.deviceDetails(1, 'ABC123')).toBe('/homes/1/devices/ABC123');
    });
    it('deviceRaw', () => {
      expect(SWR_KEYS.deviceRaw(1, 'XY')).toBe('/homes/1/tanoclo/devices/XY/raw');
    });
    it('batteryDevices', () => {
      expect(SWR_KEYS.batteryDevices(1)).toBe('/homes/1/batteryDevices');
    });
    it('batteryDevicesRaw', () => {
      expect(SWR_KEYS.batteryDevicesRaw(1)).toBe('/homes/1/tanoclo/devices/battery');
    });
    it('bridge', () => {
      expect(SWR_KEYS.bridge(1)).toBe('/homes/1/tanoclo/bridge');
    });
  });

  describe('user keys', () => {
    it('users', () => {
      expect(SWR_KEYS.users(1)).toBe('/homes/1/users');
    });
    it('mobileDevice', () => {
      expect(SWR_KEYS.mobileDevice(1, 99)).toBe('/homes/1/mobileDevices/99');
    });
    it('mobileDevices', () => {
      expect(SWR_KEYS.mobileDevices(1)).toBe('/homes/1/mobileDevices');
    });
  });

  describe('heating keys', () => {
    it('runningTimes', () => {
      expect(SWR_KEYS.runningTimes(1)).toBe('/homes/1/runningTimes');
    });
    it('runningTimesQuery', () => {
      expect(SWR_KEYS.runningTimesQuery(1, '2026-01-01', '2026-01-31', 'day'))
        .toBe('/homes/1/runningTimes?from=2026-01-01&to=2026-01-31&aggregate=day');
    });
    it('dayReport with date query', () => {
      expect(SWR_KEYS.dayReport(1, 2, '2026-07-13'))
        .toBe('/homes/1/tanoclo/zones/2/dayReport?date=2026-07-13');
    });
    it('standardDayReport', () => {
      expect(SWR_KEYS.standardDayReport(1, 2, '2026-07-13'))
        .toBe('/homes/1/zones/2/dayReport?date=2026-07-13');
    });
    it('boilerRaw', () => {
      expect(SWR_KEYS.boilerRaw(1)).toBe('/homes/1/tanoclo/boiler/raw');
    });
    it('circuits', () => {
      expect(SWR_KEYS.circuits(1)).toBe('/homes/1/tanoclo/circuits');
    });
    it('heatingSystem', () => {
      expect(SWR_KEYS.heatingSystem(1)).toBe('/homes/1/heatingSystem');
    });
    it('boilerDetails', () => {
      expect(SWR_KEYS.boilerDetails(1)).toBe('/homes/1/heatingSystem/boiler');
    });
    it('heatingCircuits', () => {
      expect(SWR_KEYS.heatingCircuits(1)).toBe('/homes/1/heatingCircuits');
    });
    it('supplyTempOptimization', () => {
      expect(SWR_KEYS.supplyTempOptimization(1)).toBe('/homes/1/supplyTemperatureOptimization');
    });
  });
});
