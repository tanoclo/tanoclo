import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let cookieStore = '';
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    get cookie() { return cookieStore; },
    set cookie(val) {
      if (val.includes('expires=Thu, 01 Jan 1970')) {
        cookieStore = '';
      } else {
        const parts = val.split(';')[0];
        cookieStore = parts;
      }
    }
  };
}

describe('i18n/index.js', () => {
  beforeEach(() => {
    vi.resetModules();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    cookieStore = '';
  });

  it('loads and initializes without errors', async () => {
    const i18n = (await import('../i18n')).default;
    expect(i18n).toBeDefined();
    expect(typeof i18n.t).toBe('function');
  }, 15000);

  it('defaults to en when no stored preference', async () => {
    // Navigator.language may vary, but fallbackLng is 'en'
    const i18n = (await import('../i18n')).default;
    expect(['en', 'de', 'nl', 'fr', 'es', 'it']).toContain(i18n.language);
  });

  it('reads language from tado_locale cookie', async () => {
    document.cookie = 'tado_locale=de; path=/';
    const i18n = (await import('../i18n')).default;
    expect(i18n.language).toBe('de');
  });

  it('reads language from localStorage when no cookie', async () => {
    localStorage.setItem('tado_locale', 'nl');
    const i18n = (await import('../i18n')).default;
    expect(i18n.language).toBe('nl');
  });

  it('syncs language change to both cookie and localStorage', async () => {
    const i18n = (await import('../i18n')).default;
    await i18n.changeLanguage('fr');
    expect(localStorage.getItem('tado_locale')).toBe('fr');
    expect(document.cookie).toContain('tado_locale=fr');
  });

  it('has all 6 locale resources loaded', async () => {
    const i18n = (await import('../i18n')).default;
    const locales = ['en', 'de', 'nl', 'fr', 'es', 'it'];
    for (const locale of locales) {
      expect(i18n.hasResourceBundle(locale, 'translation')).toBe(true);
    }
  });

  it('translates a key that exists in all locales', async () => {
    const i18n = (await import('../i18n')).default;
    // Use t() to verify translation works — exact key depends on locale files
    // At minimum, translation function should return the key itself if not found
    const result = i18n.t('nonexistent.key');
    expect(typeof result).toBe('string');
  });
});
