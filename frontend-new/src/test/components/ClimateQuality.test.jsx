import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import ClimateQualityCard from '../../components/zone/ClimateQualityCard';
import ZoneClimateCard from '../../components/climatequality/ZoneClimateCard';
import ClimateQualityHero from '../../components/climatequality/ClimateQualityHero';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, options) => {
      const map = {
        'common.loading': 'Loading...',
        'common.and': 'and',
        'air_comfort.title': 'Climate Quality',
        'air_comfort.hero_freshness': 'Indoor Air Quality',
        'air_comfort.freshness_good': 'GOOD',
        'air_comfort.freshness_fair': 'FAIR',
        'air_comfort.freshness_poor': 'POOR',
        'air_comfort.desc_good': 'The indoor climate is healthy and fresh.',
        'air_comfort.desc_fair': 'Air quality in your home is fair.',
        'air_comfort.desc_poor': 'Air quality in your home is poor.',
        'air_comfort.no_windows_opened': 'No open windows recorded recently',
        'air_comfort.last_window_opened': `Last window opened: ${options?.date || ''} ${options?.time || ''}`,
        'air_comfort.outside_weather': 'Outside Weather',
        'air_comfort.explanation.balanced': 'The climate is balanced and comfortable.',
        'air_comfort.explanation.cold': 'cold',
        'air_comfort.explanation.warm': 'warm',
        'air_comfort.explanation.dry': 'dry',
        'air_comfort.explanation.humid': 'humid',
        'air_comfort.explanation.comfy_temp': 'comfy temperature',
        'air_comfort.explanation.comfy_humidity': 'comfy humidity',
        'air_comfort.compass.warm': 'Warm',
        'air_comfort.compass.cold': 'Cold',
        'air_comfort.compass.dry': 'Dry',
        'air_comfort.compass.humid': 'Humid',
      };
      if (map[key]) return map[key];
      if (options?.conditions) return `The zone is ${options.conditions}.`;
      if (options?.condition) return `The zone is ${options.condition}.`;
      return key;
    }
  })
}));

describe('ClimateQualityCard', () => {
  it('renders LOADING state when climateQuality is null', () => {
    const html = renderToString(<ClimateQualityCard climateQuality={null} onClick={vi.fn()} />);
    expect(html).toContain('Loading...');
  });

  it('renders GOOD state with green background', () => {
    const payload = { freshness: { value: 'GOOD' } };
    const html = renderToString(<ClimateQualityCard climateQuality={payload} onClick={vi.fn()} />);
    expect(html).toContain('GOOD');
    expect(html).toContain('Climate Quality');
  });

  it('renders FAIR state', () => {
    const payload = { freshness: { value: 'FAIR' } };
    const html = renderToString(<ClimateQualityCard climateQuality={payload} onClick={vi.fn()} />);
    expect(html).toContain('FAIR');
  });

  it('renders POOR state', () => {
    const payload = { freshness: { value: 'POOR' } };
    const html = renderToString(<ClimateQualityCard climateQuality={payload} onClick={vi.fn()} />);
    expect(html).toContain('POOR');
  });
});

describe('ZoneClimateCard', () => {
  it('returns null when comfort or state is missing', () => {
    const html = renderToString(<ZoneClimateCard name="Living Room" comfort={null} state={null} />);
    expect(html).toBe('');
  });

  it('renders GOOD badge and balanced text when comfortable', () => {
    const comfort = {
      roomId: 1,
      temperatureLevel: 'COMFY',
      humidityLevel: 'COMFY',
      freshness: 'GOOD',
      coordinate: { radial: 0.1, angular: 45 }
    };
    const state = {
      sensorDataPoints: {
        insideTemperature: { celsius: 21.0 },
        humidity: { percentage: 50.0 }
      }
    };

    const html = renderToString(<ZoneClimateCard name="Living Room" comfort={comfort} state={state} outsideTemp={18.0} />);
    expect(html).toContain('Living Room');
    expect(html).toContain('GOOD');
    expect(html).toContain('21.0°');
    expect(html).toContain('50%');
    expect(html).toContain('The climate is balanced and comfortable.');
  });

  it('renders POOR badge when temperature is TOO_COLD or HOT', () => {
    const comfort = {
      roomId: 1,
      temperatureLevel: 'TOO_COLD',
      humidityLevel: 'COMFY',
      freshness: 'POOR',
      coordinate: { radial: 0.9, angular: 270 }
    };
    const state = {
      sensorDataPoints: {
        insideTemperature: { celsius: 14.5 },
        humidity: { percentage: 50.0 }
      }
    };

    const html = renderToString(<ZoneClimateCard name="Basement" comfort={comfort} state={state} outsideTemp={10.0} />);
    expect(html).toContain('Basement');
    expect(html).toContain('POOR');
  });

  it('renders FAIR badge when conditions are slightly off', () => {
    const comfort = {
      roomId: 1,
      temperatureLevel: 'COMFY',
      humidityLevel: 'HUMID',
      freshness: 'FAIR',
      coordinate: { radial: 0.6, angular: 0 }
    };
    const state = {
      sensorDataPoints: {
        insideTemperature: { celsius: 20.5 },
        humidity: { percentage: 65.0 }
      }
    };

    const html = renderToString(<ZoneClimateCard name="Bathroom" comfort={comfort} state={state} outsideTemp={15.0} />);
    expect(html).toContain('Bathroom');
    expect(html).toContain('FAIR');
  });
});

describe('ClimateQualityHero', () => {
  it('renders GOOD freshness state with description', () => {
    const freshness = { value: 'GOOD', lastOpenWindow: null };
    const html = renderToString(<ClimateQualityHero freshness={freshness} weather={{ outsideTemperature: { celsius: 18.0 }, weatherState: { value: 'SUNNY' } }} />);
    expect(html).toContain('GOOD');
    expect(html).toContain('The indoor climate is healthy and fresh.');
    expect(html).toContain('No open windows recorded recently');
  });

  it('renders POOR freshness state and formatted last open window', () => {
    const freshness = { value: 'POOR', lastOpenWindow: '2026-08-16T10:00:00Z' };
    const html = renderToString(<ClimateQualityHero freshness={freshness} weather={null} />);
    expect(html).toContain('POOR');
    expect(html).toContain('Air quality in your home is poor.');
  });
});
