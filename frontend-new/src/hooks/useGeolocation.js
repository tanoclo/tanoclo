/**
 * @file src/hooks/useGeolocation.js
 * @brief Custom hook managing background native geofencing and device location synchronization.
 * 
 * Configures the `@capgo/background-geolocation` native module on Android/iOS.
 * Sets up a geofence around the home coordinates (retrieved from HomeContext),
 * registers a background webhook URL to deliver transition events (ENTER/EXIT)
 * directly to the backend API, and registers active JS-level listeners to sync events
 * when the app is in the foreground.
 */

import { useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { BackgroundGeolocation } from '@capgo/background-geolocation';
import { useAuth } from './useAuth';
import { useHome } from '../context/HomeContext';
import { apiFetch } from '../api/client';
import { getApiBase } from '../utils/constants';
import logger from '../utils/logger';

/**
 * @brief Custom hook to initialize background geofencing tracking on mobile devices.
 * @param {string} mobileDeviceId - Current active registered mobile device.
 * @param {function} setMobileDeviceId - State setter to clear device ID if deleted on server.
 */
export function useGeolocation(mobileDeviceId, setMobileDeviceId) {
  const { isAuthenticated, user } = useAuth();
  const { activeHomeId, homeInfo } = useHome();
  
  // Keep handles to background listeners so we can unregister them on cleanup
  const listenerRef = useRef(null);
  const errorListenerRef = useRef(null);
  const geofenceIdRef = useRef(null);

  // Extract home coordinates and boundaries
  const homeLat = homeInfo?.geolocation?.latitude;
  const homeLon = homeInfo?.geolocation?.longitude;
  const awayRadius = homeInfo?.awayRadiusInMeters;

  // Track coordinates in a mutable reference to avoid re-triggering the main effect on coordinate adjustments
  const homeCoordsRef = useRef({ homeLat, homeLon, awayRadius });
  useEffect(() => {
    homeCoordsRef.current = { homeLat, homeLon, awayRadius };
  }, [homeLat, homeLon, awayRadius]);

  useEffect(() => {
    if (!isAuthenticated || !activeHomeId || !user?.id || !mobileDeviceId) return;

    // Background tracking only runs on native mobile platforms (Android/iOS)
    if (!Capacitor.isNativePlatform()) {
      logger.debug('[useGeolocation] Not native platform. Skipping geofencing.');
      return;
    }

    let active = true;
    let appStateListener = null;
    let checkinInterval = null;

    const performCheckin = async () => {
      try {
        logger.debug(`[useGeolocation] Performing check-in for device: ${mobileDeviceId}`);
        await apiFetch(`/api/v2/homes/${activeHomeId}/mobileDevices/${mobileDeviceId}/geolocation`, {
          method: 'POST',
          body: { checkin: true }
        });
        logger.debug('[useGeolocation] Check-in completed successfully.');
      } catch (err) {
        logger.error('[useGeolocation] Failed to perform check-in:', err);
      }
    };

    const setupGeofencing = async () => {
      try {
        // 1. Validate device still exists on server
        let currentDevice = null;
        try {
          currentDevice = await apiFetch(`/api/v2/homes/${activeHomeId}/mobileDevices/${mobileDeviceId}`);
        } catch (_e) {
          if (!active) return;
          logger.debug('[useGeolocation] Device not found on server, clearing.');
          localStorage.removeItem('tanoclo_mobile_device_id');
          if (setMobileDeviceId) setMobileDeviceId(null);
          return;
        }

        if (!active) return;
        logger.debug(`[useGeolocation] Device loaded. ID: ${mobileDeviceId}`);

        // 2. Check if geofencing is enabled on server
        if (currentDevice.settings?.geoTrackingEnabled === false) {
          logger.debug('[useGeolocation] Geofencing disabled in settings. Skipping.');
          return;
        }

        // Perform initial check-in on startup/load
        await performCheckin();

        // Listen for app state changes to check in when app resumes
        if (Capacitor.isNativePlatform()) {
          appStateListener = CapApp.addListener('appStateChange', async (state) => {
            if (state.isActive) {
              logger.debug('[useGeolocation] App resumed. Performing check-in.');
              await performCheckin();
            }
          });
        }

        // Setup a periodic check-in timer every 4 hours while the app is active
        checkinInterval = setInterval(async () => {
          logger.debug('[useGeolocation] Periodic 4-hour check-in.');
          await performCheckin();
        }, 4 * 60 * 60 * 1000);

        // 3. Need home coordinates to set up geofence
        const { homeLat: lat, homeLon: lon, awayRadius: rad } = homeCoordsRef.current;
        if (!lat || !lon) {
          logger.warn('[useGeolocation] No home coordinates available. Cannot set up geofence.');
          return;
        }

        // 4. Build webhook URL for native background POST delivery
        // Native layer can't send custom auth headers, so we pass the token in the payload
        const serverUrl = getApiBase() || window.location.origin;
        const geofencingToken = currentDevice.geofencingAccessToken;

        if (!geofencingToken) {
          logger.warn('[useGeolocation] No geofencing token available. Webhook delivery disabled.');
        }

        const webhookUrl = geofencingToken
          ? `${serverUrl}/api/v2/homes/${activeHomeId}/mobileDevices/${mobileDeviceId}/geofenceWebhook`
          : undefined;

        // 4.5 Handle permissions explicitly based on latest platform requirements
        try {
          const permissions = await BackgroundGeolocation.checkPermissions();
          logger.debug('[useGeolocation] Current permission status:', permissions);

          const isAndroid = Capacitor.getPlatform() === 'android';
          let currentLocGranted = permissions.location === 'granted';
          
          if (!currentLocGranted) {
            logger.debug('[useGeolocation] Requesting foreground location permission...');
            const reqStatus = await BackgroundGeolocation.requestPermissions({
              permissions: ['location']
            });
            currentLocGranted = reqStatus.location === 'granted';
          }

          if (currentLocGranted) {
            const updatedPermissions = await BackgroundGeolocation.checkPermissions();
            let bgGranted = isAndroid 
              ? updatedPermissions.backgroundLocation === 'granted'
              : (updatedPermissions.backgroundLocation === 'always' || updatedPermissions.backgroundLocation === 'granted');
              
            if (!bgGranted) {
              logger.debug('[useGeolocation] Requesting background location & notifications permission...');
              const bgStatus = await BackgroundGeolocation.requestPermissions({
                permissions: ['backgroundLocation', 'notification']
              });
              bgGranted = isAndroid 
                ? bgStatus.backgroundLocation === 'granted'
                : (bgStatus.backgroundLocation === 'always' || bgStatus.backgroundLocation === 'granted');
            }
            
            if (!bgGranted) {
              logger.warn('[useGeolocation] Background location permission denied.');
            }
          } else {
            logger.warn('[useGeolocation] Foreground location permission denied.');
          }
        } catch (permErr) {
          logger.error('[useGeolocation] Failed checking/requesting permissions:', permErr);
        }

        // 5. Configure native geofencing with webhook delivery
        await BackgroundGeolocation.setupGeofencing({
          notifyOnEntry: true,
          notifyOnExit: true,
          backgroundLocation: true,
          requestPermissions: false, // Handle manually above
          ...(webhookUrl ? { url: webhookUrl } : {}),
          payload: {
            homeId: activeHomeId,
            deviceId: mobileDeviceId,
            geofencingAccessToken: geofencingToken
          }
        });

        if (!active) return;
        logger.debug('[useGeolocation] Geofencing configured' + (webhookUrl ? ' with webhook' : ' (JS-only, no webhook)'));

        // 6. Register home geofence
        const geofenceIdentifier = `home-${activeHomeId}`;
        const radius = rad || 300;

        await BackgroundGeolocation.addGeofence({
          identifier: geofenceIdentifier,
          latitude: lat,
          longitude: lon,
          radius: radius
        });

        geofenceIdRef.current = geofenceIdentifier;
        if (!active) return;
        logger.debug(`[useGeolocation] Home geofence registered: lat=${lat}, lon=${lon}, radius=${radius}m`);

        // 7. Listen for JS-side geofence transitions (fires while app is alive in foreground)
        listenerRef.current = await BackgroundGeolocation.addListener(
          'geofenceTransition',
          async (event) => {
            logger.debug(`[useGeolocation] Geofence transition: ${event.identifier} → ${event.transition}`);

            // POST transition to server (supplements native webhook for when WebView is alive)
            try {
              await apiFetch(`/api/v2/homes/${activeHomeId}/mobileDevices/${mobileDeviceId}/geolocation`, {
                method: 'POST',
                body: {
                  geolocation: {
                    latitude: event.latitude,
                    longitude: event.longitude,
                    accuracy: 0  // Native geofence events don't provide accuracy parameters
                  },
                  transition: event.transition,
                  enter: event.enter
                }
              });
              logger.debug(`[useGeolocation] Transition synced to server: ${event.transition}`);
            } catch (postErr) {
              logger.error('[useGeolocation] Failed to sync transition:', postErr);
            }
          }
        );

        // 8. Listen for geofence errors
        errorListenerRef.current = await BackgroundGeolocation.addListener(
          'geofenceError',
          (error) => {
            logger.error('[useGeolocation] Geofence monitoring error:', error);
          }
        );

        logger.debug('[useGeolocation] Native geofencing fully initialized.');

      } catch (err) {
        logger.error('[useGeolocation] Failed to initialize geofencing:', err);
      }
    };

    setupGeofencing();

    return () => {
      active = false;

      // Cleanup: remove geofences and listeners (fire-and-forget, React won't await)
      (async () => {
        try {
          if (geofenceIdRef.current) {
            await BackgroundGeolocation.removeGeofence({ identifier: geofenceIdRef.current });
            geofenceIdRef.current = null;
            logger.debug('[useGeolocation] Geofence removed.');
          }
        } catch (e) {
          logger.warn('[useGeolocation] Failed to remove geofence:', e);
        }

        if (listenerRef.current) {
          listenerRef.current.remove();
          listenerRef.current = null;
        }
        if (errorListenerRef.current) {
          errorListenerRef.current.remove();
          errorListenerRef.current = null;
        }
        if (appStateListener) {
          appStateListener.then(h => h.remove());
          appStateListener = null;
        }
        if (checkinInterval) {
          clearInterval(checkinInterval);
          checkinInterval = null;
        }
        logger.debug('[useGeolocation] Geofencing cleanup complete.');
      })();
    };
  }, [isAuthenticated, activeHomeId, user?.id, mobileDeviceId, setMobileDeviceId]);
}
