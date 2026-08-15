/**
 * @file src/api/auth.js
 * @brief Handles OAuth2 authorization code flow with PKCE verification security.
 * 
 * Generates client challenges, exchanges auth codes for tokens, and performs token refresh requests.
 */

import { getApiBase } from '../utils/constants';

// Helper to generate a cryptographically secure random string of a given length
function generateRandomString(length) {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const randomValues = new Uint8Array(length);
  window.crypto.getRandomValues(randomValues);
  let text = '';
  for (let i = 0; i < length; i++) {
    text += possible.charAt(randomValues[i] % possible.length);
  }
  return text;
}

// Helper to calculate SHA-256 of a string and encode it in base64url
async function generateCodeChallenge(codeVerifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await window.crypto.subtle.digest('SHA-256', data);
  
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Initiates the PKCE login flow.
 * Generates code verifier/challenge, stores verifier in localStorage,
 * and redirects browser to /oauth2/authorize.
 */
export async function initiateLoginFlow() {
  const codeVerifier = generateRandomString(64);
  localStorage.setItem('pkce_code_verifier', codeVerifier);

  const codeChallenge = await generateCodeChallenge(codeVerifier);
  
  // Save current location to return to it after authentication
  const currentUrl = new URL(window.location.href);
  const redirectUri = `${currentUrl.origin}/`;
  localStorage.setItem('pkce_redirect_uri', redirectUri);

  const state = generateRandomString(16);
  localStorage.setItem('pkce_state', state);

  const params = new URLSearchParams({
    client_id: 'tado-mobile-app',
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'home.user offline_access',
    state: state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  });

  window.location.href = `${getApiBase()}/oauth2/authorize?${params.toString()}`;
}

/**
 * Exchanges auth code for tokens
 * @param {string} code
 * @returns {Promise<object>}
 */
export async function exchangeCodeForTokens(code) {
  const codeVerifier = localStorage.getItem('pkce_code_verifier');
  const redirectUri = localStorage.getItem('pkce_redirect_uri') || `${window.location.origin}/`;

  if (!codeVerifier) {
    throw new Error('No PKCE code verifier found in storage');
  }

  const response = await fetch(`${getApiBase()}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    credentials: 'include',  // Accept httpOnly refresh token cookie from server
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: 'tado-mobile-app',
      code: code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error_description || errorData.error || 'Failed to exchange authorization code');
  }

  const data = await response.json();
  
  // Clean up PKCE storage
  localStorage.removeItem('pkce_code_verifier');
  localStorage.removeItem('pkce_redirect_uri');
  localStorage.removeItem('pkce_state');

  return data;
}

/**
 * Refreshes the access token using refresh token.
 * On web, the httpOnly cookie carries the refresh token automatically.
 * On native (Capacitor), the token is passed explicitly in the body.
 * @param {string} [refreshToken] - Refresh token (required on native, optional on web).
 * @returns {Promise<object>}
 */
export async function refreshAccessToken(refreshToken) {
  const params = {
    grant_type: 'refresh_token',
    client_id: 'tado-mobile-app',
  };

  // Native clients pass the refresh token explicitly; web clients rely on httpOnly cookie
  if (refreshToken) {
    params.refresh_token = refreshToken;
  }

  const response = await fetch(`${getApiBase()}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    credentials: 'include',  // Send httpOnly cookies (tanoclo_rt) with the request
    body: new URLSearchParams(params)
  });

  if (!response.ok) {
    throw new Error('Failed to refresh access token');
  }

  return response.json();
}
