/**
 * @file src/pages/AccountPage.jsx
 * @brief User Account settings and session management page.
 * 
 * Embeds the UserSettings form to update passwords and emails, and renders session actions
 * such as signing out and switching target server URLs (exclusive to native builds).
 */


import { useState, useEffect } from 'react';
import AppShell from '../components/layout/AppShell';
import Card from '../components/common/Card';
import Button from '../components/common/Button';
import UserSettings from '../components/settings/UserSettings';
import { useAuth } from '../hooks/useAuth';
import { useTranslation } from 'react-i18next';
import { LogOut, Globe, RefreshCw } from 'lucide-react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import packageJson from '../../package.json';
import { triggerCheckForUpdates } from '../components/common/SelfUpdater';
import { apiFetch } from '../api/client';
import logger from '../utils/logger';

/**
 * @brief Renders user profile management form, signout triggers, server configurations, and manual update checks.
 */
export default function AccountPage() {
  const { logout, _user } = useAuth();
  const { t } = useTranslation();
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [serverVersion, setServerVersion] = useState(null);
  const [apkVersion, setApkVersion] = useState(null);
  const [webVersionName, setWebVersionName] = useState(null);

  const isNative = Capacitor.isNativePlatform();
  const hasCustomServer = !!localStorage.getItem('tanoclo_server_url');

  const localWebCode = localStorage.getItem('tanoclo_local_web_version_code');

  useEffect(() => {
    // Fetch server version from authenticated health endpoint
    apiFetch('/api/health')
      .then(data => { if (data?.version) setServerVersion(data.version); })
      .catch(() => { });

    // Fetch web version from OTA manifest (actual deployed version)
    apiFetch('/api/v2/ota/manifest')
      .then(data => { if (data?.webVersionName) setWebVersionName(data.webVersionName); })
      .catch(() => { });

    // Fetch APK version on native platforms
    if (isNative) {
      try {
        const SelfUpdate = registerPlugin('SelfUpdate');
        SelfUpdate.getVersionInfo()
          .then(info => { if (info?.versionName) setApkVersion(info.versionName); })
          .catch(() => { });
      } catch (_e) { /* plugin not available */ }
    }
  }, [isNative]);

  /**
   * @brief Logs out user and deletes the local server URL configuration to allow re-config.
   */
  const handleChangeServer = () => {
    logout();
    localStorage.removeItem('tanoclo_server_url');
    window.location.reload();
  };

  /**
   * @brief Triggers manual check for remote OTA APK updates against GitHub manifest.
   */
  const handleCheckUpdates = async () => {
    setIsCheckingUpdates(true);
    try {
      await triggerCheckForUpdates(true);
    } catch (err) {
      logger.error('[AccountPage] Failed manual update check:', err);
    } finally {
      setIsCheckingUpdates(false);
    }
  };

  return (
    <AppShell title={t('settings.account')}>
      <div className="page-container" style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '1.5rem',
        maxWidth: '600px',
        margin: '0 auto'
      }}>

        {/* Main account settings form */}
        <UserSettings />

        {/* Action Panel for signout/server switch/update checks */}
        <Card style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.5rem' }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: '0 0 0.5rem 0', color: 'var(--text-primary)' }}>
            {t('settings.session_connection')}
          </h3>

          {isNative && (
            <Button
              variant="secondary"
              onClick={handleCheckUpdates}
              disabled={isCheckingUpdates}
              style={{ width: '100%', padding: '0.875rem' }}
            >
              <RefreshCw size={18} style={{ animation: isCheckingUpdates ? 'spin 1s linear infinite' : 'none' }} />
              <span>{isCheckingUpdates ? t('settings.checking_updates') : t('settings.check_for_updates')}</span>
            </Button>
          )}

          <Button
            variant="destructive"
            onClick={logout}
            style={{ width: '100%', padding: '0.875rem' }}
          >
            <LogOut size={18} />
            <span>{t('auth.logout')}</span>
          </Button>

          {(isNative || hasCustomServer) && (
            <Button
              variant="secondary"
              onClick={handleChangeServer}
              style={{ width: '100%', padding: '0.875rem', marginTop: '0.25rem' }}
            >
              <Globe size={18} />
              <span>{t('settings.change_server')}</span>
            </Button>
          )}
        </Card>

        <div style={{
          textAlign: 'center',
          color: 'var(--text-muted)',
          fontSize: '0.75rem',
          marginTop: '1.5rem',
          paddingBottom: '2rem',
          lineHeight: '1.8'
        }}>
          <p style={{ marginBottom: '0.5rem' }}>{t('settings.tanoclo_branding')}</p>
          {isNative && apkVersion && (
            <p>APK: v{apkVersion}</p>
          )}
          <p>Web: v{webVersionName || packageJson.version || '?'}{localWebCode ? ` (build ${localWebCode})` : ''}</p>
          {serverVersion && (
            <p>Server: v{serverVersion}</p>
          )}
        </div>
      </div>
    </AppShell>
  );
}
