import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import CombinedTelemetryChart from '../../components/charts/CombinedTelemetryChart';

vi.mock('react-chartjs-2', () => ({
  Line: (props) => <div data-testid="chart-line" data-points={props?.data?.labels?.length || 0} />
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key) => key
  })
}));

describe('CombinedTelemetryChart', () => {
  it('returns null when dayReportData is null', () => {
    const html = renderToString(<CombinedTelemetryChart dayReportData={null} />);
    expect(html).toBe('');
  });

  it('renders no telemetry data message when points are empty', () => {
    const html = renderToString(<CombinedTelemetryChart dayReportData={{ measuredData: {} }} />);
    expect(html).toContain('zone.no_telemetry_data');
  });

  it('renders weather timeline slots directly above chart canvas with time and temperatures', () => {
    const dayReportData = {
      zoneType: 'HEATING',
      measuredData: {
        insideTemperature: {
          dataPoints: [
            { timestamp: '2026-09-11T00:00:00Z', value: { celsius: 19.5 } },
            { timestamp: '2026-09-11T04:00:00Z', value: { celsius: 19.2 } },
            { timestamp: '2026-09-11T08:00:00Z', value: { celsius: 20.0 } },
            { timestamp: '2026-09-11T12:00:00Z', value: { celsius: 21.0 } },
            { timestamp: '2026-09-11T16:00:00Z', value: { celsius: 21.5 } },
            { timestamp: '2026-09-11T20:00:00Z', value: { celsius: 20.2 } }
          ]
        }
      },
      weather: {
        slots: {
          '04:00': { state: 'RAIN', temperature: { celsius: 13.4 } },
          '08:00': { state: 'CLOUDY', temperature: { celsius: 14.4 } },
          '12:00': { state: 'CLOUDY', temperature: { celsius: 17.6 } },
          '16:00': { state: 'SUNNY', temperature: { celsius: 17.9 } },
          '20:00': { state: 'RAIN', temperature: { celsius: 15.1 } }
        }
      }
    };

    const html = renderToString(<CombinedTelemetryChart dayReportData={dayReportData} />);

    // Check weather slot times are rendered
    expect(html).toContain('04:00');
    expect(html).toContain('08:00');
    expect(html).toContain('12:00');
    expect(html).toContain('16:00');
    expect(html).toContain('20:00');

    // Check temperatures
    expect(html).toContain('13.4°');
    expect(html).toContain('14.4°');
    expect(html).toContain('17.6°');
    expect(html).toContain('17.9°');
    expect(html).toContain('15.1°');

    // Check chart canvas placeholder is rendered
    expect(html).toContain('data-testid="chart-line"');
  });
});
