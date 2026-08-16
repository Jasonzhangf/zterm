// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';
import type { BridgeSettings } from '../lib/bridge-settings';
import { DEFAULT_TERMINAL_CACHE_LINES } from '../lib/mobile-config';

const baseSettings: BridgeSettings = {
  targetHost: '',
  targetPort: 3333,
  targetAuthToken: '',
  signalUrl: '',
  turnServerUrl: '',
  turnUsername: '',
  turnCredential: '',
  transportMode: 'auto',
  terminalCacheLines: DEFAULT_TERMINAL_CACHE_LINES,
  terminalThemeId: 'classic-dark',
  terminalWidthMode: 'mirror-fixed',
  terminalSessionGroupLayoutMode: 'auto',
  shortcutSmartSort: true,
  servers: [],
  defaultServerId: undefined,
  traversalRelay: undefined,
};

const baseProps = {
  settings: baseSettings,
  currentVersionName: '0.1.1.1590',
  currentVersionCode: 1011590,
  updatePreferences: {
    manifestUrl: '',
    autoCheckOnLaunch: false,
    skippedVersionCode: undefined,
    ignoreUntilManualCheck: false,
    lastCheckedAt: undefined,
    lastSeenVersionCode: undefined,
  },
  latestManifest: null,
  updateChecking: false,
  updateInstalling: false,
  updateError: null,
  hasNewVersion: false,
  hasUpdateIgnorePolicy: false,
  onSave: vi.fn(),
  onUpdatePreferencesChange: vi.fn(),
  onCheckForUpdate: vi.fn(),
  onInstallUpdate: vi.fn(),
  onResetUpdateIgnorePolicy: vi.fn(),
  onBack: vi.fn(),
};

describe('SettingsPage settings update slot render', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, String(value));
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
        clear: () => {
          storage.clear();
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the update section through the typed plugin render callback', () => {
    const renderSettingsUpdate = vi.fn(() => (
      <div data-testid="settings-update-slot-ready" />
    ));

    render(
      <SettingsPage
        {...baseProps}
        renderSettingsUpdate={renderSettingsUpdate}
      />,
    );

    expect(screen.getByTestId('settings-update-slot-ready')).toBeTruthy();
    expect(renderSettingsUpdate).toHaveBeenCalledWith(expect.objectContaining({
      currentVersionName: '0.1.1.1590',
    }));
  });

  it('renders no update section when the settings update slot is unavailable', () => {
    render(<SettingsPage {...baseProps} />);

    expect(screen.queryByTestId('settings-update-section')).toBeNull();
  });
});
