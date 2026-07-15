// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';
import type { BridgeSettings } from '../lib/bridge-settings';
import { DEFAULT_TERMINAL_CACHE_LINES } from '../lib/mobile-config';
import { RUNTIME_DEBUG_STORAGE_KEY } from '../lib/runtime-debug';

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

describe('SettingsPage terminal theme selection', () => {
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

  it('renders the expanded built-in theme catalog', () => {
    render(
      <SettingsPage
        settings={baseSettings}
        currentVersionName="0.1.1.1590"
        currentVersionCode={1011590}
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
        hasNewVersion={false}
        hasUpdateIgnorePolicy={false}
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
    expect(screen.getByText('Relay Account')).toBeTruthy();
  });

  it('persists terminal theme immediately when a theme card is selected', () => {
    const onTerminalThemeChange = vi.fn();

    render(
      <SettingsPage
        settings={baseSettings}
        currentVersionName="0.1.1.1590"
        currentVersionCode={1011590}
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
        hasNewVersion={false}
        hasUpdateIgnorePolicy={false}
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
        currentVersionName="0.1.1.1590"
        currentVersionCode={1011590}
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
        hasNewVersion={false}
        hasUpdateIgnorePolicy={false}
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

  it('persists session group layout mode through settings save', () => {
    const onSave = vi.fn();

    render(
      <SettingsPage
        settings={baseSettings}
        currentVersionName="0.1.1.1590"
        currentVersionCode={1011590}
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
        hasNewVersion={false}
        hasUpdateIgnorePolicy={false}
        onSave={onSave}
        onUpdatePreferencesChange={vi.fn()}
        onCheckForUpdate={vi.fn()}
        onInstallUpdate={vi.fn()}
        onResetUpdateIgnorePolicy={vi.fn()}
        onTerminalThemeChange={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Vertical' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      terminalSessionGroupLayoutMode: 'vertical',
    }));
  });

  it('toggles daemon debug through the runtime debug storage truth', () => {
    render(
      <SettingsPage
        settings={baseSettings}
        currentVersionName="0.1.1.1590"
        currentVersionCode={1011590}
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
        hasNewVersion={false}
        hasUpdateIgnorePolicy={false}
        onSave={vi.fn()}
        onUpdatePreferencesChange={vi.fn()}
        onCheckForUpdate={vi.fn()}
        onInstallUpdate={vi.fn()}
        onResetUpdateIgnorePolicy={vi.fn()}
        onTerminalThemeChange={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    const button = screen.getByRole('button', { name: '○Daemon Debug 已关闭' });
    fireEvent.click(button);
    expect(window.localStorage.getItem(RUNTIME_DEBUG_STORAGE_KEY)).toBe('1');
    expect(screen.getByRole('button', { name: '✓Daemon Debug 已开启' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '✓Daemon Debug 已开启' }));
    expect(window.localStorage.getItem(RUNTIME_DEBUG_STORAGE_KEY)).toBe(null);
    expect(screen.getByRole('button', { name: '○Daemon Debug 已关闭' })).toBeTruthy();
  });

  it('shows the fixed Relay service without exposing a configurable base-url field', () => {
    render(
      <SettingsPage
        settings={{
          ...baseSettings,
          traversalRelay: {
            relayBaseUrl: 'https://claw.codewhisper.cc:18443/relay/',
            accessToken: 'token',
            userId: 'u1',
            username: 'jason',
            deviceId: 'tablet-1',
            deviceName: 'Jason Tablet',
            platform: 'android',
            wsDevicesUrl: 'wss://claw.codewhisper.cc:18443/relay/ws/devices',
            wsHostUrl: 'wss://claw.codewhisper.cc:18443/relay/ws/host',
            wsClientUrl: 'wss://claw.codewhisper.cc:18443/relay/ws/client',
            turnUrl: '',
            turnUsername: '',
            turnCredential: '',
            updatedAt: 1,
          },
        }}
        currentVersionName="0.1.1.1590"
        currentVersionCode={1011590}
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
        hasNewVersion={false}
        hasUpdateIgnorePolicy={false}
        onSave={vi.fn()}
        onUpdatePreferencesChange={vi.fn()}
        onCheckForUpdate={vi.fn()}
        onInstallUpdate={vi.fn()}
        onResetUpdateIgnorePolicy={vi.fn()}
        onTerminalThemeChange={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByTestId('settings-relay-fixed-host').textContent).toBe('relay.codewhisper.cc');
    expect(screen.queryByPlaceholderText('https://your-relay.example.com/relay/')).toBeNull();
  });
});
