import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { STORAGE_KEYS } from '../utils/constants';

// Mock the auth module
vi.mock('../api/auth', () => ({
  refreshAccessToken: vi.fn(),
}));

import { refreshAccessToken } from '../api/auth';

describe('api/client.js - apiFetch', () => {
  let apiFetch;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn());
    localStorage.clear();

    const clientModule = await import('../api/client');
    apiFetch = clientModule.apiFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('injects Bearer token when stored in localStorage', async () => {
    localStorage.setItem(STORAGE_KEYS.AUTH_TOKEN, 'my-access-token');
    
    globalThis.fetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: (h) => h === 'content-type' ? 'application/json' : null },
      json: async () => ({ success: true }),
    });

    const data = await apiFetch('/test');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/test'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer my-access-token',
        }),
      })
    );
    expect(data).toEqual({ success: true });
  });

  it('automatically stringifies object body payloads and sets Content-Type', async () => {
    globalThis.fetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: (h) => h === 'content-type' ? 'application/json' : null },
      json: async () => ({ ok: true }),
    });

    await apiFetch('/post-data', {
      method: 'POST',
      body: { name: 'tado' },
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/post-data'),
      expect.objectContaining({
        body: JSON.stringify({ name: 'tado' }),
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      })
    );
  });

  it('attempts to refresh token and retries request on 401', async () => {
    localStorage.setItem(STORAGE_KEYS.AUTH_TOKEN, 'expired-token');

    // First call: 401
    globalThis.fetch.mockResolvedValueOnce({
      status: 401,
      ok: false,
      json: async () => ({ error: 'Unauthorized' }),
    });

    refreshAccessToken.mockResolvedValueOnce({
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
    });

    // Retry: 200
    globalThis.fetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: { get: (h) => h === 'content-type' ? 'application/json' : null },
      json: async () => ({ retried: true }),
    });

    const data = await apiFetch('/secure-endpoint');

    expect(refreshAccessToken).toHaveBeenCalledWith(null);
    expect(localStorage.getItem(STORAGE_KEYS.AUTH_TOKEN)).toBe('new-access-token');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(data).toEqual({ retried: true });
  });

  it('queues concurrent requests during refresh and retries them', async () => {
    localStorage.setItem(STORAGE_KEYS.AUTH_TOKEN, 'expired-token');

    let callCount1 = 0, callCount2 = 0;
    globalThis.fetch.mockImplementation((url) => {
      if (url.includes('/endpoint1')) {
        callCount1++;
        if (callCount1 === 1) return Promise.resolve({ status: 401, ok: false, json: async () => ({}) });
        return Promise.resolve({ status: 200, ok: true, headers: { get: () => 'application/json' }, json: async () => ({ endpoint: 1 }) });
      }
      if (url.includes('/endpoint2')) {
        callCount2++;
        if (callCount2 === 1) return Promise.resolve({ status: 401, ok: false, json: async () => ({}) });
        return Promise.resolve({ status: 200, ok: true, headers: { get: () => 'application/json' }, json: async () => ({ endpoint: 2 }) });
      }
    });

    let resolveRefresh;
    refreshAccessToken.mockReturnValueOnce(new Promise(r => { resolveRefresh = r; }));

    const req1 = apiFetch('/endpoint1');
    const req2 = apiFetch('/endpoint2');
    await new Promise(r => setTimeout(r, 10));
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);

    resolveRefresh({ access_token: 'fresh', refresh_token: 'fr' });
    const [res1, res2] = await Promise.all([req1, req2]);
    expect(res1).toEqual({ endpoint: 1 });
    expect(res2).toEqual({ endpoint: 2 });
  });

  it('rejects queued requests when refresh fails', async () => {
    localStorage.setItem(STORAGE_KEYS.AUTH_TOKEN, 'expired-token');

    globalThis.fetch.mockResolvedValue({ status: 401, ok: false, json: async () => ({}) });
    refreshAccessToken.mockRejectedValueOnce(new Error('Invalid refresh token'));

    const req1 = apiFetch('/endpoint1');
    const req2 = apiFetch('/endpoint2');

    await expect(req1).rejects.toThrow('Invalid refresh token');
    await expect(req2).rejects.toThrow('Token refresh failed');
    expect(localStorage.getItem(STORAGE_KEYS.AUTH_TOKEN)).toBeNull();
  });
});
