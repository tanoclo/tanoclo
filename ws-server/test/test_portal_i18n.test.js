/**
 * @file test/test_portal_i18n.test.js
 * @brief Vitest testing suite validating Setup Portal internationalization (i18n).
 */

'use strict';

const assert = require('assert');
const { DICTIONARIES, SUPPORTED_LOCALES, renderLanguageSelector } = require('../api/routes/setup/portal/i18n');

test('Setup Portal i18n supports all 6 application locales', () => {
    assert.deepStrictEqual(SUPPORTED_LOCALES, ['en', 'de', 'nl', 'fr', 'es', 'it']);
    SUPPORTED_LOCALES.forEach(locale => {
        assert(DICTIONARIES[locale], `Dictionary missing for ${locale}`);
        assert(DICTIONARIES[locale].nav, `nav section missing for ${locale}`);
        assert(DICTIONARIES[locale].login, `login section missing for ${locale}`);
        assert(DICTIONARIES[locale].tabs, `tabs section missing for ${locale}`);
        assert(DICTIONARIES[locale].common, `common section missing for ${locale}`);
        assert(DICTIONARIES[locale].homes, `homes section missing for ${locale}`);
        assert(DICTIONARIES[locale].devices, `devices section missing for ${locale}`);
        assert(DICTIONARIES[locale].zones, `zones section missing for ${locale}`);
        assert(DICTIONARIES[locale].tuning, `tuning section missing for ${locale}`);
        assert(DICTIONARIES[locale].whitelist, `whitelist section missing for ${locale}`);
        assert(DICTIONARIES[locale].users, `users section missing for ${locale}`);
        assert(DICTIONARIES[locale].security, `security section missing for ${locale}`);
        assert(DICTIONARIES[locale].decoder, `decoder section missing for ${locale}`);
        assert(DICTIONARIES[locale].settings, `settings section missing for ${locale}`);
        assert(DICTIONARIES[locale].snapshot, `snapshot section missing for ${locale}`);
        assert(DICTIONARIES[locale].emulated, `emulated section missing for ${locale}`);
    });
});

test('renderLanguageSelector outputs dropdown with requested active locale', () => {
    const html = renderLanguageSelector('de');
    assert(html.includes('id="portal-lang-select"'), 'missing portal-lang-select id');
    assert(html.includes('<option value="de" selected>Deutsch (DE)</option>'), 'de option not selected');
    assert(html.includes('<option value="en" >English (EN)</option>'), 'en option missing');
    assert(html.includes('onchange="window.setLocale(this.value)"'), 'missing onchange handler');
});

test('renderLanguageSelector falls back to default locale on unknown locale code', () => {
    const html = renderLanguageSelector('invalid_lang');
    assert(html.includes('<option value="en" selected>English (EN)</option>'), 'did not fall back to en');
});
