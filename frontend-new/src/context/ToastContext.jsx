/**
 * @file src/context/ToastContext.jsx
 * @brief Toast notification provider context displaying popup messages at the screen bottom.
 * 
 * Provides unified function to dispatch temporary alerts (success, info, warning, error)
 * that automatically dismiss after a duration. Handles layouts considering safe area insets.
 */

import { createContext, useState, useCallback, useContext } from 'react';
import Toast from '../components/common/Toast';

// React Context for exposing toast trigger functions
const ToastContext = createContext(null);

/**
 * @brief ToastProvider context component wrapper.
 * @param {object} props.children - Sub-components tree.
 */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  /**
   * @brief Dispatches a new notification popup toast.
   * @param {string} message - Notification text content.
   * @param {string} type - Toast semantic type ('success', 'error', 'info', 'warning').
   * @param {number} duration - Lifespan duration in ms before auto dismissal.
   */
  const showToast = useCallback((message, type = 'success', duration = 4000) => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type, duration }]);
  }, []);

  /**
   * @brief Removes a toast by its identifier.
   * @param {number} id - Target toast identifier.
   */
  const dismissToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {/* Absolute container positioning toasts above standard layouts and bottom bars */}
      <div style={{
        position: 'fixed',
        bottom: 'calc(env(safe-area-inset-bottom, 0px) + 80px)',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 2000,
        display: 'flex',
        flexDirection: 'column-reverse',
        gap: '0.5rem',
        width: '90%',
        maxWidth: '400px',
        pointerEvents: 'none'
      }}>
        {toasts.map(t => (
          <Toast
            key={t.id}
            message={t.message}
            type={t.type}
            duration={t.duration}
            onClose={() => dismissToast(t.id)}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * @brief Custom hook to trigger semantic notifications.
 * @returns {object} Toast trigger function hook context wrapper.
 */
export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
