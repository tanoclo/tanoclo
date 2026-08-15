/**
 * @file src/components/common/ListItem.jsx
 * @brief Renders a standard item row for list arrays (like settings panels, room lists).
 * 
 * Supports icons, title, subtitle, inline values, click callbacks, hover animations,
 * and optional directional chevrons.
 */


import { ChevronRight } from 'lucide-react';

/**
 * @brief Renders a list item row.
 * @param {ReactNode} props.icon - Left side visual icon.
 * @param {ReactNode|string} props.title - Main row header label.
 * @param {string} props.subtitle - Descriptive sub-header row.
 * @param {string} props.value - Optional inline text value displayed on the right.
 * @param {function} props.onClick - Click event callback handler.
 * @param {boolean} props.showChevron - Whether to show the right ChevronRight indicator.
 * @param {object} props.style - Inline styling parameter overrides.
 */
export default function ListItem({ 
  icon, 
  title, 
  subtitle = '', 
  value = '', 
  onClick, 
  showChevron = true,
  style = {},
  ...props 
}) {
  const isClickable = !!onClick;

  return (
    <div 
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '1rem 1.25rem',
        backgroundColor: 'var(--bg-card)',
        borderBottom: '1px solid var(--border-color)',
        cursor: isClickable ? 'pointer' : 'default',
        transition: 'background-color var(--transition-fast)',
        userSelect: 'none',
        ...style
      }}
      onMouseEnter={(e) => {
        if (isClickable) {
          e.currentTarget.style.backgroundColor = 'var(--bg-card-hover)';
        }
      }}
      onMouseLeave={(e) => {
        if (isClickable) {
          e.currentTarget.style.backgroundColor = 'var(--bg-card)';
        }
      }}
      {...props}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flex: 1, minWidth: 0 }}>
        {icon && (
          <div style={{ display: 'flex', alignItems: 'center', color: 'var(--primary)' }}>
            {icon}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: '0.95rem' }}>
            {title}
          </span>
          {subtitle && (
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {subtitle}
            </span>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
        {value && (
          <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
            {value}
          </span>
        )}
        {isClickable && showChevron && (
          <ChevronRight size={18} style={{ color: 'var(--text-muted)' }} />
        )}
      </div>
    </div>
  );
}
