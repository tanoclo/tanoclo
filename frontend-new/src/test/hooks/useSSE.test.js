// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { SWRConfig } from 'swr';

// Mock dependencies
vi.mock('../api/client', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('../utils/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('hooks/useSSE.js', () => {
  let useSSE;
  let mockEventSource;
  let eventListeners;

  beforeEach(async () => {
    vi.resetModules();
    eventListeners = {};
    
    // Mock EventSource
    mockEventSource = {
      close: vi.fn(),
      addEventListener: vi.fn((type, cb) => {
        eventListeners[type] = cb;
      }),
      onerror: null,
    };
    
    vi.stubGlobal('EventSource', vi.fn(() => mockEventSource));
    
    // Mock apiFetch to return a ticket
    const { apiFetch: af } = await import('../api/client');
    af.mockResolvedValue({ ticket: 'test-ticket' });
    
    // Set auth token
    window.localStorage.setItem('tanoclo_token', 'test-token');

    const mod = await import('../hooks/useSSE');
    useSSE = mod.useSSE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const wrapper = ({ children }) =>
    createElement(SWRConfig, { value: { provider: () => new Map() } }, children);

  it('does nothing when homeId is null', () => {
    renderHook(() => useSSE(null), { wrapper });
    expect(EventSource).not.toHaveBeenCalled();
  });

  it('requests event ticket and creates EventSource', async () => {
    const { apiFetch: af } = await import('../api/client');

    renderHook(() => useSSE('home-1'), { wrapper });

    await waitFor(() => {
      expect(af).toHaveBeenCalledWith('/api/homes/home-1/events/ticket', { method: 'POST' });
    });

    await waitFor(() => {
      expect(EventSource).toHaveBeenCalled();
    });

    const esUrl = EventSource.mock.calls[0][0];
    expect(esUrl).toContain('/api/homes/home-1/events?ticket=test-ticket');
  });

  it('registers correct SSE event listeners', async () => {
    renderHook(() => useSSE('home-1'), { wrapper });

    await waitFor(() => {
      expect(mockEventSource.addEventListener).toHaveBeenCalled();
    });

    const registeredEvents = mockEventSource.addEventListener.mock.calls.map(c => c[0]);
    expect(registeredEvents).toContain('connected');
    expect(registeredEvents).toContain('zone-state');
    expect(registeredEvents).toContain('zone-config');
    expect(registeredEvents).toContain('device-state');
    expect(registeredEvents).toContain('home-state');
  });

  it('closes EventSource on unmount', async () => {
    const { unmount } = renderHook(() => useSSE('home-1'), { wrapper });

    await waitFor(() => {
      expect(EventSource).toHaveBeenCalled();
    });

    unmount();
    // Cleanup runs asynchronously
    await new Promise(r => setTimeout(r, 50));
    expect(mockEventSource.close).toHaveBeenCalled();
  });
});
