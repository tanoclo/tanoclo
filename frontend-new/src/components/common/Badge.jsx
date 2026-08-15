/**
 * @file src/components/common/Badge.jsx
 * @brief Renders a status badge label using dynamic HSL variants.
 */



/**
 * @brief Renders a stylized badge indicator.
 * @param {ReactNode} props.children - Node components wrapped inside badge.
 * @param {string} props.variant - Theme styling variant ('info', 'success', 'warning', 'danger', 'secondary').
 * @param {object} props.style - Inline styling parameter overrides.
 */
export default function Badge({ 
  children, 
  variant = 'info', 
  style = {}, 
  ...props 
}) {
  const getStyles = () => {
    const base = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0.25rem 0.5rem',
      borderRadius: '20px',
      fontSize: '0.75rem',
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.05em',
      whiteSpace: 'nowrap'
    };

    switch (variant) {
      case 'success':
        return {
          ...base,
          backgroundColor: 'var(--success-glow)',
          border: '1px solid hsla(140, 70%, 45%, 0.3)',
          color: 'var(--success)'
        };
      case 'warning':
        return {
          ...base,
          backgroundColor: 'var(--warning-glow)',
          border: '1px solid hsla(40, 90%, 55%, 0.3)',
          color: 'var(--warning)'
        };
      case 'danger':
        return {
          ...base,
          backgroundColor: 'var(--danger-glow)',
          border: '1px solid hsla(0, 75%, 55%, 0.3)',
          color: 'var(--danger)'
        };
      case 'secondary':
        return {
          ...base,
          backgroundColor: 'var(--bg-card-hover)',
          border: '1px solid var(--border-color)',
          color: 'var(--text-secondary)'
        };
      case 'info':
      default:
        return {
          ...base,
          backgroundColor: 'hsla(200, 75%, 50%, 0.1)',
          border: '1px solid hsla(200, 75%, 50%, 0.3)',
          color: 'var(--info)'
        };
    }
  };

  return (
    <span style={{ ...getStyles(), ...style }} {...props}>
      {children}
    </span>
  );
}
