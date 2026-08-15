/**
 * @file src/components/zone/ZoneCard.jsx
 * @brief Renders the visual status overview card for a single Zone on the home dashboard.
 * 
 * Maps target temperatures to dynamic colors on the card's left border, displays current inside temperatures,
 * relative room humidity percent metrics, and redirects hot water types to render DHWCard instead.
 */


import { Flame, Droplets, ShieldAlert, Thermometer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import DHWCard from './DHWCard';

/**
 * @brief Dashboard card displaying Zone status summary metrics.
 * @param {object} props.zone - Active zone details metadata.
 * @param {object} props.state - Current telemetry status.
 * @param {function} props.onClick - Navigation callback on click.
 */
export default function ZoneCard({ zone, state, onClick }) {
  const { t } = useTranslation();

  if (!zone) return null;

  // Render DHW Card if this is a hot water zone
  if (zone.type === 'HOT_WATER' || zone.type === 'DHW') {
    return <DHWCard zone={zone} state={state} onClick={onClick} />;
  }

  const currentTemp = state?.sensorDataPoints?.insideTemperature?.celsius;
  const humidity = state?.sensorDataPoints?.humidity?.percentage;
  const targetTemp = state?.setting?.temperature?.celsius;
  const heatingPower = state?.activityDataPoints?.heatingPower?.percentage || 0;
  const isHeating = heatingPower > 0;
  const isOffline = state?.link?.state === 'OFFLINE';
  const _isOverlay = !!state?.overlay;
  const isPowerOn = state?.setting?.power !== 'OFF';

  const getTemperatureColor = (temp) => {
    if (temp == null) {
      return 'var(--text-muted)';
    }
    const t = Math.max(5, Math.min(25, temp));
    const stops = [
      { t: 5, h: 210, s: 80, l: 45 },    // Blueish
      { t: 15, h: 145, s: 70, l: 40 },   // Greenish-teal
      { t: 18, h: 100, s: 70, l: 40 },   // Green
      { t: 19, h: 50, s: 95, l: 45 },    // Yellow
      { t: 21, h: 35, s: 95, l: 45 },    // Yellow-orange
      { t: 25, h: 15, s: 100, l: 40 }    // Dark Orange
    ];
    let lower = stops[0];
    let upper = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (t >= stops[i].t && t <= stops[i+1].t) {
        lower = stops[i];
        upper = stops[i+1];
        break;
      }
    }
    const range = upper.t - lower.t;
    const pct = range === 0 ? 0 : (t - lower.t) / range;
    const h = Math.round(lower.h + (upper.h - lower.h) * pct);
    const s = Math.round(lower.s + (upper.s - lower.s) * pct);
    const l = Math.round(lower.l + (upper.l - lower.l) * pct);
    return `hsl(${h}, ${s}%, ${l}%)`;
  };

  const getCardStyle = () => {
    let accentColor = 'var(--text-muted)';
    if (!isOffline && isPowerOn) {
      accentColor = getTemperatureColor(targetTemp);
    }

    return {
      backgroundColor: 'var(--bg-card)',
      backdropFilter: 'blur(var(--glass-blur))',
      borderRadius: '20px',
      padding: '14px 16px',
      cursor: 'pointer',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      height: '150px',
      minHeight: '150px',
      boxShadow: 'var(--glass-shadow)',
      transition: 'transform 0.15s ease, box-shadow 0.15s ease',
      userSelect: 'none',
      position: 'relative',
      overflow: 'hidden',
      color: 'var(--text-primary)',
      border: '1px solid var(--border-color)',
      borderLeft: `6px solid ${accentColor}`
    };
  };

  // Format temperature into integer and decimal components
  const formatDecimalTemp = (temp) => {
    if (temp == null) return { integer: '--', decimal: '' };
    const formatted = temp.toFixed(1);
    const parts = formatted.split('.');
    return { integer: parts[0], decimal: `.${parts[1]}°` };
  };

  const { integer, decimal } = formatDecimalTemp(currentTemp);

  return (
    <div 
      onClick={onClick}
      style={getCardStyle()}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-4px)';
        e.currentTarget.style.boxShadow = '0 8px 30px rgba(0, 0, 0, 0.25)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.15)';
      }}
    >
      {/* Top Header Row: Humidity & Heating State */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', zIndex: 1 }}>
        {humidity != null ? (
          <div style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '4px', 
            backgroundColor: 'rgba(128, 128, 128, 0.15)', 
            padding: '2px 8px', 
            borderRadius: '12px',
            fontSize: '0.75rem',
            fontWeight: 600,
            color: 'var(--text-secondary)'
          }}>
            <Droplets size={12} style={{ fill: 'currentColor' }} />
            <span>{humidity}%</span>
          </div>
        ) : <div />}

        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {isOffline && <ShieldAlert size={16} />}
          {isHeating && !isOffline && (
            <Flame 
              size={18} 
              style={{ 
                color: '#ff7a00',
                fill: '#ff5d00',
                filter: 'drop-shadow(0 0 6px rgba(255, 93, 0, 0.8))',
                animation: 'pulse-soft 1.5s infinite' 
              }} 
            />
          )}
        </div>
      </div>

      {/* Center Temperature Reading */}
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'baseline', margin: 'auto 0', zIndex: 1 }}>
        <span style={{ fontSize: '2.5rem', fontWeight: 700, lineHeight: 1 }}>
          {integer}
        </span>
        {decimal && (
          <span style={{ fontSize: '1.4rem', fontWeight: 600, opacity: 0.95, marginLeft: '1px' }}>
            {decimal}
          </span>
        )}
      </div>

      {/* Bottom Target / Room Name info */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', textAlign: 'left', zIndex: 1 }}>
        <span style={{ fontWeight: 700, fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {zone.name}
        </span>
        <span style={{ fontSize: '0.75rem', opacity: 0.85, display: 'flex', alignItems: 'center', gap: '4px' }}>
          <Thermometer size={12} />
          {isOffline ? (
            t('common.offline')
          ) : !isPowerOn ? (
            t('common.off')
          ) : targetTemp != null ? (
            `${t('dashboard.zones.set_to')} ${targetTemp.toFixed(1)}°`
          ) : (
            t('common.off')
          )}
        </span>
      </div>
    </div>
  );
}
