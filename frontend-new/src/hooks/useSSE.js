/**
 * @file src/hooks/useSSE.js
 * @brief Custom hook managing a real-time Server-Sent Events (SSE) stream client.
 * 
 * Requests a short-lived event ticket from the server, opens a persistent connection
 * to `/api/homes/:homeId/events`, and maps server pushed updates (zone states, device configurations,
 * presence states) directly to local cache mutations using SWR. Includes a robust exponential
 * backoff reconnection policy on disconnection.
 */

import { useEffect, useRef } from 'react';
import { useSWRConfig } from 'swr';
import { STORAGE_KEYS, getApiBase } from '../utils/constants';
import { apiFetch } from '../api/client';
import logger from '../utils/logger';
import { SWR_KEYS } from '../utils/swrKeys';

/**
 * @brief Custom hook to establish real-time SSE event updates for an active Home.
 * @param {string} homeId - Active home identifier.
 */
export function useSSE(homeId) {
  const { mutate } = useSWRConfig();
  const mutateRef = useRef(mutate);
  useEffect(() => {
    mutateRef.current = mutate;
  }, [mutate]);
  const esRef = useRef(null);

  useEffect(() => {
    if (!homeId) return;

    const apiBase = getApiBase();
    // Normalize url base (remove trailing slash if present)
    const base = apiBase.endsWith('/') ? apiBase.slice(0, -1) : apiBase;
    let es = null;
    let active = true;
    let reconnectDelay = 2000;
    let reconnectTimer = null;
    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 50;

    /**
     * @brief Asynchronously fetches connection ticket and configures the EventSource object.
     */
    async function connectSSE() {
      const token = localStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
      if (!token) return;

      try {
        // Fetch a one-time connection ticket to avoid exposing the bearer token directly in the query parameters
        const { ticket } = await apiFetch(`/api/homes/${homeId}/events/ticket`, {
          method: 'POST'
        });
        
        if (!active) return;

        const sseUrl = `${base}/api/homes/${homeId}/events?ticket=${ticket}`;
        logger.info(`Connecting to SSE stream for home ${homeId} via ticket...`);
        
        es = new EventSource(sseUrl);
        esRef.current = es;

        // Triggered upon successful authentication and handshake
        es.addEventListener('connected', (e) => {
          logger.info('SSE connected:', JSON.parse(e.data));
          reconnectDelay = 2000; // Reset exponential delay backoff on success
          reconnectAttempts = 0; // Reset attempt counter on success
        });

        // Telemetry update: invalidate and trigger reload of active zone stats
        es.addEventListener('zone-state', (e) => {
          logger.debug('SSE received zone-state:', e.data);
          mutateRef.current(SWR_KEYS.zoneStates(homeId));
        });

        // Layout update: invalidate and reload zone entities list
        es.addEventListener('zone-config', (e) => {
          logger.debug('SSE received zone-config:', e.data);
          mutateRef.current(SWR_KEYS.zones(homeId));
        });

        // Device update: invalidate and trigger reload of device indicators
        es.addEventListener('device-state', (e) => {
          logger.debug('SSE received device-state:', e.data);
          mutateRef.current(SWR_KEYS.zoneStates(homeId));
        });

        // Presence update: invalidate and reload HOME/AWAY occupancy state
        es.addEventListener('home-state', (e) => {
          logger.debug('SSE received home-state:', e.data);
          mutateRef.current(SWR_KEYS.homeState(homeId));
        });

        // Connection error handler: schedule reconnect with exponential backoff
        es.onerror = (err) => {
          logger.error('SSE Error, reconnecting:', err);
          if (es) {
            es.close();
          }
          if (active) {
            reconnectAttempts++;
            if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
              logger.error(`SSE: max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`);
              return;
            }
            reconnectTimer = setTimeout(() => {
              reconnectDelay = Math.min(reconnectDelay * 2, 30000);
              connectSSE();
            }, reconnectDelay);
          }
        };
      } catch (err) {
        logger.error('Failed to establish SSE connection:', err);
        if (active) {
          reconnectAttempts++;
          if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            logger.error(`SSE: max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`);
            return;
          }
          reconnectTimer = setTimeout(() => {
            reconnectDelay = Math.min(reconnectDelay * 2, 30000);
            connectSSE();
          }, reconnectDelay);
        }
      }
    }

    connectSSE();

    // Reset reconnect state when the tab becomes visible again, allowing
    // recovery if SSE exhausted its reconnect attempts while backgrounded
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && active && !esRef.current) {
        logger.info('Tab became visible and SSE is disconnected — reconnecting');
        reconnectAttempts = 0;
        reconnectDelay = 2000;
        connectSSE();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    // Close connections and clear timers on component unmount
    return () => {
      active = false;
      logger.info(`Disconnecting SSE stream for home ${homeId}`);
      document.removeEventListener('visibilitychange', handleVisibility);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      if (es) {
        es.close();
      }
      esRef.current = null;
    };
  }, [homeId]);
}
