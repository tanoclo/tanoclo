/**
 * @file src/api/client.js
 * @brief Base HTTP request client wrapping the browser Fetch API.
 * 
 * Provides unified request timeout abort control (30s), automatic JSON parsing/content-type headers,
 * authentication header injection (Bearer token), and intelligent token-refresh routing when receiving
 * 401 unauthorized responses. Implements client refresh queues to avoid duplicate refresh calls.
 * 
 * SECURITY NOTE: Access and refresh tokens are stored in localStorage, which is vulnerable to XSS.
 * This is an acceptable trade-off for the native Capacitor app (sandboxed WebView). For the web app,
 * XSS risk is mitigated by Content Security Policy headers. If stricter isolation is needed in the
 * future, the refresh token could be moved to httpOnly cookies with backend support.
 */

import { STORAGE_KEYS, getApiBase } from '../utils/constants';
import { refreshAccessToken } from './auth';

// Tracks global token-refresh status to prevent overlapping token-refresh api requests
let isRefreshing = false;
// Queue of pending requests waiting for a new token to arrive
let refreshSubscribers = [];

/**
 * @brief Subscribes a callback to execute after the access token is refreshed.
 * @param {function} cb - Retry callback receiving the new access token.
 */
function subscribeTokenRefresh(cb) {
  refreshSubscribers.push(cb);
}

/**
 * @brief Flushes all queued requests with the newly acquired token.
 * @param {string} token - The fresh access token.
 */
function onRefreshed(token) {
  refreshSubscribers.forEach(cb => cb(token));
  refreshSubscribers = [];
}

/**
 * @brief Base fetch API client wrapper with timeout, token injection, and automatic retries.
 * @param {string} endpoint - API target endpoint path.
 * @param {object} options - Fetch options override.
 * @returns {Promise<any>} Parsed response data.
 */
export async function apiFetch(endpoint, options = {}) {
  const token = localStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
  
  const headers = {
    'Accept': 'application/json',
    ...options.headers,
  };

  // Inject authentication header if token exists in LocalStorage
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // If request body is an object and not FormData, stringify it
  let body = options.body;
  if (body && typeof body === 'object' && !(body instanceof FormData)) {
    body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }

  const url = `${getApiBase()}${endpoint}`;
  const controller = new AbortController();
  // Enforce a strict 30-second request timeout abort
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
      body,
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error('Request timed out. Please check your connection.', { cause: err });
    }
    throw err;
  }
  clearTimeout(timeoutId);

  // Handle Token Expiration (401 Unauthorized)
  if (response.status === 401 && token) {
    // On native (Capacitor), read refresh token from localStorage.
    // On web, the httpOnly cookie carries it automatically — no localStorage needed.
    const isNative = typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.();
    const refreshToken = isNative ? localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN) : null;

    // On native without a stored refresh token, we can't refresh — logout immediately.
    if (isNative && !refreshToken) {
      handleLogout();
      throw new Error('Unauthorized');
    }

    if (!isRefreshing) {
      isRefreshing = true;
      try {
        // On web, refreshToken is null and the httpOnly cookie provides it.
        // On native, the explicit token is passed in the request body.
        const data = await refreshAccessToken(refreshToken);
        localStorage.setItem(STORAGE_KEYS.AUTH_TOKEN, data.access_token);
        // Only store refresh token in localStorage on native (Capacitor) platforms
        if (isNative && data.refresh_token) {
          localStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, data.refresh_token);
        }
        isRefreshing = false;
        onRefreshed(data.access_token);

        // We refreshed the token ourselves. Retry the original request immediately.
        headers['Authorization'] = `Bearer ${data.access_token}`;
        const retryController = new AbortController();
        const retryTimeoutId = setTimeout(() => retryController.abort(), 30000);
        try {
          const retriedResponse = await fetch(url, { ...options, headers, body, credentials: options.credentials || 'include', signal: retryController.signal });
          return handleResponse(retriedResponse);
        } catch (retryErr) {
          if (retryErr.name === 'AbortError') {
            throw new Error('Request timed out. Please check your connection.', { cause: retryErr });
          }
          throw retryErr;
        } finally {
          clearTimeout(retryTimeoutId);
        }
      } catch (err) {
        isRefreshing = false;
        refreshSubscribers.forEach(cb => cb(null));
        refreshSubscribers = [];
        handleLogout();
        throw err;
      }
    } else {
      // If a refresh is already in flight, queue this request to retry when finished
      const retryOriginalRequest = new Promise((resolve, reject) => {
        subscribeTokenRefresh(async (newToken) => {
          if (!newToken) {
            return reject(new Error('Token refresh failed'));
          }
          headers['Authorization'] = `Bearer ${newToken}`;
          const retryController = new AbortController();
          const retryTimeoutId = setTimeout(() => retryController.abort(), 30000);
          try {
            const retried = await fetch(url, { ...options, headers, body, credentials: options.credentials || 'include', signal: retryController.signal });
            resolve(retried);
          } catch (retryErr) {
            if (retryErr.name === 'AbortError') {
              reject(new Error('Request timed out. Please check your connection.', { cause: retryErr }));
            } else {
              reject(retryErr);
            }
          } finally {
            clearTimeout(retryTimeoutId);
          }
        });
      });

      const retriedResponse = await retryOriginalRequest;
      return handleResponse(retriedResponse);
    }
  }

  return handleResponse(response);
}

/**
 * @brief Processes standard HTTP response objects, throwing descriptive errors on non-OK statuses.
 * @param {Response} response - Fetch API Response.
 * @returns {Promise<any>} Json or text representation of payload.
 */
async function handleResponse(response) {
  if (response.status === 204) return null; // No Content
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.error_description || errorBody.message || errorBody.error || `API Request failed: ${response.statusText}`);
  }

  // Handle empty or text responses
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

/**
 * @brief Wipes local session cookies/auth parameters and dispatches a global logout event.
 * 
 * NOTE: This does NOT call the backend logout endpoint directly. Instead it dispatches
 * 'auth_logout' which AuthContext listens to, triggering AuthContext.logout() which calls
 * the backend with the still-valid token from its React state closure. The backend logout
 * handler clears the httpOnly refresh token cookie.
 */
function handleLogout() {
  localStorage.removeItem(STORAGE_KEYS.AUTH_TOKEN);
  // Only remove refresh token from localStorage on native; on web the httpOnly cookie handles it
  const isNative = typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.();
  if (isNative) {
    localStorage.removeItem(STORAGE_KEYS.REFRESH_TOKEN);
  }
  // Dispatch custom event to let AuthContext know
  window.dispatchEvent(new Event('auth_logout'));
}
