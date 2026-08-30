import { describe, it, expect, beforeEach } from 'vitest';
import {
  getUserZoneOrderKey,
  getUserZoneOrder,
  setUserZoneOrder,
  sortZonesByUserOrder
} from '../utils/zoneOrder';

describe('utils/zoneOrder.js', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('getUserZoneOrderKey', () => {
    it('generates user-specific and home-specific key', () => {
      expect(getUserZoneOrderKey(123, 456)).toBe('tanoclo_zone_order_123_456');
      expect(getUserZoneOrderKey('user-a', 'home-b')).toBe('tanoclo_zone_order_user-a_home-b');
    });

    it('handles null or undefined values gracefully', () => {
      expect(getUserZoneOrderKey(null, 456)).toBe('tanoclo_zone_order_anon_456');
      expect(getUserZoneOrderKey(123, null)).toBe('tanoclo_zone_order_123_default');
      expect(getUserZoneOrderKey(null, null)).toBe('tanoclo_zone_order_anon_default');
    });
  });

  describe('getUserZoneOrder and setUserZoneOrder', () => {
    it('returns empty array when nothing is stored', () => {
      expect(getUserZoneOrder(1, 10)).toEqual([]);
    });

    it('saves and retrieves ordered zone IDs', () => {
      setUserZoneOrder(1, 10, [3, 1, 2]);
      expect(getUserZoneOrder(1, 10)).toEqual([3, 1, 2]);
    });

    it('isolates different users and homes', () => {
      setUserZoneOrder('user1', 'home1', [1, 2]);
      setUserZoneOrder('user2', 'home1', [2, 1]);
      setUserZoneOrder('user1', 'home2', [3, 4]);

      expect(getUserZoneOrder('user1', 'home1')).toEqual([1, 2]);
      expect(getUserZoneOrder('user2', 'home1')).toEqual([2, 1]);
      expect(getUserZoneOrder('user1', 'home2')).toEqual([3, 4]);
    });

    it('handles invalid JSON in localStorage safely', () => {
      localStorage.setItem('tanoclo_zone_order_1_10', 'invalid-json{');
      expect(getUserZoneOrder(1, 10)).toEqual([]);
    });
  });

  describe('sortZonesByUserOrder', () => {
    const mockZones = [
      { id: 1, name: 'Living Room' },
      { id: 2, name: 'Kitchen' },
      { id: 3, name: 'Bedroom' }
    ];

    it('returns original zones array when no custom order exists', () => {
      const result = sortZonesByUserOrder(mockZones, 1, 10);
      expect(result.map(z => z.id)).toEqual([1, 2, 3]);
    });

    it('sorts zones according to user saved order', () => {
      setUserZoneOrder(1, 10, [3, 1, 2]);
      const result = sortZonesByUserOrder(mockZones, 1, 10);
      expect(result.map(z => z.id)).toEqual([3, 1, 2]);
    });

    it('appends newly discovered zones not in saved order to the end', () => {
      setUserZoneOrder(1, 10, [3]); // only 3 was ordered
      const result = sortZonesByUserOrder(mockZones, 1, 10);
      expect(result.map(z => z.id)).toEqual([3, 1, 2]);
    });

    it('handles string vs numeric ID comparisons correctly', () => {
      setUserZoneOrder(1, 10, ['2', '3', '1']);
      const result = sortZonesByUserOrder(mockZones, 1, 10);
      expect(result.map(z => z.id)).toEqual([2, 3, 1]);
    });

    it('handles empty or single zone inputs safely', () => {
      expect(sortZonesByUserOrder([], 1, 10)).toEqual([]);
      expect(sortZonesByUserOrder(null, 1, 10)).toEqual([]);
      expect(sortZonesByUserOrder([{ id: 1 }], 1, 10)).toEqual([{ id: 1 }]);
    });
  });
});
