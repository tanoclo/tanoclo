import { describe, it, expect, vi } from 'vitest';

vi.mock('../../i18n', () => ({
  default: { language: 'en', changeLanguage: vi.fn() },
}));

import { AuthContext } from '../../context/AuthContext';
import { useAuth } from '../../hooks/useAuth';

describe('hooks/useAuth.js', () => {
  it('throws when used outside AuthProvider', () => {
    expect(() => {
      useAuth();
    }).toThrow();
  });

  it('exports AuthContext and useAuth', () => {
    expect(AuthContext).toBeDefined();
    expect(typeof useAuth).toBe('function');
  });
});
