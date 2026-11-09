import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { HomeContext } from '../../context/HomeContext';

vi.mock('../../context/HomeContext', async () => {
  const React = await import('react');
  return {
    HomeContext: React.createContext(null)
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key) => key
  })
}));

vi.mock('../../context/ToastContext', () => ({
  useToast: () => ({
    showToast: vi.fn()
  })
}));

vi.mock('swr', () => ({
  default: (key) => {
    if (key && typeof key === 'string' && key.includes('supplyTemperatureOptimization')) {
      return {
        data: {
          maxFlowTemperature: 60,
          minFlowTemperature: 30,
          maxFlowTemperatureLimit: 80,
          autoAdaptation: {
            enabled: true,
            currentActualFlowTemperature: 45,
            currentReturnTemperature: 38,
            currentOutsideTemperature: 8.5,
            currentModulation: 25,
            lastReason: 'weather_compensation',
            lastOptimized: '2026-10-24 19:58:00'
          }
        },
        error: null,
        mutate: vi.fn()
      };
    }
    if (key && typeof key === 'string' && key.includes('supplyTemperatureHistory')) {
      return {
        data: {
          history: [
            {
              id: 1,
              timestamp: '2026-10-24 19:58:00',
              computed_flow_temp: 48,
              actual_flow_temp: 45,
              outside_temp: 8.5,
              reason: 'weather_compensation'
            }
          ]
        }
      };
    }
    return { data: null, error: null, mutate: vi.fn() };
  }
}));

import SupplyTempSettings from '../../components/settings/SupplyTempSettings';

describe('SupplyTempSettings', () => {
  it('renders timestamps converted to Berlin timezone', () => {
    const html = renderToString(
      <HomeContext.Provider value={{ homeInfo: { dateTimeZone: 'Europe/Berlin' } }}>
        <SupplyTempSettings homeId={123} />
      </HomeContext.Provider>
    );

    // 19:58:00 UTC in Europe/Berlin (CEST +2) is 21:58
    expect(html).toContain('21:58:00');
    expect(html).toContain('21:58');
  });

  it('renders timestamps converted to London timezone', () => {
    const html = renderToString(
      <HomeContext.Provider value={{ homeInfo: { dateTimeZone: 'Europe/London' } }}>
        <SupplyTempSettings homeId={123} />
      </HomeContext.Provider>
    );

    // 19:58:00 UTC in Europe/London (BST +1) is 20:58
    expect(html).toContain('20:58:00');
    expect(html).toContain('20:58');
  });
});
