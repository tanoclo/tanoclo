/**
 * @file src/components/zone/DHWCard.jsx
 * @brief Renders the Domestic Hot Water (DHW) card widget on the main dashboard.
 * 
 * Maps hot water target temperatures to dynamic colored left borders, displays active
 * boiling flame animations when hot water is active, and shows current tank temperatures.
 */


import { Droplet, ShieldAlert, Thermometer, Flame } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * @brief Dashboard card displaying Domestic Hot Water metrics.
 * @param {object} props.zone - DHW zone metadata.
 * @param {object} props.state - Current DHW zone state.
 * @param {function} props.onClick - Navigation callback on click.
 */
export default function DHWCard({ zone, state, onClick }) {
  const { t } = useTranslation();

  if (!zone) return null;

  const currentTemp = state?.sensorDataPoints?.insideTemperature?.celsius;
  const targetTemp = state?.setting?.temperature?.celsius;
  const isPowerOn = state?.setting?.power === 'ON';
  const isOffline = state?.link?.state === 'OFFLINE';
  const _isOverlay = !!state?.overlay;
  const heatingPower = state?.activityDataPoints?.heatingPower?.percentage || 0;
  const isHeating = heatingPower > 0;

  const getDhwColor = (temp) => {
    if (temp == null) {
      return 'var(--text-muted)';
    }
    const t = Math.max(30, Math.min(65, temp));
    const stops = [
      { t: 30, h: 200, s: 80, l: 45 },    // Blueish
      { t: 40, h: 145, s: 70, l: 40 },    // Teal
      { t: 48, h: 60, s: 85, l: 42 },     // Yellow
      { t: 55, h: 30, s: 95, l: 45 },     // Orange
      { t: 65, h: 5, s: 100, l: 40 }      // Red
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
      accentColor = getDhwColor(targetTemp);
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
      transition: 'transform 0.15s ease, box-shadow 0.15s ease, background 0.25s ease',
      userSelect: 'none',
      position: 'relative',
      overflow: 'hidden',
      color: 'var(--text-primary)',
      border: '1px solid var(--border-color)',
      borderLeft: `6px solid ${accentColor}`
    };
  };

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
      {/* Top Header Row: Droplet Badge & Offline Warning */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', zIndex: 1 }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgba(128, 128, 128, 0.15)',
          color: 'var(--text-secondary)',
          width: '24px',
          height: '24px',
          borderRadius: '50%'
        }}>
          <Droplet size={12} style={{ fill: 'currentColor' }} />
        </div>
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

      {/* Center Water Status / Temperature */}
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'baseline', margin: 'auto 0', zIndex: 1 }}>
        <span style={{ fontSize: '2.5rem', fontWeight: 700, lineHeight: 1 }}>
          {isOffline ? '--' : isPowerOn ? t('common.on') : t('common.off')}
        </span>
        {currentTemp != null && !isOffline && (
          <span style={{ fontSize: '1.4rem', fontWeight: 600, opacity: 0.95, marginLeft: '4px' }}>
            {Math.round(currentTemp)}°
          </span>
        )}
      </div>

      {/* Bottom Name & Info */}
      <div 
        style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'flex-end', 
          width: '100%', 
          zIndex: 2
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', textAlign: 'left', maxWidth: '100%' }}>
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
    </div>
  );
}
