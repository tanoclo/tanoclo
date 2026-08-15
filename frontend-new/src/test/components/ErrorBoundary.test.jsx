// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createElement } from 'react';
import ErrorBoundary from '../components/common/ErrorBoundary';

// Mock logger
vi.mock('../utils/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Component that throws on render
function ThrowingComponent({ shouldThrow }) {
  if (shouldThrow) {
    throw new Error('Test render error');
  }
  return createElement('div', null, 'Working fine');
}

describe('components/ErrorBoundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders children when no error', () => {
    render(
      <ErrorBoundary>
        <div>Child content</div>
      </ErrorBoundary>
    );
    expect(screen.getByText('Child content')).toBeInTheDocument();
  });

  it('catches render errors and shows fallback UI', () => {
    // Suppress React error boundary console output
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText('Application Error')).toBeInTheDocument();
    expect(screen.getByText(/Test render error/)).toBeInTheDocument();
    expect(screen.getByText('Reload Application')).toBeInTheDocument();

    consoleSpy.mockRestore();
  });

  it('displays error message in pre block', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );

    const pre = screen.getByText(/Test render error/);
    expect(pre.tagName).toBe('PRE');

    consoleSpy.mockRestore();
  });

  it('provides reload button', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Mock window.location.reload
    const reloadMock = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadMock },
      writable: true,
    });

    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );

    fireEvent.click(screen.getByText('Reload Application'));
    expect(reloadMock).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});
