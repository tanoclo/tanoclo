/**
 * @file src/pages/settings/PeopleSettings.jsx
 * @brief People and mobile devices manager panel in Home Settings.
 * 
 * Supports sending membership invites via email, toggling administrator privileges,
 * and deleting user memberships or old device profiles from the active home.
 */

import { useState } from 'react';
import useSWR from 'swr';
import { useTranslation } from 'react-i18next';
import Card from '../../components/common/Card';
import Button from '../../components/common/Button';
import Spinner from '../../components/common/Spinner';
import PeopleList from '../../components/geofencing/PeopleList';
import { getHomeUsers, inviteUserToHome, toggleUserAdminStatus } from '../../api/homes';
import { getMobileDevices } from '../../api/users';
import { useAuth } from '../../hooks/useAuth';
import logger from '../../utils/logger';
import { useToast } from '../../context/ToastContext';
import { SWR_KEYS } from '../../utils/swrKeys';

/**
 * @brief Renders the People management settings view.
 * @param {string} props.homeId - Target home identifier.
 * @param {boolean} props.isAdmin - Whether the current user is an admin.
 * @param {object} props.homeInfo - Active home metadata info.
 * @param {function} props.mutateHomeInfo - Refresh function for home metadata.
 * @param {function} props.onDeleteUser - Event hook to trigger user removal confirm modal.
 * @param {function} props.onDeleteDevice - Event hook to trigger device removal confirm modal.
 */
export default function PeopleSettings({ homeId, isAdmin, homeInfo, mutateHomeInfo, onDeleteUser, onDeleteDevice }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { user } = useAuth();
  const [inviteEmail, setInviteEmail] = useState('');
  const [isInviting, setIsInviting] = useState(false);

  const { data: mobileDevices, mutate: _mutateMobileDevices } = useSWR(
    homeId ? SWR_KEYS.mobileDevices(homeId) : null,
    () => getMobileDevices(homeId)
  );

  const { data: homeUsers, mutate: mutateHomeUsers } = useSWR(
    homeId ? SWR_KEYS.users(homeId) : null,
    () => getHomeUsers(homeId)
  );

  const handleInviteUser = async (e) => {
    e.preventDefault();
    if (!inviteEmail) return;
    setIsInviting(true);
    try {
      await inviteUserToHome(homeId, inviteEmail);
      await mutateHomeUsers();
      setInviteEmail('');
      showToast(t('settings.invite_sent_success'));
    } catch (err) {
      showToast(err.message || t('settings.failed_send_invite'), 'error');
    } finally {
      setIsInviting(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%', maxWidth: '800px' }}>
      <div style={{ minHeight: '42px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, lineHeight: 1.2 }}>{t('settings.people')}</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
          {t('settings.manage_people_desc')}
        </p>
      </div>

      <Card style={{ padding: '1.25rem' }}>
        <h3 style={{ margin: '0 0 1rem 0', fontSize: '1rem', fontWeight: 600 }}>{t('settings.invite_new_user')}</h3>
        <form onSubmit={handleInviteUser} style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <input
            type="email"
            placeholder="name@example.com"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            required
            style={{
              flex: '1 1 200px',
              backgroundColor: 'var(--bg-input)',
              border: '1px solid var(--border-color)',
              color: 'var(--text-primary)',
              padding: '0.5rem 0.75rem',
              borderRadius: 'var(--radius-sm)',
              outline: 'none',
              fontSize: '0.9rem',
              minWidth: '200px',
              boxSizing: 'border-box'
            }}
          />
          <Button type="submit" variant="primary" disabled={isInviting || !isAdmin} style={{ padding: '0.5rem 1rem', flex: '0 0 auto', minWidth: '80px' }}>
            {isInviting ? t('settings.saving') : t('settings.invite')}
          </Button>
        </form>
      </Card>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>{t('settings.home_members')}</h3>
        {!homeUsers || !mobileDevices ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '1.5rem' }}>
            <Spinner size={20} />
          </div>
        ) : (
          <PeopleList
            users={homeUsers}
            devices={mobileDevices}
            homeInfo={homeInfo}
            currentUser={user}
            onToggleAdminStatus={async (targetUserId, makeAdmin) => {
              try {
                await toggleUserAdminStatus(homeId, targetUserId, makeAdmin);
                await mutateHomeInfo();
                await mutateHomeUsers();
              } catch (e) {
                logger.error('Failed to toggle admin status:', e);
              }
            }}
            onDeleteUser={onDeleteUser}
            onDeleteDevice={onDeleteDevice}
          />
        )}
      </div>
    </div>
  );
}
