/**
 * @file src/context/ThemeContext.jsx
 * @brief Theme Provider context management supporting light, dark, and system default themes.
 * 
 * Synchronizes selected theme configurations with localStorage and applies a dynamic
 * `data-theme` attribute to the document root element. Monitors system media queries
 * to dynamically update theme preferences when 'system' is selected.
 */

import { createContext, useState, useEffect } from 'react';
import { STORAGE_KEYS } from '../utils/constants';

// React Context for exposing theme settings and toggle functions
export const ThemeContext = createContext(null);

/**
 * @brief ThemeProvider context component wrapper.
 * @param {object} props.children - Sub-components tree.
 */
export function ThemeProvider({ children }) {
  // Sync selected theme configuration with local storage parameters
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.THEME);
    if (saved && (saved === 'dark' || saved === 'light' || saved === 'system')) {
      return saved;
    }
    // Default to system theme as standard modern behavior
    return 'system';
  });

  // Keep track of resolved active theme (either 'light' or 'dark' after processing system media query)
  const [resolvedTheme, setResolvedTheme] = useState('dark');

  // Side-effect: apply appropriate class/attributes to document documentElement
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.THEME, theme);
    const root = window.document.documentElement;
    
    if (theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handleThemeChange = (e) => {
        if (e.matches) {
          root.removeAttribute('data-theme');
          setResolvedTheme('dark');
        } else {
          root.setAttribute('data-theme', 'light');
          setResolvedTheme('light');
        }
      };

      // Set initial state
      handleThemeChange(mediaQuery);

      // Listen for system theme preference transitions in real-time
      mediaQuery.addEventListener('change', handleThemeChange);
      return () => mediaQuery.removeEventListener('change', handleThemeChange);
    } else if (theme === 'light') {
      root.setAttribute('data-theme', 'light');
      setResolvedTheme(prev => prev !== 'light' ? 'light' : prev);
    } else {
      root.removeAttribute('data-theme');
      setResolvedTheme(prev => prev !== 'dark' ? 'dark' : prev);
    }
  }, [theme]);

  /**
   * @brief Toggles through active theme options: system -> light -> dark -> system
   */
  const toggleTheme = () => {
    setTheme(prev => {
      if (prev === 'system') return 'light';
      if (prev === 'light') return 'dark';
      return 'system';
    });
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme, resolvedTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
