/**
 * @file src/context/HomeContext.jsx
 * @brief Home context provider managing state, configuration parameters, SWR polling, and real-time SSE.
 * 
 * Exposes active home settings, current weather conditions, home occupancy states (HOME/AWAY),
 * zones configuration, and zone telemetries (temperature, humidity). Implements adaptive SWR
 * polling based on screen visibility and native device checks.
 */

import { createContext, useState, useEffect, useContext } from 'react';
import { useAuth } from '../hooks/useAuth';
import { Capacitor } from '@capacitor/core';
import useSWR from 'swr';
import { getHomeInfo, getHomeState } from '../api/homes';
import { getZones, getZoneStates } from '../api/zones';
import { getWeather } from '../api/weather';
import { useSSE } from '../hooks/useSSE';
import { SWR_KEYS } from '../utils/swrKeys';

// React Context for sharing general Home state parameters across screens
export const HomeContext = createContext(null);

/**
 * @brief HomeProvider context component wrapper.
 * @param {object} props.children - Sub-components tree.
 */
export function HomeProvider({ children }) {
  const { user, isAuthenticated } = useAuth();
  const [activeHomeId, setActiveHomeId] = useState(null);

  // Subscribe to Server-Sent Events (SSE) updates to push real-time zone/home telemetry
  useSSE(activeHomeId);

  // Set default active home once user profile loads
  useEffect(() => {
    let targetId = null;
    if (user && user.homes && user.homes.length > 0) {
      const first = user.homes[0];
      targetId = typeof first === 'object' ? first.id : first;
    } else if (user && user.tado_homes && user.tado_homes.length > 0) {
      const first = user.tado_homes[0];
      targetId = typeof first === 'object' ? first.id : first;
    }
    if (targetId !== null) {
      setActiveHomeId(prev => prev || targetId);
    }
  }, [user]);

  const isMobile = Capacitor.isNativePlatform();
  const [isVisible, setIsVisible] = useState(true);

  // Track page visibility to pause background SWR polling intervals when inactive/minimized
  useEffect(() => {
    const handler = () => setIsVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  /**
   * @brief Helper to calculate correct SWR polling interval.
   * @param {number} webMs - Polling interval for standard web client (active tab).
   * @param {number} mobileMs - Polling interval for Capacitor mobile wrapper.
   * @returns {number} Active polling interval in ms (0 to disable).
   */
  const pollInterval = (webMs, mobileMs) => {
    if (!isVisible) return 0;
    return isMobile ? mobileMs : webMs;
  };

  // SWR Config: allow bounded retries instead of completely disabling them
  const swrConfig = {
    revalidateOnFocus: false,
    shouldRetryOnError: true,
    errorRetryCount: 3,
    errorRetryInterval: 5000
  };

  // Fetch Home metadata (coordinates, settings)
  const { 
    data: homeInfo, 
    error: homeInfoError,
    mutate: mutateHomeInfo
  } = useSWR(
    isAuthenticated && activeHomeId ? SWR_KEYS.homeInfo(activeHomeId) : null,
    () => getHomeInfo(activeHomeId),
    { ...swrConfig, refreshInterval: pollInterval(300000, 600000) } // Poll every 5min — drives geofence coordinates
  );

  // Fetch Home presence state (HOME/AWAY)
  const { 
    data: homeState, 
    error: homeStateError,
    mutate: mutateHomeState 
  } = useSWR(
    isAuthenticated && activeHomeId ? SWR_KEYS.homeState(activeHomeId) : null,
    () => getHomeState(activeHomeId),
    { ...swrConfig, refreshInterval: pollInterval(30000, 60000) } // Poll every 30s
  );

  // Fetch Home weather
  const { 
    data: weather, 
    error: weatherError,
    mutate: mutateWeather
  } = useSWR(
    isAuthenticated && activeHomeId ? SWR_KEYS.weather(activeHomeId) : null,
    () => getWeather(activeHomeId),
    { ...swrConfig, refreshInterval: pollInterval(60000, 300000) } // Poll every 60s
  );

  // Fetch Zone list
  const { 
    data: zones, 
    error: zonesError,
    mutate: mutateZones 
  } = useSWR(
    isAuthenticated && activeHomeId ? SWR_KEYS.zones(activeHomeId) : null,
    () => getZones(activeHomeId),
    { ...swrConfig, refreshInterval: pollInterval(300000, 600000) } // Poll every 5min
  );

  // Fetch Zone states (polling fallback)
  const { 
    data: zoneStates, 
    error: zoneStatesError,
    mutate: mutateZoneStates 
  } = useSWR(
    isAuthenticated && activeHomeId ? SWR_KEYS.zoneStates(activeHomeId) : null,
    () => getZoneStates(activeHomeId),
    { ...swrConfig, refreshInterval: pollInterval(60000, 90000) } // Poll every 60s as fallback (SSE handles real-time)
  );

  const value = {
    activeHomeId,
    setActiveHomeId,
    homeInfo,
    homeState,
    weather,
    zones,
    zoneStates,
    isLoading: isAuthenticated && activeHomeId && (!homeInfo || !zones || !zoneStates) && !homeInfoError && !zonesError && !zoneStatesError,
    error: homeInfoError || homeStateError || weatherError || zonesError || zoneStatesError,
    
    // Mutators
    mutateHomeInfo,
    mutateHomeState,
    mutateWeather,
    mutateZones,
    mutateZoneStates,
    
    // Quick refresh helper triggered by pull-to-refresh or navigation events
    refreshAll: async () => {
      await Promise.all([
        mutateHomeInfo(),
        mutateHomeState(),
        mutateWeather(),
        mutateZones(),
        mutateZoneStates()
      ]);
    }
  };

  return (
    <HomeContext.Provider value={value}>
      {children}
    </HomeContext.Provider>
  );
}

/**
 * @brief Custom hook to quickly access active Home state values and mutators.
 * @returns {object} Context values for home stats.
 */
export function useHome() {
  const context = useContext(HomeContext);
  if (!context) {
    throw new Error('useHome must be used within a HomeProvider');
  }
  return context;
}
