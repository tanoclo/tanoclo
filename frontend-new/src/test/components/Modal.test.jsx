// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Modal from '../components/common/Modal';

describe('components/Modal', () => {
  it('renders nothing when isOpen is false', () => {
    render(<Modal isOpen={false} onClose={vi.fn()} title="Test">Content</Modal>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders children when isOpen is true', () => {
    render(<Modal isOpen={true} onClose={vi.fn()} title="My Modal">Modal Content</Modal>);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Modal Content')).toBeInTheDocument();
  });

  it('renders title in header', () => {
    render(<Modal isOpen={true} onClose={vi.fn()} title="Test Title">Content</Modal>);
    expect(screen.getByText('Test Title')).toBeInTheDocument();
  });

  it('calls onClose when backdrop clicked', () => {
    const onClose = vi.fn();
    render(<Modal isOpen={true} onClose={onClose} title="T">Content</Modal>);

    // Click on the outer overlay (backdrop)
    const backdrop = screen.getByRole('dialog').parentElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose when dialog body clicked', () => {
    const onClose = vi.fn();
    render(<Modal isOpen={true} onClose={onClose} title="T">Content</Modal>);

    // Click on the dialog itself (should stopPropagation)
    const dialog = screen.getByRole('dialog');
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose when X button clicked', () => {
    const onClose = vi.fn();
    render(<Modal isOpen={true} onClose={onClose} title="T">Content</Modal>);

    // X button is inside the header
    const buttons = screen.getByRole('dialog').querySelectorAll('button');
    // Last button in header is the close button
    fireEvent.click(buttons[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('sets body overflow hidden when open', () => {
    render(<Modal isOpen={true} onClose={vi.fn()} title="T">X</Modal>);
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('has aria-modal attribute', () => {
    render(<Modal isOpen={true} onClose={vi.fn()} title="T">X</Modal>);
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  });
});
