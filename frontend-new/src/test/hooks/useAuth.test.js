// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createElement } from 'react';
import { AuthContext } from '../context/AuthContext';
import { useAuth } from '../hooks/useAuth';

describe('hooks/useAuth.js', () => {
  it('throws when used outside AuthProvider', () => {
    // Suppress React error boundary console output
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => {
      renderHook(() => useAuth());
    }).toThrow('useAuth must be used within an AuthProvider');
    spy.mockRestore();
  });

  it('returns context value when wrapped in AuthProvider', () => {
    const mockValue = {
      token: 'test-token',
      user: { id: 1 },
      isAuthenticated: true,
      isLoading: false,
      login: vi.fn(),
      loginWithCredentials: vi.fn(),
      logout: vi.fn(),
      mutateUser: vi.fn(),
    };

    const wrapper = ({ children }) =>
      createElement(AuthContext.Provider, { value: mockValue }, children);

    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.token).toBe('test-token');
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user).toEqual({ id: 1 });
  });
});
