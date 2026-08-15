/**
 * @file src/i18n/index.js
 * @brief Internationalization (i18n) setup and language sync handlers.
 * 
 * Configures i18next to load JSON translation files (English, German, Dutch, French, Spanish, Italian).
 * Resolves initial locale by scanning browser cookies (`tado_locale`), localStorage configurations,
 * or navigator default languages. Automatically synchronizes updates to local cookies and localStorage
 * to ensure subsequent API calls match correct locale parameters.
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import de from './locales/de.json';
import nl from './locales/nl.json';
import fr from './locales/fr.json';
import es from './locales/es.json';
import it from './locales/it.json';
import { STORAGE_KEYS } from '../utils/constants';

/**
 * @brief Resolves active language preference from environment hooks.
 * @returns {string} Two-letter ISO language code.
 */
function getInitialLanguage() {
  // Try cookie first (tado_locale) - used to configure server redirects and locale formats
  const cookies = document.cookie.split(';');
  const localeCookie = cookies.find(c => c.trim().startsWith(`${STORAGE_KEYS.USER_LOCALE}=`));
  if (localeCookie) {
    const val = localeCookie.split('=')[1].trim();
    if (['en', 'de', 'nl', 'fr', 'es', 'it'].includes(val)) {
      return val;
    }
  }

  // Try local state cache
  const saved = localStorage.getItem(STORAGE_KEYS.USER_LOCALE);
  if (saved && ['en', 'de', 'nl', 'fr', 'es', 'it'].includes(saved)) {
    return saved;
  }

  // Fallback to browser configuration parameters
  const browserLang = navigator.language.split('-')[0];
  if (['en', 'de', 'nl', 'fr', 'es', 'it'].includes(browserLang)) {
    return browserLang;
  }

  return 'en';
}

const initialLang = getInitialLanguage();

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      de: { translation: de },
      nl: { translation: nl },
      fr: { translation: fr },
      es: { translation: es },
      it: { translation: it }
    },
    lng: initialLang,
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false // react already safes from xss
    }
  });

// Synchronize changes to cookies & localStorage when user changes language
i18n.on('languageChanged', (lng) => {
  localStorage.setItem(STORAGE_KEYS.USER_LOCALE, lng);
  document.cookie = `${STORAGE_KEYS.USER_LOCALE}=${lng}; path=/; max-age=31536000; SameSite=Lax`;
});

export default i18n;

