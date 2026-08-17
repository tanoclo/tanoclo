import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/client', () => ({
  apiFetch: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../api/tanoclo', () => ({
  getDeviceBatteryData: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../utils/logger', () => ({
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

import { useBatteryNotifier } from '../../hooks/useBatteryNotifier';

describe('hooks/useBatteryNotifier.js', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (typeof localStorage !== 'undefined') localStorage.clear();
  });

  it('exports useBatteryNotifier function', () => {
    expect(typeof useBatteryNotifier).toBe('function');
  });
});
