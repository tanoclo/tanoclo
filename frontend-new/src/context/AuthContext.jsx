/**
 * @file src/context/AuthContext.jsx
 * @brief Authentication state provider context for the application.
 * 
 * Manages user authentication states (logged in/out, current profile details),
 * handles PKCE authorization flows (callbacks, verifiers, CSRF state verification),
 * credentials-based authentication (OAuth2 password flow), and local token storage synchronization.
 */

import { createContext, useState, useEffect, useCallback, useRef } from 'react';
import { STORAGE_KEYS, getApiBase } from '../utils/constants';
import { initiateLoginFlow, exchangeCodeForTokens } from '../api/auth';
import { apiFetch } from '../api/client';
import { Capacitor } from '@capacitor/core';
import i18n from '../i18n';
import logger from '../utils/logger';

// Refresh tokens are stored in localStorage only on native (Capacitor) platforms.
// On web, the httpOnly cookie (tanoclo_rt) handles refresh token persistence.
const isNative = Capacitor.isNativePlatform();

// React Context for exposing auth state to hooks and sub-components
export const AuthContext = createContext(null);

/**
 * @brief AuthProvider context component wrapper.
 * @param {object} props.children - Sub-components tree.
 */
export function AuthProvider({ children }) {
  // Sync state with local storage tokens
  const [token, setToken] = useState(() => localStorage.getItem(STORAGE_KEYS.AUTH_TOKEN));
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(!!token);
  const [isLoading, setIsLoading] = useState(true);

  // Mutable reference to logout callback to prevent closures/stale effect references
  const logoutRef = useRef(null);

  /**
   * @brief Fetches current user profile from backend `/api/v2/me`.
   */
  const fetchUser = useCallback(async () => {
    try {
      const userData = await apiFetch('/api/v2/me');
      setUser(userData);
      setIsAuthenticated(true);
    } catch (err) {
      logger.error('Failed to fetch user profiles:', err);
      // Clean up token only if fetching user info fails due to authentication issues, not network drops
      const isAuthError = err.message === 'Unauthorized' ||
                          err.message.toLowerCase().includes('token') ||
                          err.message.toLowerCase().includes('unauthorized') ||
                          err.message.toLowerCase().includes('invalid');
      if (isAuthError) {
         if (logoutRef.current) logoutRef.current();
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * @brief Initiates standard OAuth PKCE flow (redirects browser to auth provider portal).
   */
  const login = useCallback(() => {
    initiateLoginFlow();
  }, []);

  /**
   * @brief Log in using direct user password credentials (fallback flow).
   */
  const loginWithCredentials = useCallback(async (username, password, remember = false) => {
    setIsLoading(true);
    try {
      const params = {
        grant_type: 'password',
        client_id: 'tado-mobile-app',
        username: username,
        password: password,
        scope: 'home.user offline_access'
      };
      if (remember) {
        params.remember = 'true';
      }

      const response = await fetch(`${getApiBase()}/oauth2/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        credentials: 'include',  // Accept httpOnly refresh token cookie from server
        body: new URLSearchParams(params)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error_description || errorData.error || 'Invalid credentials');
      }

      const data = await response.json();
      localStorage.setItem(STORAGE_KEYS.AUTH_TOKEN, data.access_token);
      if (isNative) {
        localStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, data.refresh_token);
      }
      
      // Fetch user profile using the token immediately (before updating state to prevent concurrent trigger)
      const userData = await apiFetch('/api/v2/me');
      
      // Update all states together at the very end
      setToken(data.access_token);
      setUser(userData);
      setIsAuthenticated(true);
      setIsLoading(false);
      return { success: true };
    } catch (err) {
      logger.error('Login failed:', err);
      setIsLoading(false);
      throw err;
    }
  }, []);

  /**
   * @brief Wipes local auth tokens, removes cached IDs, and informs backend API.
   */
  const logout = useCallback(async () => {
    localStorage.removeItem(STORAGE_KEYS.AUTH_TOKEN);
    if (isNative) {
      localStorage.removeItem(STORAGE_KEYS.REFRESH_TOKEN);
    }
    localStorage.removeItem('tanoclo_mobile_device_id');
    setToken(null);
    setUser(null);
    setIsAuthenticated(false);
    setIsLoading(false);
    
    // Call backend logout endpoint if authenticated
    if (token) {
      try {
        await fetch(`${getApiBase()}/api/logout`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });
      } catch (err) {
        logger.warn('API logout failed:', err);
      }
    }
  }, [token]);

  // Keep reference updated
  useEffect(() => { logoutRef.current = logout; }, [logout]);

  /**
   * @brief Handles PKCE authorization callback, exchanging single-use authorization code for active tokens.
   * @param {string} code - OAuth2 authorization code.
   */
  const handleAuthCallback = useCallback(async (code) => {
    setIsLoading(true);
    try {
      const data = await exchangeCodeForTokens(code);
      localStorage.setItem(STORAGE_KEYS.AUTH_TOKEN, data.access_token);
      if (isNative) {
        localStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, data.refresh_token);
      }
      
      // Fetch user profile using the token immediately
      const userData = await apiFetch('/api/v2/me');
      
      // Update all states together
      setToken(data.access_token);
      setUser(userData);
      setIsAuthenticated(true);
      setIsLoading(false);
    } catch (err) {
      logger.error('Error during authorization callback:', err);
      logout();
    }
  }, [logout]);

  // Effect 1: check URL parameters for OAuth code (runs on location changes or handler updates)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');

    if (code) {
      // Validate PKCE state parameter to prevent CSRF
      const savedState = localStorage.getItem('pkce_state');
      if (state && savedState && state !== savedState) {
        logger.error('[Auth] OAuth state mismatch — possible CSRF attack. Aborting.');
        localStorage.removeItem('pkce_code_verifier');
        localStorage.removeItem('pkce_redirect_uri');
        localStorage.removeItem('pkce_state');
        window.history.replaceState({}, document.title, window.location.pathname);
        setIsLoading(prev => prev ? false : prev);
        return;
      }
      // Clean URL search query params
      window.history.replaceState({}, document.title, window.location.pathname);
      handleAuthCallback(code);
    }
  }, [handleAuthCallback]);

  // Effect 2: Load user profile if token is present (only re-runs when token/user state changes)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (!code) {
      if (token && !user) {
        fetchUser();
      } else if (!token) {
        setIsLoading(prev => prev ? false : prev);
      }
    }
  }, [token, user, fetchUser]);

  // Apply language settings when user profile loads
  useEffect(() => {
    if (user && user.locale && i18n.language !== user.locale) {
      i18n.changeLanguage(user.locale).catch(err => {
        logger.error('Failed to change language to user locale:', err);
      });
    }
  }, [user]);

  /**
   * @brief Force refetch profile data (mutation wrapper).
   */
  const mutateUser = useCallback(async () => {
    if (token) {
      await fetchUser();
    }
  }, [token, fetchUser]);

  // Listen to logout events triggered by client.js
  useEffect(() => {
    const handleLogoutEvent = () => logout();
    window.addEventListener('auth_logout', handleLogoutEvent);
    return () => window.removeEventListener('auth_logout', handleLogoutEvent);
  }, [logout]);

  const value = {
    token,
    user,
    isAuthenticated,
    isLoading,
    login,
    loginWithCredentials,
    logout,
    mutateUser
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
