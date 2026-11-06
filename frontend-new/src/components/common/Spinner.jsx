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
  let pixelSize;
  if (typeof size === 'number') {
    pixelSize = size;
  } else if (size === 'sm' || size === 'small') {
    pixelSize = 16;
  } else if (size === 'md' || size === 'medium') {
    pixelSize = 24;
  } else if (size === 'lg' || size === 'large') {
    pixelSize = 32;
  } else {
    pixelSize = parseInt(size, 10) || 24;
  }

  return (
    <Loader2
      size={pixelSize}
      className={className}
      style={{
        animation: 'spin 1s linear infinite',
        color: 'var(--primary)',
        width: `${pixelSize}px`,
        height: `${pixelSize}px`,
        flexShrink: 0,
        ...style
      }}
      {...props}
    />
  );
}