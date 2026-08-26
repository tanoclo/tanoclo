/**
 * @file src/App.jsx
 * @brief Core application layout, routing wrapper, and native lifecycle controller.
 * 
 * Configures the primary client-side Router routes (public /login vs protected home page paths),
 * manages initialization parameters for native geolocation tracking and device battery monitors,
 * handles Android back-button hooks in native environments, and performs automatic background
 * locale/metadata syncs to the server.
 */

import { lazy, Suspense, useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router';
import { useAuth } from './hooks/useAuth';
import Spinner from './components/common/Spinner';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { useHome } from './context/HomeContext';
import { useTranslation } from 'react-i18next';
import { apiFetch } from './api/client';
import DeviceRegistrationPage from './pages/DeviceRegistrationPage';
import ErrorBoundary from './components/common/ErrorBoundary';
import RouteErrorBoundary from './components/common/RouteErrorBoundary';
import SelfUpdater from './components/common/SelfUpdater';

// Lazy loaded Pages to optimize chunk size and load speeds
const LoginPage = lazy(() => import('./pages/LoginPage'));
const HomePage = lazy(() => import('./pages/HomePage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const AccountPage = lazy(() => import('./pages/AccountPage'));
const ZonePage = lazy(() => import('./pages/ZonePage'));
const ClimateQualityPage = lazy(() => import('./pages/ClimateQualityPage'));

import { useGeolocation } from './hooks/useGeolocation';
import { useBatteryNotifier } from './hooks/useBatteryNotifier';
import logger from './utils/logger';

const isNative = Capacitor.isNativePlatform();

/**
 * @brief Handles Android hardware back button events inside Capacitor wrapper.
 */
function BackButtonHandler() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    // Register callback to intercept back-clicks
    const handler = CapApp.addListener('backButton', () => {
      const path = location.pathname;
      if (path === '/' || path === '/login') {
        // Exit application if user is at root screens
        CapApp.exitApp();
      } else {
        // Go back in history or redirect home
        if (window.history.length <= 2) {
          navigate('/');
        } else {
          window.history.back();
        }
      }
    });

    return () => {
      handler.then(h => h.remove());
    };
  }, [location.pathname, navigate]);

  return null;
}

function AuthenticatedShell({ mobileDeviceId, setMobileDeviceId }) {
  const { activeHomeId } = useHome();
  const { isAuthenticated } = useAuth();
  const { i18n } = useTranslation();

  // Initialize native background geolocation tracking when authenticated and registered
  useGeolocation(mobileDeviceId, setMobileDeviceId);

  // Initialize native local battery notifications when authenticated and registered
  useBatteryNotifier(mobileDeviceId, activeHomeId, isAuthenticated);

  // Sync mobile device metadata (specifically active locale) to the server on startup or locale change
  useEffect(() => {
    if (isAuthenticated && activeHomeId && mobileDeviceId) {
      const syncDeviceMetadata = async () => {
        try {
          let platform = 'Android';
          let osVersion = 'Unknown';
          let model = 'Unknown';
          let locale = i18n.language || 'en';

          // Query hardware details if on mobile Capacitor shell
          if (Capacitor.isNativePlatform()) {
            const { Device } = await import('@capacitor/device');
            const info = await Device.getInfo();
            platform = info.platform === 'ios' ? 'iOS' : (info.platform === 'android' ? 'Android' : info.platform);
            osVersion = info.osVersion || 'Unknown';
            model = info.model || 'Unknown';
          }

          // PUT parameters to mobile device endpoint
          await apiFetch(`/api/v2/homes/${activeHomeId}/mobileDevices/${mobileDeviceId}/metadata`, {
            method: 'PUT',
            body: {
              device: {
                platform,
                osVersion,
                model,
                locale
              }
            }
          });
          logger.debug(`[App] Device metadata synced. Locale: ${locale}`);
        } catch (err) {
          logger.error('[App] Failed to sync device metadata:', err);
        }
      };
      
      syncDeviceMetadata();
    }
  }, [isAuthenticated, activeHomeId, mobileDeviceId, i18n.language]);

  return (
    <Routes>
      <Route path="/" element={<RouteErrorBoundary><HomePage /></RouteErrorBoundary>} />
      <Route path="/zones/:id" element={<RouteErrorBoundary><ZonePage /></RouteErrorBoundary>} />
      <Route path="/climate-quality" element={<RouteErrorBoundary><ClimateQualityPage /></RouteErrorBoundary>} />
      <Route path="/settings" element={<RouteErrorBoundary><SettingsPage /></RouteErrorBoundary>} />
      <Route path="/account" element={<RouteErrorBoundary><AccountPage /></RouteErrorBoundary>} />
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  const { isAuthenticated, isLoading } = useAuth();
  const { activeHomeId, isLoading: isHomeLoading } = useHome();
  
  // Local storage mobile device registration pointer
  const [mobileDeviceId, setMobileDeviceId] = useState(() => localStorage.getItem('tanoclo_mobile_device_id'));

  useEffect(() => {
    if (!isAuthenticated) {
      setMobileDeviceId(prev => prev !== null ? null : prev);
    } else {
      const stored = localStorage.getItem('tanoclo_mobile_device_id');
      setMobileDeviceId(prev => prev !== stored ? stored : prev);
    }
  }, [isAuthenticated]);

  // Show loading spinner during session boot
  if (isLoading) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'var(--bg-app)'
      }}>
        <Spinner size={32} />
      </div>
    );
  }

  // Intercept on native platforms if device registration has not been performed
  if (isAuthenticated && isNative && !mobileDeviceId) {
    if (isHomeLoading || !activeHomeId) {
      return (
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'var(--bg-app)'
        }}>
          <Spinner size={32} />
        </div>
      );
    }
    return (
      <ErrorBoundary>
        <DeviceRegistrationPage onRegister={(id) => setMobileDeviceId(id)} />
      </ErrorBoundary>
    );
  }

  return (
    <BrowserRouter>
      <SelfUpdater />
      <BackButtonHandler />
      <Suspense fallback={
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'var(--bg-app)'
        }}>
          <Spinner size={32} />
        </div>
      }>
        <Routes>
          {!isAuthenticated ? (
            <>
              {/* Unauthenticated routes: redirect all pages to login */}
              <Route path="/login" element={<LoginPage />} />
              <Route path="*" element={<Navigate to="/login" replace />} />
            </>
          ) : (
            <Route path="*" element={<AuthenticatedShell mobileDeviceId={mobileDeviceId} setMobileDeviceId={setMobileDeviceId} />} />
          )}
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
