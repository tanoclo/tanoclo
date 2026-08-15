// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ConfirmModal from '../components/common/ConfirmModal';

describe('components/ConfirmModal', () => {
  it('renders nothing when closed', () => {
    render(
      <ConfirmModal isOpen={false} onClose={vi.fn()} onConfirm={vi.fn()} title="T" message="M" />
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('displays title and message', () => {
    render(
      <ConfirmModal isOpen={true} onClose={vi.fn()} onConfirm={vi.fn()} title="Delete?" message="Are you sure?" />
    );
    expect(screen.getByText('Delete?')).toBeInTheDocument();
    expect(screen.getByText('Are you sure?')).toBeInTheDocument();
  });

  it('shows confirm and cancel buttons with default labels', () => {
    render(
      <ConfirmModal isOpen={true} onClose={vi.fn()} onConfirm={vi.fn()} title="T" message="M" />
    );
    expect(screen.getByText('Confirm')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('shows custom button labels', () => {
    render(
      <ConfirmModal isOpen={true} onClose={vi.fn()} onConfirm={vi.fn()}
        title="T" message="M" confirmText="Yes" cancelText="No" />
    );
    expect(screen.getByText('Yes')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();
  });

  it('calls onConfirm on confirm click', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmModal isOpen={true} onClose={vi.fn()} onConfirm={onConfirm} title="T" message="M" />
    );
    fireEvent.click(screen.getByText('Confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onClose on cancel click', () => {
    const onClose = vi.fn();
    render(
      <ConfirmModal isOpen={true} onClose={onClose} onConfirm={vi.fn()} title="T" message="M" />
    );
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
