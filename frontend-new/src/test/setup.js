import { afterEach, vi } from 'vitest';

// ─── localStorage polyfill for node environment ───
if (typeof globalThis.localStorage === 'undefined') {
  const store = {};
  globalThis.localStorage = {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, val) => { store[key] = String(val); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); },
    get length() { return Object.keys(store).length; },
    key: (i) => Object.keys(store)[i] || null,
  };
}

// ─── window polyfill for node environment ───
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}
if (typeof globalThis.window.localStorage === 'undefined') {
  globalThis.window.localStorage = globalThis.localStorage;
}

// ─── Event support for node environment ───
if (typeof globalThis.window.addEventListener !== 'function') {
  const listeners = {};
  globalThis.window.addEventListener = (type, fn) => {
    (listeners[type] = listeners[type] || []).push(fn);
  };
  globalThis.window.removeEventListener = (type, fn) => {
    if (listeners[type]) listeners[type] = listeners[type].filter(f => f !== fn);
  };
  globalThis.window.dispatchEvent = (event) => {
    const type = event.type || event;
    (listeners[type] || []).forEach(fn => fn(event));
  };
}

// ─── Capacitor mock (default: web platform) ───
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => 'web',
  },
}));

vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: vi.fn().mockResolvedValue({ display: 'granted' }),
    requestPermissions: vi.fn().mockResolvedValue({ display: 'granted' }),
    schedule: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
  },
}));

vi.mock('@capgo/background-geolocation', () => ({
  BackgroundGeolocation: {
    checkPermissions: vi.fn().mockResolvedValue({ location: 'granted', backgroundLocation: 'granted' }),
    requestPermissions: vi.fn().mockResolvedValue({ location: 'granted', backgroundLocation: 'granted' }),
    setupGeofencing: vi.fn().mockResolvedValue(undefined),
    addGeofence: vi.fn().mockResolvedValue(undefined),
    removeGeofence: vi.fn().mockResolvedValue(undefined),
    addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
  },
}));

// Reset all mocks after each test
afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});
