/**
 * @file src/components/common/FullPageSpinner.jsx
 * @brief Full page centered spinner indicator for route and session boot states.
 */

import Spinner from './Spinner';

export default function FullPageSpinner({ size = 32 }) {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'var(--bg-app)'
    }}>
      <Spinner size={size} />
    </div>
  );
}
