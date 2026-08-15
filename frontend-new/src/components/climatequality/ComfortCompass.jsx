/**
 * @file src/components/climatequality/ComfortCompass.jsx
 * @brief Renders the visual comfort compass plotting room temperature vs humidity.
 * 
 * Maps radial and angular coordinate offsets onto a circular chart to indicate
 * whether a room's indoor climate lies within the comfortable zone (closer to the center)
 * or drifts towards hot, cold, humid, or dry.
 */


import { useTranslation } from 'react-i18next';

/**
 * @brief Renders the comfort compass grid.
 * @param {object} props.coordinate - Polar coordinate offset containing angular and radial properties.
 * @param {number} props.size - Circular container diameter size.
 */
export default function ComfortCompass({ coordinate, size = 160 }) {
  const { t } = useTranslation();
  
  if (!coordinate) return null;

  const rad = (coordinate.angular * Math.PI) / 180;
  const r = coordinate.radial;
  
  // Calculate dot placement inside compass
  const limit = size / 2 - 18; // Margin for dot and border
  const dotX = size / 2 + r * limit * Math.cos(rad);
  // Subtract sine component so 90 deg (Warm) translates to going UP
  const dotY = size / 2 - r * limit * Math.sin(rad);

  // Check comfort zone
  const isComfy = r <= 0.5;

  return (
    <div style={{
      width: `${size}px`,
      height: `${size}px`,
      borderRadius: '50%',
      position: 'relative',
      background: isComfy 
        ? 'radial-gradient(circle, rgba(76, 175, 80, 0.1) 0%, rgba(0,0,0,0) 70%)'
        : 'radial-gradient(circle, rgba(255, 94, 98, 0.05) 0%, rgba(0,0,0,0) 70%)',
      border: '1.5px solid var(--border-color-hover)',
      boxShadow: 'inset 0 0 12px rgba(255,255,255,0.02)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }}>
      {/* Target Center Circle (Comfortable Zone) */}
      <div style={{
        position: 'absolute',
        width: `${size * 0.5}px`,
        height: `${size * 0.5}px`,
        borderRadius: '50%',
        border: '1px dashed var(--border-color-hover)',
        backgroundColor: 'rgba(255,255,255,0.01)'
      }} />

      {/* Crosshair lines */}
      <div style={{
        position: 'absolute',
        width: `${size - 24}px`,
        height: '1px',
        backgroundColor: 'var(--border-color)'
      }} />
      <div style={{
        position: 'absolute',
        height: `${size - 24}px`,
        width: '1px',
        backgroundColor: 'var(--border-color)'
      }} />

      {/* Axis Labels */}
      <span style={{
        position: 'absolute',
        top: '6px',
        fontSize: '0.65rem',
        fontWeight: 700,
        color: 'var(--text-muted)',
        letterSpacing: '0.5px'
      }}>
        {t('air_comfort.compass.warm').toUpperCase()}
      </span>
      <span style={{
        position: 'absolute',
        bottom: '6px',
        fontSize: '0.65rem',
        fontWeight: 700,
        color: 'var(--text-muted)',
        letterSpacing: '0.5px'
      }}>
        {t('air_comfort.compass.cold').toUpperCase()}
      </span>
      <span style={{
        position: 'absolute',
        left: '8px',
        fontSize: '0.65rem',
        fontWeight: 700,
        color: 'var(--text-muted)',
        letterSpacing: '0.5px'
      }}>
        {t('air_comfort.compass.dry').toUpperCase()}
      </span>
      <span style={{
        position: 'absolute',
        right: '8px',
        fontSize: '0.65rem',
        fontWeight: 700,
        color: 'var(--text-muted)',
        letterSpacing: '0.5px'
      }}>
        {t('air_comfort.compass.humid').toUpperCase()}
      </span>

      {/* Indicator Dot */}
      <div style={{
        position: 'absolute',
        width: '12px',
        height: '12px',
        borderRadius: '50%',
        backgroundColor: isComfy ? 'var(--success)' : 'var(--primary)',
        boxShadow: isComfy 
          ? '0 0 12px var(--success), 0 0 4px var(--success)' 
          : '0 0 12px var(--primary), 0 0 4px var(--primary)',
        left: `${dotX - 6}px`,
        top: `${dotY - 6}px`,
        transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)'
      }} />
    </div>
  );
}
