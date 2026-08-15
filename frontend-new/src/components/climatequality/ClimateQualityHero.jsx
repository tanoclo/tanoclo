/**
 * @file src/components/climatequality/ClimateQualityHero.jsx
 * @brief Renders the overall home air comfort and freshness summary banner.
 * 
 * Displays calculated air freshness status (GOOD/FAIR/POOR), the timestamp of the last detected open window,
 * and current outdoor weather state/temperature configurations.
 */


import { useTranslation } from 'react-i18next';
import Card from '../common/Card';
import { Wind, Smile, CheckCircle } from 'lucide-react';
import { formatTemperature } from '../../utils/temperature';

/**
 * @brief Hero card visual indicator displaying summary metrics.
 * @param {object} props.freshness - Active freshness payload containing value and lastOpenWindow parameters.
 * @param {object} props.weather - External weather telemetry metrics.
 */
export default function ClimateQualityHero({ freshness, weather }) {
  const { t } = useTranslation();

  const getFreshnessDetails = (val) => {
    switch (val?.toUpperCase()) {
      case 'POOR':
        return {
          label: t('air_comfort.freshness_poor'),
          color: 'var(--danger)',
          bg: 'var(--danger-glow)',
          desc: t('air_comfort.desc_poor')
        };
      case 'FAIR':
        return {
          label: t('air_comfort.freshness_fair'),
          color: 'var(--warning)',
          bg: 'var(--warning-glow)',
          desc: t('air_comfort.desc_fair')
        };
      case 'FRESH':
      default:
        return {
          label: t('air_comfort.freshness_good'),
          color: 'var(--success)',
          bg: 'var(--success-glow)',
          desc: t('air_comfort.desc_good')
        };
    }
  };

  const freshDetails = getFreshnessDetails(freshness?.value);

  // Format last open window
  const formatLastOpened = (isoStr) => {
    if (!isoStr) return t('air_comfort.no_windows_opened');
    const date = new Date(isoStr);
    return t('air_comfort.last_window_opened', {
      date: date.toLocaleDateString(),
      time: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  };

  return (
    <Card style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
      gap: '1.5rem',
      padding: '1.5rem',
      alignItems: 'center',
      borderLeft: `5px solid ${freshDetails.color}`
    }}>
      {/* Visual Indicator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '56px',
          height: '56px',
          borderRadius: '16px',
          background: `linear-gradient(135deg, ${freshDetails.bg} 0%, rgba(255,255,255,0.01) 100%)`,
          border: `1px solid ${freshDetails.color}`,
          color: freshDetails.color
        }}>
          {freshness?.value === 'FRESH' ? <Smile size={32} /> : <Wind size={32} />}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
            {t('air_comfort.hero_freshness')}
          </span>
          <strong style={{ fontSize: '1.5rem', fontWeight: 800, color: freshDetails.color }}>
            {freshDetails.label}
          </strong>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {formatLastOpened(freshness?.lastOpenWindow)}
          </span>
        </div>
      </div>

      {/* Description and Info */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
          {freshDetails.desc}
        </p>

        {weather && (
          <div style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '0.5rem', 
            fontSize: '0.8rem', 
            color: 'var(--text-muted)',
            marginTop: '0.25rem' 
          }}>
            <CheckCircle size={14} style={{ color: 'var(--success)' }} />
            <span>
              {t('air_comfort.outside_weather')}: {t(`weather.states.${weather.weatherState?.value}`, { defaultValue: weather.weatherState?.value })} ({formatTemperature(weather.outsideTemperature?.celsius)})
            </span>
          </div>
        )}
      </div>
    </Card>
  );
}
