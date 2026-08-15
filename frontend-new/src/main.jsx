/**
 * @file src/main.jsx
 * @brief Application entry point. Instantiates the React component tree and wraps it in providers.
 * 
 * Sets up global styling and localizations, mounts state management context providers (Theme, Toast, Auth, Home),
 * configures Progressive Web App (PWA) Service Workers (bypassing it on Capacitor native builds),
 * and implements global error routing handlers to catch chunk loading errors during hot redeployments.
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'leaflet/dist/leaflet.css'
import './index.css'
import './i18n' // Initialize translations
import App from './App.jsx'
import { AuthProvider } from './context/AuthContext'
import { ThemeProvider } from './context/ThemeContext'
import { HomeProvider } from './context/HomeContext'
import { ToastProvider } from './context/ToastContext'
import ErrorBoundary from './components/common/ErrorBoundary'
import { Capacitor } from '@capacitor/core'
import { CapacitorUpdater } from '@capgo/capacitor-updater'
import logger from './utils/logger'

// Notify CapGo that the current web bundle loaded successfully
// Without this, CapGo auto-rolls back OTA-applied bundles on next launch
if (Capacitor.isNativePlatform()) {
  CapacitorUpdater.notifyAppReady()
    .then(() => logger.debug('[CapGo] notifyAppReady() confirmed current bundle'))
    .catch((err) => logger.warn('[CapGo] notifyAppReady() failed (expected on first install):', err));
}


// Mount application to the root DOM node
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ThemeProvider>
      <ErrorBoundary>
        <ToastProvider>
          <AuthProvider>
            <HomeProvider>
              <App />
            </HomeProvider>
          </AuthProvider>
        </ToastProvider>
      </ErrorBoundary>
    </ThemeProvider>
  </StrictMode>,
)

// Service Worker handling based on platforms
if ('serviceWorker' in navigator) {
  if (Capacitor.isNativePlatform()) {
    // Unregister any active service worker in Capacitor to avoid stale cached pages on APK updates
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const registration of registrations) {
        registration.unregister()
          .then((success) => {
            if (success) {
              logger.debug('Unregistered active service worker for Capacitor environment.');
            }
          })
          .catch((err) => logger.error('Failed to unregister service worker:', err));
      }
    });
  } else if (import.meta.env.PROD) {
    // Register Service Worker in Production for PWA support on web
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`)
        .then(reg => logger.debug('Service Worker registered successfully:', reg.scope))
        .catch(err => logger.error('Service Worker registration failed:', err));
    });
  }
}

/**
 * @brief Global handler to catch chunk/module loading errors (e.g. from Vite hot-redeployments).
 * Reloads the application if a dynamic import fails due to missing hashed assets on the backend.
 * @param {string|Error} error - Received error details.
 */
const handleChunkError = (error) => {
  if (!error) return;

  const msg = typeof error === 'string' ? error : (error.message || error.toString());
  const isChunkError = (
    /loading chunk/i.test(msg) ||
    /failed to fetch dynamically imported module/i.test(msg) ||
    /dynamically imported module/i.test(msg) ||
    (error.name && error.name === 'ChunkLoadError')
  );

  if (isChunkError) {
    const lastReload = sessionStorage.getItem('tanoclo_chunk_error_reload');
    const now = Date.now();
    // Prevent infinite reload loops by limiting reload to once every 10 seconds
    if (!lastReload || now - parseInt(lastReload, 10) > 10000) {
      sessionStorage.setItem('tanoclo_chunk_error_reload', now.toString());
      logger.warn('Chunk loading error detected. Purging cache and reloading...', error);
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(regs => {
          for (const reg of regs) reg.unregister();
        });
      }
      if ('caches' in window) {
        caches.keys().then(keys => {
          for (const key of keys) caches.delete(key);
        });
      }
      setTimeout(() => {
        window.location.reload();
      }, 100);
    }
  }
};

// Bind to window-level crash handlers
window.addEventListener('error', (event) => handleChunkError(event.error || event.message));
window.addEventListener('unhandledrejection', (event) => handleChunkError(event.reason));
