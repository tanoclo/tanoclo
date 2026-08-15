/**
 * @file src/components/zone/ZoneDetailControls.jsx
 * @brief Renders the timeline overlays controls panel inside ZoneDetail.
 */


import { RotateCcw, Clock } from 'lucide-react';

/**
 * @brief Overlay controls sub-panel.
 * @param {boolean} props.isOverlay - Whether there is currently an active manual override overlay.
 * @param {boolean} props.isPreviewMode - Whether dial stepper has local preview settings not yet saved.
 * @param {string} props.termType - Active override type ('TADO_MODE', 'TIMER', 'MANUAL').
 * @param {number} props.durationInMinutes - Active timer duration in minutes.
 * @param {number} props.countdownSeconds - Active timer remaining countdown ticks in seconds.
 * @param {object} props.state - Current zone state details.
 * @param {function} props.t - Translation resolver hook.
 * @param {function} props.handleResumeSchedule - Resume schedule action click callback.
 * @param {function} props.onTermTypeChange - Selection type change callback.
 * @param {function} props.onDurationChange - TIMER duration select picker change callback.
 * @param {function} props.formatAbsoluteTime - Date format utility mapping string stamps.
 * @param {function} props.getTimerEndTime - Expiry end time resolver helper.
 * @param {function} props.formatCountdown - Seconds-to-duration text mapping helper.
 */
export default function ZoneDetailControls({
  isOverlay,
  isPreviewMode,
  termType,
  durationInMinutes,
  countdownSeconds,
  state,
  t,
  handleResumeSchedule,
  onTermTypeChange,
  onDurationChange,
  formatAbsoluteTime,
  getTimerEndTime,
  formatCountdown
}) {
  if (!isOverlay && !isPreviewMode) {
    const isAway = state?.tadoMode === 'AWAY';
    return (
      <div style={{
        border: '1px solid rgba(255, 255, 255, 0.25)',
        backgroundColor: 'rgba(255, 255, 255, 0.15)',
        padding: '0.75rem 1rem',
        borderRadius: '16px',
        width: '100%',
        textAlign: 'center',
        fontSize: '0.85rem',
        fontWeight: 600
      }}>
        <span>{isAway ? (t('zone_detail.following_away_setting') || 'Following Away Setting') : t('zone_detail.following_schedule')}</span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
      {/* Resume Schedule Button */}
      <button 
        onClick={handleResumeSchedule}
        style={{
          backgroundColor: '#ffffff',
          border: 'none',
          color: '#ff5d00',
          padding: '0.6rem 1.25rem',
          borderRadius: '24px',
          fontSize: '0.85rem',
          fontWeight: 700,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
          marginBottom: '1rem',
          transition: 'transform 0.1s'
        }}
        onMouseDown={(e) => e.currentTarget.style.transform = 'scale(0.96)'}
        onMouseUp={(e) => e.currentTarget.style.transform = 'scale(1)'}
      >
        <RotateCcw size={14} />
        {t('zone_detail.resume_schedule')}
      </button>

      {/* Duration/Termination Mode Tabs */}
      <div style={{
        display: 'flex',
        backgroundColor: 'rgba(255, 255, 255, 0.1)',
        padding: '4px',
        borderRadius: '12px',
        width: '100%',
        marginBottom: '0.75rem',
        border: '1px solid rgba(255, 255, 255, 0.1)'
      }}>
        {[
          { id: 'TADO_MODE', label: t('zone_detail.next_change') || 'Next Change' },
          { id: 'TIMER', label: t('zone_detail.timer') || 'Timer' },
          { id: 'MANUAL', label: t('zone_detail.infinite') || 'Infinite' }
        ].map(tab => {
          const active = termType === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => onTermTypeChange(tab.id)}
              style={{
                flex: 1,
                padding: '0.45rem 0.25rem',
                border: 'none',
                backgroundColor: active ? 'rgba(255, 255, 255, 0.2)' : 'transparent',
                color: '#ffffff',
                borderRadius: '8px',
                fontSize: '0.75rem',
                fontWeight: 700,
                cursor: 'pointer',
                transition: 'all 0.15s ease'
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Inline Timer Duration Selector if TIMER is selected */}
      {termType === 'TIMER' && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          backgroundColor: 'rgba(255, 255, 255, 0.1)',
          padding: '0.6rem 1rem',
          borderRadius: '12px',
          marginBottom: '0.75rem',
          gap: '1rem'
        }}>
          <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'rgba(255, 255, 255, 0.8)' }}>
            {t('zone_detail.duration') || 'Duration'}:
          </span>
          <select
            value={durationInMinutes}
            onChange={(e) => onDurationChange(parseInt(e.target.value))}
            style={{
              backgroundColor: '#1f2937',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              color: '#ffffff',
              padding: '0.35rem 0.5rem',
              borderRadius: '8px',
              fontSize: '0.8rem',
              fontWeight: 600,
              outline: 'none',
              cursor: 'pointer'
            }}
          >
            {[15, 30, 45, 60, 90, 120, 180, 240, 300, 360, 480, 720].map(m => (
              <option key={m} value={m}>
                {m < 60 ? `${m}m` : `${m/60}h`}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Remaining time / countdown info */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        backgroundColor: 'rgba(255, 255, 255, 0.1)',
        padding: '0.6rem 1rem',
        borderRadius: '12px',
        gap: '10px'
      }}>
        <Clock size={16} style={{ opacity: 0.8 }} />
        <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#ffffff' }}>
          {termType === 'TADO_MODE' && t('zone_detail.until_next_time_block', { time: formatAbsoluteTime(state?.nextScheduleChange?.start) })}
          {termType === 'MANUAL' && t('zone_detail.until_resume')}
          {termType === 'TIMER' && t('zone_detail.until_time', { time: getTimerEndTime(state?.overlay?.termination?.expiry) })}
          {termType !== 'MANUAL' && countdownSeconds > 0 && ` (${formatCountdown(countdownSeconds)})`}
        </span>
      </div>
    </div>
  );
}
