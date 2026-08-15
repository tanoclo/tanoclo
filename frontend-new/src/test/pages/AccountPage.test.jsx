// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AccountPage from '../../pages/AccountPage';
import * as SelfUpdaterModule from '../../components/common/SelfUpdater';

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => true),
    getPlatform: vi.fn(() => 'android')
  }
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
    render(<AccountPage />);
    expect(screen.getByText('Check for Updates')).toBeInTheDocument();
  });

  it('invokes triggerCheckForUpdates when button clicked', async () => {
    const triggerSpy = vi.spyOn(SelfUpdaterModule, 'triggerCheckForUpdates').mockResolvedValue(false);
    render(<AccountPage />);
    
    const button = screen.getByText('Check for Updates');
    fireEvent.click(button);

    await waitFor(() => {
      expect(triggerSpy).toHaveBeenCalledWith(true);
    });
  });
});
