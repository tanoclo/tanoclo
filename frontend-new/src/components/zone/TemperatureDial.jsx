/**
 * @file src/components/zone/TemperatureDial.jsx
 * @brief Renders the Home Assistant style interactive circular thermostat arc dial.
 */

import { useRef, useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Minus } from 'lucide-react';
import { formatTemperature } from '../../utils/temperature';

/**
 * @brief Home Assistant Thermostat style circular dial spin button controller.
 * @param {number} props.value - Active temperature setpoint.
 * @param {function} props.onChange - Value change callback handler.
 * @param {number} props.min - Minimum temperature boundary.
 * @param {number} props.max - Maximum temperature boundary.
 * @param {number} props.step - Single stepper click increment size.
 * @param {boolean} props.disabled - Active control disability parameter.
 * @param {number|null} props.currentTemp - Current room temperature telemetry.
 */
export default function TemperatureDial({ 
  value, 
  onChange, 
  min = 5.0, 
  max = 25.0, 
  step = 0.5,
  disabled = false,
  currentTemp = null
}) {
  const { t } = useTranslation();
  const svgRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleIncrement = () => {
    if (disabled) return;
    const newValue = Math.min(max, value + step);
    onChange && onChange(newValue);
  };

  const handleDecrement = () => {
    if (disabled) return;
    const newValue = Math.max(min, value - step);
    onChange && onChange(newValue);
  };

  // Convert temperature to angle in degrees (135° at min to 45° at max, clockwise 270° total)
  const tempToAngleDeg = (tempVal) => {
    if (tempVal == null) return 135;
    const clamped = Math.max(min, Math.min(max, tempVal));
    const pct = (clamped - min) / (max - min);
    return 135 + pct * 270;
  };

  // Convert angle in degrees to temperature setpoint
  const angleDegToTemp = useCallback((deg) => {
    let norm = (deg % 360 + 360) % 360;
    if (norm > 45 && norm < 135) {
      if (norm < 90) norm = 45;
      else norm = 135;
    }

    let pct;
    if (norm >= 135) {
      pct = (norm - 135) / 270;
    } else {
      pct = (norm + 360 - 135) / 270;
    }

    pct = Math.max(0, Math.min(1, pct));
    const rawTemp = min + pct * (max - min);
    const stepped = Math.round(rawTemp / step) * step;
    return Math.max(min, Math.min(max, stepped));
  }, [min, max, step]);

  const updateFromPointer = useCallback((e) => {
    if (disabled || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const dx = clientX - cx;
    const dy = clientY - cy;
    
    let rad = Math.atan2(dy, dx);
    let deg = (rad * 180 / Math.PI + 360) % 360;
    
    const newTemp = angleDegToTemp(deg);
    if (newTemp !== value) {
      onChange && onChange(newTemp);
    }
  }, [disabled, value, angleDegToTemp, onChange]);

  const handlePointerDown = (e) => {
    if (disabled) return;
    setIsDragging(true);
    updateFromPointer(e);
  };

  useEffect(() => {
    if (!isDragging) return;
    const handlePointerMove = (e) => updateFromPointer(e);
    const handlePointerUp = () => setIsDragging(false);

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [isDragging, updateFromPointer]);

  // Geometry calculations (Center = 120, 120, R = 90)
  const R = 90;
  const cx = 120;
  const cy = 120;

  const targetAngleDeg = tempToAngleDeg(value);
  const targetRad = (targetAngleDeg * Math.PI) / 180;
  const targetX = (cx + R * Math.cos(targetRad)).toFixed(2);
  const targetY = (cy + R * Math.sin(targetRad)).toFixed(2);

  const targetPct = (value - min) / (max - min);
  const largeArcFlag = targetPct * 270 > 180 ? 1 : 0;
  const fillArcPath = `M 56.36 183.64 A 90 90 0 ${largeArcFlag} 1 ${targetX} ${targetY}`;

  // Current Temp Marker position
  let currentX = null;
  let currentY = null;
  if (currentTemp != null) {
    const currentAngleDeg = tempToAngleDeg(currentTemp);
    const currentRad = (currentAngleDeg * Math.PI) / 180;
    currentX = (cx + R * Math.cos(currentRad)).toFixed(2);
    currentY = (cy + R * Math.sin(currentRad)).toFixed(2);
  }

  const isOff = value <= min;

  return (
    <div 
      role="spinbutton"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '0.75rem',
        width: '100%',
        maxWidth: '300px',
        margin: '0 auto',
        userSelect: 'none'
      }}
    >
      {/* Home Assistant Thermostat Dial Arc Container */}
      <div 
        style={{
          position: 'relative',
          width: '240px',
          height: '240px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        {/* SVG Circular Gauge Arc */}
        <svg 
          ref={svgRef}
          viewBox="0 0 240 240"
          onPointerDown={handlePointerDown}
          style={{
            width: '100%',
            height: '100%',
            cursor: disabled ? 'not-allowed' : 'pointer',
            touchAction: 'none'
          }}
        >
          {/* Background Arc Track (270° from 135° to 45°) */}
          <path 
            d="M 56.36 183.64 A 90 90 0 1 1 183.64 183.64" 
            fill="none" 
            stroke="rgba(255, 255, 255, 0.25)" 
            strokeWidth="12" 
            strokeLinecap="round" 
          />

          {/* Active Target Setpoint Fill Arc */}
          {!isOff && (
            <path 
              d={fillArcPath} 
              fill="none" 
              stroke="#ffffff" 
              strokeWidth="12" 
              strokeLinecap="round" 
              style={{
                filter: 'drop-shadow(0 0 6px rgba(255, 255, 255, 0.5))'
              }}
            />
          )}

          {/* Current Room Temperature Notch Dot */}
          {currentX != null && currentY != null && (
            <g>
              <circle 
                cx={currentX} 
                cy={currentY} 
                r="6" 
                fill="#fbbf24" 
                stroke="#1f2937" 
                strokeWidth="2" 
                style={{
                  filter: 'drop-shadow(0 0 4px rgba(251, 191, 36, 0.8))'
                }}
              />
            </g>
          )}

          {/* Target Setpoint Knob / Handle */}
          <circle 
            cx={targetX} 
            cy={targetY} 
            r="12" 
            fill="#ffffff" 
            stroke="#1f2937" 
            strokeWidth="3" 
            style={{
              filter: 'drop-shadow(0 2px 8px rgba(0, 0, 0, 0.4))',
              transition: isDragging ? 'none' : 'all 0.15s ease'
            }}
          />
        </svg>

        {/* Center Target Temperature Display Readout */}
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
          color: '#ffffff'
        }}>
          <span style={{
            fontSize: '3.25rem',
            fontWeight: 800,
            lineHeight: 1,
            letterSpacing: '-1px',
            textShadow: '0 2px 10px rgba(0, 0, 0, 0.2)'
          }}>
            {isOff ? t('common.off', 'OFF') : formatTemperature(value, 'CELSIUS', false)}
          </span>
          <span style={{
            fontSize: '0.85rem',
            fontWeight: 600,
            opacity: 0.9,
            marginTop: '4px'
          }}>
            {isOff ? '' : t('common.celsius', 'Celsius')}
          </span>
          
          {/* Current Room Temp Badge inside dial center */}
          {currentTemp != null && (
            <span style={{
              fontSize: '0.75rem',
              fontWeight: 600,
              backgroundColor: 'rgba(0, 0, 0, 0.2)',
              padding: '2px 10px',
              borderRadius: '12px',
              marginTop: '8px',
              color: 'rgba(255, 255, 255, 0.95)'
            }}>
              {t('zone.inside_temp', 'Inside {{temp}}°', { temp: currentTemp.toFixed(1) })}
            </span>
          )}
        </div>
      </div>

      {/* Stepper (+/-) Control Buttons placed cleanly below the arc */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '2rem', marginTop: '-8px' }}>
        <button
          onClick={handleDecrement}
          disabled={disabled || value <= min}
          aria-label={t('zone.decrease_temp', 'Decrease temperature')}
          style={{
            width: '46px',
            height: '46px',
            borderRadius: '50%',
            backgroundColor: 'rgba(255, 255, 255, 0.25)',
            backdropFilter: 'blur(8px)',
            border: '1px solid rgba(255, 255, 255, 0.35)',
            color: '#ffffff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: disabled || value <= min ? 'not-allowed' : 'pointer',
            opacity: disabled || value <= min ? 0.3 : 1,
            transition: 'all 0.15s ease',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
            outline: 'none'
          }}
        >
          <Minus size={22} />
        </button>

        <button
          onClick={handleIncrement}
          disabled={disabled || value >= max}
          aria-label={t('zone.increase_temp', 'Increase temperature')}
          style={{
            width: '46px',
            height: '46px',
            borderRadius: '50%',
            backgroundColor: 'rgba(255, 255, 255, 0.25)',
            backdropFilter: 'blur(8px)',
            border: '1px solid rgba(255, 255, 255, 0.35)',
            color: '#ffffff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: disabled || value >= max ? 'not-allowed' : 'pointer',
            opacity: disabled || value >= max ? 0.3 : 1,
            transition: 'all 0.15s ease',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
            outline: 'none'
          }}
        >
          <Plus size={22} />
        </button>
      </div>
    </div>
  );
}
