/**
 * @file src/components/layout/Header.jsx
 * @brief Sticky top header component containing navigation actions.
 * 
 * Renders page titles, optional back navigation buttons, theme switches (light/dark/system loops),
 * and quick profile redirects showing active user initials.
 */

import { useContext } from 'react';
import { useNavigate } from 'react-router';
import { ThemeContext } from '../../context/ThemeContext';
import { useAuth } from '../../hooks/useAuth';
import { Sun, Moon, Laptop, User, ChevronLeft } from 'lucide-react';

/**
 * @brief Sticky top header component.
 * @param {string} props.title - Current route title text.
 * @param {boolean} props.showBack - Whether to show back navigation button.
 * @param {function} props.onBack - Back click event handler.
 */
export default function Header({ title = '', showBack = false, onBack }) {
  const { theme, toggleTheme } = useContext(ThemeContext);
  const { user } = useAuth();
  const navigate = useNavigate();

  return (
    <header className="app-header">
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {showBack && (
          <button
            onClick={onBack}
            style={{
              background: 'var(--bg-card-hover)',
              border: '1px solid var(--border-color)',
              borderRadius: '50%',
              width: '32px',
              height: '32px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: 'var(--text-primary)',
              flexShrink: 0
            }}
          >
            <ChevronLeft size={18} />
          </button>
        )}
        <h1 style={{
          fontSize: '1.25rem',
          fontWeight: 600,
          margin: 0,
          letterSpacing: '-0.3px',
          color: 'var(--text-primary)'
        }}>
          {title || 'TaNoClo'}
        </h1>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        {/* Theme Toggle Button */}
        <button
          onClick={toggleTheme}
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-secondary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '8px',
            borderRadius: '50%',
            transition: 'background-color var(--transition-fast)'
          }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-card-hover)'}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
        >
          {theme === 'light' ? <Moon size={20} /> : theme === 'dark' ? <Laptop size={20} /> : <Sun size={20} />}
        </button>

        {/* User Profile Info */}
        {user && (
          <div 
            onClick={() => navigate('/account')}
            style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: '0.5rem',
              cursor: 'pointer',
              padding: '4px 8px',
              borderRadius: '20px',
              transition: 'background-color var(--transition-fast)'
            }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-card-hover)'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
          >
            <div style={{
              width: '32px',
              height: '32px',
              borderRadius: '50%',
              backgroundColor: 'var(--bg-card-hover)',
              border: '1px solid var(--border-color)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-secondary)'
            }}>
              <User size={16} />
            </div>
            <span style={{
              fontSize: '0.875rem',
              color: 'var(--text-secondary)',
              fontWeight: 500
            }}>
              {user.name || 'User'}
            </span>
          </div>
        )}
      </div>
    </header>
  );
}
