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

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => {
      const map = {
        'air_comfort.mold_low': 'Low Mold Risk',
        'air_comfort.mold_elevated': 'Elevated Risk',
        'air_comfort.mold_high': 'High Mold Risk',
        'air_comfort.mold_calibrating': `Calibrating (${opts?.progress || 0}%)`,
        'air_comfort.mold_diagnostics_title': 'Mold Risk Diagnostics',
        'air_comfort.mold_wall_surface': 'Cold Wall Surface',
        'air_comfort.mold_ambient_air': 'Ambient Room Air',
        'air_comfort.mold_vtt_index': 'VTT Mold Index',
        'air_comfort.mold_insulation_factor': 'Insulation Factor (fRsi)',
        'air_comfort.mold_inherited': 'Inherited from home'
      };
      return map[key] || opts?.defaultValue || key;
    }
  })
}));

import MoldRiskBadge from '../../components/climatequality/MoldRiskBadge';
import MoldDetailModal from '../../components/climatequality/MoldDetailModal';

describe('MoldRiskBadge', () => {
  it('renders null when mold is missing', () => {
    const html = renderToString(<MoldRiskBadge mold={null} />);
    expect(html).toBe('');
  });

  it('renders low risk badge', () => {
    const mold = { level: 'LOW' };
    const html = renderToString(<MoldRiskBadge mold={mold} />);
    expect(html).toContain('Low Mold Risk');
    expect(html).toContain('#10b981');
  });

  it('renders elevated risk badge', () => {
    const mold = { level: 'ELEVATED' };
    const html = renderToString(<MoldRiskBadge mold={mold} />);
    expect(html).toContain('Elevated Risk');
    expect(html).toContain('#f59e0b');
  });

  it('renders high risk badge', () => {
    const mold = { level: 'HIGH' };
    const html = renderToString(<MoldRiskBadge mold={mold} />);
    expect(html).toContain('High Mold Risk');
    expect(html).toContain('#ef4444');
  });

  it('renders calibrating badge', () => {
    const mold = { status: 'CALIBRATING', progressPercentage: 60 };
    const html = renderToString(<MoldRiskBadge mold={mold} />);
    expect(html).toContain('Calibrating (60%)');
    expect(html).toContain('#94a3b8');
  });
});

describe('MoldDetailModal', () => {
  it('renders null when isOpen is false or comfort is missing', () => {
    const comfort = { mold: { level: 'HIGH' } };
    expect(renderToString(<MoldDetailModal isOpen={false} onClose={vi.fn()} zoneName="Bedroom" comfort={comfort} />)).toBe('');
    expect(renderToString(<MoldDetailModal isOpen={true} onClose={vi.fn()} zoneName="Bedroom" comfort={null} />)).toBe('');
  });

  it('renders modal diagnostics correctly when open', () => {
    const comfort = {
      mold: {
        status: 'COMPUTED',
        level: 'HIGH',
        index: 2.4,
        surfaceTemperature: 11.2,
        surfaceRelativeHumidity: 84.5,
        dewPoint: 11.8,
        condensationRisk: true,
        effectiveInsulationFactor: 0.65,
        isInherited: false
      }
    };
    const state = {
      sensorDataPoints: {
        insideTemperature: { celsius: 19.5 },
        humidity: { percentage: 62.0 }
      }
    };
    const html = renderToString(
      <MoldDetailModal
        isOpen={true}
        onClose={vi.fn()}
        zoneName="Master Bedroom"
        comfort={comfort}
        state={state}
        outsideTemp={5.0}
      />
    );
    expect(html).toContain('Master Bedroom');
    expect(html).toContain('Mold Risk Diagnostics');
    expect(html).toContain('11.2°');
    expect(html).toContain('85%');
    expect(html).toContain('0.65');
    expect(html).toContain('High Mold Risk');
  });
});
