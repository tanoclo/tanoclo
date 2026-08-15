/**
 * @file src/components/settings/ScheduleSettings.jsx
 * @brief Renders the Zone Schedule picker list and wraps ScheduleEditor.
 */


import { ArrowLeft, Calendar } from 'lucide-react';
import Button from '../common/Button';
import Card from '../common/Card';
import ListItem from '../common/ListItem';
import ScheduleEditor from '../schedule/ScheduleEditor';

/**
 * @brief Schedule settings list/detail wrapper panel.
 * @param {Array} props.zones - List of home zones (rooms).
 * @param {number} props.scheduleZoneId - Active selected zone ID for schedule editing.
 * @param {function} props.handleBack - Navigation back action callback.
 * @param {URLSearchParams} props.searchParams - Active URL search params object.
 * @param {function} props.setSearchParams - React Router set query params dispatcher.
 * @param {function} props.t - Translation mapping resolver hook.
 */
export default function ScheduleSettings({
  zones,
  scheduleZoneId,
  handleBack,
  searchParams,
  setSearchParams,
  t
}) {
  if (scheduleZoneId !== null && scheduleZoneId !== undefined) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%', maxWidth: '800px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minHeight: '42px' }}>
          <Button variant="secondary" onClick={handleBack} style={{ width: '32px', height: '32px', padding: 0, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <ArrowLeft size={16} />
          </Button>
          <div>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, lineHeight: 1.2 }}>
              {zones?.find(z => z.id === scheduleZoneId)?.name} {t('schedule.title')}
            </h2>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'block' }}>
              {t('settings.configure_timetable_desc')}
            </span>
          </div>
        </div>
        <ScheduleEditor zoneId={scheduleZoneId} />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%', maxWidth: '800px' }}>
      <div style={{ minHeight: '42px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, lineHeight: 1.2 }}>{t('schedule.title')}</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
          {t('settings.select_zone_schedule')}
        </p>
      </div>

      <Card style={{ padding: 0, overflow: 'hidden' }}>
        {zones?.map(zone => (
          <ListItem
            key={zone.id}
            icon={<Calendar size={18} style={{ color: 'var(--primary)' }} />}
            title={zone.name}
            subtitle={t('settings.configure_timetable_desc')}
            onClick={() => {
              const nextParams = new URLSearchParams(searchParams);
              nextParams.set('scheduleZoneId', zone.id);
              setSearchParams(nextParams);
            }}
          />
        ))}
      </Card>
    </div>
  );
}
