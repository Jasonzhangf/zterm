// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { SettingsPage } from './SettingsPage';
import { AppUpdateSection } from '../components/settings/AppUpdateSection';
import type { BridgeSettings, TraversalRelayClientSettings } from '../lib/bridge-settings';
import { DEFAULT_TERMINAL_CACHE_LINES } from '../lib/mobile-config';

const syncRelay = vi.fn();
const logoutRelay = vi.fn();

vi.mock('../hooks/useTraversalRelayAccount', () => ({
  useTraversalRelayAccount: vi.fn(() => ({
    account: null,
    relayDevices: [],
    relayStatus: '',
    relayBusy: null,
    refreshLocalAccount: vi.fn(),
    syncRelay,
    logoutRelay,
  })),
}));

import { useTraversalRelayAccount } from '../hooks/useTraversalRelayAccount';

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

const relaySettings: TraversalRelayClientSettings = {
  relayBaseUrl: 'https://relay.codewhisper.cc:18443/relay/',
  accessToken: 'token',
  userId: 'u1',
  username: 'jason',
  deviceId: 'android-1',
  deviceName: 'ZTerm Android',
  platform: 'android',
  wsDevicesUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/devices',
  wsHostUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/host',
  wsClientUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/client',
  turnUrl: '',
  turnUsername: '',
  turnCredential: '',
  updatedAt: 1,
};
const successfulBridgeSettings = () => ({
  ok: true as const,
  settings: baseSettings,
  persistedKeys: [],
});
const successfulUpdatePreferences = () => ({
  ok: true as const,
  preferences: {
    manifestUrl: '',
    autoCheckOnLaunch: false,
    skippedVersionCode: undefined,
    ignoreUntilManualCheck: false,
    lastCheckedAt: undefined,
    lastSeenVersionCode: undefined,
  },
  persistedKeys: [],
});

function renderSettings(overrides: Partial<ComponentProps<typeof SettingsPage>> = {}) {
  return render(
    <SettingsPage
      settings={baseSettings}
      relayDevices={[]}
      currentVersionName="0.1.3"
      currentVersionCode={1030000}
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
      onSave={vi.fn(successfulBridgeSettings)}
      onRelaySettingsChange={vi.fn()}
      onUpdatePreferencesChange={vi.fn(successfulUpdatePreferences)}
      onCheckForUpdate={vi.fn()}
      onInstallUpdate={vi.fn()}
      onResetUpdateIgnorePolicy={vi.fn()}
      onTerminalThemeChange={vi.fn()}
      onBack={vi.fn()}
      renderSettingsUpdate={(props) => <AppUpdateSection {...props} />}
      {...overrides}
    />,
  );
}

function openConnectionConfig() {
  fireEvent.click(screen.getByTestId('settings-connection-config-expand'));
}

