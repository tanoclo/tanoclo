/**
 * @file src/hooks/useSSE.js
 * @brief Custom hook managing a real-time Server-Sent Events (SSE) stream client.
 * 
 * Requests a short-lived event ticket from the server, opens a persistent connection
 * to `/api/homes/:homeId/events`, and maps server pushed updates (zone states, device configurations,
 * presence states) directly to local cache mutations using SWR. Includes a robust exponential
 * backoff reconnection policy, heartbeat watchdog, and automatic recovery on network/visibility changes.
 */

import { useState, useEffect, useRef } from 'react';
import { useSWRConfig } from 'swr';
import { STORAGE_KEYS, getApiBase } from '../utils/constants';
import { apiFetch } from '../api/client';
import logger from '../utils/logger';
import { SWR_KEYS } from '../utils/swrKeys';

/**
 * @brief Custom hook to establish real-time SSE event updates for an active Home.
 * @param {string|number} homeId - Active home identifier.
 * @returns {{ isConnected: boolean, lastEventAt: number | null }}
 */
export function useSSE(homeId) {
  const { mutate } = useSWRConfig();
  const mutateRef = useRef(mutate);
  useEffect(() => {
    mutateRef.current = mutate;
  }, [mutate]);

  const [isConnected, setIsConnected] = useState(false);
  const [lastEventAt, setLastEventAt] = useState(null);
  const esRef = useRef(null);
  const lastHeartbeatRef = useRef(Date.now());

  useEffect(() => {
    if (!homeId) {
      setIsConnected(false);
      return;
    }

    const apiBase = getApiBase();
    // Normalize url base (remove trailing slash if present)
    const base = apiBase.endsWith('/') ? apiBase.slice(0, -1) : apiBase;
    let es = null;
    let active = true;
    let reconnectDelay = 2000;
    let reconnectTimer = null;
    let watchdogTimer = null;
    let isConnecting = false;

    function markActivity() {
      lastHeartbeatRef.current = Date.now();
      setLastEventAt(Date.now());
    }

    function scheduleReconnect(immediate = false) {
      if (!active || isConnecting) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      setIsConnected(false);

      if (immediate) {
        reconnectDelay = 2000;
        connectSSE();
        return;
      }

      const jitter = Math.floor(Math.random() * 1000);
      const delay = Math.min(reconnectDelay, 30000) + jitter;
      reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);

      logger.debug(`Scheduling SSE reconnect in ${delay}ms`);
      reconnectTimer = setTimeout(() => {
        if (active) {
          connectSSE();
        }
      }, delay);
    }

    /**
     * @brief Asynchronously fetches connection ticket and configures the EventSource object.
     */
    async function connectSSE() {
      if (!active || isConnecting) return;
      isConnecting = true;

      const token = localStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
      if (!token) {
        isConnecting = false;
        setIsConnected(false);
        return;
      }

      // Close previous instance if any
      if (es) {
        try { es.close(); } catch (_e) {}
        es = null;
      }
      esRef.current = null;

      try {
        // Fetch a one-time connection ticket to avoid exposing the bearer token directly in query parameters
        const { ticket } = await apiFetch(`/api/homes/${homeId}/events/ticket`, {
          method: 'POST'
        });

        if (!active) {
          isConnecting = false;
          return;
        }

        const sseUrl = `${base}/api/homes/${homeId}/events?ticket=${ticket}`;
        logger.info(`Connecting to SSE stream for home ${homeId} via ticket...`);

        es = new EventSource(sseUrl);
        esRef.current = es;
        isConnecting = false;

        // Triggered upon successful authentication and handshake
        es.addEventListener('connected', (e) => {
          logger.info('SSE connected:', e.data ? JSON.parse(e.data) : {});
          setIsConnected(true);
          reconnectDelay = 2000;
          markActivity();

          // Immediately re-sync to ensure no state updates were missed during disconnect
          if (mutateRef.current) {
            mutateRef.current(SWR_KEYS.zoneStates(homeId));
            mutateRef.current(SWR_KEYS.homeState(homeId));
            mutateRef.current(SWR_KEYS.zones(homeId));
          }
        });

        // Telemetry / measurement update: invalidate and trigger reload of active zone stats
        es.addEventListener('zone-state', (e) => {
          logger.debug('SSE received zone-state:', e.data);
          markActivity();
          let parsed = null;
          try { parsed = JSON.parse(e.data); } catch (_err) {}

          mutateRef.current(SWR_KEYS.zoneStates(homeId));
          if (parsed && parsed.zoneId != null) {
            mutateRef.current(SWR_KEYS.zoneState(homeId, parsed.zoneId));
          }
        });

        // Layout update: invalidate and reload zone entities list
        es.addEventListener('zone-config', (e) => {
          logger.debug('SSE received zone-config:', e.data);
          markActivity();
          let parsed = null;
          try { parsed = JSON.parse(e.data); } catch (_err) {}

          mutateRef.current(SWR_KEYS.zones(homeId));
          mutateRef.current(SWR_KEYS.zoneStates(homeId));
          if (parsed && parsed.zoneId != null) {
            mutateRef.current(SWR_KEYS.zoneState(homeId, parsed.zoneId));
          }
        });

        // Device update: invalidate and trigger reload of device indicators
        es.addEventListener('device-state', (e) => {
          logger.debug('SSE received device-state:', e.data);
          markActivity();
          let parsed = null;
          try { parsed = JSON.parse(e.data); } catch (_err) {}

          mutateRef.current(SWR_KEYS.devices(homeId));
          mutateRef.current(SWR_KEYS.zoneStates(homeId));
          mutateRef.current(SWR_KEYS.batteryDevices(homeId));
          mutateRef.current(SWR_KEYS.batteryDevicesRaw(homeId));
          if (parsed && parsed.deviceId) {
            mutateRef.current(SWR_KEYS.deviceDetails(homeId, parsed.deviceId));
            mutateRef.current(SWR_KEYS.deviceRaw(homeId, parsed.deviceId));
          }
        });

        // Device debug response: push live diagnostic/NVM response directly to components
        es.addEventListener('device-debug-response', (e) => {
          logger.debug('SSE received device-debug-response:', e.data);
          markActivity();
          try {
            const parsed = JSON.parse(e.data);
            window.dispatchEvent(new CustomEvent('device-debug-response', { detail: parsed }));
          } catch (_err) {}
        });

        // Presence update: invalidate and reload HOME/AWAY occupancy state
        es.addEventListener('home-state', (e) => {
          logger.debug('SSE received home-state:', e.data);
          markActivity();
          mutateRef.current(SWR_KEYS.homeState(homeId));
          mutateRef.current(SWR_KEYS.zoneStates(homeId));
        });

        // Heartbeat / ping from server to maintain active connection
        es.addEventListener('ping', () => {
          markActivity();
        });

        es.addEventListener('heartbeat', () => {
          markActivity();
        });

        es.onmessage = () => {
          markActivity();
        };

        // Connection error handler: schedule reconnect with exponential backoff
        es.onerror = (err) => {
          logger.error('SSE Error, reconnecting:', err);
          if (es) {
            try { es.close(); } catch (_e) {}
            es = null;
          }
          if (esRef.current === es) {
            esRef.current = null;
          }
          scheduleReconnect(false);
        };
      } catch (err) {
        logger.error('Failed to establish SSE connection:', err);
        isConnecting = false;
        if (es) {
          try { es.close(); } catch (_e) {}
          es = null;
        }
        esRef.current = null;
        scheduleReconnect(false);
      }
    }

    connectSSE();

    // Heartbeat Watchdog: check every 15s to detect silent dead TCP sockets
    // (server sends ping heartbeat every 20s)
    watchdogTimer = setInterval(() => {
      if (!active) return;
      const elapsed = Date.now() - lastHeartbeatRef.current;
      if (esRef.current && elapsed > 60000) {
        logger.warn(`SSE watchdog: no heartbeat for ${Math.round(elapsed / 1000)}s. Reconnecting.`);
        if (esRef.current) {
          try { esRef.current.close(); } catch (_e) {}
          esRef.current = null;
        }
        scheduleReconnect(true);
      }
    }, 15000);

    // Immediate recovery when device regains network connectivity
    const handleOnline = () => {
      if (active) {
        logger.info('Network online event detected — forcing SSE reconnect');
        scheduleReconnect(true);
      }
    };
    window.addEventListener('online', handleOnline);

    // Reset reconnect state when the tab/app becomes visible again
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && active) {
        const elapsed = Date.now() - lastHeartbeatRef.current;
        if (!esRef.current || elapsed > 40000) {
          logger.info('Tab/app became visible and SSE needs refresh — reconnecting');
          scheduleReconnect(true);
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    // Close connections and clear timers on component unmount
    return () => {
      active = false;
      logger.info(`Disconnecting SSE stream for home ${homeId}`);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (watchdogTimer) clearInterval(watchdogTimer);
      if (es) {
        try { es.close(); } catch (_e) {}
      }
      esRef.current = null;
      setIsConnected(false);
    };
  }, [homeId]);

  return { isConnected, lastEventAt };
}
