/**
 * @file src/components/geofencing/PeopleList.jsx
 * @brief Renders the list of home members and their paired mobile device locations.
 * 
 * Displays geo-tracking statuses (HOME/AWAY), last seen check-in timestamps,
 * mobile platform parameters, and administrative controls (Make Admin, Revoke Admin, Unlink Device).
 */


import Card from '../common/Card';
import Badge from '../common/Badge';
import { useTranslation } from 'react-i18next';
import { User, Smartphone, MapPin } from 'lucide-react';

/**
 * @brief Home members list component.
 * @param {Array} props.users - List of registered home users.
 * @param {Array} props.devices - List of paired mobile devices.
 * @param {object} props.homeInfo - Active home details.
 * @param {object} props.currentUser - Active session user.
 * @param {function} props.onToggleAdminStatus - Toggle callback for user permissions.
 * @param {function} props.onDeleteUser - User deletion callback.
 * @param {function} props.onDeleteDevice - Device unlinking callback.
 */
export default function PeopleList({ 
  users = [], 
  devices = [], 
  homeInfo, 
  currentUser, 
  onToggleAdminStatus,
  onDeleteUser,
  onDeleteDevice
}) {
  const { t } = useTranslation();

  if (users.length === 0) {
    return (
      <div style={{ color: 'var(--text-secondary)', padding: '1.5rem', textAlign: 'center' }}>
        {t('geofencing.no_people_found')}
      </div>
    );
  }

  // Helper to determine user presence from SWR mobileDevices locations
  const getUserPresence = (userId) => {
    const userDevices = devices.filter(d => d.user_id === userId || d.userId === userId);
    if (userDevices.length === 0) {
      return { status: 'UNKNOWN', subtitle: t('geofencing.status.no_device_linked') };
    }

    const hasActiveTracking = userDevices.some(d => d.settings?.geoTrackingEnabled);
    if (!hasActiveTracking) {
      return { status: 'UNKNOWN', subtitle: t('geofencing.status.tracking_disabled') };
    }

    // Filter to only active devices with recent check-ins (within last 24 hours)
    const recentDevices = userDevices.filter(d => {
      if (!d.settings?.geoTrackingEnabled) return false;
      if (!d.location?.lastSeen) return false;
      const lastSeenTime = new Date(d.location.lastSeen).getTime();
      return !isNaN(lastSeenTime) && (Date.now() - lastSeenTime) < 24 * 60 * 60 * 1000;
    });

    if (recentDevices.length === 0) {
      return { status: 'UNKNOWN', subtitle: t('geofencing.status.no_recent_checkin', { defaultValue: 'No recent check-in' }) };
    }

    const atHome = recentDevices.some(d => d.location?.atHome);

    if (atHome) {
      return { status: 'HOME', subtitle: t('geofencing.status.at_home_label') };
    }

    return { status: 'AWAY', subtitle: t('geofencing.status.away_label') };
  };

  const isAdmin = homeInfo && currentUser && (homeInfo.isCurrentUserAdmin || String(currentUser.id) === String(homeInfo.adminUserId));
  const isTadoAdmin = homeInfo && currentUser && String(currentUser.id) === String(homeInfo.adminUserId);
  const isTaNoCloAdmin = isAdmin && !isTadoAdmin;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {users.map((user) => {
        const presence = getUserPresence(user.id);
        const userDevices = devices.filter(d => d.user_id === user.id || d.userId === user.id);
        const userIsTadoAdmin = homeInfo && String(user.id) === String(homeInfo.adminUserId);
        const userIsTaNoCloAdmin = user.homes?.[0]?.isTaNoCloAdmin;
        const _userIsAdmin = userIsTadoAdmin || userIsTaNoCloAdmin;

        return (
          <Card 
            key={user.id} 
            style={{ 
              padding: '1.25rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '1rem'
            }}
          >
            {/* Header info */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.5rem' }}>
              <div style={{ display: 'flex', gap: '0.85rem', alignItems: 'center' }}>
                <div style={{
                  width: '38px',
                  height: '38px',
                  borderRadius: '50%',
                  backgroundColor: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--primary)'
                }}>
                  <User size={20} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <strong style={{ fontSize: '1rem', color: 'var(--text-primary)' }}>{user.name}</strong>
                    <Badge variant={userIsTadoAdmin ? 'warning' : (userIsTaNoCloAdmin ? 'warning' : 'secondary')}>
                      {userIsTadoAdmin ? t('settings.admin_role') : (userIsTaNoCloAdmin ? 'TaNoClo Admin' : t('settings.member_role'))}
                    </Badge>
                  </div>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{user.email}</span>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {isAdmin && !userIsTadoAdmin && onToggleAdminStatus && (
                  <button
                    onClick={() => onToggleAdminStatus(user.id, !userIsTaNoCloAdmin)}
                    style={{
                      backgroundColor: userIsTaNoCloAdmin ? 'rgba(239, 68, 68, 0.1)' : 'rgba(37, 195, 136, 0.1)',
                      border: userIsTaNoCloAdmin ? '1px solid var(--danger)' : '1px solid var(--success)',
                      color: userIsTaNoCloAdmin ? 'var(--danger)' : 'var(--success)',
                      padding: '3px 8px',
                      borderRadius: '6px',
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      cursor: 'pointer',
                      transition: 'background-color 0.15s',
                      marginRight: '8px'
                    }}
                  >
                    {userIsTaNoCloAdmin ? 'Revoke Admin' : 'Make Admin'}
                  </button>
                )}
                {!userIsTadoAdmin && isAdmin && onDeleteUser && (user.id !== currentUser.id) && (
                  <button
                    onClick={() => onDeleteUser(user.username || user.email || user.id)}
                    style={{
                      backgroundColor: 'rgba(239, 68, 68, 0.1)',
                      border: '1px solid var(--danger)',
                      color: 'var(--danger)',
                      padding: '3px 8px',
                      borderRadius: '6px',
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      cursor: 'pointer',
                      transition: 'background-color 0.15s'
                    }}
                  >
                    {t('common.remove')}
                  </button>
                )}
                <Badge variant={presence.status === 'HOME' ? 'success' : 'secondary'}>
                  {presence.status === 'HOME' 
                    ? t('geofencing.people.at_home') 
                    : (presence.status === 'UNKNOWN' 
                      ? t('geofencing.people.unknown', { defaultValue: 'Unknown' }) 
                      : t('geofencing.people.away'))}
                </Badge>
              </div>
            </div>

            {/* Subtitle status summary */}
            <p style={{ fontSize: '0.825rem', color: 'var(--text-secondary)', margin: 0, display: 'flex', alignItems: 'center', gap: '4px' }}>
              <MapPin size={14} style={{ color: presence.status === 'HOME' ? 'var(--success)' : 'var(--text-muted)' }} />
              {presence.subtitle}
            </p>

            {/* Device list */}
            {userDevices.length > 0 && (
              <div style={{
                borderTop: '1px solid var(--border-color)',
                paddingTop: '0.75rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem'
              }}>
                {userDevices.map(d => {
                  const locationStale = d.location?.stale;
                  const gpsEnabled = d.settings?.geoTrackingEnabled;

                  return (
                    <div 
                      key={d.id}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.5rem',
                        backgroundColor: 'var(--bg-input)',
                        padding: '0.75rem',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border-color)'
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.85rem' }}>
                            <Smartphone size={15} style={{ color: 'var(--primary)' }} />
                            <span>{d.name || t('geofencing.device.device_fallback')}</span>
                          </div>
                          <Badge variant={gpsEnabled ? 'success' : 'secondary'} style={{ fontSize: '0.7rem', padding: '0.15rem 0.4rem' }}>
                            {gpsEnabled ? (locationStale ? t('geofencing.stale_location') : t('geofencing.active_tracking')) : t('geofencing.device.gps_off')}
                          </Badge>
                        </div>
                        {isAdmin && (!isTaNoCloAdmin || !userIsTadoAdmin) && onDeleteDevice && (
                          <button
                            onClick={() => onDeleteDevice(d.id)}
                            style={{
                              backgroundColor: 'rgba(239, 68, 68, 0.1)',
                              border: '1px solid var(--danger)',
                              color: 'var(--danger)',
                              padding: '3px 8px',
                              borderRadius: '6px',
                              fontSize: '0.75rem',
                              fontWeight: 700,
                              cursor: 'pointer',
                              whiteSpace: 'nowrap',
                              transition: 'background-color 0.15s'
                            }}
                          >
                            {t('geofencing.device.unlink')}
                          </button>
                        )}
                      </div>
                      <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                        gap: '0.4rem',
                        fontSize: '0.75rem',
                        color: 'var(--text-secondary)',
                        paddingLeft: '1.45rem'
                      }}>
                        <div><strong>{t('geofencing.device.platform', { defaultValue: 'Platform' })}:</strong> {d.deviceMetadata?.platform || 'Unknown'}</div>
                        <div><strong>{t('geofencing.device.model', { defaultValue: 'Model' })}:</strong> {d.deviceMetadata?.model || 'Unknown'}</div>
                        <div><strong>{t('geofencing.device.os_version', { defaultValue: 'OS Version' })}:</strong> {d.deviceMetadata?.osVersion || 'Unknown'}</div>
                        <div><strong>{t('geofencing.device.locale', { defaultValue: 'Locale' })}:</strong> {d.deviceMetadata?.locale || 'Unknown'}</div>
                        <div><strong>{t('geofencing.device.last_seen', { defaultValue: 'Last Seen' })}:</strong> {d.location?.lastSeen ? new Date(d.location.lastSeen).toLocaleString() : t('geofencing.device.never_seen', { defaultValue: 'Never' })}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
