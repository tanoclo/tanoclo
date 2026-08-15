/**
 * @file eslint.config.js
 * @brief ESLint flat configuration file for frontend-new code guidelines.
 * 
 * Defines global ignoring rules (like production distributions, Android files, and public assets)
 * and extends the recommended linting rules for React, React hooks, and Vite environments.
 */

import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Ignore build/transpiled files and platform directories
  globalIgnores(['dist', 'android', 'public/assets']),
  {
    // Apply rules to all source JavaScript and JSX files
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      // Configure global variables for modern browser environment
      globals: globals.browser,
      parserOptions: { 
        ecmaFeatures: { jsx: true } 
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      'react-hooks/set-state-in-effect': 'off',
      'react-refresh/only-export-components': 'off',
    },
  },
])
