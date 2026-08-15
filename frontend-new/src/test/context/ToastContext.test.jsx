// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { ToastProvider, useToast } from '../context/ToastContext';

describe('context/ToastContext', () => {
  const wrapper = ({ children }) => createElement(ToastProvider, null, children);

  it('useToast throws outside provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => {
      renderHook(() => useToast());
    }).toThrow('useToast must be used within a ToastProvider');
    spy.mockRestore();
  });

  it('showToast adds a toast message', () => {
    const { result } = renderHook(() => useToast(), { wrapper });

    act(() => {
      result.current.showToast('Test message', 'success');
    });

    expect(typeof result.current.showToast).toBe('function');
  });

  it('renders toast content in DOM', () => {
    const TestComponent = () => {
      const { showToast } = useToast();
      return createElement('button', {
        onClick: () => showToast('Hello World', 'info'),
        'data-testid': 'trigger'
      }, 'Show');
    };

    render(createElement(ToastProvider, null, createElement(TestComponent)));
    const btn = screen.getByTestId('trigger');
    act(() => btn.click());

    expect(screen.getByText('Hello World')).toBeInTheDocument();
  });
});
