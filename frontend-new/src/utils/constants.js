/**
 * @file src/utils/constants.js
 * @brief Global constant configurations and API base URL resolution utility.
 */

import { Capacitor } from '@capacitor/core';

/**
 * @brief Resolves target API server endpoint based on runtime platform (Web vs Native).
 * @returns {string} Fully qualified base API target address or empty string.
 */
export const getApiBase = () => {
  if (!Capacitor.isNativePlatform()) {
    // For standard web environments, use relative URLs (devServer proxy handles routing)
    return '';
  }
  // For native platforms (where asset protocol is file://), read custom Server URL from localStorage or configuration
  return localStorage.getItem('tanoclo_server_url') || import.meta.env.VITE_API_BASE || '';
};

// Supported application locales
export const LOCALES = {
  EN: 'en',
  DE: 'de',
  NL: 'nl',
  FR: 'fr',
  ES: 'es',
  IT: 'it'
};

// Keys used for localStorage parameters persistence
export const STORAGE_KEYS = {
  AUTH_TOKEN: 'tanoclo_token',
  REFRESH_TOKEN: 'tanoclo_refresh_token',
  THEME: 'tanoclo_theme',
  USER_LOCALE: 'tado_locale'
};

// Manual override modes matching Tado API endpoints
export const MANUAL_OVERLAY_MODES = {
  NEXT_CHANGE: 'TADO_MODE', // Follows schedule till next block transition
  TIMER: 'TIMER',           // Follows override for custom duration
  RESUME: 'MANUAL'          // Manual override indefinitely until cleared
};

// Zone types definitions
export const ZONE_TYPES = {
  HEATING: 'HEATING',
  DHW: 'HOT_WATER'          // Domestic Hot Water
};

// Default temperatures in Celsius
export const DEFAULT_TEMPERATURES = {
  HEATING: 20.0,
  AWAY: 15.0,
  FROST_PROTECTION: 5.0
};

// Temperature configuration step ranges
export const TEMP_MIN_HEATING = 5.0;
export const TEMP_MIN_DHW = 29.0;
export const TEMP_MAX_DEFAULT = 25.0;
export const TEMP_STEP = 0.5;

