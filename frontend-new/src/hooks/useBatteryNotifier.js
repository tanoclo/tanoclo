/**
 * @file src/hooks/useBatteryNotifier.js
 * @brief Custom hook managing hardware low battery alert notifications.
 * 
 * Fetches battery telemetry for all linked smart home devices (radiators, bridges, valves)
 * and schedules native LocalNotifications (or fallback standard Web Notifications)
 * when a low battery state transition is detected. Prevents duplicate notifications
 * using localStorage state tracking.
 */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { apiFetch } from '../api/client';
import { getDeviceBatteryData } from '../api/tanoclo';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { SWR_KEYS } from '../utils/swrKeys';
import logger from '../utils/logger';

/**
 * @brief Custom hook to monitor battery states and issue push/native notifications.
 * @param {string} mobileDeviceId - Current active registered mobile device.
 * @param {string} activeHomeId - Target home identifier.
 * @param {boolean} isAuthenticated - Current authentication status.
 */
export function useBatteryNotifier(mobileDeviceId, activeHomeId, isAuthenticated) {
  const { t } = useTranslation();
  
  // 1. Fetch current mobile device settings (to check lowBatteryReminder configuration)
  const { data: deviceData } = useSWR(
    isAuthenticated && activeHomeId && mobileDeviceId 
      ? SWR_KEYS.mobileDevice(activeHomeId, mobileDeviceId) 
      : null,
    () => apiFetch(`/api/v2/homes/${activeHomeId}/mobileDevices/${mobileDeviceId}`),
    { refreshInterval: 60000 }
  );

  const isEnabled = deviceData?.settings?.pushNotifications?.lowBatteryReminder ?? true;

  // 2. Fetch device battery data (poll every 5 minutes)
  const { data: batteryDevices } = useSWR(
    isAuthenticated && activeHomeId ? SWR_KEYS.batteryDevices(activeHomeId) : null,
    () => getDeviceBatteryData(activeHomeId),
    { refreshInterval: 300000, revalidateOnFocus: true }
  );

  useEffect(() => {
    if (!isAuthenticated || !activeHomeId || !batteryDevices || !isEnabled) return;

    // Load previously notified states from localStorage to persist across app restarts
    let notifiedStates = {};
    try {
      const stored = localStorage.getItem('tanoclo_notified_battery_states');
      if (stored) notifiedStates = JSON.parse(stored);
    } catch (e) {
      logger.warn('Failed to parse notified battery states:', e);
    }

    let stateChanged = false;

    for (const d of batteryDevices) {
      const serial = d.serial_no;
      const state = d.battery_state || 'NORMAL';
      const label = d.friendly_name || serial;

      // Detect state transition to LOW, CRITICAL, or DEPLETED
      const isNewLowOrDepleted = (state === 'LOW' || state === 'CRITICAL' || state === 'DEPLETED');
      const oldState = notifiedStates[serial] || 'NORMAL';

      if (isNewLowOrDepleted && oldState !== state) {
        const isDepleted = state === 'CRITICAL' || state === 'DEPLETED';
        const title = isDepleted ? t('battery.depleted_title', 'Battery Depleted!') : t('battery.low_title', 'Low Battery!');
        const body = isDepleted 
          ? t('battery.depleted_body', { device: label, defaultValue: `Battery critical/depleted for ${label}. Please replace immediately.` })
          : t('battery.low_body', { device: label, defaultValue: `Low battery for ${label}. Please replace soon.` });

        logger.debug(`[useBatteryNotifier] Triggering notification for ${serial}: ${oldState} -> ${state}`);

        if (Capacitor.isNativePlatform()) {
          // Native mobile local notification scheduler
          (async () => {
            try {
              const perm = await LocalNotifications.checkPermissions();
              if (perm.display !== 'granted') {
                await LocalNotifications.requestPermissions();
              }
              const updatedPerm = await LocalNotifications.checkPermissions();
              if (updatedPerm.display === 'granted') {
                await LocalNotifications.schedule({
                  notifications: [
                    {
                      title,
                      body,
                      id: Math.floor(Math.random() * 1000000),
                      schedule: { at: new Date(Date.now() + 1000) }
                    }
                  ]
                });
              }
            } catch (err) {
              logger.error('[useBatteryNotifier] Native notification failed:', err);
            }
          })();
        } else {
          // Standard Web Notifications API fallback for testing on browser
          if ('Notification' in window) {
            if (Notification.permission === 'granted') {
              new Notification(title, { body });
            } else if (Notification.permission !== 'denied') {
              Notification.requestPermission().then(permission => {
                if (permission === 'granted') {
                  new Notification(title, { body });
                }
              });
            }
          }
        }
        
        notifiedStates[serial] = state;
        stateChanged = true;
      } else if (!isNewLowOrDepleted && oldState !== 'NORMAL') {
        // Reset state tracker if battery is replaced and goes back to NORMAL/GOOD
        notifiedStates[serial] = 'NORMAL';
        stateChanged = true;
      }
    }

    if (stateChanged) {
      localStorage.setItem('tanoclo_notified_battery_states', JSON.stringify(notifiedStates));
    }
  }, [isAuthenticated, activeHomeId, batteryDevices, isEnabled, t]);
}
