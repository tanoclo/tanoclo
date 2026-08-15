// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Toggle from '../components/common/Toggle';

describe('components/Toggle', () => {
  it('renders unchecked state', () => {
    render(<Toggle checked={false} onChange={vi.fn()} />);
    const input = screen.getByRole('switch');
    expect(input).not.toBeChecked();
  });

  it('renders checked state', () => {
    render(<Toggle checked={true} onChange={vi.fn()} />);
    const input = screen.getByRole('switch');
    expect(input).toBeChecked();
  });

  it('fires onChange on click', () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('respects disabled prop — does not call onChange', () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} disabled />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders label text when provided', () => {
    render(<Toggle checked={false} onChange={vi.fn()} label="Enable" />);
    expect(screen.getByText('Enable')).toBeInTheDocument();
  });

  it('does not render label when empty', () => {
    const { container } = render(<Toggle checked={false} onChange={vi.fn()} />);
    expect(container.querySelector('span')).toBeNull();
  });

  it('has aria-checked attribute', () => {
    render(<Toggle checked={true} onChange={vi.fn()} />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });
});
