import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import ZoneCard from '../../components/zone/ZoneCard';

describe('components/zone/ZoneCard', () => {
  it('renders null if zone is missing', () => {
    const html = renderToString(<ZoneCard zone={null} />);
    expect(html).toBe('');
  });

  it('renders zone name and temperature reading', () => {
    const zone = { id: 1, name: 'Living Room', type: 'HEATING' };
    const state = {
      sensorDataPoints: {
        insideTemperature: { celsius: 21.5 },
        humidity: { percentage: 48 }
      },
      setting: {
        power: 'ON',
        temperature: { celsius: 22.0 }
      },
      activityDataPoints: {
        heatingPower: { percentage: 50 }
      }
    };

    const html = renderToString(<ZoneCard zone={zone} state={state} />);
    expect(html).toContain('Living Room');
    expect(html).toContain('21');
    expect(html).toContain('.5°');
    expect(html).toContain('48');
    expect(html).toContain('22.0°');
  });

  it('renders offline state when link is offline', () => {
    const zone = { id: 2, name: 'Bedroom', type: 'HEATING' };
    const state = {
      link: { state: 'OFFLINE' },
      setting: { power: 'ON', temperature: { celsius: 20.0 } }
    };

    const html = renderToString(<ZoneCard zone={zone} state={state} />);
    expect(html).toContain('Bedroom');
  });

  it('delegates to DHWCard when zone type is HOT_WATER', () => {
    const zone = { id: 3, name: 'Hot Water', type: 'HOT_WATER' };
    const state = { setting: { power: 'ON' } };
    const html = renderToString(<ZoneCard zone={zone} state={state} />);
    expect(html).toContain('Hot Water');
  });
});
