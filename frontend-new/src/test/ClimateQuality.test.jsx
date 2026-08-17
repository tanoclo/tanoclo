// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ClimateQualityCard from './components/zone/ClimateQualityCard';
import ZoneClimateCard from './components/climatequality/ZoneClimateCard';
import ClimateQualityHero from './components/climatequality/ClimateQualityHero';

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
    render(<ClimateQualityCard climateQuality={null} onClick={vi.fn()} />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('renders GOOD state with green background', () => {
    const payload = { freshness: { value: 'GOOD' } };
    render(<ClimateQualityCard climateQuality={payload} onClick={vi.fn()} />);
    expect(screen.getByText('GOOD')).toBeInTheDocument();
    expect(screen.getByText('Climate Quality')).toBeInTheDocument();
  });

  it('renders FAIR state', () => {
    const payload = { freshness: { value: 'FAIR' } };
    render(<ClimateQualityCard climateQuality={payload} onClick={vi.fn()} />);
    expect(screen.getByText('FAIR')).toBeInTheDocument();
  });

  it('renders POOR state', () => {
    const payload = { freshness: { value: 'POOR' } };
    render(<ClimateQualityCard climateQuality={payload} onClick={vi.fn()} />);
    expect(screen.getByText('POOR')).toBeInTheDocument();
  });

  it('calls onClick callback when clicked', () => {
    const onClick = vi.fn();
    render(<ClimateQualityCard climateQuality={{ freshness: { value: 'GOOD' } }} onClick={onClick} />);
    fireEvent.click(screen.getByText('Climate Quality'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('ZoneClimateCard', () => {
  it('returns null when comfort or state is missing', () => {
    const { container } = render(<ZoneClimateCard name="Living Room" comfort={null} state={null} />);
    expect(container.firstChild).toBeNull();
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

    render(<ZoneClimateCard name="Living Room" comfort={comfort} state={state} outsideTemp={18.0} />);
    expect(screen.getByText('Living Room')).toBeInTheDocument();
    expect(screen.getByText('GOOD')).toBeInTheDocument();
    expect(screen.getByText('21.0°')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('The climate is balanced and comfortable.')).toBeInTheDocument();
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

    render(<ZoneClimateCard name="Basement" comfort={comfort} state={state} outsideTemp={10.0} />);
    expect(screen.getByText('Basement')).toBeInTheDocument();
    expect(screen.getByText('POOR')).toBeInTheDocument();
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

    render(<ZoneClimateCard name="Bathroom" comfort={comfort} state={state} outsideTemp={15.0} />);
    expect(screen.getByText('Bathroom')).toBeInTheDocument();
    expect(screen.getByText('FAIR')).toBeInTheDocument();
  });
});

describe('ClimateQualityHero', () => {
  it('renders GOOD freshness state with description', () => {
    const freshness = { value: 'GOOD', lastOpenWindow: null };
    render(<ClimateQualityHero freshness={freshness} weather={{ outsideTemperature: { celsius: 18.0 }, weatherState: { value: 'SUNNY' } }} />);
    expect(screen.getByText('GOOD')).toBeInTheDocument();
    expect(screen.getByText('The indoor climate is healthy and fresh.')).toBeInTheDocument();
    expect(screen.getByText('No open windows recorded recently')).toBeInTheDocument();
  });

  it('renders POOR freshness state and formatted last open window', () => {
    const freshness = { value: 'POOR', lastOpenWindow: '2026-08-16T10:00:00Z' };
    render(<ClimateQualityHero freshness={freshness} weather={null} />);
    expect(screen.getByText('POOR')).toBeInTheDocument();
    expect(screen.getByText('Air quality in your home is poor.')).toBeInTheDocument();
  });
});
