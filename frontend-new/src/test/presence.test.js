import { describe, it, expect } from 'vitest';
import { getAutoPresenceState } from '../utils/presence';

describe('getAutoPresenceState', () => {
  it('returns HOME when users array is empty or null', () => {
    expect(getAutoPresenceState([], [])).toBe('HOME');
    expect(getAutoPresenceState(null, null)).toBe('HOME');
  });

  it('returns HOME when no user has a linked geofence device', () => {
    const users = [{ id: 1 }, { id: 2 }];
    const devices = [];
    expect(getAutoPresenceState(users, devices)).toBe('HOME');
  });

  it('returns HOME when any active recent device is atHome', () => {
    const users = [{ id: 1 }, { id: 2 }];
    const devices = [
      {
        user_id: 1,
        settings: { geoTrackingEnabled: true },
        location: { atHome: true, lastSeen: new Date().toISOString() }
      },
      {
        user_id: 2,
        settings: { geoTrackingEnabled: true },
        location: { atHome: false, lastSeen: new Date().toISOString() }
      }
    ];
    expect(getAutoPresenceState(users, devices)).toBe('HOME');
  });

  it('returns AWAY when all users with known active devices are away', () => {
    const users = [{ id: 1 }, { id: 2 }];
    const devices = [
      {
        user_id: 1,
        settings: { geoTrackingEnabled: true },
        location: { atHome: false, lastSeen: new Date().toISOString() }
      },
      {
        user_id: 2,
        settings: { geoTrackingEnabled: true },
        location: { atHome: false, lastSeen: new Date().toISOString() }
      }
    ];
    expect(getAutoPresenceState(users, devices)).toBe('AWAY');
  });

  it('returns HOME when devices are stale (>24h old)', () => {
    const users = [{ id: 1 }];
    const staleDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const devices = [
      {
        user_id: 1,
        settings: { geoTrackingEnabled: true },
        location: { atHome: false, lastSeen: staleDate }
      }
    ];
    expect(getAutoPresenceState(users, devices)).toBe('HOME');
  });
});
