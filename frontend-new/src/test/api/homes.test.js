import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/client', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../api/client';
import {
  getHomeInfo, getHomeDetails, updateHomeDetails,
  getHomeState, setHomePresenceLock, releaseHomePresenceLock,
  getHomeWeather, getHomeUsers, updateZoneOrder,
  updateAwayRadius, updateHomeGeolocation, updateHomeAdmin,
  toggleUserAdminStatus, inviteUserToHome, deleteUserFromHome
} from '../../api/homes';

describe('api/homes.js', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({});
  });

  it('getHomeInfo → GET', async () => {
    await getHomeInfo(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1');
  });

  it('getHomeDetails → GET', async () => {
    await getHomeDetails(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/details');
  });

  it('updateHomeDetails → PUT', async () => {
    const details = { name: 'My Home' };
    await updateHomeDetails(1, details);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/details', {
      method: 'PUT', body: details
    });
  });

  it('getHomeState → GET', async () => {
    await getHomeState(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/state');
  });

  it('setHomePresenceLock → PUT with homePresence', async () => {
    await setHomePresenceLock(1, 'AWAY');
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/presenceLock', {
      method: 'PUT', body: { homePresence: 'AWAY' }
    });
  });

  it('releaseHomePresenceLock → DELETE', async () => {
    await releaseHomePresenceLock(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/presenceLock', { method: 'DELETE' });
  });

  it('getHomeWeather → GET', async () => {
    await getHomeWeather(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/weather');
  });

  it('getHomeUsers → GET', async () => {
    await getHomeUsers(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/users');
  });

  it('updateZoneOrder → PUT with array body', async () => {
    await updateZoneOrder(1, [3, 1, 2]);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/zoneOrder', {
      method: 'PUT', body: [3, 1, 2]
    });
  });

  it('updateAwayRadius → PUT', async () => {
    await updateAwayRadius(1, 500);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/awayRadiusInMeters', {
      method: 'PUT', body: { awayRadiusInMeters: 500 }
    });
  });

  it('updateHomeGeolocation → PUT with lat/lon', async () => {
    await updateHomeGeolocation(1, 52.37, 4.89);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/geolocation', {
      method: 'PUT', body: { latitude: 52.37, longitude: 4.89 }
    });
  });

  it('updateHomeAdmin → PUT', async () => {
    await updateHomeAdmin(1, 'user42');
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/admin/user42', {
      method: 'PUT', body: {}
    });
  });

  it('toggleUserAdminStatus → PUT', async () => {
    await toggleUserAdminStatus(1, 'u1', true);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/tanoclo/users/u1/admin', {
      method: 'PUT', body: { isAdmin: true }
    });
  });

  it('inviteUserToHome → POST with email', async () => {
    await inviteUserToHome(1, 'user@example.com');
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/invitations', {
      method: 'POST', body: { email: 'user@example.com' }
    });
  });

  it('deleteUserFromHome → DELETE with encoded username', async () => {
    await deleteUserFromHome(1, 'user@example.com');
    expect(apiFetch).toHaveBeenCalledWith(
      `/api/v2/homes/1/users/${encodeURIComponent('user@example.com')}`,
      { method: 'DELETE' }
    );
  });
});
