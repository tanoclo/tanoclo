/**
 * @file src/pages/SettingsPage.jsx
 * @brief Renders the application settings dashboard.
 * 
 * Implements a split two-column layout on desktop and single list navigation on mobile devices.
 * Coordinates subsections including Home Settings, Zone Configuration, Physical Device pairing,
 * User access control panels (PeopleSettings), smart schedule layouts, and energy history charts.
 */

import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import useSWR, { mutate } from 'swr';
import PeopleSettings from './settings/PeopleSettings';
import EnergySettings from './settings/EnergySettings';
import AppShell from '../components/layout/AppShell';
import Card from '../components/common/Card';
import ListItem from '../components/common/ListItem';
import Button from '../components/common/Button';
import Spinner from '../components/common/Spinner';
import Modal from '../components/common/Modal';
import ConfirmModal from '../components/common/ConfirmModal';
import SettingsMenu, { getSettingsMenuItems } from '../components/settings/SettingsMenu';
import HomeSettings from '../components/settings/HomeSettings';
import ZoneSettings from '../components/settings/ZoneSettings';
import DeviceSettings from '../components/settings/DeviceSettings';
import ScheduleSettings from '../components/settings/ScheduleSettings';
import ServerSettingsPanel from './settings/ServerSettingsPanel';
import { useHome } from '../context/HomeContext';
import { SWR_KEYS } from '../utils/swrKeys';
import { useAuth } from '../hooks/useAuth';
import { createZone } from '../api/zones';
import { getDevices, createDevice } from '../api/devices';
import { deleteUserFromHome } from '../api/homes';
import { deleteMobileDevice } from '../api/users';
import { useToast } from '../context/ToastContext';
import { Shield } from 'lucide-react';

const MemoizedPeopleSettings = React.memo(PeopleSettings);
const MemoizedEnergySettings = React.memo(EnergySettings);
const MemoizedHomeSettings = React.memo(HomeSettings);
const MemoizedZoneSettings = React.memo(ZoneSettings);
const MemoizedDeviceSettings = React.memo(DeviceSettings);
const MemoizedScheduleSettings = React.memo(ScheduleSettings);

/**
 * @brief Renders settings sections, validation boundaries, and create/delete modals.
 */
