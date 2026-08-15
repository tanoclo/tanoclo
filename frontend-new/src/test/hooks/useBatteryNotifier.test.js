// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { SWRConfig } from 'swr';

// Mock all dependencies
vi.mock('../api/client', () => ({
  apiFetch: vi.fn().mockResolvedValue({}),
}));

vi.mock('../api/tanoclo', () => ({
  getDeviceBatteryData: vi.fn().mockResolvedValue([]),
}));

vi.mock('../utils/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue) => (typeof defaultValue === 'string' ? defaultValue : key),
  }),
}));

import { apiFetch } from '../api/client';
import { getDeviceBatteryData } from '../api/tanoclo';

describe('hooks/useBatteryNotifier.js', () => {
  let useBatteryNotifier;

  beforeEach(async () => {
    vi.resetModules();
    window.localStorage.clear();

    // Mock Notification API
    window.Notification = vi.fn();
    window.Notification.permission = 'granted';

    const mod = await import('../hooks/useBatteryNotifier');
    useBatteryNotifier = mod.useBatteryNotifier;
  });

  const wrapper = ({ children }) =>
    createElement(SWRConfig, {
      value: {
        provider: () => new Map(),
        dedupingInterval: 0,
      }
    }, children);

  it('does nothing when not authenticated', () => {
    renderHook(() => useBatteryNotifier('dev1', 'home1', false), { wrapper });
    expect(getDeviceBatteryData).not.toHaveBeenCalled();
  });

  it('does nothing when homeId is missing', () => {
    renderHook(() => useBatteryNotifier('dev1', null, true), { wrapper });
    expect(getDeviceBatteryData).not.toHaveBeenCalled();
  });

  it('tracks battery state transitions in localStorage', async () => {
    // Mock mobile device settings (lowBatteryReminder enabled)
    apiFetch.mockResolvedValue({
      settings: { pushNotifications: { lowBatteryReminder: true } }
    });

    getDeviceBatteryData.mockResolvedValue([
      { serial_no: 'SN001', battery_state: 'LOW', friendly_name: 'Living Room' }
    ]);

    renderHook(() => useBatteryNotifier('dev1', 'home1', true), { wrapper });

    await waitFor(() => {
      const stored = window.localStorage.getItem('tanoclo_notified_battery_states');
      if (stored) {
        const states = JSON.parse(stored);
        expect(states.SN001).toBe('LOW');
      }
    }, { timeout: 3000 });
  });

  it('resets tracked state when battery returns to NORMAL', async () => {
    // Pre-set notified state
    window.localStorage.setItem('tanoclo_notified_battery_states', JSON.stringify({ SN001: 'LOW' }));

    apiFetch.mockResolvedValue({
      settings: { pushNotifications: { lowBatteryReminder: true } }
    });

    getDeviceBatteryData.mockResolvedValue([
      { serial_no: 'SN001', battery_state: 'NORMAL', friendly_name: 'Living Room' }
    ]);

    renderHook(() => useBatteryNotifier('dev1', 'home1', true), { wrapper });

    await waitFor(() => {
      const stored = window.localStorage.getItem('tanoclo_notified_battery_states');
      if (stored) {
        const states = JSON.parse(stored);
        expect(states.SN001).toBe('NORMAL');
      }
    }, { timeout: 3000 });
  });
});
