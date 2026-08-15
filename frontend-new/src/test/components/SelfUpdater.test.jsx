// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
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
    localStorage.clear();
    globalThis.fetch = vi.fn();
  });

  it('triggers CapGo web update when webVersionCode is newer', async () => {
    render(<SelfUpdater />);

    let result;
    await waitFor(async () => {
      result = await triggerCheckForUpdates(true);
    });

    expect(result).toBe(true);
  });

  it('triggers native APK prompt modal ONLY when apkVersionCode is newer', async () => {
    const { apiFetch } = await import('../../api/client');
    apiFetch.mockResolvedValueOnce({
      webVersionCode: 100,
      webVersionName: '1.0.0',
      apkVersionCode: 110,
      apkVersionName: '1.1.0',
      apkUrl: 'https://raw.githubusercontent.com/tanoclo/tanoclo/ota/tanoclo.apk'
    });

    render(<SelfUpdater />);

    let result;
    await waitFor(async () => {
      result = await triggerCheckForUpdates(true);
    });

    expect(result).toBe(true);
    expect(await screen.findByText('Update Available')).toBeInTheDocument();
  });
});
