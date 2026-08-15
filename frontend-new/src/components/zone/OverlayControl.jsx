/**
 * @file src/components/zone/OverlayControl.jsx
 * @brief Renders the overlay manual override duration selector buttons/sliders.
 * 
 * Supports applying active manual temperature overrides with dynamic termination parameters
 * (TADO_MODE, TIMER duration in minutes, or MANUAL infinite hold).
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Button from '../common/Button';
import SegmentedControl from '../common/SegmentedControl';
import Slider from '../common/Slider';
import { Calendar, Hourglass, ShieldAlert } from 'lucide-react';

/**
 * @brief Overlay control selection sub-panel.
 * @param {object} props.zone - Active zone details.
 * @param {object} props.state - Current zone state containing overlay metrics.
 * @param {function} props.onApply - Override submission event handler callback.
 * @param {function} props.onResume - Resume smart schedule event handler callback.
 */
export default function OverlayControl({ 
  zone, 
  state, 
  onApply, 
  onResume 
}) {
  const { t } = useTranslation();
  const isOverlay = !!state?.overlay;
  
  const [termType, setTermType] = useState('TADO_MODE'); // TADO_MODE, TIMER, MANUAL
  const [timerDuration, setTimerDuration] = useState(60); // minutes, default 1 hour

  const isDhw = zone?.type === 'HOT_WATER' || zone?.type === 'DHW';

  const termOptions = [
    { label: t('zone_detail.next_change'), value: 'TADO_MODE', icon: <Calendar size={14} /> },
    { label: t('zone_detail.timer'), value: 'TIMER', icon: <Hourglass size={14} /> },
    { label: t('zone_detail.infinite'), value: 'MANUAL', icon: <ShieldAlert size={14} /> }
  ];

  const handleApply = () => {
    // Construct the overlay payload matching the backend format
    const payload = {
      setting: {
        type: isDhw ? 'HOT_WATER' : 'HEATING',
        power: 'ON'
      },
      termination: {
        type: termType
      }
    };

    if (termType === 'TIMER') {
      payload.termination.durationInSeconds = timerDuration * 60;
    }

    onApply && onApply(payload);
  };

  // Convert remaining seconds to user friendly string
  const formatRemaining = (seconds) => {
    if (seconds == null) return '';
    const mins = Math.ceil(seconds / 60);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', width: '100%' }}>
      {isOverlay ? (
        // Overlay Active: Show status + Resume button
        <div style={{
          backgroundColor: 'hsla(40, 90%, 55%, 0.1)',
          border: '1px solid hsla(40, 90%, 55%, 0.25)',
          borderRadius: 'var(--radius-md)',
          padding: '1rem',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '0.75rem',
          textAlign: 'center'
        }}>
          <span style={{ fontWeight: 600, color: 'var(--warning)', fontSize: '0.95rem' }}>
            {t('zone_detail.overlay_active')}
          </span>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {state.overlay.termination?.type === 'TADO_MODE' && t('zone_detail.until_next_change')}
            {state.overlay.termination?.type === 'MANUAL' && t('zone_detail.until_resume')}
            {state.overlay.termination?.type === 'TIMER' && t('zone_detail.timer_minutes', { 
              minutes: formatRemaining(state.overlay.termination?.remainingTimeInSeconds) 
            })}
          </span>
          <Button 
            variant="secondary" 
            onClick={onResume}
            style={{ width: '100%', marginTop: '0.25rem' }}
          >
            {t('zone_detail.resume_schedule')}
          </Button>
        </div>
      ) : (
        // No Overlay: Show controls to set one
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
              {t('settings.duration_mode')}
            </span>
            <SegmentedControl 
              options={termOptions}
              value={termType}
              onChange={setTermType}
            />
          </div>

          {termType === 'TIMER' && (
            <div style={{ padding: '0 0.5rem' }}>
              <Slider 
                min={15} 
                max={360} 
                step={15} 
                value={timerDuration} 
                onChange={setTimerDuration} 
                label={t('settings.override_time')} 
                unit=" min"
              />
            </div>
          )}

          <Button 
            variant="primary" 
            onClick={handleApply}
            style={{ width: '100%', padding: '0.75rem' }}
          >
            {t('settings.apply_override')}
          </Button>
        </div>
      )}
    </div>
  );
}
