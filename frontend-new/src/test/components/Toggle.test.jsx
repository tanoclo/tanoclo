import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import Toggle from '../../components/common/Toggle';

describe('components/Toggle', () => {
  it('renders unchecked state', () => {
    const html = renderToString(<Toggle checked={false} onChange={vi.fn()} />);
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
  });

  it('renders checked state', () => {
    const html = renderToString(<Toggle checked={true} onChange={vi.fn()} />);
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
  });

  it('fires onChange on input change', () => {
    const onChange = vi.fn();
    const elem = Toggle({ checked: false, onChange });
    const input = elem.props.children[0].props.children[0];
    input.props.onChange({ target: { checked: true } });
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('respects disabled prop — does not call onChange', () => {
    const onChange = vi.fn();
    const elem = Toggle({ checked: false, onChange, disabled: true });
    const input = elem.props.children[0].props.children[0];
    input.props.onChange({ target: { checked: true } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders label text when provided', () => {
    const html = renderToString(<Toggle checked={false} onChange={vi.fn()} label="Enable" />);
    expect(html).toContain('Enable');
  });

  it('has aria-checked attribute', () => {
    const html = renderToString(<Toggle checked={true} onChange={vi.fn()} />);
    expect(html).toContain('aria-checked="true"');
  });
});
