import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';

vi.mock('../../api/auth', () => ({
  initiateLoginFlow: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../i18n', () => ({
  default: { language: 'en', changeLanguage: vi.fn().mockResolvedValue(undefined) },
}));

import { AuthProvider, AuthContext } from '../../context/AuthContext';

describe('context/AuthContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (typeof localStorage !== 'undefined') localStorage.clear();
  });

  it('renders AuthProvider with children', () => {
    const html = renderToString(
      createElement(AuthProvider, null, createElement('div', null, 'Auth Child'))
    );
    expect(html).toContain('Auth Child');
  });

  it('exports AuthProvider and AuthContext', () => {
    expect(AuthProvider).toBeDefined();
    expect(AuthContext).toBeDefined();
  });
});
