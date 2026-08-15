/**
 * @file src/pages/LoginPage.jsx
 * @brief Renders the application user login screen.
 * 
 * Handles user authentication (credentials-based passwords) and triggers native server
 * destination validation redirects. Configures health check connections to `/api/public/health`
 * when establishing custom server endpoints.
 */

import { useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useTranslation } from 'react-i18next';
import { Flame } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import logger from '../utils/logger';
import LoginForm from '../components/login/LoginForm';
import ServerConfigForm from '../components/login/ServerConfigForm';

/**
 * @brief Renders login credentials forms or server url selector overlays.
 */
export default function LoginPage() {
  const { _login, loginWithCredentials } = useAuth();
  const { t } = useTranslation();

  const isNative = Capacitor.isNativePlatform();
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem('tanoclo_server_url') || '');
  const [inputUrl, setInputUrl] = useState(serverUrl);
  const [isConnecting, setIsConnecting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [showConfig, setShowConfig] = useState(!serverUrl && isNative);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(() => isNative);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  /**
   * @brief Dispatches credentials sign-in request to AuthContext.
   */
  const handleLogin = async (e) => {
    e.preventDefault();
    setErrorMsg('');
    setIsLoggingIn(true);

    try {
      await loginWithCredentials(username, password, remember);
    } catch (err) {
      setErrorMsg(err.message || 'Login failed');
    } finally {
      setIsLoggingIn(false);
    }
  };

  /**
   * @brief Connects to the user-entered server endpoint and validates its health status.
   */
  const handleConnect = async (e) => {
    e.preventDefault();
    setErrorMsg('');
    setIsConnecting(true);

    let url = inputUrl.trim();
    if (!url) {
      setErrorMsg(t('auth.error_empty_url'));
      setIsConnecting(false);
      return;
    }

    if (url.endsWith('/')) {
      url = url.slice(0, -1);
    }

    if (!/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }

    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 8000); // 8 seconds connection timeout

      const response = await fetch(`${url}/api/public/health`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        mode: 'cors',
        signal: controller.signal
      });
      clearTimeout(id);

      if (!response.ok) {
        throw new Error(`Server returned status ${response.status}`);
      }

      const data = await response.json();
      if (data && (data.status === 'ok' || data.status === 'healthy')) {
        localStorage.setItem('tanoclo_server_url', url);
        setServerUrl(url);
        setShowConfig(false);
        window.location.reload();
      } else {
        throw new Error('Server health check returned invalid status');
      }
    } catch (err) {
      logger.error('Connection check failed:', err);
      setErrorMsg(t('auth.error_connect_fail'));
    } finally {
      setIsConnecting(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '1.5rem',
      background: 'linear-gradient(135deg, var(--bg-app) 0%, var(--bg-card) 100%)',
      position: 'relative',
      overflow: 'hidden'
    }}>
      {/* Background Decorative Blobs */}
      <div style={{
        position: 'absolute',
        width: '400px',
        height: '400px',
        borderRadius: '50%',
        background: 'radial-gradient(circle, hsla(220, 85%, 55%, 0.15) 0%, transparent 70%)',
        top: '-100px',
        right: '-100px',
        zIndex: 0
      }} />
      <div style={{
        position: 'absolute',
        width: '500px',
        height: '500px',
        borderRadius: '50%',
        background: 'radial-gradient(circle, hsla(160, 70%, 45%, 0.1) 0%, transparent 70%)',
        bottom: '-150px',
        left: '-150px',
        zIndex: 0
      }} />

      <div className="glass-panel animate-scale-in" style={{
        padding: '2.5rem',
        maxWidth: '440px',
        width: '100%',
        textAlign: 'center',
        position: 'relative',
        zIndex: 1,
        border: '1px solid var(--border-color)'
      }}>
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '64px',
          height: '64px',
          borderRadius: '16px',
          background: 'linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%)',
          boxShadow: '0 8px 16px rgba(0, 0, 0, 0.2)',
          marginBottom: '1.5rem'
        }}>
          <Flame size={32} color="#fff" />
        </div>

        <h1 style={{
          fontSize: '2rem',
          fontWeight: 700,
          marginBottom: '2.5rem',
          color: 'var(--text-primary)',
          letterSpacing: '-0.5px'
        }}>
          {showConfig ? t('auth.configure_server') : t('auth.title')}
        </h1>

        {showConfig ? (
          <ServerConfigForm
            inputUrl={inputUrl}
            setInputUrl={setInputUrl}
            handleConnect={handleConnect}
            isConnecting={isConnecting}
            errorMsg={errorMsg}
            serverUrl={serverUrl}
            setShowConfig={setShowConfig}
            t={t}
          />
        ) : (
          <LoginForm
            username={username}
            setUsername={setUsername}
            password={password}
            setPassword={setPassword}
            remember={remember}
            setRemember={setRemember}
            handleLogin={handleLogin}
            isLoggingIn={isLoggingIn}
            errorMsg={errorMsg}
            isNative={isNative}
            serverUrl={serverUrl}
            setShowConfig={setShowConfig}
            setInputUrl={setInputUrl}
            t={t}
          />
        )}

        <p style={{
          fontSize: '0.75rem',
          color: 'var(--text-muted)',
          marginTop: '2rem'
        }}>
          TaNoClo
        </p>
        <p style={{
          fontSize: '0.65rem',
          color: 'var(--text-muted)',
          marginTop: '1rem',
          lineHeight: '1.4',
          maxWidth: '320px',
          marginLeft: 'auto',
          marginRight: 'auto'
        }}>
          {t('common.disclaimer')}
        </p>
      </div>
    </div>
  );
}
