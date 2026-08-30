/**
 * @file src/components/settings/UserSettings.jsx
 * @brief Renders the User Profile and Paired Mobile Settings cards.
 * 
 * Supports updating personal parameters (name, locale, email, password hashes), toggling app-wide themes,
 * querying native device metadata, toggling background geofencing permissions, and managing low-battery
 * push notification preferences.
 */

import { useState, useEffect, useContext } from 'react';
import Card from '../common/Card';
import Button from '../common/Button';
import Spinner from '../common/Spinner';
import { useAuth } from '../../hooks/useAuth';
import { useHome } from '../../context/HomeContext';
import { ThemeContext } from '../../context/ThemeContext';
import { apiFetch } from '../../api/client';
import { Capacitor } from '@capacitor/core';
import { updateUserProfile, updateUserEmail, updateUserPassword } from '../../api/users';
import { User, Mail, Lock, Languages, ArrowUpDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import logger from '../../utils/logger';
import { useToast } from '../../context/ToastContext';
import ReorderRooms from '../zone/ReorderRooms';

/**
 * @brief User configuration settings dashboard panel.
 */
export default function UserSettings() {
  const { user, mutateUser } = useAuth();
  const { activeHomeId } = useHome();
  const { theme, setTheme } = useContext(ThemeContext);
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();

  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  
  const [locale, setLocale] = useState(user?.locale || 'en');

  const [isSavingName, setIsSavingName] = useState(false);
  const [isSavingEmail, setIsSavingEmail] = useState(false);
  const [isSavingPassword, setIsSavingPassword] = useState(false);

  const [geoTrackingEnabled, setGeoTrackingEnabled] = useState(false);
  const [isSavingGeo, setIsSavingGeo] = useState(false);
  const [lowBatteryReminderEnabled, setLowBatteryReminderEnabled] = useState(true);
  const [isSavingLowBattery, setIsSavingLowBattery] = useState(false);
  const [hasMobileDevice, setHasMobileDevice] = useState(false);
  const [currentDeviceId, setCurrentDeviceId] = useState(null);
  const [isReorderOpen, setIsReorderOpen] = useState(false);

  useEffect(() => {
    if (user) {
      setName(prev => prev !== (user.name || '') ? (user.name || '') : prev);
      setEmail(prev => prev !== (user.email || '') ? (user.email || '') : prev);
      setLocale(prev => prev !== (user.locale || 'en') ? (user.locale || 'en') : prev);
    }
  }, [user]);

  useEffect(() => {
    let active = true;
    const loadMobileDevice = async () => {
      if (!activeHomeId) return;

      let devId = localStorage.getItem('tanoclo_mobile_device_id');
      if (!devId && user?.mobileDevices) {
        if (Capacitor.isNativePlatform()) {
          const platform = Capacitor.getPlatform();
          const device = user.mobileDevices.find(d => d.deviceMetadata?.platform === platform);
          if (device) devId = device.id;
        }
      }

      if (devId) {
        setHasMobileDevice(true);
        setCurrentDeviceId(devId);
        
        try {
          const deviceData = await apiFetch(`/api/v2/homes/${activeHomeId}/mobileDevices/${devId}`);
          if (active && deviceData) {
            setGeoTrackingEnabled(deviceData.settings?.geoTrackingEnabled ?? false);
            setLowBatteryReminderEnabled(deviceData.settings?.pushNotifications?.lowBatteryReminder ?? true);
            localStorage.setItem('tanoclo_mobile_device_id', devId);
          }
        } catch (err) {
          logger.error('[UserSettings] Failed to fetch mobile device details:', err);
        }
      }
    };

    loadMobileDevice();
    return () => { active = false; };
  }, [user, activeHomeId]);

  const handleToggleGeoTracking = async (checked) => {
    if (!currentDeviceId || !activeHomeId) return;
    setIsSavingGeo(true);
    setGeoTrackingEnabled(checked);
    try {
      await apiFetch(`/api/v2/homes/${activeHomeId}/mobileDevices/${currentDeviceId}/settings`, {
        method: 'PUT',
        body: { geoTrackingEnabled: checked }
      });
      await mutateUser();
      showToast(t('settings.geofencing_updated_success'));
    } catch (err) {
      showToast(err.message || t('settings.failed_update_geofencing'), 'error');
      setGeoTrackingEnabled(!checked);
    } finally {
      setIsSavingGeo(false);
    }
  };

  const handleToggleLowBatteryReminder = async (checked) => {
    if (!currentDeviceId || !activeHomeId) return;
    setIsSavingLowBattery(true);
    setLowBatteryReminderEnabled(checked);
    try {
      await apiFetch(`/api/v2/homes/${activeHomeId}/mobileDevices/${currentDeviceId}/settings`, {
        method: 'PUT',
        body: {
          pushNotifications: {
            lowBatteryReminder: checked
          }
        }
      });
      await mutateUser();
      showToast(t('settings.low_battery_reminder_updated_success', { defaultValue: 'Battery reminder settings updated.' }));
    } catch (err) {
      showToast(err.message || t('settings.failed_update_battery_reminder', { defaultValue: 'Failed to update battery reminder settings.' }), 'error');
      setLowBatteryReminderEnabled(!checked);
    } finally {
      setIsSavingLowBattery(false);
    }
  };

  const handleUpdateName = async (e) => {
    e.preventDefault();
    setIsSavingName(true);
    try {
      await updateUserProfile('me', { name });
      await mutateUser();
      showToast(t('settings.name_updated_success'));
    } catch (err) {
      showToast(err.message || t('settings.failed_update_name'), 'error');
    } finally {
      setIsSavingName(false);
    }
  };

  const handleUpdateEmail = async (e) => {
    e.preventDefault();
    if (!currentPassword) return;
    setIsSavingEmail(true);
    try {
      await updateUserEmail('me', email, currentPassword);
      await mutateUser();
      setCurrentPassword('');
      showToast(t('settings.email_updated_success'));
    } catch (err) {
      showToast(err.message || t('settings.failed_update_email'), 'error');
    } finally {
      setIsSavingEmail(false);
    }
  };

  const handleUpdatePassword = async (e) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      showToast(t('settings.passwords_do_not_match'), 'error');
      return;
    }
    setIsSavingPassword(true);
    try {
      await updateUserPassword('me', newPassword, currentPassword);
      setNewPassword('');
      setConfirmPassword('');
      setCurrentPassword('');
      showToast(t('settings.password_changed_success'));
    } catch (err) {
      showToast(err.message || t('settings.failed_change_password'), 'error');
    } finally {
      setIsSavingPassword(false);
    }
  };

  const handleLanguageChange = async (lang) => {
    setLocale(lang);
    try {
      await updateUserProfile('me', { locale: lang });
      // Apply the language change in i18next
      i18n.changeLanguage(lang);

      // Sync active language to mobile device metadata if registered
      if (currentDeviceId) {
        try {
          let platform = 'Android';
          if (Capacitor.isNativePlatform()) {
            platform = Capacitor.getPlatform() === 'ios' ? 'iOS' : 'Android';
          }
          await apiFetch(`/api/v2/homes/${activeHomeId}/mobileDevices/${currentDeviceId}/metadata`, {
            method: 'PUT',
            body: {
              device: {
                platform,
                locale: lang
              }
            }
          });
        } catch (deviceErr) {
          logger.error('[UserSettings] Failed to update device locale metadata:', deviceErr);
        }
      }

      // Wait for user re-fetching
      await mutateUser();
      showToast(t('settings.language_updated_success'));
    } catch (err) {
      logger.error('Failed to change language:', err);
    }
  };

  if (!user) {
    return (
      <Card style={{ padding: '2rem', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        <Spinner size={32} />
      </Card>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%', maxWidth: '800px' }}>
      <div style={{ minHeight: '42px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, lineHeight: 1.2 }}>{t('settings.account')}</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
          {t('settings.account_desc')}
        </p>
      </div>

      {/* Profile Name */}
      <Card style={{ padding: '1.25rem' }}>
        <form onSubmit={handleUpdateName} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
            <User size={16} color="var(--primary)" />
            {t('settings.profile_details')}
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.full_name')}</label>
            <input 
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
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
          <Button type="submit" variant="primary" disabled={isSavingName} style={{ alignSelf: 'flex-end' }}>
            {isSavingName ? t('settings.saving') : t('settings.save_name')}
          </Button>
        </form>
      </Card>

      {/* Language Preferences */}
      <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Languages size={16} color="var(--secondary)" />
          {t('settings.language_settings')}
        </h3>
        <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
          {t('settings.choose_language')}
        </p>
        <select
          value={locale}
          onChange={(e) => handleLanguageChange(e.target.value)}
          style={{
            backgroundColor: 'var(--bg-input)',
            border: '1px solid var(--border-color)',
            color: 'var(--text-primary)',
            padding: '0.5rem',
            borderRadius: 'var(--radius-sm)',
            outline: 'none',
            fontWeight: 600,
            cursor: 'pointer'
          }}
        >
          <option value="en">{t('settings.lang_en')}</option>
          <option value="de">{t('settings.lang_de')}</option>
          <option value="nl">{t('settings.lang_nl')}</option>
          <option value="fr">{t('settings.lang_fr')}</option>
          <option value="es">{t('settings.lang_es')}</option>
          <option value="it">{t('settings.lang_it')}</option>
        </select>
      </Card>

      {/* Theme Preferences */}
      <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ display: 'inline-flex', width: '16px', height: '16px', alignItems: 'center', justifyContent: 'center', color: 'var(--primary)', fontSize: '1rem' }}>🌓</span>
          {t('settings.theme_settings', { defaultValue: 'Theme Settings' })}
        </h3>
        <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
          {t('settings.choose_theme', { defaultValue: 'Choose your preferred color theme.' })}
        </p>
        <select
          value={theme}
          onChange={(e) => setTheme(e.target.value)}
          style={{
            backgroundColor: 'var(--bg-input)',
            border: '1px solid var(--border-color)',
            color: 'var(--text-primary)',
            padding: '0.5rem',
            borderRadius: 'var(--radius-sm)',
            outline: 'none',
            fontWeight: 600,
            cursor: 'pointer'
          }}
        >
          <option value="system">{t('settings.theme_system', { defaultValue: 'System (Follow Device)' })}</option>
          <option value="dark">{t('settings.theme_dark', { defaultValue: 'Dark' })}</option>
          <option value="light">{t('settings.theme_light', { defaultValue: 'Light' })}</option>
        </select>
      </Card>

      {/* Zone Display Order */}
      <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
          <ArrowUpDown size={16} color="var(--primary)" />
          {t('dashboard.zones.reorder', { defaultValue: 'Reorder Zones' })}
        </h3>
        <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
          {t('settings.reorder_zones_desc', { defaultValue: 'Customize the display order of rooms and zones on your dashboard for this account.' })}
        </p>
        <Button 
          variant="secondary" 
          onClick={() => setIsReorderOpen(true)}
          style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: '6px', padding: '0.5rem 1rem' }}
        >
          <ArrowUpDown size={14} />
          <span>{t('dashboard.zones.reorder', { defaultValue: 'Reorder Zones' })}</span>
        </Button>
      </Card>

      {/* Mobile Geofencing */}
      {hasMobileDevice && (
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ display: 'inline-flex', color: 'var(--primary)' }}>🧭</span>
            {t('geofencing.title')}
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, paddingRight: '1rem' }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>{t('settings.enable_geofencing', { defaultValue: 'Enable Geofencing' })}</span>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                {t('settings.enable_geofencing_desc', { defaultValue: 'Allow this device to report its location to determine if you are home or away.' })}
              </span>
            </div>
            <label style={{
              position: 'relative',
              display: 'inline-block',
              width: '46px',
              height: '24px',
              flexShrink: 0,
              cursor: isSavingGeo ? 'not-allowed' : 'pointer',
              opacity: isSavingGeo ? 0.6 : 1
            }}>
              <input
                type="checkbox"
                checked={geoTrackingEnabled}
                disabled={isSavingGeo}
                onChange={(e) => handleToggleGeoTracking(e.target.checked)}
                style={{ opacity: 0, width: 0, height: 0 }}
              />
              <span style={{
                position: 'absolute',
                top: 0, left: 0, right: 0, bottom: 0,
                backgroundColor: geoTrackingEnabled ? 'var(--primary)' : 'var(--border-color)',
                transition: 'background-color 0.2s',
                borderRadius: '24px'
              }}>
                <span style={{
                  position: 'absolute',
                  content: '""',
                  height: '18px',
                  width: '18px',
                  left: geoTrackingEnabled ? '24px' : '3px',
                  bottom: '3px',
                  backgroundColor: '#ffffff',
                  transition: 'left 0.2s',
                  borderRadius: '50%',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.4)'
                }} />
              </span>
            </label>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid var(--border-color)', paddingTop: '1rem', marginTop: '0.5rem' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, paddingRight: '1rem' }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>{t('settings.enable_low_battery_notifications', { defaultValue: 'Low Battery Notifications' })}</span>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                {t('settings.enable_low_battery_notifications_desc', { defaultValue: 'Get notified when device batteries are running low or depleted.' })}
              </span>
            </div>
            <label style={{
              position: 'relative',
              display: 'inline-block',
              width: '46px',
              height: '24px',
              flexShrink: 0,
              cursor: isSavingLowBattery ? 'not-allowed' : 'pointer',
              opacity: isSavingLowBattery ? 0.6 : 1
            }}>
              <input
                type="checkbox"
                checked={lowBatteryReminderEnabled}
                disabled={isSavingLowBattery}
                onChange={(e) => handleToggleLowBatteryReminder(e.target.checked)}
                style={{ opacity: 0, width: 0, height: 0 }}
              />
              <span style={{
                position: 'absolute',
                top: 0, left: 0, right: 0, bottom: 0,
                backgroundColor: lowBatteryReminderEnabled ? 'var(--primary)' : 'var(--border-color)',
                transition: 'background-color 0.2s',
                borderRadius: '24px'
              }}>
                <span style={{
                  position: 'absolute',
                  content: '""',
                  height: '18px',
                  width: '18px',
                  left: lowBatteryReminderEnabled ? '24px' : '3px',
                  bottom: '3px',
                  backgroundColor: '#ffffff',
                  transition: 'left 0.2s',
                  borderRadius: '50%',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.4)'
                }} />
              </span>
            </label>
          </div>
        </Card>
      )}

      {/* Email Update */}
      <Card style={{ padding: '1.25rem' }}>
        <form onSubmit={handleUpdateEmail} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Mail size={16} color="var(--warning)" />
            {t('settings.change_email')}
          </h3>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.new_email')}</label>
            <input 
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.5rem 0.75rem',
                borderRadius: 'var(--radius-sm)',
                outline: 'none'
              }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.current_password_verify')}</label>
            <input 
              type="password"
              placeholder={t('settings.confirm_password_placeholder')}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.5rem 0.75rem',
                borderRadius: 'var(--radius-sm)',
                outline: 'none'
              }}
            />
          </div>

          <Button type="submit" variant="primary" disabled={isSavingEmail} style={{ alignSelf: 'flex-end' }}>
            {isSavingEmail ? t('settings.saving') : t('settings.update_email')}
          </Button>
        </form>
      </Card>

      {/* Password Update */}
      <Card style={{ padding: '1.25rem' }}>
        <form onSubmit={handleUpdatePassword} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Lock size={16} color="var(--danger)" />
            {t('settings.change_password')}
          </h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.current_password')}</label>
            <input 
              type="password"
              placeholder={t('settings.confirm_password_placeholder')}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.5rem 0.75rem',
                borderRadius: 'var(--radius-sm)',
                outline: 'none'
              }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.new_password')}</label>
            <input 
              type="password"
              placeholder={t('settings.new_password_placeholder')}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.5rem 0.75rem',
                borderRadius: 'var(--radius-sm)',
                outline: 'none'
              }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.confirm_new_password')}</label>
            <input 
              type="password"
              placeholder={t('settings.confirm_password_placeholder_repeat')}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.5rem 0.75rem',
                borderRadius: 'var(--radius-sm)',
                outline: 'none'
              }}
            />
          </div>

          <Button type="submit" variant="primary" disabled={isSavingPassword} style={{ alignSelf: 'flex-end' }}>
            {isSavingPassword ? t('settings.saving') : t('settings.change_password')}
          </Button>
        </form>
      </Card>

      {/* Room Reordering Modal */}
      <ReorderRooms 
        isOpen={isReorderOpen}
        onClose={() => setIsReorderOpen(false)}
      />

    </div>
  );
}
