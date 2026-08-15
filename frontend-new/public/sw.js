/**
 * @file public/sw.js
 * @brief Service Worker implementation for offline caching and Progressive Web App shell support.
 * 
 * Intercepts GET fetch requests for static application assets (HTML, layout icons, configurations)
 * and serves them from local CacheStorage to enable instant load times and offline fallback.
 * Bypasses network logging, APIs, and real-time streams to prevent stale responses.
 */

// Cache Name. The version suffix (v1) gets patched dynamically at build time by Vite.
const CACHE_NAME = 'tanoclo-shell-v1';
// Core application shell assets to preload immediately during the SW install phase.
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/favicon.svg',
  '/manifest.json'
];

// Installs service worker and caches core assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting(); // Force activation immediately
});

// Cleans up old service worker caches and claims active clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim(); // Immediately start controlling open pages
});

// Intercepts network requests to serve assets from cache or cache on-the-fly
self.addEventListener('fetch', (event) => {
  // Only intercept GET requests, ignoring API/OAuth/GraphQL/Setup endpoints
  if (event.request.method !== 'GET' || 
      event.request.url.includes('/api/') || 
      event.request.url.includes('/oauth2/') || 
      event.request.url.includes('/graphql') ||
      event.request.url.includes('/setup')) {
    return;
  }

  // Network-First strategy for HTML navigation requests (index.html / SPA routes)
  if (event.request.mode === 'navigate' || event.request.destination === 'document') {
    event.respondWith(
      fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Fallback to cached index.html only when network is completely unreachable (offline)
        return caches.match(event.request).then((cachedResponse) => {
          return cachedResponse || caches.match('/index.html') || caches.match('/');
        });
      })
    );
    return;
  }
  
  // Cache-First strategy for static assets, with automatic cache purge on 404 asset failures
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      
      return fetch(event.request).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        } else if (response && (response.status === 404 || response.status === 403)) {
          // If a static asset is missing on server, clear stale cache
          caches.keys().then((keys) => {
            keys.forEach((key) => caches.delete(key));
          });
        }
        return response;
      }).catch((_err) => {
        return new Response('Network error', { status: 408, statusText: 'Network Error' });
      });
    })
  );
});
