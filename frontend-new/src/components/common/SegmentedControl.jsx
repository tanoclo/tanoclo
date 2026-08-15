/**
 * @file src/components/common/SegmentedControl.jsx
 * @brief Renders a standard inline segmented toggle control block (e.g. tabs switch, unit switch).
 */



/**
 * @brief Segmented control switch component.
 * @param {Array} props.options - Array of items containing value, label, and optional icon parameters.
 * @param {any} props.value - Active selection value.
 * @param {function} props.onChange - Selection transition callback handler.
 * @param {object} props.style - Inline styling overrides.
 */
export default function SegmentedControl({ 
  options = [], 
  value, 
  onChange, 
  style = {},
  ...props 
}) {
  return (
    <div 
      style={{
        display: 'inline-flex',
        backgroundColor: 'var(--bg-input)',
        border: '1px solid var(--border-color)',
        borderRadius: 'var(--radius-md)',
        padding: '3px',
        width: '100%',
        ...style
      }}
      {...props}
    >
      {options.map((opt) => {
        const isActive = opt.value === value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange && onChange(opt.value)}
            style={{
              flex: 1,
              padding: '0.5rem 0.75rem',
              borderRadius: 'calc(var(--radius-md) - 3px)',
              border: 'none',
              backgroundColor: isActive ? 'var(--bg-card-hover)' : 'transparent',
              color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontWeight: isActive ? 600 : 400,
              fontSize: '0.875rem',
              cursor: 'pointer',
              boxShadow: isActive ? '0 2px 8px rgba(0,0,0,0.15)' : 'none',
              transition: 'background-color var(--transition-fast), color var(--transition-fast), box-shadow var(--transition-fast)',
              outline: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.375rem'
            }}
          >
            {opt.icon && opt.icon}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
