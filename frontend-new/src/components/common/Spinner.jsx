/**
 * @file src/components/common/Spinner.jsx
 * @brief Standard loading indicator utilizing lucide loader icon with infinite spin keyframe.
 */


import { Loader2 } from 'lucide-react';

/**
 * @brief Activity spinner component.
 * @param {number} props.size - Dimension diameter size of the spinner icon.
 * @param {string} props.className - Custom CSS class parameters.
 * @param {object} props.style - Inline styling overrides.
 */
export default function Spinner({ size = 24, className = '', style = {}, ...props }) {
  return (
    <Loader2 
      size={size}
      className={className}
      style={{
        animation: 'spin 1s linear infinite',
        color: 'var(--primary)',
        ...style
      }}
      {...props}
    />
  );
}
