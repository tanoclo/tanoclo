import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @capacitor/core so we can toggle isNativePlatform
const mockIsNative = vi.fn(() => false);
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => mockIsNative(),
    getPlatform: () => 'web',
  },
}));

describe('utils/constants.js', () => {
  let getApiBase, STORAGE_KEYS, MANUAL_OVERLAY_MODES, ZONE_TYPES, DEFAULT_TEMPERATURES;
  let TEMP_MIN_HEATING, TEMP_MIN_DHW, TEMP_MAX_DEFAULT, TEMP_STEP, LOCALES;

  beforeEach(async () => {
    vi.resetModules();
    mockIsNative.mockReturnValue(false);
    localStorage.clear();
    const mod = await import('../utils/constants');
    getApiBase = mod.getApiBase;
    STORAGE_KEYS = mod.STORAGE_KEYS;
    MANUAL_OVERLAY_MODES = mod.MANUAL_OVERLAY_MODES;
    ZONE_TYPES = mod.ZONE_TYPES;
    DEFAULT_TEMPERATURES = mod.DEFAULT_TEMPERATURES;
    TEMP_MIN_HEATING = mod.TEMP_MIN_HEATING;
    TEMP_MIN_DHW = mod.TEMP_MIN_DHW;
    TEMP_MAX_DEFAULT = mod.TEMP_MAX_DEFAULT;
    TEMP_STEP = mod.TEMP_STEP;
    LOCALES = mod.LOCALES;
  });

  describe('getApiBase', () => {
    it('returns empty string on web (non-native)', () => {
      mockIsNative.mockReturnValue(false);
      expect(getApiBase()).toBe('');
    });

    it('reads tanoclo_server_url from localStorage on native', async () => {
      mockIsNative.mockReturnValue(true);
      localStorage.setItem('tanoclo_server_url', 'https://my.server.com');
      vi.resetModules();
      const mod = await import('../utils/constants');
      expect(mod.getApiBase()).toBe('https://my.server.com');
    });

    it('returns empty string on native with no server URL stored', async () => {
      mockIsNative.mockReturnValue(true);
      vi.resetModules();
      const mod = await import('../utils/constants');
      expect(mod.getApiBase()).toBe('');
    });
  });

  describe('STORAGE_KEYS', () => {
    it('contains expected keys', () => {
      expect(STORAGE_KEYS.AUTH_TOKEN).toBe('tanoclo_token');
      expect(STORAGE_KEYS.REFRESH_TOKEN).toBe('tanoclo_refresh_token');
      expect(STORAGE_KEYS.THEME).toBe('tanoclo_theme');
      expect(STORAGE_KEYS.USER_LOCALE).toBe('tado_locale');
      expect(STORAGE_KEYS.ZONE_ORDER_PREFIX).toBe('tanoclo_zone_order_');
    });
  });

  describe('LOCALES', () => {
    it('has all supported locales', () => {
      expect(LOCALES).toEqual({ EN: 'en', DE: 'de', NL: 'nl', FR: 'fr', ES: 'es', IT: 'it' });
    });
  });

  describe('MANUAL_OVERLAY_MODES', () => {
    it('maps correctly', () => {
      expect(MANUAL_OVERLAY_MODES.NEXT_CHANGE).toBe('TADO_MODE');
      expect(MANUAL_OVERLAY_MODES.TIMER).toBe('TIMER');
      expect(MANUAL_OVERLAY_MODES.RESUME).toBe('MANUAL');
    });
  });

  describe('ZONE_TYPES', () => {
    it('has HEATING and DHW', () => {
      expect(ZONE_TYPES.HEATING).toBe('HEATING');
      expect(ZONE_TYPES.DHW).toBe('HOT_WATER');
    });
  });

  describe('DEFAULT_TEMPERATURES', () => {
    it('has correct defaults', () => {
      expect(DEFAULT_TEMPERATURES.HEATING).toBe(20.0);
      expect(DEFAULT_TEMPERATURES.AWAY).toBe(15.0);
      expect(DEFAULT_TEMPERATURES.FROST_PROTECTION).toBe(5.0);
    });
  });

  describe('temperature bounds', () => {
    it('has correct ranges', () => {
      expect(TEMP_MIN_HEATING).toBe(5.0);
      expect(TEMP_MIN_DHW).toBe(29.0);
      expect(TEMP_MAX_DEFAULT).toBe(25.0);
      expect(TEMP_STEP).toBe(0.5);
    });
  });

  describe('getCartoTileUrl', () => {
    it('returns default tile URL when no key is provided', async () => {
      const { getCartoTileUrl } = await import('../utils/constants');
      expect(getCartoTileUrl()).toBe('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png');
      expect(getCartoTileUrl('')).toBe('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png');
    });

    it('returns tile URL with key query param when API key is provided', async () => {
      const { getCartoTileUrl } = await import('../utils/constants');
      expect(getCartoTileUrl('my_test_key')).toBe('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=my_test_key');
    });
  });
});
