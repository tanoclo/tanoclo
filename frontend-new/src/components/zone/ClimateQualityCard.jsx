/**
 * @file src/components/zone/ClimateQualityCard.jsx
 * @brief Renders the home air comfort card widget shown on the main dashboard.
 * 
 * Displays consolidated freshness ratings with animated, color-graded backgrounds
 * (green for good, amber for fair, red for poor, slate for loading) mapping to indoor climate conditions.
 */


import { Wind, ShieldCheck, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * @brief Dashboard card displaying Home Indoor Air Quality metrics.
 * @param {object} props.climateQuality - Active air quality payload from API.
 * @param {function} props.onClick - Navigation callback on click.
 */
export default function ClimateQualityCard({ climateQuality, onClick }) {
  const { t } = useTranslation();

  const rawFreshness = climateQuality?.freshness?.value?.toUpperCase();
  const freshness = !climateQuality 
    ? 'LOADING' 
    : (rawFreshness === 'FRESH' || rawFreshness === 'GOOD' ? 'GOOD' : (rawFreshness || 'GOOD'));

  // Dynamic Background: emerald for good, amber for fair, red for poor, slate for loading
  const getCardStyle = () => {
    let background = 'linear-gradient(135deg, #10b981 0%, #059669 100%)'; // GOOD (Emerald)
    if (freshness === 'LOADING') {
      background = 'linear-gradient(135deg, #64748b 0%, #475569 100%)'; // LOADING (Slate gray)
    } else if (freshness === 'FAIR') {
      background = 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)'; // FAIR (Amber)
    } else if (freshness === 'POOR') {
      background = 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)'; // POOR (Red)
    }

    return {
      background,
      borderRadius: '20px',
      padding: '14px 16px',
      cursor: 'pointer',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      height: '150px',
      minHeight: '150px',
      boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15)',
      transition: 'transform 0.15s ease, box-shadow 0.15s ease',
      userSelect: 'none',
      position: 'relative',
      overflow: 'hidden',
      color: '#ffffff',
      border: '1px solid rgba(255, 255, 255, 0.1)'
    };
  };

  const getFreshnessLabel = () => {
    switch (freshness) {
      case 'LOADING':
        return t('common.loading');
      case 'POOR':
        return t('air_comfort.freshness_poor');
      case 'FAIR':
        return t('air_comfort.freshness_fair');
      case 'GOOD':
      case 'FRESH':
      default:
        return t('air_comfort.freshness_good');
    }
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
      {/* Top Header Row */}
      <div style={{ display: 'flex', justifycontent: 'space-between', alignItems: 'center', width: '100%', zIndex: 1 }}>
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: '4px', 
          backgroundColor: 'rgba(255, 255, 255, 0.2)', 
          padding: '2px 8px', 
          borderRadius: '12px',
          fontSize: '0.75rem',
          fontWeight: 700
        }}>
          <span>{t('air_comfort.iaq_badge', { defaultValue: 'IAQ' })}</span>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {freshness === 'GOOD' || freshness === 'FRESH' ? (
            <ShieldCheck size={16} />
          ) : freshness === 'LOADING' ? (
            null
          ) : (
            <AlertTriangle size={16} />
          )}
        </div>
      </div>

      {/* Center Rating */}
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', margin: 'auto 0', zIndex: 1 }}>
        <span style={{ fontSize: '1.75rem', fontWeight: 800, letterSpacing: '0.5px', lineHeight: 1 }}>
          {getFreshnessLabel()}
        </span>
      </div>

      {/* Bottom info */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', textAlign: 'left', zIndex: 1 }}>
        <span style={{ fontWeight: 700, fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {t('air_comfort.title')}
        </span>
        <span style={{ fontSize: '0.75rem', opacity: 0.85, display: 'flex', alignItems: 'center', gap: '4px' }}>
          <Wind size={12} />
          {t('air_comfort.hero_freshness')}
        </span>
      </div>
    </div>
  );
}
