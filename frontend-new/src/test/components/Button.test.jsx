import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import Button from '../../components/common/Button';

describe('components/Button', () => {
  it('renders with children text', () => {
    const html = renderToString(<Button>Click Me</Button>);
    expect(html).toContain('Click Me');
  });

  it('wires onClick handler on rendered element', () => {
    const handler = vi.fn();
    const elem = Button({ onClick: handler, children: 'Go' });
    elem.props.onClick();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('disabled prop renders disabled attribute', () => {
    const html = renderToString(<Button disabled>Go</Button>);
    expect(html).toContain('disabled');
    expect(html).toContain('opacity:0.6');
  });

  it('defaults to primary variant styles', () => {
    const html = renderToString(<Button>Primary</Button>);
    expect(html).toContain('Primary');
    expect(html).toContain('linear-gradient');
  });

  it('applies destructive variant styles', () => {
    const html = renderToString(<Button variant="destructive">Delete</Button>);
    expect(html).toContain('Delete');
    expect(html).toContain('linear-gradient');
  });

  it('applies secondary variant styles', () => {
    const html = renderToString(<Button variant="secondary">Cancel</Button>);
    expect(html).toContain('Cancel');
    expect(html).toContain('1px solid');
  });

  it('passes extra props through', () => {
    const html = renderToString(<Button data-testid="custom-btn">Test</Button>);
    expect(html).toContain('data-testid="custom-btn"');
  });
});
