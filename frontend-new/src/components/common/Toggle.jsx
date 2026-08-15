/**
 * @file src/components/common/Toggle.jsx
 * @brief Renders a standard slide-switch toggle button.
 */



/**
 * @brief Switch toggle component.
 * @param {boolean} props.checked - Whether the toggle is currently active (on).
 * @param {function} props.onChange - Switch change callback handler.
 * @param {boolean} props.disabled - Boolean indicating if the toggle is disabled.
 * @param {string} props.label - Optional label text shown on the right.
 */
export default function Toggle({ 
  checked, 
  onChange, 
  disabled = false, 
  label = '', 
  ...props 
}) {
  return (
    <label style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '0.75rem',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.6 : 1,
      userSelect: 'none'
    }}>
      <div style={{
        position: 'relative',
        width: '44px',
        height: '24px',
        backgroundColor: checked ? 'var(--primary)' : 'var(--bg-input)',
        border: '1px solid var(--border-color)',
        borderRadius: '12px',
        transition: 'background-color var(--transition-fast)'
      }}>
        <input 
          type="checkbox"
          role="switch"
          aria-checked={checked}
          checked={checked}
          onChange={(e) => !disabled && onChange && onChange(e.target.checked)}
          disabled={disabled}
          style={{
            opacity: 0,
            position: 'absolute',
            width: '100%',
            height: '100%',
            margin: 0,
            cursor: 'inherit',
            zIndex: 1
          }}
          {...props}
        />
        <div style={{
          position: 'absolute',
          top: '2px',
          left: checked ? '22px' : '2px',
          width: '18px',
          height: '18px',
          backgroundColor: '#ffffff',
          borderRadius: '50%',
          boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
          transition: 'left var(--transition-fast) cubic-bezier(0.4, 0, 0.2, 1)'
        }} />
      </div>
      {label && (
        <span style={{ fontSize: '0.95rem', color: 'var(--text-primary)', fontWeight: 500 }}>
          {label}
        </span>
      )}
    </label>
  );
}
