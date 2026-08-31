/**
 * @file src/components/settings/ZoneSettingsSchedule.jsx
 * @brief Renders the offline schedule configuration panel for radiator valves.
 * 
 * Supports toggling offline functionality and triggering a manual sync to push timetable rules
 * into the physical device's non-volatile memory via custom local websocket server messages.
 */


import Card from '../common/Card';
import Button from '../common/Button';
import Toggle from '../common/Toggle';
import logger from '../../utils/logger';

/**
 * @brief Offline schedule controller settings sub-panel.
 * @param {boolean} props.isDhw - Whether the zone is Domestic Hot Water (excluded from offline scheduling).
 * @param {object} props.zone - Zone metadata details.
 * @param {boolean} props.offlineScheduleEnabled - Active offline schedule status.
 * @param {function} props.handleOfflineScheduleToggle - Toggle callback hook.
 * @param {boolean} props.isSaving - Active synchronization API progress.
 * @param {function} props.syncOfflineSchedule - Callback handler to push schedule rules to the physical device.
 * @param {number} props.homeId - Active home identifier.
 * @param {number} props.zoneId - Active zone identifier.
 * @param {function} props.mutateZones - SWR mutate callback to reload zones metadata.
 * @param {function} props.triggerToast - Callback function to show notification toast.
 * @param {function} props.t - Translation resolver hook.
 */
export default function ZoneSettingsSchedule({
  isDhw,
  zone,
  isReadOnly,
  offlineScheduleEnabled,
  handleOfflineScheduleToggle,
  isSaving,
  syncOfflineSchedule,
  homeId,
  zoneId,
  mutateZones,
  triggerToast,
  t
}) {
  if (isDhw || !zone?.devices?.some(d => d.deviceType?.startsWith('VA'))) {
    return null;
  }

  return (
    <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <strong>{t('schedule.offline_schedule', 'Offline Schedule')}</strong>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
            {t('schedule.offline_schedule_desc', 'Enable smart schedule functionality when the Internet Bridge goes offline.')}
          </p>
        </div>
        <Toggle checked={offlineScheduleEnabled} onChange={handleOfflineScheduleToggle} disabled={isReadOnly} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
        <div>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            {t('schedule.last_synced', 'Last Synced')}: {zone?.offlineScheduleSyncedAt ? new Date(zone.offlineScheduleSyncedAt).toLocaleString() : t('common.never', 'Never')}
          </span>
        </div>
        <Button 
          type="button" 
          variant="secondary" 
          disabled={isSaving || !offlineScheduleEnabled || isReadOnly}
          onClick={async () => {
            try {
              triggerToast(t('settings.syncing_offline_schedule'), 'success');
              await syncOfflineSchedule(homeId, zoneId);
              triggerToast(t('settings.offline_schedule_synced'), 'success');
              if (mutateZones) mutateZones();
            } catch (err) {
              logger.error(err);
              triggerToast(t('settings.failed_sync_offline_schedule'), 'error');
            }
          }}
        >
          {t('schedule.sync_now', 'Sync Now')}
        </Button>
      </div>

      <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
        <h4 style={{ fontSize: '0.85rem', fontWeight: 600, margin: '0 0 0.5rem 0' }}>Offline Schedule Explanation & Interpretation</h4>
        <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
          Offline Schedule stores a simplified daily schedule profile directly into the Smart Radiator Thermostat (SRT) flash memory.
          <br />
          • <em>How to use</em>: Enable the toggle above, then click <strong>Sync Now</strong>. The server compiles your active schedule into a hardware-compatible TLV profile and transmits it via the Bridge to the device.
          <br />
          • <em>Interpretation</em>: If your internet connection drops, the thermostat will autonomously switch temperatures at the scheduled times rather than remaining frozen at the last setpoint. Note that because of hardware memory limits, complex multi-step rules may be simplified.
        </p>
      </div>
    </Card>
  );
}
