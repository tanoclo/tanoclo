import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/client', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { useSSE } from '../../hooks/useSSE';

describe('hooks/useSSE.js', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('exports useSSE hook function', () => {
    expect(typeof useSSE).toBe('function');
  });
});
