// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createElement, useContext } from 'react';
import { ThemeProvider, ThemeContext } from '../context/ThemeContext';

describe('context/ThemeContext', () => {
  const wrapper = ({ children }) => createElement(ThemeProvider, null, children);

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('defaults to system theme', () => {
    const { result } = renderHook(() => useContext(ThemeContext), { wrapper });
    expect(result.current.theme).toBe('system');
  });

  it('reads saved theme from localStorage', () => {
    localStorage.setItem('tanoclo_theme', 'light');
    const { result } = renderHook(() => useContext(ThemeContext), { wrapper });
    expect(result.current.theme).toBe('light');
  });

  it('toggleTheme cycles: system → light → dark → system', () => {
    const { result } = renderHook(() => useContext(ThemeContext), { wrapper });
    expect(result.current.theme).toBe('system');

    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe('light');

    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe('dark');

    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe('system');
  });

  it('setTheme(light) sets data-theme attribute', () => {
    const { result } = renderHook(() => useContext(ThemeContext), { wrapper });
    act(() => result.current.setTheme('light'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(result.current.resolvedTheme).toBe('light');
  });

  it('setTheme(dark) removes data-theme attribute', () => {
    const { result } = renderHook(() => useContext(ThemeContext), { wrapper });
    act(() => result.current.setTheme('dark'));
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
    expect(result.current.resolvedTheme).toBe('dark');
  });

  it('persists theme to localStorage on change', () => {
    const { result } = renderHook(() => useContext(ThemeContext), { wrapper });
    act(() => result.current.setTheme('dark'));
    expect(localStorage.getItem('tanoclo_theme')).toBe('dark');
  });
});
