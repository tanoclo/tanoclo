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

import Modal from '../../components/common/Modal';

describe('components/Modal', () => {
  it('renders nothing when isOpen is false', () => {
    const html = renderToString(<Modal isOpen={false} onClose={vi.fn()} title="Test">Content</Modal>);
    expect(html).toBe('');
  });

  it('renders children when isOpen is true', () => {
    const html = renderToString(<Modal isOpen={true} onClose={vi.fn()} title="My Modal">Modal Content</Modal>);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Modal Content');
  });

  it('renders title in header', () => {
    const html = renderToString(<Modal isOpen={true} onClose={vi.fn()} title="Test Title">Content</Modal>);
    expect(html).toContain('Test Title');
  });

  it('has aria-modal attribute', () => {
    const html = renderToString(<Modal isOpen={true} onClose={vi.fn()} title="T">X</Modal>);
    expect(html).toContain('aria-modal="true"');
  });
});
