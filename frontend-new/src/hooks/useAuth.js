/**
 * @file src/hooks/useAuth.js
 * @brief Custom hook wrapper for accessing authentication context.
 */

import { useContext } from 'react';
import { AuthContext } from '../context/AuthContext';

/**
 * @brief Custom hook to access credentials and profile functions from AuthContext.
 * @returns {object} Context values for authentication.
 */
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
