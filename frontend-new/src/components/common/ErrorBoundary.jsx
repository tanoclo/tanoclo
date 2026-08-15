/**
 * @file src/components/common/ErrorBoundary.jsx
 * @brief Standard React error boundary catching render failures at the root level.
 * 
 * Intercepts ChunkLoadErrors during updates, performs automated tab reloads,
 * and renders a fallback diagnostic page detailing caught exceptions.
 */

import { Component } from 'react';
import i18next from 'i18next';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import Card from './Card';
import Button from './Button';
import logger from '../../utils/logger';

/**
 * @brief ErrorBoundary React Component catching child node render crashes.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    logger.error('ErrorBoundary caught an error', error, errorInfo);

    // Auto-reload on chunk load error
    const msg = error ? (error.message || error.toString()) : '';
    const isChunkError = (
      /chunk/i.test(msg) ||
      /failed.+loading/i.test(msg) ||
      /dynamically imported module/i.test(msg) ||
      (error && error.name === 'ChunkLoadError')
    );

    if (isChunkError) {
      const lastReload = sessionStorage.getItem('tanoclo_chunk_error_reload');
      const now = Date.now();
      if (!lastReload || now - parseInt(lastReload, 10) > 10000) {
        sessionStorage.setItem('tanoclo_chunk_error_reload', now.toString());
        logger.warn('ErrorBoundary detected chunk load error. Auto-reloading...', error);
        window.location.reload();
      }
    }
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'var(--bg-app)',
          padding: '2rem'
        }}>
          <Card style={{
            maxWidth: '480px',
            width: '100%',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '1.5rem',
            padding: '2.5rem 2rem',
            borderColor: 'var(--danger)',
            boxShadow: '0 8px 32px 0 var(--danger-glow)'
          }}>
            <div style={{
              backgroundColor: 'var(--danger-glow)',
              color: 'var(--danger)',
              padding: '1rem',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '64px',
              height: '64px'
            }}>
              <AlertTriangle size={32} />
            </div>

            <div>
              <h2 style={{ fontSize: '1.5rem', fontWeight: 700, margin: '0 0 0.5rem', color: 'var(--text-primary)' }}>
                {i18next.t('common.error_boundary.title', 'Something went wrong.')}
              </h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: '1.5' }}>
                {i18next.t('common.error_boundary.desc', 'Application encountered an error.')}
              </p>
            </div>

            {this.state.error && (
              <pre style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                padding: '0.75rem',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--danger)',
                fontSize: '0.8rem',
                fontFamily: 'monospace',
                overflowX: 'auto',
                width: '100%',
                maxHeight: '120px',
                textAlign: 'left'
              }}>
                {this.state.error.toString()}
              </pre>
            )}

            <Button 
              variant="primary" 
              onClick={this.handleReload}
              style={{ width: '100%', padding: '0.875rem' }}
            >
              <RefreshCw size={18} />
              <span>{i18next.t('common.error_boundary.reload', 'Reload Application')}</span>
            </Button>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}
