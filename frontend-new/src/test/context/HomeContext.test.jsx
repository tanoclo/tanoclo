import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 1, homes: [{ id: 123456, name: 'Main Home' }] },
    isAuthenticated: true,
  }),
}));

vi.mock('../../api/homes', () => ({
  getHomeInfo: vi.fn().mockResolvedValue({ id: 123456, name: 'Main Home' }),
  getHomeState: vi.fn().mockResolvedValue({ presence: 'HOME' }),
}));

vi.mock('../../api/zones', () => ({
  getZones: vi.fn().mockResolvedValue([{ id: 1, name: 'Living Room' }]),
  getZoneStates: vi.fn().mockResolvedValue({ '1': { setting: { power: 'ON' } } }),
}));

vi.mock('../../api/weather', () => ({
  getWeather: vi.fn().mockResolvedValue({ weatherState: { value: 'SUNNY' } }),
}));

vi.mock('../../hooks/useSSE', () => ({
  useSSE: () => ({ isConnected: true, lastEventAt: 123456789 }),
}));

import { HomeProvider, useHome, HomeContext } from '../../context/HomeContext';

describe('context/HomeContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('useHome throws outside HomeProvider', () => {
    expect(() => {
      useHome();
    }).toThrow();
  });

  it('renders HomeProvider with children', () => {
    const html = renderToString(
      createElement(HomeProvider, null, createElement('div', null, 'Home Child Content'))
    );
    expect(html).toContain('Home Child Content');
  });

  it('exports HomeProvider, useHome, and HomeContext', () => {
    expect(typeof HomeProvider).toBe('function');
    expect(typeof useHome).toBe('function');
    expect(HomeContext).toBeDefined();
  });
});
