import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import TemperatureDial from '../../components/zone/TemperatureDial';

describe('components/zone/TemperatureDial', () => {
  it('renders temperature value and stepper buttons', () => {
    const html = renderToString(
      <TemperatureDial 
        value={21.5} 
        onChange={() => {}} 
        min={5.0} 
        max={25.0} 
      />
    );
    expect(html).toContain('21');
    expect(html).toContain('.5');
  });

  it('renders disabled state styling', () => {
    const html = renderToString(
      <TemperatureDial 
        value={20.0} 
        disabled={true} 
      />
    );
    expect(html).toContain('cursor:not-allowed');
  });

  it('renders current temperature indicator if provided', () => {
    const html = renderToString(
      <TemperatureDial 
        value={21.0} 
        currentTemp={19.8} 
      />
    );
    expect(html).toContain('Inside');
  });
});
