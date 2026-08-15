/**
 * @file src/utils/logger.js
 * @brief Dynamic client-side logger supporting runtime log level modifications.
 * 
 * Defines log levels (SILENT, ERROR, WARN, INFO, DEBUG) and reads initial configurations
 * from localStorage or environments. Attaches a window-level reference `window.tanocloLog`
 * to let developers query or toggle logging output on the fly in the browser console.
 */

// Integer priority scores for semantic logging levels
const LOG_LEVELS = { SILENT: 0, ERROR: 1, WARN: 2, INFO: 3, DEBUG: 4 };

/**
 * @brief Resolves active log level priority on startup.
 * @returns {number} Log level integer priority.
 */
function getLevel() {
  try {
    const stored = localStorage.getItem('tanoclo_log_level');
    if (stored && LOG_LEVELS[stored.toUpperCase()] !== undefined) {
      return LOG_LEVELS[stored.toUpperCase()];
    }
  } catch (_e) {
    /* ignore localStorage unavailable */
  }
  return import.meta.env.DEV ? LOG_LEVELS.DEBUG : LOG_LEVELS.WARN;
}

let currentLevel = getLevel();

// Semantic log dispatch object
const logger = {
  debug: (...args) => currentLevel >= LOG_LEVELS.DEBUG && console.debug('[DEBUG]', ...args),
  info:  (...args) => currentLevel >= LOG_LEVELS.INFO  && console.info('[INFO]', ...args),
  warn:  (...args) => currentLevel >= LOG_LEVELS.WARN  && console.warn('[WARN]', ...args),
  error: (...args) => currentLevel >= LOG_LEVELS.ERROR && console.error('[ERROR]', ...args),
  
  /**
   * @brief Modifies active log level at runtime.
   * @param {string} level - Log level name.
   */
  setLevel: (level) => {
    currentLevel = LOG_LEVELS[level.toUpperCase()] ?? currentLevel;
    try { localStorage.setItem('tanoclo_log_level', level.toUpperCase()); } catch (_e) {
      /* ignore localStorage unavailable */
    }
  },
  
  /**
   * @brief Returns current active level name.
   * @returns {string} Level name.
   */
  getLevel: () => Object.keys(LOG_LEVELS).find(k => LOG_LEVELS[k] === currentLevel) || 'WARN',
};

// Bind to window to allow runtime modifications in the web browser inspect console
if (typeof window !== 'undefined') window.tanocloLog = logger;

export default logger;

