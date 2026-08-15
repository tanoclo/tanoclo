/**
 * @file src/components/schedule/DayTimeline.jsx
 * @brief Renders the consolidated horizontal 24h timeline bar for a single schedule day.
 * 
 * Orders active schedule blocks chronologically and passes proportion configurations
 * to individual TimeBlock elements. Renders static hourly markers (0:00 to 24:00) underneath.
 */


import { useTranslation } from 'react-i18next';
import TimeBlock from './TimeBlock';

/**
 * @brief Timeline container component.
 * @param {string} props.dayType - Day block designation (e.g. MONDAY, MONDAY_TO_FRIDAY).
 * @param {Array} props.blocks - Configured time block segments.
 * @param {function} props.onBlockClick - Time block selection/editing callback handler.
 * @param {boolean} props.isDhw - Whether the target zone is DHW (Domestic Hot Water).
 */
export default function DayTimeline({ 
  _dayType, 
  blocks = [], 
  onBlockClick, 
  isDhw = false 
}) {
  const { t } = useTranslation();
  // Sort blocks by start time to display them sequentially
  const sortedBlocks = [...blocks].sort((a, b) => a.start.localeCompare(b.start));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', width: '100%' }}>
      {/* Timeline Bar */}
      <div style={{
        height: '16px',
        width: '100%',
        display: 'flex',
        borderRadius: '8px',
        overflow: 'hidden',
        border: '1px solid var(--border-color)',
        backgroundColor: 'var(--bg-input)',
        boxShadow: 'inset 0 2px 4px rgba(0, 0, 0, 0.2)'
      }}>
        {sortedBlocks.map((block, idx) => (
          <TimeBlock 
            key={`${block.start}-${idx}`}
            block={block}
            isDhw={isDhw}
            onClick={() => onBlockClick && onBlockClick(block, idx)}
          />
        ))}
        {sortedBlocks.length === 0 && (
          <div style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-muted)',
            fontSize: '0.8rem'
          }}>
            {t('schedule.no_blocks_configured')}
          </div>
        )}
      </div>

      {/* Hourly labels (0, 6, 12, 18, 24) underneath */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: '0 4px',
        fontSize: '0.65rem',
        color: 'var(--text-muted)',
        fontWeight: 500,
        letterSpacing: '0.05em'
      }}>
        <span>0:00</span>
        <span>6:00</span>
        <span>12:00</span>
        <span>18:00</span>
        <span>24:00</span>
      </div>
    </div>
  );
}
