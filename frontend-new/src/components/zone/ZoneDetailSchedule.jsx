/**
 * @file src/components/zone/ZoneDetailSchedule.jsx
 * @brief Renders the quick redirects and toggles for smart schedules and telemetry charts inside ZoneDetail.
 */


import { Calendar, BarChart3 } from 'lucide-react';

/**
 * @brief Zone detail schedule and telemetry navigation links sub-panel.
 * @param {boolean} props.isAdmin - Whether the user has admin credentials.
 * @param {object} props.zone - Active zone details.
 * @param {boolean} props.showTelemetry - Whether the historical chart segment is visible.
 * @param {function} props.toggleTelemetry - Telemetry view toggle callback hook.
 * @param {function} props.onClose - Sidebar close callback hook.
 * @param {function} props.navigate - Router navigation dispatcher hook.
 * @param {function} props.t - Translation resolver hook.
 */
export default function ZoneDetailSchedule({ isAdmin, zone, showTelemetry, toggleTelemetry, onClose, navigate, t }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'center',
      gap: '1rem',
      width: '100%',
      marginBottom: '1rem',
      padding: '0.6rem 0',
      borderTop: '1px solid rgba(255, 255, 255, 0.15)',
      borderBottom: '1px solid rgba(255, 255, 255, 0.15)'
    }}>
      {isAdmin && (
        <button 
          onClick={() => {
            onClose();
            navigate(`/settings?section=smart-schedule&scheduleZoneId=${zone.id}`);
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: '#ffffff',
            fontSize: '0.8rem',
            fontWeight: 700,
            outline: 'none'
          }}
        >
          <Calendar size={16} />
          <span>{t('zone_detail.smart_schedule') || 'Smart Schedule'}</span>
        </button>
      )}
      
      {isAdmin && <div style={{ width: '1px', backgroundColor: 'rgba(255, 255, 255, 0.2)' }} />}

      <button 
        onClick={toggleTelemetry}
        style={{ 
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: showTelemetry ? '#ffca28' : '#ffffff',
          fontSize: '0.8rem',
          fontWeight: 700,
          outline: 'none'
        }}
        title={t('zone_detail.toggle_telemetry')}
      >
        <BarChart3 size={16} />
        <span>{showTelemetry ? t('zone_detail.hide_charts') || 'Hide Charts' : t('zone_detail.show_charts') || 'Show Charts'}</span>
      </button>
    </div>
  );
}
