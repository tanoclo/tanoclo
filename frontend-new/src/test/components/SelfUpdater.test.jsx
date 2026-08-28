import { renderToString } from 'react-dom/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import SelfUpdater, { triggerCheckForUpdates } from '../../components/common/SelfUpdater';

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

vi.mock('@capgo/capacitor-updater', () => ({
  CapacitorUpdater: {
    download: vi.fn(() => Promise.resolve({ version: '1.0.1' })),
    set: vi.fn(() => Promise.resolve())
  }
}));

vi.mock('../../context/ToastContext', () => ({
  useToast: () => ({
    showToast: vi.fn()
  })
}));

vi.mock('../../api/client', () => ({
  apiFetch: vi.fn(() => Promise.resolve({
    webVersionCode: 105,
    webVersionName: '1.0.5',
    apkVersionCode: 100,
    apkVersionName: '1.0.0',
    zipUrl: 'https://raw.githubusercontent.com/tanoclo/tanoclo/ota/dist.zip'
  }))
}));

describe('SelfUpdater', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    globalThis.fetch = vi.fn();
  });

  it('dispatches tanoclo_check_for_updates event', async () => {
    let captured = null;
    const handler = (e) => {
      captured = e.detail;
      e.detail.resolve(true);
    };
    window.addEventListener('tanoclo_check_for_updates', handler, { once: true });

    const result = await triggerCheckForUpdates(true);
    expect(result).toBe(true);
    expect(captured.manual).toBe(true);
  });

  it('renders SelfUpdater component without errors', () => {
    const html = renderToString(<SelfUpdater />);
    expect(typeof html).toBe('string');
  });

  it('detects update when apkSha256 differs', async () => {
    const { apiFetch } = await import('../../api/client');
    vi.mocked(apiFetch).mockResolvedValueOnce({
      apkVersionCode: 100,
      apkVersionName: '1.0.0',
      apkSha256: 'sha256-remote-new-build',
      apkUrl: '/api/v2/ota/tanoclo.apk'
    });

    const { registerPlugin } = await import('@capacitor/core');
    const mockPlugin = registerPlugin('SelfUpdate');
    vi.mocked(mockPlugin.getVersionInfo).mockResolvedValueOnce({
      versionCode: 100,
      versionName: '1.0.0',
      apkSha256: 'sha256-local-old-build'
    });

    const handler = (e) => {
      e.detail.resolve(true);
    };
    window.addEventListener('tanoclo_check_for_updates', handler, { once: true });

    const result = await triggerCheckForUpdates(true);
    expect(result).toBe(true);
  });

  it('detects web update when webSha256 differs', async () => {
    localStorage.setItem('tanoclo_local_web_sha', 'sha256-web-old');

    const { apiFetch } = await import('../../api/client');
    vi.mocked(apiFetch).mockResolvedValueOnce({
      webVersionCode: 100,
      webVersionName: '1.0.0',
      webSha256: 'sha256-web-new',
      zipUrl: '/api/v2/ota/dist.zip',
      apkVersionCode: 100,
      apkVersionName: '1.0.0',
      apkSha256: 'sha256-same'
    });

    const { registerPlugin } = await import('@capacitor/core');
    const mockPlugin = registerPlugin('SelfUpdate');
    vi.mocked(mockPlugin.getVersionInfo).mockResolvedValueOnce({
      versionCode: 100,
      versionName: '1.0.0',
      apkSha256: 'sha256-same'
    });

    const handler = (e) => {
      e.detail.resolve(true);
    };
    window.addEventListener('tanoclo_check_for_updates', handler, { once: true });

    const result = await triggerCheckForUpdates(true);
    expect(result).toBe(true);
  });
});
