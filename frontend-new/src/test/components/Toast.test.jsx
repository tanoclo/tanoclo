import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import Toast from '../../components/common/Toast';

describe('components/Toast', () => {
  it('renders message text', () => {
    const html = renderToString(<Toast message="Test notification" onClose={vi.fn()} />);
    expect(html).toContain('Test notification');
  });

  it('renders close button when onClose provided', () => {
    const html = renderToString(<Toast message="Msg" onClose={vi.fn()} />);
    expect(html).toContain('<button');
  });

  it('renders different types correctly', () => {
    const successHtml = renderToString(<Toast message="M" type="success" />);
    expect(successHtml).toContain('M');

    const errorHtml = renderToString(<Toast message="M" type="error" />);
    expect(errorHtml).toContain('M');
  });
});
