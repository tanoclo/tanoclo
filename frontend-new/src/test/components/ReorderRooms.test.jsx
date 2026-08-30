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

import ReorderRooms from '../../components/zone/ReorderRooms';

const mockZones = [
  { id: 1, name: 'Living Room' },
  { id: 2, name: 'Bedroom' },
  { id: 3, name: 'Kitchen' }
];

vi.mock('../../context/HomeContext', () => ({
  useHome: () => ({
    zones: mockZones,
    saveUserZoneOrder: vi.fn()
  })
}));

vi.mock('../../context/ToastContext', () => ({
  useToast: () => ({
    showToast: vi.fn()
  })
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => typeof fallback === 'string' ? fallback : key
  })
}));

describe('components/zone/ReorderRooms', () => {
  it('renders rooms list when open', () => {
    const html = renderToString(<ReorderRooms isOpen={true} onClose={vi.fn()} />);
    expect(html).toContain('Living Room');
    expect(html).toContain('Bedroom');
    expect(html).toContain('Kitchen');
  });

  it('renders null when not open or no zones', () => {
    const html = renderToString(<ReorderRooms isOpen={false} onClose={vi.fn()} />);
    expect(html).toBe('');
  });
});
