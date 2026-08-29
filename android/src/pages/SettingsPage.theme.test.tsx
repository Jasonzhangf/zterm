// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';
import { AppUpdateSection } from '../components/settings/AppUpdateSection';
import type { BridgeSettings } from '../lib/bridge-settings';
import type { AppUpdatePreferences } from '../lib/app-update';
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
        renderSettingsUpdate={(props) => <AppUpdateSection {...props} />}
      />,
    );

    // 主题收拢为入口：先点击展开主题卡目录
    fireEvent.click(screen.getByText(/展开 ▾/));
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
    expect(screen.getByText('连接配置')).toBeTruthy();
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

    fireEvent.click(screen.getByText(/展开 ▾/));
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

  it('persists terminal shell skin through settings save', () => {
    const onSave = vi.fn();
    const onTerminalShellSkinChange = vi.fn();
    const renderSettingsPage = (settings: BridgeSettings) => (
      <SettingsPage
        settings={settings}
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
        onTerminalShellSkinChange={onTerminalShellSkinChange}
        onBack={vi.fn()}
      />
    );

    const view = render(renderSettingsPage(baseSettings));

    fireEvent.click(screen.getByRole('button', { name: 'Adaptive Phone' }));
    const blackSkinButton = screen.getByText('全黑底').closest('button');
    expect(blackSkinButton).toBeTruthy();
    fireEvent.click(blackSkinButton!);
    expect(onTerminalShellSkinChange).toHaveBeenCalledWith('black');

    view.rerender(renderSettingsPage({
      ...baseSettings,
      terminalShellSkin: 'black',
    }));

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      terminalWidthMode: 'adaptive-phone',
      terminalShellSkin: 'black',
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

    const button = screen.getByRole('button', { name: 'Daemon Debug 已关闭' });
    fireEvent.click(button);
    expect(window.localStorage.getItem(RUNTIME_DEBUG_STORAGE_KEY)).toBe('1');
    expect(screen.getByRole('button', { name: 'Daemon Debug 已开启' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Daemon Debug 已开启' }));
    expect(window.localStorage.getItem(RUNTIME_DEBUG_STORAGE_KEY)).toBe(null);
    expect(screen.getByRole('button', { name: 'Daemon Debug 已关闭' })).toBeTruthy();
  });

  it('progressively discloses advanced settings instead of stacking every card', () => {
    render(
      <SettingsPage
        settings={baseSettings}
        currentVersionName="0.0.0"
        currentVersionCode={0}
        updatePreferences={{
          manifestUrl: '',
          manifestSource: 'none',
          autoCheckOnLaunch: true,
          ignoreUntilManualCheck: false,
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
        onBack={vi.fn()}
      />,
    );

    const groups = screen.getAllByTestId('settings-group');
    expect(groups.map((group) => group.hasAttribute('open'))).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);

    fireEvent.click(within(groups[0]!).getByText('连接与升级'));
    expect(groups[0]!.hasAttribute('open')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Daemon Debug 已关闭' }));
    expect(groups[0]!.hasAttribute('open')).toBe(false);
    expect(groups[2]!.hasAttribute('open')).toBe(false);
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

    fireEvent.click(screen.getByTestId('settings-connection-config-expand'));
    expect(screen.getByTestId('settings-relay-fixed-host').textContent).toBe('relay.codewhisper.cc');
    expect(screen.queryByPlaceholderText('https://your-relay.example.com/relay/')).toBeNull();
  });

  it('offers only the relay public update manifest, never a direct daemon address', () => {
    const onUpdatePreferencesChange = vi.fn();

    render(
      <SettingsPage
        settings={{
          ...baseSettings,
          targetHost: '100.66.1.82',
          targetPort: 3333,
          servers: [{
            id: 'mac-studio-direct',
            name: 'Mac Studio',
            targetHost: '100.66.1.82',
            targetPort: 3333,
            authToken: 'token',
          }],
          defaultServerId: 'mac-studio-direct',
          traversalRelay: {
            relayBaseUrl: 'https://relay.codewhisper.cc:18443/relay/',
            accessToken: 'token',
            userId: 'u1',
            username: 'jason',
            deviceId: 'tablet-1',
            deviceName: 'Jason Tablet',
            platform: 'android',
            wsDevicesUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/devices',
            wsHostUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/host',
            wsClientUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/client',
            turnUrl: '',
            turnUsername: '',
            turnCredential: '',
            updatedAt: 1,
          },
        }}
        currentVersionName="0.1.1.1590"
        currentVersionCode={1011590}
        updatePreferences={{
          manifestUrl: 'http://100.66.1.82:3333/updates/latest.json',
          manifestSource: 'server-connected',
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
        onUpdatePreferencesChange={onUpdatePreferencesChange}
        onCheckForUpdate={vi.fn()}
        onInstallUpdate={vi.fn()}
        onResetUpdateIgnorePolicy={vi.fn()}
        onTerminalThemeChange={vi.fn()}
        onBack={vi.fn()}
        renderSettingsUpdate={(props) => <AppUpdateSection {...props} />}
      />,
    );

    expect(screen.getByRole('button', { name: '使用 Relay 公网' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '使用 Mac Studio' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '使用 Relay 公网' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onUpdatePreferencesChange).toHaveBeenCalledWith(expect.objectContaining({
      manifestUrl: 'https://relay.codewhisper.cc:18443/relay/updates/latest.json',
      manifestSource: 'relay-injected',
    }));
  });

  it('resyncs an in-place Relay preference update instead of saving a stale LAN draft', () => {
    const onUpdatePreferencesChange = vi.fn();
    const updatePreferences: AppUpdatePreferences = {
      manifestUrl: 'http://192.168.0.3:3333/updates/latest.json',
      manifestSource: 'server-connected' as const,
      autoCheckOnLaunch: false,
      skippedVersionCode: undefined,
      ignoreUntilManualCheck: false,
      lastCheckedAt: undefined,
      lastSeenVersionCode: undefined,
    };
    const relaySettings = {
      relayBaseUrl: 'https://relay.codewhisper.cc:18443/relay/',
      accessToken: 'token',
      userId: 'u1',
      username: 'jason',
      deviceId: 'tablet-1',
      deviceName: 'Jason Tablet',
      platform: 'android' as const,
      wsDevicesUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/devices',
      wsHostUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/host',
      wsClientUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/client',
      turnUrl: '',
      turnUsername: '',
      turnCredential: '',
      updatedAt: 1,
    };
    const renderPage = () => (
      <SettingsPage
        settings={{ ...baseSettings, targetHost: '192.168.0.3', traversalRelay: relaySettings }}
        currentVersionName="0.1.1.1590"
        currentVersionCode={1011590}
        updatePreferences={updatePreferences}
        latestManifest={null}
        updateChecking={false}
        updateInstalling={false}
        updateError={null}
        hasNewVersion={false}
        hasUpdateIgnorePolicy={false}
        onSave={vi.fn()}
        onUpdatePreferencesChange={onUpdatePreferencesChange}
        onCheckForUpdate={vi.fn()}
        onInstallUpdate={vi.fn()}
        onResetUpdateIgnorePolicy={vi.fn()}
        onBack={vi.fn()}
        renderSettingsUpdate={(props) => <AppUpdateSection {...props} />}
      />
    );

    const view = render(renderPage());
    expect(screen.queryByRole('button', { name: '使用当前 daemon 地址' })).toBeNull();

    updatePreferences.manifestUrl = 'https://relay.codewhisper.cc:18443/relay/updates/latest.json';
    updatePreferences.manifestSource = 'relay-injected';
    view.rerender(renderPage());

    expect(screen.getByDisplayValue('https://relay.codewhisper.cc:18443/relay/updates/latest.json')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onUpdatePreferencesChange).toHaveBeenCalledWith(expect.objectContaining({
      manifestUrl: 'https://relay.codewhisper.cc:18443/relay/updates/latest.json',
      manifestSource: 'relay-injected',
    }));
  });

  it('keeps a manually saved manifest when Relay preferences refresh', () => {
    const onUpdatePreferencesChange = vi.fn();
    const updatePreferences: AppUpdatePreferences = {
      manifestUrl: 'https://relay.codewhisper.cc:18443/relay/updates/latest.json',
      manifestSource: 'relay-injected' as const,
      autoCheckOnLaunch: false,
      skippedVersionCode: undefined,
      ignoreUntilManualCheck: false,
      lastCheckedAt: undefined,
      lastSeenVersionCode: undefined,
    };
    const relaySettings = {
      relayBaseUrl: 'https://relay.codewhisper.cc:18443/relay/',
      accessToken: 'token',
      userId: 'u1',
      username: 'jason',
      deviceId: 'tablet-1',
      deviceName: 'Jason Tablet',
      platform: 'android' as const,
      wsDevicesUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/devices',
      wsHostUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/host',
      wsClientUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/client',
      turnUrl: '',
      turnUsername: '',
      turnCredential: '',
      updatedAt: 1,
    };
    const view = render(
      <SettingsPage
        settings={{ ...baseSettings, traversalRelay: relaySettings }}
        currentVersionName="0.1.1.1590"
        currentVersionCode={1011590}
        updatePreferences={updatePreferences}
        latestManifest={null}
        updateChecking={false}
        updateInstalling={false}
        updateError={null}
        hasNewVersion={false}
        hasUpdateIgnorePolicy={false}
        onSave={vi.fn()}
        onUpdatePreferencesChange={onUpdatePreferencesChange}
        onCheckForUpdate={vi.fn()}
        onInstallUpdate={vi.fn()}
        onResetUpdateIgnorePolicy={vi.fn()}
        onBack={vi.fn()}
        renderSettingsUpdate={(props) => <AppUpdateSection {...props} />}
      />,
    );

    fireEvent.change(screen.getByDisplayValue(updatePreferences.manifestUrl), {
      target: { value: 'https://updates.example.com/latest.json' },
    });
    updatePreferences.manifestUrl = 'https://relay.codewhisper.cc:19443/relay/updates/latest.json';
    updatePreferences.manifestSource = 'relay-injected';
    view.rerender(
      <SettingsPage
        settings={{ ...baseSettings, traversalRelay: { ...relaySettings, updatedAt: 2 } }}
        currentVersionName="0.1.1.1590"
        currentVersionCode={1011590}
        updatePreferences={updatePreferences}
        latestManifest={null}
        updateChecking={false}
        updateInstalling={false}
        updateError={null}
        hasNewVersion={false}
        hasUpdateIgnorePolicy={false}
        onSave={vi.fn()}
        onUpdatePreferencesChange={onUpdatePreferencesChange}
        onCheckForUpdate={vi.fn()}
        onInstallUpdate={vi.fn()}
        onResetUpdateIgnorePolicy={vi.fn()}
        onBack={vi.fn()}
        renderSettingsUpdate={(props) => <AppUpdateSection {...props} />}
      />,
    );

    expect(screen.getByDisplayValue('https://updates.example.com/latest.json')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onUpdatePreferencesChange).toHaveBeenCalledWith(expect.objectContaining({
      manifestUrl: 'https://updates.example.com/latest.json',
      manifestSource: 'user-saved',
    }));
  });

  it('keeps the explicit LAN route when no Relay source exists', () => {
    const onUpdatePreferencesChange = vi.fn();

    render(
      <SettingsPage
        settings={{ ...baseSettings, targetHost: '192.168.0.3' }}
        currentVersionName="0.1.1.1590"
        currentVersionCode={1011590}
        updatePreferences={{
          manifestUrl: 'http://192.168.0.3:3333/updates/latest.json',
          manifestSource: 'server-connected',
          autoCheckOnLaunch: false,
          ignoreUntilManualCheck: false,
        }}
        latestManifest={null}
        updateChecking={false}
        updateInstalling={false}
        updateError={null}
        hasNewVersion={false}
        hasUpdateIgnorePolicy={false}
        onSave={vi.fn()}
        onUpdatePreferencesChange={onUpdatePreferencesChange}
        onCheckForUpdate={vi.fn()}
        onInstallUpdate={vi.fn()}
        onResetUpdateIgnorePolicy={vi.fn()}
        onBack={vi.fn()}
        renderSettingsUpdate={(props) => <AppUpdateSection {...props} />}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onUpdatePreferencesChange).toHaveBeenCalledWith(expect.objectContaining({
      manifestUrl: 'http://192.168.0.3:3333/updates/latest.json',
      manifestSource: 'server-connected',
    }));
  });
});
