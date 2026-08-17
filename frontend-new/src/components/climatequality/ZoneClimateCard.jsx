/**
 * @file src/components/climatequality/ZoneClimateCard.jsx
 * @brief Renders the visual comfort overview card for a single room.
 * 
 * Embeds ComfortCompass to map temperature vs humidity levels, translates climate benchmarks
 * (TOO_COLD, TOO_DRY, TOO_HUMID, etc.) into descriptive localized recommendations,
 * and handles weather correlation checks to suggest opening windows when outside weather allows.
 */


import { useTranslation } from 'react-i18next';
import Card from '../common/Card';
import ComfortCompass from './ComfortCompass';
import { Thermometer, Droplets } from 'lucide-react';

/**
 * @brief Renders the individual climate status card for a room.
 * @param {string} props.name - Room name label.
 * @param {object} props.comfort - Calculated comfort details containing temperatureLevel, humidityLevel, and coordinate.
 * @param {object} props.state - Current room state.
 * @param {number} props.outsideTemp - Current outdoor temperature in Celsius.
 */
export default function ZoneClimateCard({ name, comfort, state, outsideTemp }) {
  const { t } = useTranslation();

  if (!comfort || !state) return null;

  const { temperatureLevel, humidityLevel, coordinate } = comfort;

  // Temperature and Humidity values from current zone state
  const temp = state.sensorDataPoints?.insideTemperature?.celsius;
  const humidity = state.sensorDataPoints?.humidity?.percentage;

  // Formulate comfort evaluation sentence
  const getExplanation = (tL, hL) => {
    const tText = (tL === 'TOO_COLD' || tL === 'COLD') ? t('air_comfort.explanation.cold')
                : (tL === 'HOT' || tL === 'WARM') ? t('air_comfort.explanation.warm')
                : t('air_comfort.explanation.comfy_temp');

    const hText = (hL === 'TOO_DRY' || hL === 'DRY') ? t('air_comfort.explanation.dry')
                : (hL === 'TOO_HUMID' || hL === 'HUMID') ? t('air_comfort.explanation.humid')
                : t('air_comfort.explanation.comfy_humidity');

    if (tL === 'COMFY' && hL === 'COMFY') {
      return t('air_comfort.explanation.balanced');
    }

    const conditions = `${tText} ${t('common.and')} ${hText}`;

    if (hL.includes('HUMID')) {
      return t('air_comfort.explanation.room_is_vent', { conditions });
    }

    if (hL.includes('DRY')) {
      return t('air_comfort.explanation.room_is_humidify', { conditions });
    }

    if (tL.includes('COLD')) {
      return t('air_comfort.explanation.room_is_cold', { condition: tText });
    }

    if (tL.includes('HOT') || tL.includes('WARM')) {
      const powerState = state.setting?.power;
      const target = state.setting?.temperature?.celsius;
      const isHeatingActive = powerState !== 'OFF' && target != null && target >= temp;

      if (isHeatingActive) {
        return t('air_comfort.explanation.room_is_warm', { condition: tText });
      } else {
        if (outsideTemp != null) {
          if (outsideTemp < temp) {
            return t('air_comfort.explanation.room_is_warm_cool_outside', { condition: tText });
          } else {
            return t('air_comfort.explanation.room_is_warm_hot_outside', { condition: tText });
          }
        } else {
          return t('air_comfort.explanation.room_is_warm_heating_off', { condition: tText });
        }
      }
    }

    return t('air_comfort.explanation.normal');
  };

  const explanation = getExplanation(temperatureLevel, humidityLevel);

  // Status Badge styles
  const getStatusBadge = (tL, hL, zoneFreshness) => {
    const f = zoneFreshness?.toUpperCase() || (
      (tL === 'TOO_COLD' || tL === 'HOT' || tL === 'TOO_HOT' || hL === 'TOO_DRY' || hL === 'TOO_HUMID') ? 'POOR' :
      (tL === 'COLD' || tL === 'WARM' || hL === 'DRY' || hL === 'HUMID') ? 'FAIR' :
      'GOOD'
    );
    if (f === 'POOR') {
      return { label: t('air_comfort.freshness_poor'), color: 'var(--danger)' };
    }
    if (f === 'FAIR') {
      return { label: t('air_comfort.freshness_fair'), color: 'var(--warning)' };
    }
    return { label: t('air_comfort.freshness_good'), color: 'var(--success)' };
  };

  const badge = getStatusBadge(temperatureLevel, humidityLevel, comfort.freshness);

  return (
    <Card style={{
      display: 'flex',
      flexDirection: 'column',
      gap: '1.25rem',
      padding: '1.25rem',
      height: '100%'
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0 }}>
            {name}
          </h3>
          <p style={{ 
            fontSize: '0.8rem', 
            fontWeight: 700, 
            color: badge.color, 
            marginTop: '2px',
            letterSpacing: '0.5px' 
          }}>
            {badge.label}
          </p>
        </div>

        {/* Small badge reading values */}
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <div style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '2px', 
            fontSize: '0.8rem', 
            color: 'var(--text-secondary)' 
          }}>
            <Thermometer size={14} style={{ color: 'var(--primary)' }} />
            <strong>{temp != null ? `${temp.toFixed(1)}°` : '--'}</strong>
          </div>
          <div style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '2px', 
            fontSize: '0.8rem', 
            color: 'var(--text-secondary)' 
          }}>
            <Droplets size={14} style={{ color: 'var(--secondary)' }} />
            <strong>{humidity != null ? `${humidity.toFixed(0)}%` : '--'}</strong>
          </div>
        </div>
      </div>

      {/* Compass Centering */}
      <div style={{ display: 'flex', justifyContent: 'center', margin: '0.25rem 0' }}>
        <ComfortCompass coordinate={coordinate} size={150} />
      </div>

      {/* Explanation text */}
      <p style={{ 
        fontSize: '0.825rem', 
        color: 'var(--text-secondary)', 
        lineHeight: 1.4,
        margin: 0,
        textAlign: 'center'
      }}>
        {explanation}
      </p>
    </Card>
  );
}