export default function SettingsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const { activeHomeId, zones, mutateZones, homeInfo, mutateHomeInfo, isLoading: isHomeLoading } = useHome();
  const isReadOnly = (homeInfo?.configReadonly ?? homeInfo?.zoneConfigReadonly) && !homeInfo?.devBypass;
  const { showToast } = useToast();

  const [isMobile, setIsMobile] = useState(false);

  // Parse navigation state from URL Search Params
  const activeSection = searchParams.get('section') || (isMobile ? null : 'zones');
  const activeRoomId = searchParams.get('roomId') ? parseInt(searchParams.get('roomId'), 10) : null;
  const activeDeviceId = searchParams.get('deviceId') || null;
  const scheduleZoneId = searchParams.get('scheduleZoneId') ? parseInt(searchParams.get('scheduleZoneId'), 10) : null;

  const handleBack = () => {
    if (searchParams.get('advanced')) {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete('advanced');
      setSearchParams(nextParams);
    } else if (searchParams.get('roomId') || searchParams.get('deviceId') || searchParams.get('scheduleZoneId')) {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete('roomId');
      nextParams.delete('deviceId');
      nextParams.delete('scheduleZoneId');
      nextParams.delete('advanced');
      setSearchParams(nextParams);
    } else if (searchParams.get('section')) {
      if (isMobile) {
        setSearchParams({});
      } else {
        navigate('/');
      }
    } else {
      navigate('/');
    }
  };

  const triggerToast = (msg, type = 'success') => {
    showToast(msg, type);
  };

  const [isConfirmUserOpen, setIsConfirmUserOpen] = useState(false);
  const [userToDelete, setUserToDelete] = useState('');
  const [isConfirmDeviceOpen, setIsConfirmDeviceOpen] = useState(false);
  const [deviceToDelete, setDeviceToDelete] = useState('');

  // Create zone states
  const [isCreateZoneOpen, setIsCreateZoneOpen] = useState(false);
  const [newZoneName, setNewZoneName] = useState('');
  const [isCreatingZone, setIsCreatingZone] = useState(false);

  // Add device states
  const [isAddDeviceOpen, setIsAddDeviceOpen] = useState(false);
  const [newDeviceSerial, setNewDeviceSerial] = useState('');
  const [isAddingDevice, setIsAddingDevice] = useState(false);

  // Fetch devices list SWR
  const { data: devices, mutate: mutateDevices } = useSWR(
    activeHomeId ? SWR_KEYS.devices(activeHomeId) : null,
    () => getDevices(activeHomeId)
  );

  const handleDeleteUser = (username) => {
    setUserToDelete(username);
    setIsConfirmUserOpen(true);
  };

  const handleConfirmDeleteUser = async () => {
    setIsConfirmUserOpen(false);
    try {
      await deleteUserFromHome(activeHomeId, userToDelete);
      mutate(SWR_KEYS.users(activeHomeId));
      triggerToast(t('settings.user_removed_success'));
    } catch (err) {
      triggerToast(err.message || t('settings.failed_remove_user'), 'error');
    }
  };

  const handleDeleteMobileDevice = (deviceId) => {
    setDeviceToDelete(deviceId);
    setIsConfirmDeviceOpen(true);
  };

  const handleConfirmDeleteDevice = async () => {
    setIsConfirmDeviceOpen(false);
    try {
      await deleteMobileDevice(activeHomeId, deviceToDelete);
      mutate(`/api/v2/homes/${activeHomeId}/mobileDevices`);
      triggerToast(t('settings.device_removed_success'));
    } catch (err) {
      triggerToast(err.message || t('settings.failed_remove_device'), 'error');
    }
  };

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handleSelectSection = (sectionId) => {
    const nextParams = new URLSearchParams();
    nextParams.set('section', sectionId);
    setSearchParams(nextParams);
  };

  const handleCreateZone = async (e) => {
    e.preventDefault();
    if (!newZoneName) return;

    const heatingRoomsCount = (zones || []).filter(z => z.type === 'HEATING').length;
    if (heatingRoomsCount >= 25) {
      triggerToast(t('settings.error_max_rooms_reached'), 'error');
      return;
    }

    setIsCreatingZone(true);
    try {
      await createZone(activeHomeId, { name: newZoneName, type: 'HEATING' });
      await mutateZones();
      setNewZoneName('');
      setIsCreateZoneOpen(false);
      triggerToast(t('settings.create_zone_success'));
    } catch (err) {
      triggerToast(err.message || t('settings.failed_create_zone'), 'error');
    } finally {
      setIsCreatingZone(false);
    }
  };

  const handleAddDevice = async (e) => {
    e.preventDefault();
    if (!newDeviceSerial) return;

    const upperSerial = newDeviceSerial.toUpperCase();
    const match = /^(RU)(\d{10})$/.exec(upperSerial);
    if (!match || Number(match[2]) > 4294967295) {
      triggerToast(t('settings.invalid_serial_format'), 'error');
      return;
    }

    const prefix = match[1];
    let derivedType = 'VA02';
    if (prefix === 'VA') derivedType = 'VA02';
    else if (['RU', 'WR', 'SU', 'BP', 'BR'].includes(prefix)) derivedType = 'RU02';
    else if (prefix === 'IB') derivedType = 'IB01';
    else if (prefix === 'BU') derivedType = 'BU01';

    const isBridge = prefix === 'IB';
    const heatingDevicesCount = (devices || []).filter(d => !d.deviceType?.startsWith('IB') && !d.deviceType?.startsWith('GW') && d.deviceType !== 'BRIDGE').length;
    if (!isBridge && heatingDevicesCount >= 25) {
      triggerToast(t('settings.error_max_devices_reached'), 'error');
      return;
    }

    setIsAddingDevice(true);
    try {
      await createDevice(activeHomeId, {
        serialNo: upperSerial,
        deviceType: derivedType
      });
      await Promise.all([
        mutateDevices(),
        mutateZones()
      ]);
      setNewDeviceSerial('');
      setIsAddDeviceOpen(false);
      triggerToast(t('settings.device_added_success'));
    } catch (err) {
      triggerToast(err.message || t('settings.failed_add_device'), 'error');
    } finally {
      setIsAddingDevice(false);
    }
  };

  // Loading indicator
  if (isHomeLoading || !user) {
    return (
      <AppShell title={t('common.loading')}>
        <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
          <Spinner size={32} />
        </div>
      </AppShell>
    );
  }

  // Permission boundary check
  const isAdmin = homeInfo && user && (homeInfo.isCurrentUserAdmin || String(user.id) === String(homeInfo.adminUserId));
  if (homeInfo && user && !isAdmin) {
    return (
      <AppShell title={t('settings.access_restricted')}>
        <div className="page-container" style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '60vh',
          textAlign: 'center',
          gap: '1.5rem',
          maxWidth: '500px',
          margin: '0 auto',
          padding: '2rem'
        }}>
          <div style={{
            width: '80px',
            height: '80px',
            borderRadius: '50%',
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            border: '2px dashed var(--danger)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--danger)',
            marginBottom: '0.5rem'
          }}>
            <Shield size={40} />
          </div>
          <h1 style={{ fontSize: '2.0rem', fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>
            {t('settings.access_restricted')}
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '1rem', lineHeight: 1.5, margin: 0 }}>
            {t('settings.access_restricted_desc')}
          </p>
          <Button variant="secondary" onClick={() => navigate('/')} style={{ marginTop: '1rem' }}>
            {t('common.back')}
          </Button>
        </div>
      </AppShell>
    );
  }

  // Render Sub-view Contents
  const renderContent = () => {
    // sub-pages for specific rooms or devices
    if (activeRoomId !== null && activeRoomId !== undefined) {
      const targetZone = zones?.find(z => z.id === activeRoomId);
      return (
        <MemoizedZoneSettings
          homeId={activeHomeId}
          zoneId={activeRoomId}
          zone={targetZone}
          onBack={handleBack}
          mutateZones={mutateZones}
          onNavigateToDevice={(serial) => {
            const nextParams = new URLSearchParams();
            nextParams.set('section', 'devices');
            nextParams.set('deviceId', serial);
            setSearchParams(nextParams);
          }}
        />
      );
    }

    if (activeDeviceId) {
      return (
        <MemoizedDeviceSettings
          homeId={activeHomeId}
          deviceId={activeDeviceId}
          onBack={handleBack}
          mutateDevices={mutateDevices}
        />
      );
    }

    // Main Sections
    switch (activeSection) {
      case 'home-details':
        return (
          <MemoizedHomeSettings
            homeId={activeHomeId}
            homeInfo={homeInfo}
            mutateHomeInfo={mutateHomeInfo}
          />
        );

      case 'zones':
      case 'devices':
      case 'flow-temp':
      case 'boiler-circuits':
      case 'raw-explorer':
        return (
          <ServerSettingsPanel
            activeSection={activeSection}
            activeHomeId={activeHomeId}
            zones={zones}
            devices={devices}
            searchParams={searchParams}
            setSearchParams={setSearchParams}
            setIsAddDeviceOpen={setIsAddDeviceOpen}
            isReadOnly={isReadOnly}
            t={t}
          />
        );

      case 'people':
        return (
          <MemoizedPeopleSettings
            homeId={activeHomeId}
            isAdmin={homeInfo?.admin_user_id === user?.id || user?.is_tanoclo_admin === 1}
            homeInfo={homeInfo}
            mutateHomeInfo={mutateHomeInfo}
            onDeleteUser={handleDeleteUser}
            onDeleteDevice={handleDeleteMobileDevice}
          />
        );


      case 'smart-schedule':
        return (
          <MemoizedScheduleSettings
            zones={zones}
            scheduleZoneId={scheduleZoneId}
            handleBack={handleBack}
            searchParams={searchParams}
            setSearchParams={setSearchParams}
            t={t}
          />
        );

      case 'heating-activity':
        return (
          <MemoizedEnergySettings
            homeId={activeHomeId}
            zones={zones}
          />
        );

      default:
        return <div>{t('settings.select_section_prompt')}</div>;
    }
  };

  const renderModals = () => {
    return (
      <>
        {/* Create Zone Modal */}
        <Modal isOpen={isCreateZoneOpen} onClose={() => setIsCreateZoneOpen(false)} title={t('settings.create_zone_title')}>
          <form onSubmit={handleCreateZone} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0 }}>
              {t('settings.create_zone_desc')}
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.zone_name')}</label>
              <input
                type="text"
                placeholder={t('settings.zone_name_placeholder')}
                value={newZoneName}
                onChange={(e) => setNewZoneName(e.target.value)}
                required
                style={{
                  backgroundColor: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)',
                  padding: '0.5rem 0.75rem',
                  borderRadius: 'var(--radius-sm)',
                  outline: 'none',
                  fontWeight: 600
                }}
              />
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
              <Button type="button" variant="secondary" onClick={() => setIsCreateZoneOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" variant="primary" disabled={isCreatingZone}>
                <span>{isCreatingZone ? (t('settings.creating')) : (t('common.create'))}</span>
              </Button>
            </div>
          </form>
        </Modal>

        {/* Add Device Modal */}
        <Modal isOpen={isAddDeviceOpen} onClose={() => setIsAddDeviceOpen(false)} title={t('settings.register_device_title')}>
          <form onSubmit={handleAddDevice} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0 }}>
              {t('settings.register_device_desc')}
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.serial_number')}</label>
              <input
                type="text"
                placeholder={t('settings.serial_placeholder')}
                value={newDeviceSerial}
                onChange={(e) => setNewDeviceSerial(e.target.value.toUpperCase())}
                required
                style={{
                  backgroundColor: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)',
                  padding: '0.5rem 0.75rem',
                  borderRadius: 'var(--radius-sm)',
                  outline: 'none',
                  fontWeight: 600
                }}
              />
            </div>

            {/* Hardware Type is auto-deduced from serial */}

            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
              <Button type="button" variant="secondary" onClick={() => setIsAddDeviceOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" variant="primary" disabled={isAddingDevice}>
                <span>{isAddingDevice ? (t('settings.registering')) : (t('settings.register'))}</span>
              </Button>
            </div>
          </form>
        </Modal>

        {/* User Delete Confirmation */}
        <ConfirmModal
          isOpen={isConfirmUserOpen}
          onClose={() => setIsConfirmUserOpen(false)}
          onConfirm={handleConfirmDeleteUser}
          title={t('settings.remove_user_title')}
          message={t('settings.confirm_remove_user', { username: userToDelete })}
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          variant="destructive"
        />

        {/* Device Delete Confirmation */}
        <ConfirmModal
          isOpen={isConfirmDeviceOpen}
          onClose={() => setIsConfirmDeviceOpen(false)}
          onConfirm={handleConfirmDeleteDevice}
          title={t('settings.remove_device_title')}
          message={t('settings.confirm_remove_device')}
          confirmText={t('settings.remove_device_action')}
          cancelText={t('common.cancel')}
          variant="destructive"
        />
      </>
    );
  };

  // 1. Mobile Settings Overview Page
  if (isMobile && activeSection === null) {
    const menuItems = getSettingsMenuItems(t);
    return (
      <AppShell title={t('nav.settings')}>
        <div className="page-container" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            {menuItems.map(item => (
              <ListItem
                key={item.id}
                icon={item.icon}
                title={item.label}
                subtitle={item.subtitle}
                onClick={() => handleSelectSection(item.id)}
              />
            ))}
          </Card>
          <footer style={{
            marginTop: 'auto',
            paddingTop: '1.5rem',
            textAlign: 'center',
            fontSize: '0.65rem',
            color: 'var(--text-muted)',
            lineHeight: '1.4',
            borderTop: '1px solid var(--border-color)',
            width: '100%'
          }}>
            {t('common.disclaimer')}
          </footer>
          {renderModals()}
        </div>
      </AppShell>
    );
  }

  const getMobileTitle = () => {
    const isAdvanced = searchParams.get('advanced') === 'true';
    if (activeRoomId !== null) {
      const z = zones?.find(item => item.id === activeRoomId);
      return z ? (isAdvanced ? `Advanced • ${z.name}` : z.name) : t('nav.settings');
    }
    if (activeDeviceId) {
      const d = devices?.find(item => item.serialNo === activeDeviceId);
      return d ? (isAdvanced ? `Advanced • ${d.friendlyName || d.serialNo}` : (d.friendlyName || d.serialNo)) : t('nav.settings');
    }
    if (scheduleZoneId !== null) {
      const z = zones?.find(item => item.id === scheduleZoneId);
      return z ? `${z.name} ${t('schedule.title')}` : t('schedule.title');
    }
    const item = getSettingsMenuItems(t).find(i => i.id === activeSection);
    return item ? item.label : t('nav.settings');
  };

  // 2. Mobile Tab View Page (Full Screen with Back Button)
  if (isMobile && activeSection !== null) {
    return (
      <AppShell title={getMobileTitle()} showBack={true} onBack={handleBack}>
        <div className="page-container" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {renderContent()}
          <footer style={{
            marginTop: 'auto',
            paddingTop: '1.5rem',
            textAlign: 'center',
            fontSize: '0.65rem',
            color: 'var(--text-muted)',
            lineHeight: '1.4',
            borderTop: '1px solid var(--border-color)',
            width: '100%'
          }}>
            {t('common.disclaimer')}
          </footer>
          {renderModals()}
        </div>
      </AppShell>
    );
  }

  // 3. Desktop Settings Page (Two Column Split Layout)
  return (
    <AppShell title={t('nav.settings')}>
      <div className="page-container" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', height: '100%' }}>
        <div style={{ display: 'flex', gap: '2rem', flex: 1, alignItems: 'flex-start' }}>
          {/* Sidebar */}
          <SettingsMenu
            activeSection={activeSection}
            onSelect={handleSelectSection}
          />

          {/* Main workspace */}
          <div style={{ flex: 1, paddingLeft: '0.5rem', minWidth: 0 }}>
            {renderContent()}
          </div>
        </div>
        <footer style={{
          marginTop: 'auto',
          paddingTop: '1.5rem',
          textAlign: 'center',
          fontSize: '0.65rem',
          color: 'var(--text-muted)',
          lineHeight: '1.4',
          borderTop: '1px solid var(--border-color)',
          width: '100%'
        }}>
          {t('common.disclaimer')}
        </footer>
        {renderModals()}
      </div>
    </AppShell>
  );
}
