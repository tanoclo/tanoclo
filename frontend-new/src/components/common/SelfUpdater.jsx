/**
 * @file src/components/common/SelfUpdater.jsx
 * @brief Self-update OTA component mapping to Android Capacitor SelfUpdate custom plugin.
 * 
 * Periodically polls GitHub OTA repository branch manifests (`/ota/manifest.json`), compares versionCode
 * parameters, queries Android package manager install permissions (`canInstallApk`), and triggers
 * native background downloader tasks with dynamic UI progress overlays.
 */

import { useState, useEffect, useCallback } from 'react';
import { registerPlugin, Capacitor } from '@capacitor/core';
import { CapacitorUpdater } from '@capgo/capacitor-updater';
import { App as CapApp } from '@capacitor/app';
import { ArrowDownToLine, Settings as SettingsIcon, AlertCircle, X } from 'lucide-react';
import logger from '../../utils/logger';
import { useToast } from '../../context/ToastContext';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../../api/client';
import { getApiBase, STORAGE_KEYS } from '../../utils/constants';

const SelfUpdate = registerPlugin('SelfUpdate');

/**
 * @brief Helper function to trigger a manual check for updates via custom DOM event.
 * @param {boolean} manual - Whether check is user-initiated.
 * @returns {Promise<boolean>} Resolves to true if new version available, false otherwise.
 */
export function triggerCheckForUpdates(manual = true) {
  return new Promise((resolve, reject) => {
    window.dispatchEvent(new CustomEvent('tanoclo_check_for_updates', {
      detail: { manual, resolve, reject }
    }));
  });
}

/**
 * @brief SelfUpdater component rendering progress sheets and permission explanation dialogs.
 */
