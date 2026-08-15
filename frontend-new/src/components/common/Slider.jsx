/**
 * @file src/components/common/Slider.jsx
 * @brief Renders a standard range slider input element with headers.
 */



/**
 * @brief Slider input component.
 * @param {number} props.value - Active selection value.
 * @param {function} props.onChange - Value transition callback handler.
 * @param {number} props.min - Minimum slider value boundary.
 * @param {number} props.max - Maximum slider value boundary.
 * @param {number} props.step - Slider step increments.
 * @param {string} props.label - Descriptive label text.
 * @param {string} props.unit - Optional value unit parameter (e.g. °C, %).
 * @param {boolean} props.disabled - Whether input selection is disabled.
 */
export default function Slider({ 
  value, 
  onChange, 
  min = 5, 
  max = 25, 
  step = 0.5, 
  label = '', 
  unit = '', 
  disabled = false,
  ...props 
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', width: '100%' }}>
      {(label || value != null) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {label && (
            <span style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
              {label}
            </span>
          )}
          {value != null && (
            <span style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--primary-light)' }}>
              {value}{unit}
            </span>
          )}
        </div>
      )}
      <input 
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => !disabled && onChange && onChange(Number(e.target.value))}
        disabled={disabled}
        style={{
          width: '100%',
          height: '6px',
          borderRadius: '3px',
          backgroundColor: 'var(--bg-input)',
          outline: 'none',
          WebkitAppearance: 'none',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          accentColor: 'var(--primary)'
        }}
        {...props}
      />
    </div>
  );
}
