/**
 * @file src/components/common/Toast.jsx
 * @brief Individual notification banner rendered by ToastContext.
 * 
 * Supports auto-dismissal timeouts, semantic types (info, success, warning, error),
 * and custom icons matching each type.
 */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, AlertTriangle, AlertCircle, Info, X } from 'lucide-react';

/**
 * @brief Individual Toast alert item.
 * @param {string} props.message - Descriptive notification text.
 * @param {string} props.type - Theme style variant ('info', 'success', 'warning', 'error').
 * @param {number} props.duration - Active lifespan duration in ms before triggering onClose.
 * @param {function} props.onClose - Dismissal callback hook.
 */
export default function Toast({ 
  message, 
  type = 'info', 
  duration = 4000, 
  onClose 
}) {
  const { t } = useTranslation();

  useEffect(() => {
    if (duration > 0 && onClose) {
      const timer = setTimeout(() => {
        onClose();
      }, duration);
      return () => clearTimeout(timer);
    }
  }, [duration, onClose]);

  const getTheme = () => {
    switch (type) {
      case 'success':
        return {
          color: 'var(--success)',
          icon: <CheckCircle size={18} style={{ color: 'var(--success)' }} />
        };
      case 'warning':
        return {
          color: 'var(--warning)',
          icon: <AlertTriangle size={18} style={{ color: 'var(--warning)' }} />
        };
      case 'error':
        return {
          color: 'var(--danger)',
          icon: <AlertCircle size={18} style={{ color: 'var(--danger)' }} />
        };
      case 'info':
      default:
        return {
          color: 'var(--info)',
          icon: <Info size={18} style={{ color: 'var(--info)' }} />
        };
    }
  };

  const theme = getTheme();
  const displayMessage = typeof message === 'string' 
    ? t(`errors.${message}`, { defaultValue: t(message, { defaultValue: message }) }) 
    : message;

  return (
    <div 
      className="glass-panel animate-fade-in"
      style={{
        backgroundColor: 'var(--bg-card)',
        border: '1px solid var(--border-color)',
        borderLeft: `4px solid ${theme.color}`,
        color: 'var(--text-primary)',
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        padding: '0.875rem 1.25rem',
        boxShadow: 'var(--glass-shadow)',
        borderRadius: 'var(--radius-md)',
        maxWidth: '360px',
        width: '100%',
        pointerEvents: 'auto',
        overflow: 'hidden'
      }}
    >
      {theme.icon}
      <span style={{ fontSize: '0.9rem', fontWeight: 500, flex: 1 }}>
        {displayMessage}
      </span>
      {onClose && (
        <button 
          onClick={onClose}
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'inherit',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '2px',
            opacity: 0.7,
            transition: 'opacity var(--transition-fast)'
          }}
          onMouseEnter={(e) => e.currentTarget.style.opacity = 1}
          onMouseLeave={(e) => e.currentTarget.style.opacity = 0.7}
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}