export default function SelfUpdater() {
  const [updateState, setUpdateState] = useState('IDLE'); // IDLE, PROMPT, PROMPT_WEB, PERMISSION_EXPLANATION, DOWNLOADING, FAILED
  const [manifest, setManifest] = useState(null);
  const [localVersion, setLocalVersion] = useState(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [isChecking, setIsChecking] = useState(false);
  const [pendingWebBundle, setPendingWebBundle] = useState(null);

  const { showToast } = useToast();
  const { t } = useTranslation();

  // Check for updates
  const checkForUpdates = useCallback(async (isManual = false) => {
    if (isChecking) return false;
    setIsChecking(true);

    try {
      if (!Capacitor.isNativePlatform()) {
        logger.debug('[SelfUpdater] Not a native platform, skipping update check');
        if (isManual) {
          showToast(t('settings.update_native_only') || 'Update check is only available on native mobile app', 'info');
        }
        return false;
      }

      if (!isManual) {
        // Check if 24 hours have passed since last check
        const lastCheck = localStorage.getItem('tanoclo_last_ota_check');
        const now = Date.now();
        const checkInterval = 24 * 60 * 60 * 1000; // 24 hours

        if (lastCheck && now - parseInt(lastCheck, 10) < checkInterval) {
          logger.debug('[SelfUpdater] Skipping update check, checked within last 24h');
          return false;
        }
      }

      logger.debug('[SelfUpdater] Checking for updates... (manual:', isManual, ')');
      localStorage.setItem('tanoclo_last_ota_check', Date.now().toString());

      // Get local native APK version info from plugin
      const localInfo = await SelfUpdate.getVersionInfo();
      setLocalVersion(localInfo);
      logger.debug('[SelfUpdater] Local native version info:', localInfo);

      // Fetch manifest from server authenticated endpoint or GitHub fallback
      let manifestData = null;
      try {
        manifestData = await apiFetch('/api/v2/ota/manifest');
      } catch (err) {
        logger.debug('[SelfUpdater] Server OTA manifest endpoint fallback to GitHub raw:', err.message);
        const manifestUrl = 'https://raw.githubusercontent.com/tanoclo/tanoclo/ota/manifest.json';
        const response = await fetch(manifestUrl, { cache: 'no-store' });
        if (response.ok) {
          manifestData = await response.json();
        }
      }

      if (!manifestData) {
        throw new Error('Failed to fetch OTA update manifest.');
      }

      setManifest(manifestData);
      logger.debug('[SelfUpdater] Remote manifest info:', manifestData);

      let hasAnyUpdate = false;
      let hadError = false;

      // 1. Web Asset OTA Update via CapGo
      const remoteWebSha = manifestData.webSha256 ? String(manifestData.webSha256).toLowerCase().trim() : null;
      const localWebSha = (localStorage.getItem('tanoclo_local_web_sha') || '').toLowerCase().trim() || null;
      
      let isWebUpdateAvailable = false;
      if (remoteWebSha && localWebSha) {
        isWebUpdateAvailable = (remoteWebSha !== localWebSha);
        logger.debug(`[SelfUpdater] Web SHA check: remote=${remoteWebSha} local=${localWebSha} -> update=${isWebUpdateAvailable}`);
      } else {
        const remoteWebCode = Number(manifestData.webVersionCode || 0);
        const localWebCode = Number(localStorage.getItem('tanoclo_local_web_version_code') || 0);
        isWebUpdateAvailable = (remoteWebCode > localWebCode);
        logger.debug(`[SelfUpdater] Web versionCode check: remote=${remoteWebCode} local=${localWebCode} -> update=${isWebUpdateAvailable}`);
      }

      if (isWebUpdateAvailable && manifestData.zipUrl) {
        hasAnyUpdate = true;
        const remoteWebCode = Number(manifestData.webVersionCode || 0);
        logger.info('[SelfUpdater] Downloading CapGo web asset update (SHA:', remoteWebSha || remoteWebCode, ')');
        try {
          const zipUrl = manifestData.zipUrl.startsWith('/') 
            ? `${getApiBase()}${manifestData.zipUrl}`
            : manifestData.zipUrl;
          const bundle = await CapacitorUpdater.download({
            url: zipUrl,
            version: remoteWebSha || manifestData.webVersionName || `web-${remoteWebCode}`,
            checksum: remoteWebSha || undefined
          });
          // Store bundle but don't apply yet — prompt user or apply on next cold start
          setPendingWebBundle({ bundle, remoteWebCode, remoteWebSha });
          setUpdateState('PROMPT_WEB');
          logger.info('[SelfUpdater] Web bundle downloaded, awaiting user confirmation to apply');
          if (isManual) {
            showToast(t('settings.update_available') || 'Web update available!', 'info');
          }
        } catch (capGoErr) {
          logger.error('[SelfUpdater] CapGo web bundle update failed:', capGoErr);
          // Download failed — don't claim we have an update, but mark error so we don't claim up-to-date
          hasAnyUpdate = false;
          hadError = true;
          if (isManual) {
            showToast(t('settings.update_check_failed') || 'Web update download failed', 'error');
          }
        }
      }

      // 2. Native APK Update via SelfUpdate plugin
      // Compare SHA-256 checksums if available; any hash difference triggers update.
      const remoteSha = manifestData.apkSha256 ? String(manifestData.apkSha256).toLowerCase().trim() : null;
      const localSha = localInfo.apkSha256 ? String(localInfo.apkSha256).toLowerCase().trim() : null;

      let isApkUpdateAvailable = false;
      if (remoteSha && localSha) {
        isApkUpdateAvailable = (remoteSha !== localSha);
        logger.debug(`[SelfUpdater] APK SHA check: remote=${remoteSha} local=${localSha} -> update=${isApkUpdateAvailable}`);
      } else {
        // Fallback to versionCode if SHA is missing from either side
        const remoteApkCode = Number(manifestData.apkVersionCode || manifestData.versionCode || 0);
        const localApkCode = Number(localInfo.versionCode || 0);
        isApkUpdateAvailable = (remoteApkCode > localApkCode);
        logger.debug(`[SelfUpdater] APK versionCode check: remote=${remoteApkCode} local=${localApkCode} -> update=${isApkUpdateAvailable}`);
      }

      if (isApkUpdateAvailable) {
        hasAnyUpdate = true;
        logger.info('[SelfUpdater] New native APK version available (SHA:', remoteSha || 'N/A', ')');
        setUpdateState('PROMPT');
        if (isManual) {
          showToast(t('settings.update_available') || 'New app version available!', 'info');
        }
        return true;
      }

      if (!hasAnyUpdate && !hadError) {
        logger.debug('[SelfUpdater] App is completely up to date');
        if (isManual) {
          showToast(t('settings.app_up_to_date') || 'TaNoClo is up to date', 'success');
        }
      }

      return hasAnyUpdate;
    } catch (err) {
      logger.error('[SelfUpdater] Failed checking for updates:', err);
      if (isManual) {
        showToast(err.message || t('settings.update_check_failed') || 'Failed to check for updates', 'error');
      }
      throw err;
    } finally {
      setIsChecking(false);
    }
  }, [isChecking, showToast, t]);

  useEffect(() => {
    const timer = setTimeout(() => {
      checkForUpdates(false);
    }, 0);
    return () => clearTimeout(timer);
  }, [checkForUpdates]);

  useEffect(() => {
    const handleCheckEvent = async (e) => {
      const isManual = e?.detail?.manual ?? true;
      const { resolve, reject } = e?.detail || {};
      try {
        const hasUpdate = await checkForUpdates(isManual);
        if (resolve) resolve(hasUpdate);
      } catch (err) {
        if (reject) reject(err);
      }
    };

    window.addEventListener('tanoclo_check_for_updates', handleCheckEvent);
    return () => {
      window.removeEventListener('tanoclo_check_for_updates', handleCheckEvent);
    };
  }, [checkForUpdates]);

  // Apply pending web bundle after user confirms
  const applyWebUpdate = async () => {
    if (!pendingWebBundle) return;
    try {
      // MUST persist version BEFORE set() — set() triggers immediate app reload
      if (pendingWebBundle.remoteWebSha) {
        localStorage.setItem('tanoclo_local_web_sha', pendingWebBundle.remoteWebSha);
      }
      localStorage.setItem('tanoclo_local_web_version_code', pendingWebBundle.remoteWebCode.toString());
      await CapacitorUpdater.set({ id: pendingWebBundle.bundle.id });
      // Lines below may never execute if set() reloads the app
      showToast(t('settings.web_ota_updated') || 'Web update applied — restarting...', 'success');
      setUpdateState('IDLE');
      setPendingWebBundle(null);
    } catch (err) {
      logger.error('[SelfUpdater] Failed to apply web bundle:', err);
      setErrorMsg(err.message || String(err));
      setUpdateState('FAILED');
    }
  };

  const startDownload = async () => {
    if (!manifest || !manifest.apkUrl) {
      setErrorMsg('No APK URL specified in the update manifest.');
      setUpdateState('FAILED');
      return;
    }

    setUpdateState('DOWNLOADING');
    setDownloadProgress(0);

    let progressListener = null;
    try {
      progressListener = await SelfUpdate.addListener('downloadProgress', (data) => {
        setDownloadProgress(data.progress || 0);
      });

      let apkUrl = manifest.apkUrl;
      const isInternalUrl = apkUrl.startsWith('/') || (getApiBase() && apkUrl.startsWith(getApiBase()));
      if (apkUrl.startsWith('/')) {
        apkUrl = `${getApiBase()}${apkUrl}`;
      }

      const headers = {};
      if (isInternalUrl) {
        const token = localStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
      }

      logger.debug('[SelfUpdater] Downloading APK from:', apkUrl);
      await SelfUpdate.downloadAndInstallApk({
        url: apkUrl,
        headers,
        expectedSha256: manifest.apkSha256 || null
      });
      setUpdateState('IDLE');
    } catch (err) {
      logger.error('[SelfUpdater] Download or installation failed:', err);
      setErrorMsg(err.message || String(err));
      setUpdateState('FAILED');
    } finally {
      if (progressListener) {
        progressListener.remove();
      }
    }
  };

  // Listen to app foregrounding to re-check permissions if in PERMISSION_EXPLANATION state
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    const handler = CapApp.addListener('appStateChange', async (state) => {
      if (state.isActive && updateState === 'PERMISSION_EXPLANATION') {
        logger.debug('[SelfUpdater] App returned to foreground, checking install permissions...');
        const { value: canInstall } = await SelfUpdate.canInstallApk();
        if (canInstall) {
          logger.debug('[SelfUpdater] Install permission granted, starting download...');
          startDownload();
        }
      }
    });

    return () => {
      handler.then(h => h.remove());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateState, manifest]);

  const handleUpgradeClick = async () => {
    try {
      const { value: canInstall } = await SelfUpdate.canInstallApk();
      if (!canInstall) {
        setUpdateState('PERMISSION_EXPLANATION');
      } else {
        startDownload();
      }
    } catch (err) {
      logger.error('[SelfUpdater] Upgrade failed to initiate:', err);
      setErrorMsg(err.message || String(err));
      setUpdateState('FAILED');
    }
  };

  const handleGrantPermission = async () => {
    try {
      await SelfUpdate.openInstallSettings();
    } catch (err) {
      logger.error('[SelfUpdater] Failed opening install settings:', err);
      setErrorMsg(err.message || String(err));
      setUpdateState('FAILED');
    }
  };


  if (updateState === 'IDLE') return null;

  // Render Overlay Modal using variables from design tokens in index.css
  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 9999,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(0, 0, 0, 0.65)',
      backdropFilter: 'blur(10px)',
      padding: '20px'
    }}>
      <div style={{
        backgroundColor: 'var(--bg-card-solid)',
        border: '1px solid var(--border-color)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--glass-shadow)',
        width: '100%',
        maxWidth: '440px',
        padding: '24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '20px',
        color: 'var(--text-primary)',
        animation: 'fadeInScale 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards'
      }}>
        {updateState === 'PROMPT' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{
                  backgroundColor: 'var(--primary-glow)',
                  color: 'var(--primary)',
                  borderRadius: '50%',
                  width: '40px',
                  height: '40px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}>
                  <ArrowDownToLine size={22} />
                </div>
                <div>
                  <h3 style={{ fontSize: '18px', fontWeight: 600 }}>{t('common.updater.update_available')}</h3>
                  <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{t('common.updater.new_version_available', 'New version available!')}</p>
                </div>
              </div>
              <button 
                onClick={() => setUpdateState('IDLE')}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  padding: '4px'
                }}
              >
                <X size={20} />
              </button>
            </div>

            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              backgroundColor: 'var(--bg-input)',
              padding: '16px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-color)'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                <span style={{ color: 'var(--text-secondary)' }}>{t('common.updater.current_version')}:</span>
                <span style={{ fontWeight: 500 }}>{localVersion?.versionName || 'Unknown'}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                <span style={{ color: 'var(--text-secondary)' }}>{t('common.updater.new_version')}:</span>
                <span style={{ color: 'var(--primary-light)', fontWeight: 600 }}>{manifest?.apkVersionName || manifest?.webVersionName || 'Unknown'}</span>
              </div>
              {manifest?.releaseNotes && (
                <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '10px', marginTop: '4px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>{t('common.updater.release_notes')}</span>
                  <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.4', whiteSpace: 'pre-wrap' }}>
                    {manifest.releaseNotes}
                  </p>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: '12px', marginTop: '4px' }}>
              <button
                onClick={() => setUpdateState('IDLE')}
                style={{
                  flex: 1,
                  padding: '12px',
                  backgroundColor: 'transparent',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-secondary)',
                  borderRadius: 'var(--radius-sm)',
                  fontWeight: 500,
                  cursor: 'pointer',
                  transition: 'background var(--transition-fast)'
                }}
              >
                {t('common.updater.later')}
              </button>
              <button
                onClick={handleUpgradeClick}
                style={{
                  flex: 2,
                  padding: '12px',
                  backgroundColor: 'var(--primary)',
                  border: 'none',
                  color: 'var(--text-on-primary)',
                  borderRadius: 'var(--radius-sm)',
                  fontWeight: 600,
                  cursor: 'pointer',
                  boxShadow: '0 4px 12px var(--primary-glow)',
                  transition: 'background var(--transition-fast)'
                }}
              >
                {t('common.updater.update_and_restart')}
              </button>
            </div>
          </>
        )}

        {updateState === 'PROMPT_WEB' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{
                  backgroundColor: 'var(--primary-glow)',
                  color: 'var(--primary)',
                  borderRadius: '50%',
                  width: '40px',
                  height: '40px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}>
                  <ArrowDownToLine size={22} />
                </div>
                <div>
                  <h3 style={{ fontSize: '18px', fontWeight: 600 }}>{t('common.updater.web_update_ready')}</h3>
                  <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{t('common.updater.web_update_subtitle')}</p>
                </div>
              </div>
              <button 
                onClick={() => { setUpdateState('IDLE'); setPendingWebBundle(null); }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  padding: '4px'
                }}
              >
                <X size={20} />
              </button>
            </div>

            <p style={{ fontSize: '14px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
              {t('common.updater.web_update_desc')}
            </p>

            <div style={{ display: 'flex', gap: '12px', marginTop: '4px' }}>
              <button
                onClick={() => { setUpdateState('IDLE'); setPendingWebBundle(null); }}
                style={{
                  flex: 1,
                  padding: '12px',
                  backgroundColor: 'transparent',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-secondary)',
                  borderRadius: 'var(--radius-sm)',
                  fontWeight: 500,
                  cursor: 'pointer',
                  transition: 'background var(--transition-fast)'
                }}
              >
                {t('common.updater.later')}
              </button>
              <button
                onClick={applyWebUpdate}
                style={{
                  flex: 2,
                  padding: '12px',
                  backgroundColor: 'var(--primary)',
                  border: 'none',
                  color: 'var(--text-on-primary)',
                  borderRadius: 'var(--radius-sm)',
                  fontWeight: 600,
                  cursor: 'pointer',
                  boxShadow: '0 4px 12px var(--primary-glow)',
                  transition: 'background var(--transition-fast)'
                }}
              >
                {t('common.updater.apply_update')}
              </button>
            </div>
          </>
        )}

        {updateState === 'PERMISSION_EXPLANATION' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div style={{
                backgroundColor: 'hsla(40, 90%, 55%, 0.15)',
                color: 'var(--warning)',
                borderRadius: '50%',
                width: '40px',
                height: '40px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
                <SettingsIcon size={22} />
              </div>
              <div>
                <h3 style={{ fontSize: '18px', fontWeight: 600 }}>{t('common.updater.permission_required')}</h3>
                <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{t('common.updater.permission_subtitle')}</p>
              </div>
            </div>

            <p style={{ fontSize: '14px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
              {t('common.updater.permission_desc')}
            </p>

            <div style={{ display: 'flex', gap: '12px', marginTop: '4px' }}>
              <button
                onClick={() => setUpdateState('PROMPT')}
                style={{
                  flex: 1,
                  padding: '12px',
                  backgroundColor: 'transparent',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-secondary)',
                  borderRadius: 'var(--radius-sm)',
                  fontWeight: 500,
                  cursor: 'pointer'
                }}
              >
                {t('common.updater.cancel')}
              </button>
              <button
                onClick={handleGrantPermission}
                style={{
                  flex: 2,
                  padding: '12px',
                  backgroundColor: 'var(--primary)',
                  border: 'none',
                  color: 'var(--text-on-primary)',
                  borderRadius: 'var(--radius-sm)',
                  fontWeight: 600,
                  cursor: 'pointer',
                  boxShadow: '0 4px 12px var(--primary-glow)'
                }}
              >
                {t('common.updater.grant_permission')}
              </button>
            </div>
          </>
        )}

        {updateState === 'DOWNLOADING' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div style={{
                backgroundColor: 'var(--primary-glow)',
                color: 'var(--primary)',
                borderRadius: '50%',
                width: '40px',
                height: '40px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                animation: 'pulse 1.5s infinite ease-in-out'
              }}>
                <ArrowDownToLine size={22} />
              </div>
              <div>
                <h3 style={{ fontSize: '18px', fontWeight: 600 }}>{t('common.updater.downloading')}</h3>
                <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{t('common.updater.downloading')}</p>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', fontWeight: 500 }}>
                <span>{t('common.updater.progress')}</span>
                <span>{downloadProgress}%</span>
              </div>
              <div style={{
                backgroundColor: 'var(--bg-input)',
                height: '8px',
                borderRadius: '4px',
                width: '100%',
                overflow: 'hidden',
                border: '1px solid var(--border-color)'
              }}>
                <div style={{
                  backgroundColor: 'var(--primary)',
                  height: '100%',
                  width: `${downloadProgress}%`,
                  transition: 'width 0.2s ease-out'
                }} />
              </div>
            </div>
          </>
        )}

        {updateState === 'FAILED' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div style={{
                backgroundColor: 'var(--danger-glow)',
                color: 'var(--danger)',
                borderRadius: '50%',
                width: '40px',
                height: '40px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
                <AlertCircle size={22} />
              </div>
              <div>
                <h3 style={{ fontSize: '18px', fontWeight: 600 }}>{t('common.updater.update_error')}</h3>
                <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{t('common.updater.update_error')}</p>
              </div>
            </div>

            <div style={{
              backgroundColor: 'hsla(0, 75%, 55%, 0.08)',
              color: 'var(--danger)',
              padding: '12px 16px',
              borderRadius: 'var(--radius-md)',
              fontSize: '13px',
              border: '1px solid hsla(0, 75%, 55%, 0.2)',
              lineHeight: '1.4'
            }}>
              {errorMsg}
            </div>

            <div style={{ display: 'flex', gap: '12px', marginTop: '4px' }}>
              <button
                onClick={() => setUpdateState('IDLE')}
                style={{
                  flex: 1,
                  padding: '12px',
                  backgroundColor: 'transparent',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-secondary)',
                  borderRadius: 'var(--radius-sm)',
                  fontWeight: 500,
                  cursor: 'pointer'
                }}
              >
                {t('common.updater.dismiss')}
              </button>
              <button
                onClick={handleUpgradeClick}
                style={{
                  flex: 2,
                  padding: '12px',
                  backgroundColor: 'var(--primary)',
                  border: 'none',
                  color: 'var(--text-on-primary)',
                  borderRadius: 'var(--radius-sm)',
                  fontWeight: 600,
                  cursor: 'pointer',
                  boxShadow: '0 4px 12px var(--primary-glow)'
                }}
              >
                {t('common.updater.retry')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
