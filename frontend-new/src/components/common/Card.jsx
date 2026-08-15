/**
 * @file src/components/common/Card.jsx
 * @brief Renders the base glassmorphism layout card container.
 */



/**
 * @brief Layout container wrapper.
 * @param {string} props.className - Custom CSS class parameters.
 * @param {object} props.style - Inline styling overrides.
 * @param {function} props.onClick - Click event callback hook.
 */
export default function Card({ children, className = '', style = {}, onClick, ...props }) {
  const isClickable = !!onClick;
  
  return (
    <div 
      className={`glass-panel ${className}`}
      onClick={onClick}
      style={{
        padding: '1.25rem',
        cursor: isClickable ? 'pointer' : 'default',
        transition: 'transform var(--transition-fast), border-color var(--transition-fast), background-color var(--transition-fast)',
        outline: 'none',
        ...style
      }}
      {...props}
    >
      {children}
    </div>
  );
}
