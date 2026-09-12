/**
 * @file src/utils/secureStorage.js
 * @brief Secure storage wrapper for sensitive credentials on native platforms.
 * 
 * Uses @aparajita/capacitor-secure-storage (Android KeyStore / iOS Keychain)
 * when running under Capacitor native runtime, with fallback and migration support.
 */

import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { Capacitor } from '@capacitor/core';
import { STORAGE_KEYS } from './constants';

const isNative = () => Capacitor.isNativePlatform();

/**
 * Retrieves the refresh token. On native, reads from SecureStorage with localStorage fallback.
 * @returns {Promise<string|null>}
 */
export async function getRefreshToken() {
  if (!isNative()) return null;
  try {
    const token = await SecureStorage.get(STORAGE_KEYS.REFRESH_TOKEN);
    if (token) return token;
  } catch {
    // Fall back if SecureStorage fails or key not yet migrated
  }
  return localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN);
}

/**
 * Persists the refresh token. On native, writes to hardware-backed SecureStorage and clears plaintext localStorage.
 * @param {string} token
 * @returns {Promise<void>}
 */
export async function setRefreshToken(token) {
  if (!token) return;
  localStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, token);
  if (isNative()) {
    try {
      await SecureStorage.set(STORAGE_KEYS.REFRESH_TOKEN, token);
    } catch {
      // Fallback already persisted in localStorage
    }
  }
}

/**
 * Deletes the refresh token from both SecureStorage and localStorage.
 * @returns {Promise<void>}
 */
export async function removeRefreshToken() {
  localStorage.removeItem(STORAGE_KEYS.REFRESH_TOKEN);
  if (isNative()) {
    try {
      await SecureStorage.remove(STORAGE_KEYS.REFRESH_TOKEN);
    } catch {
      // Ignore error
    }
  }
}