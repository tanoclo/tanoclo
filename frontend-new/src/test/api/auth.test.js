import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally
vi.stubGlobal('fetch', vi.fn());

describe('api/auth.js', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    sessionStorage.clear();
    fetch.mockReset();
    globalThis.window = globalThis.window || {};
    globalThis.window.location = { href: 'http://localhost:5173/', origin: 'http://localhost:5173' };
    globalThis.location = globalThis.window.location;
    // Mock crypto for PKCE
    if (!globalThis.crypto?.subtle) {
      globalThis.crypto = {
        getRandomValues: (arr) => {
          for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
          return arr;
        },
        subtle: {
          digest: vi.fn().mockResolvedValue(new ArrayBuffer(32)),
        },
      };
    }
  });

  describe('refreshAccessToken', () => {
    it('sends correct grant_type without refresh token (web mode)', async () => {
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'new-token' }),
      });

      const { refreshAccessToken } = await import('../../api/auth');
      const result = await refreshAccessToken();

      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, opts] = fetch.mock.calls[0];
      expect(url).toContain('/oauth2/token');
      expect(opts.method).toBe('POST');
      expect(opts.credentials).toBe('include');

      const body = new URLSearchParams(opts.body);
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('client_id')).toBe('tado-mobile-app');
      expect(body.get('refresh_token')).toBeNull();
      expect(result.access_token).toBe('new-token');
    });

    it('sends refresh_token in body when provided (native mode)', async () => {
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'new-token-native' }),
      });

      const { refreshAccessToken } = await import('../../api/auth');
      const result = await refreshAccessToken('my-refresh-token');

      const body = new URLSearchParams(fetch.mock.calls[0][1].body);
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('my-refresh-token');
      expect(result.access_token).toBe('new-token-native');
    });

    it('throws on non-OK response', async () => {
      fetch.mockResolvedValueOnce({ ok: false });
      const { refreshAccessToken } = await import('../../api/auth');
      await expect(refreshAccessToken()).rejects.toThrow('Failed to refresh access token');
    });
  });

  describe('exchangeCodeForTokens', () => {
    it('throws when no PKCE verifier stored', async () => {
      const { exchangeCodeForTokens } = await import('../../api/auth');
      await expect(exchangeCodeForTokens('code123')).rejects.toThrow('No PKCE code verifier found');
    });

    it('exchanges code with correct body and cleans PKCE state', async () => {
      sessionStorage.setItem('pkce_code_verifier', 'test-verifier');
      sessionStorage.setItem('pkce_redirect_uri', 'https://example.com/');

      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'at', refresh_token: 'rt' }),
      });

      const { exchangeCodeForTokens } = await import('../../api/auth');
      const result = await exchangeCodeForTokens('auth-code-123');

      const body = new URLSearchParams(fetch.mock.calls[0][1].body);
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('auth-code-123');
      expect(body.get('code_verifier')).toBe('test-verifier');
      expect(body.get('redirect_uri')).toBe('https://example.com/');
      expect(result.access_token).toBe('at');

      // PKCE state cleaned up
      expect(sessionStorage.getItem('pkce_code_verifier')).toBeNull();
      expect(sessionStorage.getItem('pkce_redirect_uri')).toBeNull();
      expect(sessionStorage.getItem('pkce_state')).toBeNull();
      expect(localStorage.getItem('pkce_code_verifier')).toBeNull();
    });

    it('throws descriptive error on failed exchange', async () => {
      sessionStorage.setItem('pkce_code_verifier', 'v');
      fetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error_description: 'Invalid code' }),
      });

      const { exchangeCodeForTokens } = await import('../../api/auth');
      await expect(exchangeCodeForTokens('bad-code')).rejects.toThrow('Invalid code');
    });
  });

  describe('initiateLoginFlow', () => {
    it('stores PKCE verifier and state in sessionStorage, redirects', async () => {
      globalThis.window.location = { href: 'http://localhost:5173/', origin: 'http://localhost:5173' };
      globalThis.location = globalThis.window.location;

      const { initiateLoginFlow } = await import('../../api/auth');
      await initiateLoginFlow();

      expect(sessionStorage.getItem('pkce_code_verifier')).toBeTruthy();
      expect(sessionStorage.getItem('pkce_code_verifier').length).toBe(64);
      expect(sessionStorage.getItem('pkce_state')).toBeTruthy();
      expect(sessionStorage.getItem('pkce_redirect_uri')).toBe('http://localhost:5173/');
      expect(window.location.href).toContain('/oauth2/authorize');
      expect(window.location.href).toContain('code_challenge_method=S256');
    });
  });
});
