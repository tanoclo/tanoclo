/**
 * @file src/components/login/LoginForm.jsx
 * @brief Renders the credentials inputs form on the Login Page.
 */


import { RefreshCw } from 'lucide-react';

/**
 * @brief Login form sub-panel.
 * @param {string} props.username - Current username state.
 * @param {function} props.setUsername - Username state setter.
 * @param {string} props.password - Current password state.
 * @param {function} props.setPassword - Password state setter.
 * @param {boolean} props.remember - Boolean indicating remember session choice.
 * @param {function} props.setRemember - Remember state setter.
 * @param {function} props.handleLogin - Sign-in dispatch handler callback.
 * @param {boolean} props.isLoggingIn - Loading boolean representing authentication request status.
 * @param {string} props.errorMsg - Error message text displayed below form.
 * @param {boolean} props.isNative - Whether the app runs on a native mobile wrapper.
 * @param {string} props.serverUrl - Target backend server URL.
 * @param {function} props.setShowConfig - Visibility state setter of ServerConfigForm.
 * @param {function} props.setInputUrl - Input url state setter.
 * @param {function} props.t - Language translation resolver.
 */
export default function LoginForm({
  username,
  setUsername,
  password,
  setPassword,
  remember,
  setRemember,
  handleLogin,
  isLoggingIn,
  errorMsg,
  isNative,
  serverUrl,
  setShowConfig,
  setInputUrl,
  t
}) {
  return (
    <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', textAlign: 'left' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
          {t('auth.username_or_email', { defaultValue: 'Username or Email' })}
        </label>
        <input 
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="name@example.com"
          required
          style={{
            width: '100%',
            padding: '0.75rem 1rem',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-color)',
            background: 'var(--bg-input)',
            color: 'var(--text-primary)',
            fontSize: '0.95rem',
            outline: 'none',
            transition: 'border-color var(--transition-fast)'
          }}
          disabled={isLoggingIn}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
          {t('auth.password', { defaultValue: 'Password' })}
        </label>
        <input 
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          required
          style={{
            width: '100%',
            padding: '0.75rem 1rem',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-color)',
            background: 'var(--bg-input)',
            color: 'var(--text-primary)',
            fontSize: '0.95rem',
            outline: 'none',
            transition: 'border-color var(--transition-fast)'
          }}
          disabled={isLoggingIn}
        />
      </div>

      {!isNative && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.25rem' }}>
          <input 
            type="checkbox"
            id="remember"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            disabled={isLoggingIn}
            style={{
              width: '16px',
              height: '16px',
              cursor: 'pointer',
              accentColor: 'var(--primary)'
            }}
          />
          <label htmlFor="remember" style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' }}>
            {t('auth.remember_me', { defaultValue: 'Remember Me' })}
          </label>
        </div>
      )}

      {errorMsg && (
        <div style={{
          fontSize: '0.85rem',
          color: 'var(--danger)',
          backgroundColor: 'hsla(0, 75%, 55%, 0.08)',
          border: '1px solid hsla(0, 75%, 55%, 0.15)',
          padding: '0.75rem',
          borderRadius: 'var(--radius-md)',
          lineHeight: 1.4
        }}>
          {errorMsg}
        </div>
      )}

      <button 
        type="submit"
        disabled={isLoggingIn}
        style={{
          width: '100%',
          padding: '0.875rem',
          borderRadius: 'var(--radius-md)',
          border: 'none',
          background: 'linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%)',
          color: 'white',
          fontWeight: 600,
          fontSize: '0.95rem',
          cursor: isLoggingIn ? 'not-allowed' : 'pointer',
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.5rem',
          marginTop: '0.5rem'
        }}
      >
        {isLoggingIn ? (
          <>
            <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite' }} />
            <span>{t('auth.signing_in', { defaultValue: 'Signing In...' })}</span>
          </>
        ) : (
          <span>{t('auth.login', { defaultValue: 'Sign In' })}</span>
        )}
      </button>

      {isNative && serverUrl && (
        <button
          type="button"
          onClick={() => {
            setInputUrl(serverUrl);
            setShowConfig(true);
          }}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-muted)',
            fontSize: '0.85rem',
            textDecoration: 'underline',
            cursor: 'pointer',
            marginTop: '1.25rem',
            textAlign: 'center'
          }}
        >
          {t('settings.change_server')} ({serverUrl.replace(/^https?:\/\//i, '')})
        </button>
      )}
    </form>
  );
}
