import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { ThemeProvider, ThemeContext } from '../../context/ThemeContext';
import { STORAGE_KEYS } from '../../utils/constants';

describe('context/ThemeContext', () => {
  beforeEach(() => {
    if (typeof localStorage !== 'undefined') localStorage.clear();
  });

  it('renders ThemeProvider with children', () => {
    const html = renderToString(
      createElement(ThemeProvider, null, createElement('div', null, 'Themed Content'))
    );
    expect(html).toContain('Themed Content');
  });

  it('provides ThemeContext export', () => {
    expect(ThemeContext).toBeDefined();
    expect(ThemeProvider).toBeDefined();
  });

  it('verifies STORAGE_KEYS.THEME constant', () => {
    expect(STORAGE_KEYS.THEME).toBe('tanoclo_theme');
  });
});
