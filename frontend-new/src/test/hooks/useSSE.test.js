import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { STORAGE_KEYS } from '../../utils/constants';
import { useSSE } from '../../hooks/useSSE';

// Polyfill document for node test environment if needed
if (typeof globalThis.document === 'undefined') {
  const docListeners = {};
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener: (type, fn) => {
      (docListeners[type] = docListeners[type] || []).push(fn);
    },
    removeEventListener: (type, fn) => {
      if (docListeners[type]) docListeners[type] = docListeners[type].filter(f => f !== fn);
    },
    dispatchEvent: (event) => {
      const type = event.type || event;
      (docListeners[type] || []).forEach(fn => fn(event));
    }
  };
}

vi.mock('../../api/client', () => ({
  apiFetch: vi.fn().mockResolvedValue({ ticket: 'test-ticket-123' }),
}));

vi.mock('../../utils/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('hooks/useSSE.js', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    localStorage.setItem(STORAGE_KEYS.AUTH_TOKEN, 'test-token');
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('exports useSSE hook function', () => {
    expect(typeof useSSE).toBe('function');
  });
});
