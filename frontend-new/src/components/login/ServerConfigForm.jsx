/**
 * @file src/components/login/ServerConfigForm.jsx
 * @brief Renders the custom server endpoint setting input form on the Login Page.
 */


import { Globe, RefreshCw } from 'lucide-react';

/**
 * @brief Server configuration input sub-panel.
 * @param {string} props.inputUrl - Current user input URL string.
 * @param {function} props.setInputUrl - Input state setter.
 * @param {function} props.handleConnect - Verify and save connection dispatch callback.
 * @param {boolean} props.isConnecting - Verification connection status indicator.
 * @param {string} props.errorMsg - Verification connection error message.
 * @param {string} props.serverUrl - Saved target server URL parameter.
 * @param {function} props.setShowConfig - Config overlay visibility setter.
 * @param {function} props.t - Translation mapping hook.
 */
export default function ServerConfigForm({
  inputUrl,
  setInputUrl,
  handleConnect,
  isConnecting,
  errorMsg,
  serverUrl,
  setShowConfig,
  t
}) {
  return (
    <form onSubmit={handleConnect} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', textAlign: 'left' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
          {t('auth.server_url')}
        </label>
        <div style={{ position: 'relative' }}>
          <input 
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            placeholder={t('auth.server_placeholder')}
            style={{
              width: '100%',
              padding: '0.75rem 1rem 0.75rem 2.25rem',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-color)',
              background: 'var(--bg-input)',
              color: 'var(--text-primary)',
              fontSize: '0.95rem',
              outline: 'none',
              transition: 'border-color var(--transition-fast)'
            }}
            disabled={isConnecting}
          />
          <Globe size={16} style={{ position: 'absolute', left: '0.85rem', top: '1rem', color: 'var(--text-muted)' }} />
        </div>
      </div>

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
        disabled={isConnecting}
        style={{
          width: '100%',
          padding: '0.875rem',
          borderRadius: 'var(--radius-md)',
          border: 'none',
          background: 'linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%)',
          color: 'white',
          fontWeight: 600,
          fontSize: '0.95rem',
          cursor: isConnecting ? 'not-allowed' : 'pointer',
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.5rem',
          marginTop: '0.5rem'
        }}
      >
        {isConnecting ? (
          <>
            <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite' }} />
            <span>{t('auth.verifying_connection')}</span>
          </>
        ) : (
          <span>{t('auth.verify_save')}</span>
        )}
      </button>

      {serverUrl && (
        <button
          type="button"
          onClick={() => setShowConfig(false)}
          style={{
            width: '100%',
            padding: '0.75rem',
            borderRadius: 'var(--radius-md)',
            border: '1px solid hsla(220, 20%, 30%, 0.25)',
            background: 'transparent',
            color: 'var(--text-secondary)',
            fontSize: '0.9rem',
            cursor: 'pointer',
            textAlign: 'center',
            marginTop: '0.25rem'
          }}
        >
          {t('common.cancel')}
        </button>
      )}
    </form>
  );
}
