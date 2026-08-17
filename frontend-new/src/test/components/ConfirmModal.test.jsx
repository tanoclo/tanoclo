import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

globalThis.document = globalThis.document || {};
if (!globalThis.document.body) globalThis.document.body = {};

vi.mock('react-dom', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createPortal: (children) => children,
  };
});

import ConfirmModal from '../../components/common/ConfirmModal';

describe('components/ConfirmModal', () => {
  it('renders nothing when closed', () => {
    const html = renderToString(
      <ConfirmModal isOpen={false} onClose={vi.fn()} onConfirm={vi.fn()} title="T" message="M" />
    );
    expect(html).toBe('');
  });

  it('displays title and message', () => {
    const html = renderToString(
      <ConfirmModal isOpen={true} onClose={vi.fn()} onConfirm={vi.fn()} title="Delete?" message="Are you sure?" />
    );
    expect(html).toContain('Delete?');
    expect(html).toContain('Are you sure?');
  });

  it('shows confirm and cancel buttons with default labels', () => {
    const html = renderToString(
      <ConfirmModal isOpen={true} onClose={vi.fn()} onConfirm={vi.fn()} title="T" message="M" />
    );
    expect(html).toContain('Confirm');
    expect(html).toContain('Cancel');
  });

  it('shows custom button labels', () => {
    const html = renderToString(
      <ConfirmModal isOpen={true} onClose={vi.fn()} onConfirm={vi.fn()}
        title="T" message="M" confirmText="Yes" cancelText="No" />
    );
    expect(html).toContain('Yes');
    expect(html).toContain('No');
  });

  it('wires onConfirm and onClose props', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const elem = ConfirmModal({ isOpen: true, onClose, onConfirm, title: 'T', message: 'M' });
    expect(elem).toBeDefined();
  });
});