describe('SettingsPage Relay account configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useTraversalRelayAccount).mockReturnValue({
      account: null,
      relayDevices: [],
      relayStatus: '',
      relayBusy: null,
      refreshLocalAccount: vi.fn(),
      syncRelay,
      logoutRelay,
    });
  });

  afterEach(cleanup);

  it('keeps Relay auth in Settings and writes returned settings to the app owner', async () => {
    const onRelaySettingsChange = vi.fn();
    const onSave = vi.fn(successfulBridgeSettings);
    syncRelay.mockResolvedValueOnce({
      account: {
        username: 'jason',
        password: '',
        relayBaseUrl: relaySettings.relayBaseUrl,
        accessToken: 'token',
        user: { id: 'u1', username: 'jason', createdAt: 'now' },
        deviceId: 'android-1',
        deviceName: 'ZTerm Android',
        platform: 'android',
        devices: [],
        directory: null,
        updatedAt: 1,
        relaySettings,
      },
      relaySettings,
    });

    renderSettings({ onRelaySettingsChange, onSave });

    openConnectionConfig();
    expect(screen.getByTestId('settings-relay-fixed-host').textContent).toBe('relay.codewhisper.cc');
    fireEvent.change(screen.getByLabelText('Relay 账号'), { target: { value: 'jason' } });
    fireEvent.change(screen.getByLabelText('Relay 密码'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(syncRelay).toHaveBeenCalledWith('login', {
      relayBaseUrl: '',
      username: 'jason',
      password: 'secret',
    }, undefined));
    expect(onRelaySettingsChange).toHaveBeenCalledWith(relaySettings);

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      traversalRelay: relaySettings,
    }));
  });

  it('renders a clear signed-in account panel after relay login', () => {
    vi.mocked(useTraversalRelayAccount).mockReturnValue({
      account: {
        username: 'jason',
        password: '',
        relayBaseUrl: relaySettings.relayBaseUrl,
        accessToken: 'token',
        user: { id: 'u1', username: 'jason', createdAt: 'now' },
        deviceId: 'android-1',
        deviceName: 'ZTerm Android',
        platform: 'android',
        devices: [],
        directory: null,
        updatedAt: 1,
        relaySettings,
      },
      relayDevices: [
        {
          deviceId: 'mac-device',
          deviceName: 'Mac Studio',
          platform: 'darwin',
          appVersion: '0.1.3',
          client: { connected: false, lastSeenAt: '' },
          daemon: {
            connected: true,
            lastSeenAt: '2026-07-16T10:00:00.000Z',
            hostId: 'mac-studio',
            version: '0.1.3',
          },
          updatedAt: '2026-07-16T10:00:00.000Z',
        },
      ],
      relayStatus: '',
      relayBusy: null,
      refreshLocalAccount: vi.fn(),
      syncRelay,
      logoutRelay,
    });

    renderSettings({
      settings: {
        ...baseSettings,
        traversalRelay: relaySettings,
      },
      relayDevices: vi.mocked(useTraversalRelayAccount)().relayDevices,
    });

    openConnectionConfig();
    expect(screen.getAllByText('已登录').length).toBeGreaterThan(0);
    const signedInPanel = screen.getByTestId('settings-relay-signed-in-panel');
    expect(signedInPanel.textContent).toContain('已登录');
    expect(signedInPanel.textContent).toContain('jason');
    expect(signedInPanel.textContent).toContain('1 设备');
    expect(screen.getByRole('button', { name: '退出登录' })).toBeTruthy();
    expect(screen.queryByLabelText('Relay 账号')).toBeNull();
    expect(screen.queryByLabelText('Relay 密码')).toBeNull();
  });

  it('shows relay login errors without hiding the logged-out form', () => {
    vi.mocked(useTraversalRelayAccount).mockReturnValue({
      account: null,
      relayDevices: [],
      relayStatus: '账号或密码错误',
      relayBusy: null,
      refreshLocalAccount: vi.fn(),
      syncRelay,
      logoutRelay,
    });

    renderSettings();

    openConnectionConfig();
    expect(screen.getByLabelText('Relay 账号')).toBeTruthy();
    expect(screen.getByLabelText('Relay 密码')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('账号或密码错误');
  });

  it('keeps in-progress relay login status neutral', () => {
    vi.mocked(useTraversalRelayAccount).mockReturnValue({
      account: null,
      relayDevices: [],
      relayStatus: '登录中…',
      relayBusy: 'login',
      refreshLocalAccount: vi.fn(),
      syncRelay,
      logoutRelay,
    });

    renderSettings();

    openConnectionConfig();
    const status = screen.getByTestId('settings-relay-login-status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toContain('登录中…');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps remove-default visible when the default preset is subsumed by an online relay daemon', () => {
    const now = new Date().toISOString();
    vi.mocked(useTraversalRelayAccount).mockReturnValue({
      account: null,
      relayDevices: [
        {
          deviceId: 'mac-device',
          deviceName: 'Mac Studio',
          platform: 'darwin',
          appVersion: '0.1.3',
          client: { connected: true, lastSeenAt: now },
          daemon: {
            connected: true,
            lastSeenAt: now,
            hostId: 'mac-studio',
            version: '0.1.3',
            endpoints: [
              {
                id: 'relay-rtc:mac-studio',
                kind: 'relay-rtc',
                relayHostId: 'mac-studio',
                authRequired: true,
                lastSeenAt: now,
              },
            ],
            sessions: [],
          },
          updatedAt: now,
        },
      ],
      relayStatus: '',
      relayBusy: null,
      refreshLocalAccount: vi.fn(),
      syncRelay,
      logoutRelay,
    });

    const relayDevices = vi.mocked(useTraversalRelayAccount)().relayDevices;
    renderSettings({
      settings: {
        ...baseSettings,
        defaultServerId: 'preset-1',
        servers: [
          {
            id: 'preset-1',
            name: 'Mac Studio',
            targetHost: '100.66.1.82',
            targetPort: 3333,
            authToken: 'token',
            relayHostId: 'mac-studio',
          },
        ],
      },
      relayDevices,
    });

    openConnectionConfig();
    expect(screen.getByTestId('settings-relay-online-entry')).toBeTruthy();
    expect(screen.getByRole('button', { name: '移除默认服务器' })).toBeTruthy();
    expect(screen.getByTestId('settings-connection-config-summary').textContent).toContain('默认 Mac Studio');
  });

  it('renders the app confirmed directory generation and never writes relay endpoints into local presets', () => {
    const now = new Date().toISOString();
    const staleLanDevice = {
      deviceId: 'stale-device',
      deviceName: 'Stale LAN Mac',
      platform: 'darwin',
      appVersion: '0.1.2',
      client: { connected: true, lastSeenAt: now },
      daemon: {
        connected: true,
        lastSeenAt: now,
        hostId: 'mac-studio',
        version: '0.1.2',
        endpoints: [{
          id: 'ipv4:mac-studio',
          kind: 'ipv4' as const,
          host: '192.168.0.3',
          port: 3333,
          authRequired: true,
          lastSeenAt: now,
        }],
        sessions: [],
      },
      updatedAt: now,
    };
    const confirmedDevice = {
      ...staleLanDevice,
      deviceId: 'confirmed-device',
      deviceName: 'Confirmed Mac Studio',
      appVersion: '0.1.3',
      daemon: {
        ...staleLanDevice.daemon,
        version: '0.1.3',
        endpoints: [{
          id: 'tailscale:mac-studio',
          kind: 'tailscale' as const,
          host: '100.66.1.82',
          port: 3333,
          authRequired: true,
          lastSeenAt: now,
        }],
      },
    };
    vi.mocked(useTraversalRelayAccount).mockReturnValue({
      account: null,
      relayDevices: [staleLanDevice],
      relayStatus: '',
      relayBusy: null,
      refreshLocalAccount: vi.fn(),
      syncRelay,
      logoutRelay,
    });
    const onSave = vi.fn(successfulBridgeSettings);

    renderSettings({ relayDevices: [confirmedDevice], onSave });
    openConnectionConfig();

    expect(screen.getByText('Confirmed Mac Studio')).toBeTruthy();
    expect(screen.queryByText('Stale LAN Mac')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      servers: [],
      targetHost: '',
    }));
  });

  it('adds a direct server inside Settings so Home can project it as a server row', () => {
    const onSave = vi.fn(successfulBridgeSettings);
    renderSettings({ onSave });

    openConnectionConfig();
    fireEvent.change(screen.getByLabelText('服务器名称'), { target: { value: 'Mac Studio' } });
    fireEvent.change(screen.getByLabelText('服务器地址'), { target: { value: '100.66.1.82' } });
    fireEvent.change(screen.getByLabelText('服务器认证令牌'), { target: { value: 'wterm-4123456' } });
    fireEvent.change(screen.getByLabelText('守护进程 ID（Daemon ID）'), { target: { value: 'mac-studio' } });
    fireEvent.click(screen.getByRole('button', { name: '添加服务器' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      servers: [
        expect.objectContaining({
          name: 'Mac Studio',
          targetHost: '100.66.1.82',
          targetPort: 3333,
          authToken: 'wterm-4123456',
          relayHostId: 'mac-studio',
        }),
      ],
      targetHost: '100.66.1.82',
      targetPort: 3333,
      targetAuthToken: 'wterm-4123456',
    }));
  });

  it('collapses connection configuration until expanded and keeps upgrade controls above it', () => {
    const onCheckForUpdate = vi.fn();
    renderSettings({ onCheckForUpdate });

    expect(screen.getByTestId('settings-connection-config-summary')).toBeTruthy();
    expect(screen.queryByLabelText('服务器名称')).toBeNull();
    openConnectionConfig();
    const updateSection = screen.getByTestId('settings-update-section');
    const serverNameInput = screen.getByLabelText('服务器名称');
    expect(updateSection.compareDocumentPosition(serverNameInput) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(screen.getByText('版本与升级')).toBeTruthy();
    expect(screen.getByRole('button', { name: '下载并安装' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));
    expect(onCheckForUpdate).toHaveBeenCalledTimes(1);
  });
});
