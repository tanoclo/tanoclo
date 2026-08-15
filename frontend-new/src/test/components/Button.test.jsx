// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Button from '../components/common/Button';

describe('components/Button', () => {
  it('renders with children text', () => {
    render(<Button>Click Me</Button>);
    expect(screen.getByText('Click Me')).toBeInTheDocument();
  });

  it('fires onClick handler', () => {
    const handler = vi.fn();
    render(<Button onClick={handler}>Go</Button>);
    fireEvent.click(screen.getByText('Go'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('disabled prop prevents click', () => {
    const handler = vi.fn();
    render(<Button onClick={handler} disabled>Go</Button>);
    const btn = screen.getByText('Go');
    fireEvent.click(btn);
    expect(handler).not.toHaveBeenCalled();
    expect(btn).toBeDisabled();
  });

  it('applies opacity for disabled state', () => {
    render(<Button disabled>Off</Button>);
    const btn = screen.getByText('Off');
    expect(btn.style.opacity).toBe('0.6');
  });

  it('defaults to primary variant styles', () => {
    render(<Button>Primary</Button>);
    const btn = screen.getByText('Primary');
    expect(btn.style.color).toBe('#ffffff');
    expect(btn.style.background).toContain('gradient');
  });

  it('applies destructive variant styles', () => {
    render(<Button variant="destructive">Delete</Button>);
    const btn = screen.getByText('Delete');
    expect(btn.style.color).toBe('#ffffff');
    expect(btn.style.background).toContain('gradient');
  });

  it('applies secondary variant styles', () => {
    render(<Button variant="secondary">Cancel</Button>);
    const btn = screen.getByText('Cancel');
    expect(btn.style.border).toContain('1px solid');
  });

  it('passes extra props through', () => {
    render(<Button data-testid="custom-btn">Test</Button>);
    expect(screen.getByTestId('custom-btn')).toBeInTheDocument();
  });
});
