import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/client', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../api/client';
import {
  getMobileDevices, getMobileDevice, deleteMobileDevice,
  updateUserProfile, updateUserEmail, updateUserPassword
} from '../../api/users';

describe('api/users.js', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({});
  });

  it('getMobileDevices → GET', async () => {
    await getMobileDevices(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/mobileDevices');
  });

  it('getMobileDevice → GET', async () => {
    await getMobileDevice(1, 99);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/mobileDevices/99');
  });

  it('deleteMobileDevice → DELETE', async () => {
    await deleteMobileDevice(1, 99);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/mobileDevices/99', { method: 'DELETE' });
  });

  it('updateUserProfile → PUT', async () => {
    await updateUserProfile('u1', { name: 'Test User', locale: 'en' });
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/users/u1', {
      method: 'PUT', body: { name: 'Test User', locale: 'en' }
    });
  });

  it('updateUserEmail → PUT with email and password', async () => {
    await updateUserEmail('u1', 'new@email.com', 'pass123');
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/users/u1/email', {
      method: 'PUT', body: { email: 'new@email.com', currentPassword: 'pass123' }
    });
  });

  it('updateUserPassword → PUT with passwords', async () => {
    await updateUserPassword('u1', 'newpass', 'oldpass');
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/users/u1/password', {
      method: 'PUT', body: { password: 'newpass', currentPassword: 'oldpass' }
    });
  });
});
