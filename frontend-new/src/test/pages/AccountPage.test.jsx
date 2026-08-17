import { renderToString } from 'react-dom/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AccountPage from '../../pages/AccountPage';

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => true),
    getPlatform: vi.fn(() => 'android')
  },
  registerPlugin: vi.fn(() => ({
    getVersionInfo: vi.fn(() => Promise.resolve({ versionCode: 100, versionName: '1.0.0' })),
    canInstallApk: vi.fn(() => Promise.resolve({ value: true })),
    downloadAndInstallApk: vi.fn(() => Promise.resolve()),
    addListener: vi.fn(() => Promise.resolve({ remove: vi.fn() }))
  }))
}));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    logout: vi.fn(),
    user: { name: 'Test User', email: 'test@example.com' }
  })
}));

vi.mock('../../context/HomeContext', () => ({
  useHome: () => ({
    activeHomeId: 1
  })
}));

vi.mock('../../context/ToastContext', () => ({
  useToast: () => ({
    showToast: vi.fn()
  })
}));

vi.mock('../../components/layout/AppShell', () => ({
  default: ({ children }) => <div>{children}</div>
}));

vi.mock('../../components/settings/UserSettings', () => ({
  default: () => <div>UserSettings</div>
}));

describe('AccountPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Check for Updates button on native platform', () => {
    const html = renderToString(<AccountPage />);
    expect(html).toContain('settings.check_for_updates');
  });

  it('renders UserSettings component', () => {
    const html = renderToString(<AccountPage />);
    expect(html).toContain('UserSettings');
  });
});
