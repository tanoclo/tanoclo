/**
 * @file src/components/common/Button.jsx
 * @brief Stylized action button component supporting multiple design variants.
 */



/**
 * @brief Standard button component wrapper.
 * @param {string} props.variant - Theme style variant ('primary', 'secondary', 'destructive', 'text').
 * @param {string} props.className - CSS class configuration.
 * @param {object} props.style - Inline styling override configurations.
 * @param {boolean} props.disabled - Boolean indicating if the button is disabled.
 * @param {function} props.onClick - Click callback handler.
 */
export default function Button({ 
  children, 
  variant = 'primary', 
  className = '', 
  style = {}, 
  disabled = false, 
  onClick, 
  ...props 
}) {
  const getStyles = () => {
    const base = {
      padding: '0.625rem 1.25rem',
      borderRadius: 'var(--radius-sm)',
      fontWeight: 500,
      fontSize: '0.9rem',
      border: 'none',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.6 : 1,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '0.5rem',
      transition: 'all var(--transition-fast)',
      fontFamily: 'inherit',
      outline: 'none'
    };

    if (variant === 'primary') {
      return {
        ...base,
        background: 'linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%)',
        color: '#ffffff',
        boxShadow: '0 4px 12px var(--primary-glow)'
      };
    } else if (variant === 'secondary') {
      return {
        ...base,
        backgroundColor: 'var(--bg-card-hover)',
        border: '1px solid var(--border-color)',
        color: 'var(--text-primary)'
      };
    } else if (variant === 'destructive') {
      return {
        ...base,
        background: 'linear-gradient(135deg, var(--danger) 0%, hsl(0, 75%, 65%) 100%)',
        color: '#ffffff',
        boxShadow: '0 4px 12px var(--danger-glow)'
      };
    } else if (variant === 'text') {
      return {
        ...base,
        backgroundColor: 'transparent',
        color: 'var(--text-secondary)',
        padding: '0.5rem'
      };
    }
    return base;
  };

  return (
    <button
      className={className}
      disabled={disabled}
      onClick={onClick}
      style={{ ...getStyles(), ...style }}
      {...props}
    >
      {children}
    </button>
  );
}
