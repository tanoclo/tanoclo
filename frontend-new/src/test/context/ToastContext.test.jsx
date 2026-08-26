import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { ToastProvider, useToast } from '../../context/ToastContext';

describe('context/ToastContext', () => {
  it('useToast throws outside provider', () => {
    expect(() => {
      useToast();
    }).toThrow();
  });

  it('renders ToastProvider with children', () => {
    const html = renderToString(
      createElement(ToastProvider, null, createElement('div', null, 'Toast Test Child'))
    );
    expect(html).toContain('Toast Test Child');
  });

  it('provides ToastProvider and useToast functions', () => {
    expect(typeof ToastProvider).toBe('function');
    expect(typeof useToast).toBe('function');
  });
});
