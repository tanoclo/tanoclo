/**
 * @file src/components/common/RouteErrorBoundary.jsx
 * @brief Segmented route-level boundary preventing single route crashes from failing the entire application.
 */

import React from 'react';
import i18next from 'i18next';
import logger from '../../utils/logger';

/**
 * @brief RouteErrorBoundary React Component wrapping nested sub-pages inside routes.
 */
export default class RouteErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    logger.error('[RouteErrorBoundary] Caught error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'var(--bg-app)',
          color: 'var(--text-primary)',
          padding: '2rem',
          textAlign: 'center',
          gap: '1rem'
        }}>
          <h2 style={{ margin: 0 }}>{i18next.t('common.route_error.title', 'Page Error')}</h2>
          <p style={{ color: 'var(--text-secondary)', maxWidth: '400px' }}>
            {this.state.error?.message || 'An unexpected error occurred.'}
          </p>
          <button
            onClick={() => {
              this.setState({ hasError: false, error: null });
              window.location.reload();
            }}
            style={{
              padding: '0.75rem 1.5rem',
              borderRadius: '8px',
              border: 'none',
              backgroundColor: 'var(--accent)',
              color: '#fff',
              fontSize: '1rem',
              cursor: 'pointer'
            }}
          >
            {i18next.t('common.route_error.return_home', 'Return Home')}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
