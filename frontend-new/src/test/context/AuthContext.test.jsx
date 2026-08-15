// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { createElement } from 'react';

vi.mock('../api/auth', () => ({
  initiateLoginFlow: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
}));

vi.mock('../api/client', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../i18n', () => ({
  default: { language: 'en', changeLanguage: vi.fn().mockResolvedValue(undefined) },
}));

import { initiateLoginFlow } from '../api/auth';
import { apiFetch } from '../api/client';
import { AuthProvider, AuthContext } from '../context/AuthContext';
import { useContext } from 'react';

describe('context/AuthContext', () => {
  const wrapper = ({ children }) => createElement(AuthProvider, null, children);

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    window.history.replaceState({}, '', '/');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  it('starts unauthenticated when no token', async () => {
    apiFetch.mockRejectedValue(new Error('no token'));
    const { result } = renderHook(() => useContext(AuthContext), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isAuthenticated).toBe(false);
  });

  it('initializes with token from localStorage', async () => {
    localStorage.setItem('tanoclo_token', 'stored-token');
    apiFetch.mockResolvedValue({ id: 1, name: 'Test', locale: 'en' });
    const { result } = renderHook(() => useContext(AuthContext), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    expect(result.current.user).toEqual({ id: 1, name: 'Test', locale: 'en' });
  });

  it('login() calls initiateLoginFlow', async () => {
    const { result } = renderHook(() => useContext(AuthContext), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.login());
    expect(initiateLoginFlow).toHaveBeenCalled();
  });

  it('loginWithCredentials stores token and fetches user', async () => {
    fetch.mockResolvedValueOnce({
      ok: true, json: async () => ({ access_token: 'new-token', refresh_token: 'new-rt' }),
    });
    apiFetch.mockResolvedValue({ id: 2, name: 'User2', locale: 'en' });
    const { result } = renderHook(() => useContext(AuthContext), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => { await result.current.loginWithCredentials('user', 'pass'); });
    expect(result.current.isAuthenticated).toBe(true);
    expect(localStorage.getItem('tanoclo_token')).toBe('new-token');
  });

  it('logout clears tokens and state', async () => {
    localStorage.setItem('tanoclo_token', 'tok');
    apiFetch.mockResolvedValue({ id: 1, name: 'Test', locale: 'en' });
    const { result } = renderHook(() => useContext(AuthContext), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    await act(async () => { await result.current.logout(); });
    expect(result.current.isAuthenticated).toBe(false);
    expect(localStorage.getItem('tanoclo_token')).toBeNull();
  });

  it('listens for auth_logout events', async () => {
    localStorage.setItem('tanoclo_token', 'tok');
    apiFetch.mockResolvedValue({ id: 1, name: 'Test', locale: 'en' });
    const { result } = renderHook(() => useContext(AuthContext), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    act(() => { window.dispatchEvent(new Event('auth_logout')); });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(false));
  });
});
