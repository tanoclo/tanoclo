/**
 * @file src/components/schedule/TimeBlock.jsx
 * @brief Renders a single timed slot segment within a DayTimeline.
 * 
 * Calculates slot width percentages based on duration relative to a 24-hour day,
 * and sets background color gradients dynamically mapped to target temperatures.
 */


import { formatTemperature } from '../../utils/temperature';

/**
 * @brief Time block segment component.
 * @param {object} props.block - Time block details containing start, end, and setting.
 * @param {function} props.onClick - Selection callback hook.
 * @param {number} props.totalMinutes - Total scale minutes (standard 1440 for 24h).
 * @param {boolean} props.isDhw - Whether the target zone is DHW (Domestic Hot Water).
 */
export default function TimeBlock({ 
  block, 
  onClick, 
  totalMinutes = 1440, // 24 hours
  isDhw = false 
}) {
  const { start, end, setting } = block;

  // Convert time HH:MM to minutes past midnight
  const timeToMinutes = (timeStr) => {
    if (!timeStr) return 0;
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
  };

  const startMin = timeToMinutes(start);
  let endMin = timeToMinutes(end);
  
  // Handing midnight wraparound or 24:00 (which might be stored as 00:00 or 24:00)
  if (endMin <= startMin) {
    endMin = 1440; // Assume end of day if end <= start (e.g. 00:00 to 00:00 seed block)
  }

  const duration = endMin - startMin;
  const widthPercent = (duration / totalMinutes) * 100;

  // Compute background gradient based on temperature setpoint
  const getBackgroundStyle = () => {
    if (isDhw) {
      const isPowerOn = setting?.power === 'ON';
      if (!isPowerOn) {
        return 'linear-gradient(to bottom, hsl(220, 15%, 18%), hsl(220, 15%, 12%))';
      }
      const temp = setting?.temperature?.celsius ?? 50.0;
      const minTemp = 30.0;
      const maxTemp = 65.0;
      const ratio = Math.min(1, Math.max(0, (temp - minTemp) / (maxTemp - minTemp)));
      const hue = 200 - ratio * 175; // 200 (blue) down to 25 (orange/red)
      return `linear-gradient(to bottom, hsl(${hue}, 75%, 22%), hsl(${hue}, 80%, 13%))`;
    }

    const temp = setting?.temperature?.celsius ?? 15.0;
    // Map temperature 5.0 -> 25.0 to HSL hue range (200=blue -> 25=orange)
    const minTemp = 5.0;
    const maxTemp = 25.0;
    const ratio = Math.min(1, Math.max(0, (temp - minTemp) / (maxTemp - minTemp)));
    const hue = 200 - ratio * 175; // 200 (blue) down to 25 (orange/red)
    
    return `linear-gradient(to bottom, hsl(${hue}, 75%, 22%), hsl(${hue}, 80%, 13%))`;
  };

  const _label = isDhw 
    ? (setting?.power === 'ON' 
        ? (setting?.temperature?.celsius ? formatTemperature(setting.temperature.celsius) : 'ON')
        : 'OFF')
    : formatTemperature(setting?.temperature?.celsius);

  return (
    <div 
      onClick={onClick}
      style={{
        width: `${widthPercent}%`,
        height: '100%',
        background: getBackgroundStyle(),
        borderLeft: '1px solid hsla(0, 0%, 100%, 0.15)',
        borderRight: '1px solid hsla(0, 0%, 0%, 0.3)',
        cursor: 'pointer',
        minWidth: '4px',
        transition: 'filter var(--transition-fast)'
      }}
      onMouseEnter={(e) => e.currentTarget.style.filter = 'brightness(1.2)'}
      onMouseLeave={(e) => e.currentTarget.style.filter = 'none'}
    />
  );
}
