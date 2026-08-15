/**
 * @file src/pages/DeviceRegistrationPage.jsx
 * @brief Renders device registration portal requested on first native launch.
 * 
 * Intercepts user navigation to home if no `mobileDeviceId` is present in local cache.
 * Collects physical device configurations, browser capabilities, platform tags,
 * and posts this metadata to backend API to establish low battery alerts and geofencing endpoints.
 * Supports replacing an existing registered device profile to prevent orphan sessions.
 */

import { useState, useEffect } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useHome } from '../context/HomeContext';
import { apiFetch } from '../api/client';
import { useTranslation } from 'react-i18next';
import { Smartphone, RefreshCw } from 'lucide-react';
import { Device } from '@capacitor/device';
import logger from '../utils/logger';

/**
 * @brief Form page forcing registration of current native device on backend server.
 * @param {function} props.onRegister - Callback notifying main layout of completed registration.
 */
export default function DeviceRegistrationPage({ onRegister }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { activeHomeId } = useHome();
  
  const [deviceName, setDeviceName] = useState(() => localStorage.getItem('tanoclo_last_device_name') || '');
  const [isRegistering, setIsRegistering] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [existingDevices, setExistingDevices] = useState([]);
  const [selectedDeviceIdToReplace, setSelectedDeviceIdToReplace] = useState(null);

  // Default name to "{user name} Mobile" when user is loaded and no saved name
  useEffect(() => {
    if (user) {
      const defaultName = `${user.name || 'My'} Mobile`;
      setDeviceName(prev => prev ? prev : defaultName);
    }
  }, [user]);

  // Fetch list of mobile devices to check for name collisions / replacement
  useEffect(() => {
    let active = true;
    const fetchDevices = async () => {
      try {
        const devices = await apiFetch(`/api/v2/homes/${activeHomeId}/mobileDevices`);
        if (active) {
          setExistingDevices(devices || []);
        }
      } catch (err) {
        logger.error('[DeviceRegistration] Failed to fetch existing devices:', err);
      }
    };
    fetchDevices();
    return () => { active = false; };
  }, [activeHomeId]);

  /**
   * @brief Queries hardware specifications and registers device inside active home settings.
   */
  const handleRegister = async (e) => {
    e.preventDefault();
    if (!deviceName.trim()) {
      setErrorMsg(t('device_registration.error_empty_name'));
      return;
    }

    setIsRegistering(true);
    setErrorMsg('');

    try {
      let platform = 'Android';
      let osVersion = 'Unknown';
      let model = 'Unknown';
      let locale = 'en';

      try {
        const info = await Device.getInfo();
        const lang = await Device.getLanguageCode();
        platform = info.platform === 'ios' ? 'iOS' : (info.platform === 'android' ? 'Android' : info.platform);
        osVersion = info.osVersion || 'Unknown';
        model = info.model || 'Unknown';
        locale = lang.value ? lang.value.split('-')[0] : 'en';
      } catch (deviceErr) {
        logger.warn('[DeviceRegistration] Failed to get device metadata:', deviceErr);
      }

      // Delete selected device to replace, or search by name match
      let deviceDeleted = false;
      if (selectedDeviceIdToReplace) {
        logger.debug(`[DeviceRegistration] Replacing selected device ID: ${selectedDeviceIdToReplace}. Deleting old entry...`);
        try {
          await apiFetch(`/api/v2/homes/${activeHomeId}/mobileDevices/${selectedDeviceIdToReplace}`, {
            method: 'DELETE'
          });
          deviceDeleted = true;
        } catch (deleteErr) {
          logger.error('[DeviceRegistration] Failed to delete selected device:', deleteErr);
        }
      }

      if (!deviceDeleted) {
        const devices = await apiFetch(`/api/v2/homes/${activeHomeId}/mobileDevices`);
        const existingMatch = devices.find(d => d.name && d.name.toLowerCase() === deviceName.trim().toLowerCase());
        if (existingMatch) {
          logger.debug(`[DeviceRegistration] Overwriting existing device "${deviceName}" (ID: ${existingMatch.id}). Reusing existing ID.`);
        }
      }

      logger.debug('[DeviceRegistration] Registering mobile device...');
      const currentDevice = await apiFetch(`/api/v2/homes/${activeHomeId}/mobileDevices`, {
        method: 'POST',
        body: {
          name: deviceName.trim(),
          settings: { geoTrackingEnabled: true },
          metadata: {
            device: {
              platform,
              osVersion,
              model,
              locale
            }
          }
        }
      });

      const newId = currentDevice.id;
      localStorage.setItem('tanoclo_mobile_device_id', newId);
      localStorage.setItem('tanoclo_last_device_name', deviceName.trim());
      
      // Notify parent app
      onRegister(newId);
    } catch (err) {
      logger.error('[DeviceRegistration] Registration failed:', err);
      setErrorMsg(err.message || 'Failed to register device.');
    } finally {
      setIsRegistering(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'var(--bg-app)',
      padding: '1.5rem',
      fontFamily: 'Inter, system-ui, sans-serif'
    }}>
      <div style={{
        width: '100%',
        maxWidth: '420px',
        backgroundColor: 'var(--bg-card)',
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--border-color)',
        padding: '2.5rem',
        boxShadow: '0 20px 40px rgba(0, 0, 0, 0.3)',
        textAlign: 'center',
        position: 'relative',
        overflow: 'hidden'
      }}>
        {/* Glow effect */}
        <div style={{
          position: 'absolute',
          top: '-50%',
          left: '-50%',
          width: '200%',
          height: '200%',
          background: 'radial-gradient(circle, rgba(var(--primary-rgb), 0.08) 0%, transparent 70%)',
          pointerEvents: 'none'
        }} />

        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '56px',
          height: '56px',
          borderRadius: '16px',
          background: 'linear-gradient(135deg, rgba(var(--primary-rgb), 0.2) 0%, rgba(var(--primary-rgb), 0.05) 100%)',
          border: '1px solid var(--primary)',
          color: 'var(--primary)',
          marginBottom: '1.5rem'
        }}>
          <Smartphone size={28} />
        </div>

        <h1 style={{
          fontSize: '1.75rem',
          fontWeight: 800,
          margin: '0 0 0.75rem 0',
          color: 'var(--text-primary)',
          letterSpacing: '-0.5px'
        }}>
          {t('device_registration.title')}
        </h1>

        <p style={{
          fontSize: '0.9rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.5,
          margin: '0 0 2rem 0'
        }}>
          {t('device_registration.desc')}
        </p>

        <form onSubmit={handleRegister} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', textAlign: 'left' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
              {t('device_registration.device_name')}
            </label>
            <input 
              type="text"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              placeholder={t('device_registration.placeholder')}
              required
              style={{
                width: '100%',
                padding: '0.75rem 1rem',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-color)',
                background: 'var(--bg-input)',
                color: 'var(--text-primary)',
                fontSize: '0.95rem',
                outline: 'none',
                transition: 'border-color var(--transition-fast)'
              }}
              disabled={isRegistering}
            />
          </div>

          {existingDevices.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
                {t('device_registration.replace_existing', { defaultValue: 'Or Replace an Existing Device:' })}
              </label>
              <select
                value={selectedDeviceIdToReplace || ''}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val) {
                    const devId = parseInt(val, 10);
                    setSelectedDeviceIdToReplace(devId);
                    const matched = existingDevices.find(d => d.id === devId);
                    if (matched) {
                      setDeviceName(matched.name);
                    }
                  } else {
                    setSelectedDeviceIdToReplace(null);
                  }
                }}
                style={{
                  width: '100%',
                  padding: '0.75rem 1rem',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border-color)',
                  background: 'var(--bg-input)',
                  color: 'var(--text-primary)',
                  fontSize: '0.95rem',
                  outline: 'none',
                  transition: 'border-color var(--transition-fast)'
                }}
              >
                <option value="">-- {t('device_registration.new_device_option', { defaultValue: 'Register as new device' })} --</option>
                {existingDevices.map(d => (
                  <option key={d.id} value={d.id}>{d.name} ({d.deviceMetadata?.platform || 'Unknown'})</option>
                ))}
              </select>
            </div>
          )}

          {errorMsg && (
            <div style={{
              fontSize: '0.85rem',
              color: 'var(--danger)',
              backgroundColor: 'rgba(239, 68, 68, 0.08)',
              border: '1px solid rgba(239, 68, 68, 0.15)',
              padding: '0.75rem',
              borderRadius: 'var(--radius-md)',
              lineHeight: 1.4
            }}>
              {errorMsg}
            </div>
          )}

          <button 
            type="submit"
            disabled={isRegistering}
            style={{
              width: '100%',
              padding: '0.875rem',
              borderRadius: 'var(--radius-md)',
              border: 'none',
              background: 'linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%)',
              color: 'white',
              fontWeight: 600,
              fontSize: '0.95rem',
              cursor: isRegistering ? 'not-allowed' : 'pointer',
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              marginTop: '0.5rem'
            }}
          >
            {isRegistering ? (
              <>
                <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite' }} />
                <span>{t('device_registration.registering')}</span>
              </>
            ) : (
              <span>{t('device_registration.register_action')}</span>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
