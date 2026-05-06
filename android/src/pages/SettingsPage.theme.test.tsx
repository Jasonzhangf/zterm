// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  shortcutSmartSort: true,
  servers: [],
  defaultServerId: undefined,
  traversalRelay: undefined,
};

describe('SettingsPage terminal theme selection', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the expanded built-in theme catalog', () => {
    render(
      <SettingsPage
        settings={baseSettings}
        updatePreferences={{
          manifestUrl: '',
          autoCheckOnLaunch: false,
          skippedVersionCode: undefined,
          ignoreUntilManualCheck: false,
          lastCheckedAt: undefined,
          lastSeenVersionCode: undefined,
        }}
        latestManifest={null}
        updateChecking={false}
        updateInstalling={false}
        updateError={null}
        onSave={vi.fn()}
        onUpdatePreferencesChange={vi.fn()}
        onCheckForUpdate={vi.fn()}
        onInstallUpdate={vi.fn()}
        onResetUpdateIgnorePolicy={vi.fn()}
        onTerminalThemeChange={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByText('Dracula')).toBeTruthy();
    expect(screen.getByText('ENCOM')).toBeTruthy();
    expect(screen.getByText('Homebrew')).toBeTruthy();
    expect(screen.getByText('Cobalt2')).toBeTruthy();
    expect(screen.getByText('GitHub Light')).toBeTruthy();
    expect(screen.getByText('Light Owl')).toBeTruthy();
    expect(screen.getByText('Solarized Dark')).toBeTruthy();
    expect(screen.getByText('Solarized Light')).toBeTruthy();
    expect(screen.getByText('Tokyo Night Storm')).toBeTruthy();
    expect(screen.getByText('Monokai')).toBeTruthy();
    expect(screen.getByText('Night Owl')).toBeTruthy();
    expect(screen.getByText('Kanagawa Wave')).toBeTruthy();
    expect(screen.getByText('Rose Pine Moon')).toBeTruthy();
    expect(screen.getByText('登录并同步控制面')).toBeTruthy();
  });

  it('persists terminal theme immediately when a theme card is selected', () => {
    const onTerminalThemeChange = vi.fn();

    render(
      <SettingsPage
        settings={baseSettings}
        updatePreferences={{
          manifestUrl: '',
          autoCheckOnLaunch: false,
          skippedVersionCode: undefined,
          ignoreUntilManualCheck: false,
          lastCheckedAt: undefined,
          lastSeenVersionCode: undefined,
        }}
        latestManifest={null}
        updateChecking={false}
        updateInstalling={false}
        updateError={null}
        onSave={vi.fn()}
        onUpdatePreferencesChange={vi.fn()}
        onCheckForUpdate={vi.fn()}
        onInstallUpdate={vi.fn()}
        onResetUpdateIgnorePolicy={vi.fn()}
        onTerminalThemeChange={onTerminalThemeChange}
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Cobalt2'));
    expect(onTerminalThemeChange).toHaveBeenCalledWith('tabby-cobalt2');
  });

  it('persists terminal width mode through settings save', () => {
    const onSave = vi.fn();

    render(
      <SettingsPage
        settings={baseSettings}
        updatePreferences={{
          manifestUrl: '',
          autoCheckOnLaunch: false,
          skippedVersionCode: undefined,
          ignoreUntilManualCheck: false,
          lastCheckedAt: undefined,
          lastSeenVersionCode: undefined,
        }}
        latestManifest={null}
        updateChecking={false}
        updateInstalling={false}
        updateError={null}
        onSave={onSave}
        onUpdatePreferencesChange={vi.fn()}
        onCheckForUpdate={vi.fn()}
        onInstallUpdate={vi.fn()}
        onResetUpdateIgnorePolicy={vi.fn()}
        onTerminalThemeChange={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Adaptive Phone' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      terminalWidthMode: 'adaptive-phone',
    }));
  });
});
