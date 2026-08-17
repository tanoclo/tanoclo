import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import ErrorBoundary from '../../components/common/ErrorBoundary';

vi.mock('i18next', () => ({
  default: {
    t: (key, fallback) => fallback || key,
  },
}));

// Mock logger
vi.mock('../../utils/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('components/ErrorBoundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders children when no error', () => {
    const html = renderToString(
      <ErrorBoundary>
        <div>Child content</div>
      </ErrorBoundary>
    );
    expect(html).toContain('Child content');
  });

  it('initializes with hasError: false', () => {
    const boundary = new ErrorBoundary({});
    expect(boundary.state.hasError).toBe(false);
    expect(boundary.state.error).toBeNull();
  });

  it('getDerivedStateFromError updates state to hasError: true', () => {
    const err = new Error('Test render error');
    const newState = ErrorBoundary.getDerivedStateFromError(err);
    expect(newState.hasError).toBe(true);
    expect(newState.error).toBe(err);
  });

  it('renders fallback UI when state has error', () => {
    const boundary = new ErrorBoundary({ children: <div>Child</div> });
    boundary.state = { hasError: true, error: new Error('Simulated failure') };
    const rendered = boundary.render();
    const html = renderToString(rendered);
    expect(html).toContain('Something went wrong.');
    expect(html).toContain('Simulated failure');
  });
});
