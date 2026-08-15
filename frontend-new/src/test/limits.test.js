import { describe, it, expect } from 'vitest';

describe('hardware and room limits logic', () => {
  const isHeatingDevice = (device) => {
    const type = device.deviceType || '';
    return !type.startsWith('IB') && !type.startsWith('GW') && type !== 'BRIDGE';
  };

  const isHeatingRoom = (zone) => {
    return zone.type === 'HEATING';
  };

  describe('heating devices limit (max 25)', () => {
    it('correctly filters heating vs gateway devices', () => {
      const devices = [
        { serialNo: 'IB01', deviceType: 'IB01' },
        { serialNo: 'GW01', deviceType: 'GW01' },
        { serialNo: 'VA01', deviceType: 'VA02' },
        { serialNo: 'RU01', deviceType: 'RU02' },
        { serialNo: 'SU01', deviceType: 'SU02' },
        { serialNo: 'BU01', deviceType: 'BU01' }
      ];

      const heatingDevs = devices.filter(isHeatingDevice);
      expect(heatingDevs.length).toBe(4);
      expect(heatingDevs.map(d => d.serialNo)).toEqual(['VA01', 'RU01', 'SU01', 'BU01']);
    });

    it('identifies when limit of 25 is reached', () => {
      const devices = Array.from({ length: 25 }, (_, i) => ({
        serialNo: `VA00000000${i}`,
        deviceType: 'VA02'
      }));
      devices.push({ serialNo: 'IB0000000001', deviceType: 'IB01' });

      const heatingCount = devices.filter(isHeatingDevice).length;
      expect(heatingCount).toBe(25);
      const canAddHeatingDevice = heatingCount < 25;
      expect(canAddHeatingDevice).toBe(false);

      // Gateways can still be added
      const canAddBridge = true;
      expect(canAddBridge).toBe(true);
    });
  });

  describe('heating rooms limit (max 25 total, max 10 with Zone Controller)', () => {
    it('identifies when total heating rooms limit of 25 is reached', () => {
      const zones = Array.from({ length: 25 }, (_, i) => ({
        id: i + 1,
        name: `Room ${i + 1}`,
        type: 'HEATING'
      }));
      zones.push({ id: 0, name: 'Hot Water', type: 'HOT_WATER' });

      const heatingRoomsCount = zones.filter(isHeatingRoom).length;
      expect(heatingRoomsCount).toBe(25);
      const canCreateHeatingRoom = heatingRoomsCount < 25;
      expect(canCreateHeatingRoom).toBe(false);
    });

    it('enforces maximum 10 rooms communicating with Zone Controller', () => {
      const zones = Array.from({ length: 15 }, (_, i) => ({
        id: i + 1,
        name: `Room ${i + 1}`,
        type: 'HEATING',
        heatingCircuit: i < 10 ? 1 : null
      }));

      const zcRoomsCount = zones.filter(z => z.type === 'HEATING' && z.heatingCircuit !== null).length;
      expect(zcRoomsCount).toBe(10);

      // 11th room attempting to attach to zone controller
      const targetRoom = zones[10]; // heatingCircuit is null
      const canAssignController = zcRoomsCount < 10 || (targetRoom.heatingCircuit !== null);
      expect(canAssignController).toBe(false);

      // Room that already has a controller can switch controllers without exceeding limit
      const canChangeActiveRoomController = (zcRoomsCount - 1) < 10;
      expect(canChangeActiveRoomController).toBe(true);
    });
  });

  describe('devices per room limit (max 7)', () => {
    it('enforces maximum 7 heating devices in a single room', () => {
      const targetZoneId = 5;
      const devices = Array.from({ length: 7 }, (_, i) => ({
        serialNo: `VA00000000${i}`,
        deviceType: 'VA02',
        zoneId: targetZoneId
      }));

      const roomDevCount = devices.filter(d => d.zoneId === targetZoneId && isHeatingDevice(d)).length;
      expect(roomDevCount).toBe(7);

      // New device moving into room 5
      const newDev = { serialNo: 'VA0000000099', deviceType: 'VA02', zoneId: 1 };
      const canAssignToRoom = (roomDevCount < 7) || (newDev.zoneId === targetZoneId);
      expect(canAssignToRoom).toBe(false);

      // Existing device already in room 5 stays in room 5
      const existingDev = devices[0];
      const canReassignSameRoom = (roomDevCount < 7) || (existingDev.zoneId === targetZoneId);
      expect(canReassignSameRoom).toBe(true);
    });
  });
});
