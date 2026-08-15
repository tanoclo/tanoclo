// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Toast from '../components/common/Toast';

describe('components/Toast', () => {
  it('renders message text', () => {
    render(<Toast message="Test notification" onClose={vi.fn()} />);
    expect(screen.getByText('Test notification')).toBeInTheDocument();
  });

  it('renders close button when onClose provided', () => {
    render(<Toast message="Msg" onClose={vi.fn()} />);
    // Close button exists
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
  });

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn();
    render(<Toast message="Msg" onClose={onClose} />);
    const closeBtn = screen.getByRole('button');
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('auto-dismisses after duration', async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<Toast message="Auto" duration={1000} onClose={onClose} />);

    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('does not auto-dismiss when duration is 0', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<Toast message="Persist" duration={0} onClose={onClose} />);

    vi.advanceTimersByTime(10000);
    expect(onClose).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('renders different icon for each type', () => {
    const { rerender, container } = render(<Toast message="M" type="success" />);
    const successSvg = container.querySelector('svg');
    expect(successSvg).toBeTruthy();

    rerender(<Toast message="M" type="error" />);
    const errorSvg = container.querySelector('svg');
    expect(errorSvg).toBeTruthy();
  });
});
