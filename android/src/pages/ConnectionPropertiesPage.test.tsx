// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConnectionConfigShareLink } from '@zterm/shared';
import type { BridgeSettings } from '../lib/bridge-settings';
import { DEFAULT_TERMINAL_CACHE_LINES } from '../lib/mobile-config';
import type { Host } from '../lib/types';
import { ConnectionPropertiesPage } from './ConnectionPropertiesPage';

const tmuxSessionMocks = vi.hoisted(() => ({
  fetchTmuxSessions: vi.fn(),
}));

const RELAY_ACCOUNT_STORAGE_KEY = 'zterm:traversal-relay-account';

vi.mock('../lib/tmux-sessions', () => ({
  fetchTmuxSessions: tmuxSessionMocks.fetchTmuxSessions,
}));

const bridgeSettings: BridgeSettings = {
  targetHost: '100.64.0.1',
  targetPort: 3333,
  targetAuthToken: 'saved-token',
  signalUrl: '',
  turnServerUrl: '',
  turnUsername: '',
  turnCredential: '',
  transportMode: 'auto',
  terminalCacheLines: DEFAULT_TERMINAL_CACHE_LINES,
  terminalThemeId: 'classic-dark',
  terminalWidthMode: 'mirror-fixed',
  shortcutSmartSort: true,
  traversalRelay: {
    relayBaseUrl: 'http://159.75.134.56/relay/',
    accessToken: 'access-1',
    userId: 'user-1',
    username: 'jason',
    deviceId: 'tablet-1',
    deviceName: 'Jason Tablet',
    platform: 'android',
    wsDevicesUrl: 'ws://159.75.134.56/relay/ws/devices',
    wsHostUrl: 'ws://159.75.134.56/relay/ws/host',
    wsClientUrl: 'ws://159.75.134.56/relay/ws/client',
    turnUrl: 'turn:claw.codewhisper.cc:3479?transport=udp',
    turnUsername: 'ztermturn',
    turnCredential: 'turn-pass',
    updatedAt: 1,
  },
  defaultServerId: 'server-1',
  servers: [
    {
      id: 'server-1',
      name: 'MacStudio',
      targetHost: '100.64.0.10',
      targetPort: 3333,
      authToken: 'token-a',
      relayHostId: 'daemon-host-a',
    },
  ],
};

function makeHost(overrides: Partial<Host> = {}): Host {
  return {
    id: overrides.id || 'host-1',
    createdAt: overrides.createdAt || 1000,
    name: overrides.name || 'Share Mac',
    bridgeHost: overrides.bridgeHost || '100.127.23.27:40807',
    bridgePort: overrides.bridgePort || 3333,
    daemonHostId: overrides.daemonHostId || 'daemon-a',
    sessionName: overrides.sessionName || 'main',
    authToken: overrides.authToken || 'token-a',
    relayHostId: overrides.relayHostId || 'daemon-a',
    relayDeviceId: overrides.relayDeviceId || 'device-a',
    tailscaleHost: overrides.tailscaleHost,
    ipv6Host: overrides.ipv6Host,
    ipv4Host: overrides.ipv4Host,
    signalUrl: overrides.signalUrl,
    transportMode: overrides.transportMode || 'webrtc',
    authType: overrides.authType || 'password',
    password: overrides.password,
    privateKey: overrides.privateKey,
    tags: overrides.tags || ['work'],
    pinned: overrides.pinned || false,
    lastConnected: overrides.lastConnected,
    autoCommand: overrides.autoCommand,
  };
}

describe('ConnectionPropertiesPage', () => {
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
      },
    });
    tmuxSessionMocks.fetchTmuxSessions.mockReset();
    vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    window.localStorage.removeItem?.(RELAY_ACCOUNT_STORAGE_KEY);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('covers the normal create flow: apply remembered server, discover tmux session, and save the connection', async () => {
    const onSave = vi.fn();
    tmuxSessionMocks.fetchTmuxSessions.mockResolvedValueOnce(['main']);

    render(
      <ConnectionPropertiesPage
        bridgeSettings={bridgeSettings}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('例如：MacStudio'), { target: { value: ' My Mac ' } });
    fireEvent.click(screen.getByText('MacStudio'));

    expect(screen.getByDisplayValue('100.64.0.10')).toBeTruthy();
    expect(screen.getByDisplayValue('3333')).toBeTruthy();
    expect(screen.getByDisplayValue('token-a')).toBeTruthy();

    fireEvent.click(screen.getByText('Connect'));

    await waitFor(() => {
      expect(tmuxSessionMocks.fetchTmuxSessions).toHaveBeenCalledWith(
        expect.objectContaining({
          bridgeHost: '100.64.0.10',
          bridgePort: 3333,
          authToken: 'token-a',
          relayHostId: 'daemon-host-a',
          transportMode: 'auto',
        }),
        bridgeSettings,
      );
    });

    await screen.findByText('main');
    expect(screen.getByDisplayValue('main')).toBeTruthy();
    expect(screen.queryByText('Signal URL Override')).toBeNull();
    expect(screen.getByText(/当前已启用 relay 控制面/i)).toBeTruthy();

    fireEvent.click(screen.getByText('RTC First'));
    fireEvent.change(screen.getByPlaceholderText('your-host.ts.net 或 100.x.y.z'), { target: { value: 'mac.tailnet.ts.net' } });
    fireEvent.change(screen.getByPlaceholderText('例如：tmux attach -t main'), { target: { value: 'htop' } });
    fireEvent.click(screen.getByText('Pin this connection to the top'));
    fireEvent.click(screen.getByText('Save'));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'My Mac',
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        authToken: 'token-a',
        relayHostId: 'daemon-host-a',
        sessionName: 'main',
        transportMode: 'webrtc',
        tailscaleHost: 'mac.tailnet.ts.net',
        autoCommand: 'htop',
        pinned: true,
      }),
    );
  });

  it('normalizes raw host:port input before discovery and save', async () => {
    const onSave = vi.fn();
    tmuxSessionMocks.fetchTmuxSessions.mockResolvedValueOnce(['main']);

    render(
      <ConnectionPropertiesPage
        bridgeSettings={bridgeSettings}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('例如：MacStudio'), { target: { value: ' Tailnet ' } });
    fireEvent.change(screen.getByPlaceholderText('100.127.23.27[:40807] 或 macstudio.tailnet'), {
      target: { value: '100.127.23.27:40807' },
    });
    fireEvent.change(screen.getByPlaceholderText('daemon 的共享 token'), { target: { value: 'token-a' } });

    expect(screen.getByDisplayValue('100.127.23.27')).toBeTruthy();
    expect(screen.getByDisplayValue('40807')).toBeTruthy();

    fireEvent.click(screen.getByText('Connect'));

    await waitFor(() => {
      expect(tmuxSessionMocks.fetchTmuxSessions).toHaveBeenCalledWith(
        expect.objectContaining({
          bridgeHost: '100.127.23.27',
          bridgePort: 40807,
          authToken: 'token-a',
        }),
        bridgeSettings,
      );
    });

    await screen.findByText('main');
    fireEvent.click(screen.getByText('Save'));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Tailnet',
        bridgeHost: '100.127.23.27',
        bridgePort: 40807,
        authToken: 'token-a',
        sessionName: 'main',
      }),
    );
  });

  it('selects relay daemon device instead of requiring manual hostId input', () => {
    const onSave = vi.fn();
    window.localStorage.setItem(
      RELAY_ACCOUNT_STORAGE_KEY,
      JSON.stringify({
        username: 'jason',
        password: 'pw',
        relayBaseUrl: 'http://159.75.134.56/relay/',
        accessToken: 'access-1',
        user: { id: 'user-1', username: 'jason', createdAt: '2026-05-06T00:00:00Z' },
        deviceId: 'tablet-1',
        deviceName: 'Jason Tablet',
        platform: 'android',
        relaySettings: bridgeSettings.traversalRelay,
        devices: [
          {
            deviceId: 'daemon-device-1',
            deviceName: 'Claw Mac',
            platform: 'mac',
            appVersion: '0.1.1',
            updatedAt: '2026-05-06T00:00:00Z',
            client: { connected: true, lastSeenAt: '2026-05-06T00:00:00Z' },
            daemon: {
              connected: true,
              lastSeenAt: '2026-05-06T00:00:00Z',
              hostId: 'daemon-host-a',
              version: '1.2.3',
            },
          },
        ],
        updatedAt: Date.now(),
      }),
    );

    render(
      <ConnectionPropertiesPage
        bridgeSettings={bridgeSettings}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('例如：MacStudio'), { target: { value: ' Relay Mac ' } });
    fireEvent.click(screen.getByText('Claw Mac'));

    expect(screen.queryByPlaceholderText('100.127.23.27[:40807] 或 macstudio.tailnet')).toBeNull();
    expect(screen.getByText('当前绑定：MacStudio')).toBeTruthy();
    expect(screen.getByText('bridgeHost: 100.64.0.10')).toBeTruthy();
    expect(screen.getByText('authToken: 已绑定')).toBeTruthy();

    fireEvent.click(screen.getByText('Save'));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Relay Mac',
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        authToken: 'token-a',
        daemonHostId: 'daemon-host-a',
        relayHostId: 'daemon-host-a',
        relayDeviceId: 'daemon-device-1',
      }),
    );
  });

  it('discovers tmux sessions in daemon-first mode without manual host/token input', async () => {
    const onSave = vi.fn();
    tmuxSessionMocks.fetchTmuxSessions.mockResolvedValueOnce(['main']);
    window.localStorage.setItem(
      RELAY_ACCOUNT_STORAGE_KEY,
      JSON.stringify({
        username: 'jason',
        password: 'pw',
        relayBaseUrl: 'http://159.75.134.56/relay/',
        accessToken: 'access-1',
        user: { id: 'user-1', username: 'jason', createdAt: '2026-05-06T00:00:00Z' },
        deviceId: 'tablet-1',
        deviceName: 'Jason Tablet',
        platform: 'android',
        relaySettings: bridgeSettings.traversalRelay,
        devices: [
          {
            deviceId: 'daemon-device-1',
            deviceName: 'Claw Mac',
            platform: 'mac',
            appVersion: '0.1.1',
            updatedAt: '2026-05-06T00:00:00Z',
            client: { connected: true, lastSeenAt: '2026-05-06T00:00:00Z' },
            daemon: {
              connected: true,
              lastSeenAt: '2026-05-06T00:00:00Z',
              hostId: 'daemon-host-a',
              version: '1.2.3',
            },
          },
        ],
        updatedAt: Date.now(),
      }),
    );

    render(
      <ConnectionPropertiesPage
        bridgeSettings={bridgeSettings}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('例如：MacStudio'), { target: { value: ' Relay Connect ' } });
    fireEvent.click(screen.getByText('Claw Mac'));
    fireEvent.click(screen.getByText('Connect'));

    await waitFor(() => {
      expect(tmuxSessionMocks.fetchTmuxSessions).toHaveBeenCalledWith(
        expect.objectContaining({
          bridgeHost: '100.64.0.10',
          bridgePort: 3333,
          authToken: 'token-a',
          daemonHostId: 'daemon-host-a',
          relayHostId: 'daemon-host-a',
          relayDeviceId: 'daemon-device-1',
        }),
        bridgeSettings,
      );
    });

    await screen.findByText('main');
    expect(screen.getByDisplayValue('main')).toBeTruthy();
  });

  it('allows first-time daemon bridge binding when selected daemon has no mapped bridge preset', async () => {
    const onSave = vi.fn();
    tmuxSessionMocks.fetchTmuxSessions.mockResolvedValueOnce(['main']);
    window.localStorage.setItem(
      RELAY_ACCOUNT_STORAGE_KEY,
      JSON.stringify({
        username: 'jason',
        password: 'pw',
        relayBaseUrl: 'http://159.75.134.56/relay/',
        accessToken: 'access-1',
        user: { id: 'user-1', username: 'jason', createdAt: '2026-05-06T00:00:00Z' },
        deviceId: 'tablet-1',
        deviceName: 'Jason Tablet',
        platform: 'android',
        relaySettings: bridgeSettings.traversalRelay,
        devices: [
          {
            deviceId: 'daemon-device-2',
            deviceName: 'Other Mac',
            platform: 'mac',
            appVersion: '0.1.1',
            updatedAt: '2026-05-06T00:00:00Z',
            client: { connected: true, lastSeenAt: '2026-05-06T00:00:00Z' },
            daemon: {
              connected: true,
              lastSeenAt: '2026-05-06T00:00:00Z',
              hostId: 'daemon-host-unmapped',
              version: '1.2.3',
            },
          },
        ],
        updatedAt: Date.now(),
      }),
    );

    render(
      <ConnectionPropertiesPage
        bridgeSettings={bridgeSettings}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('例如：MacStudio'), { target: { value: ' Relay Missing Map ' } });
    fireEvent.click(screen.getByText('Other Mac'));
    expect(screen.getByText('这个 daemon 还没有绑定 bridge preset。先手工填写 bridge host 和 token，然后保存会把它写入连接列表。')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('100.127.23.27[:40807] 或 macstudio.tailnet'), {
      target: { value: '100.86.84.63' },
    });
    fireEvent.change(screen.getByPlaceholderText('daemon 的共享 token'), { target: { value: 'token-new' } });
    fireEvent.click(screen.getByText('Connect'));

    await waitFor(() => {
      expect(tmuxSessionMocks.fetchTmuxSessions).toHaveBeenCalledWith(
        expect.objectContaining({
          bridgeHost: '100.86.84.63',
          bridgePort: 3333,
          authToken: 'token-new',
          daemonHostId: 'daemon-host-unmapped',
          relayHostId: 'daemon-host-unmapped',
          relayDeviceId: 'daemon-device-2',
        }),
        bridgeSettings,
      );
    });

    await screen.findByText('main');
    fireEvent.click(screen.getByText('Save'));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Relay Missing Map',
        bridgeHost: '100.86.84.63',
        bridgePort: 3333,
        authToken: 'token-new',
        daemonHostId: 'daemon-host-unmapped',
        relayHostId: 'daemon-host-unmapped',
        relayDeviceId: 'daemon-device-2',
        sessionName: 'main',
      }),
    );
  });

  it('clears stale bridge mapping when switching from a mapped daemon to an unmapped daemon and allows manual binding', async () => {
    const onSave = vi.fn();
    tmuxSessionMocks.fetchTmuxSessions.mockResolvedValueOnce(['main']);
    window.localStorage.setItem(
      RELAY_ACCOUNT_STORAGE_KEY,
      JSON.stringify({
        username: 'jason',
        password: 'pw',
        relayBaseUrl: 'http://159.75.134.56/relay/',
        accessToken: 'access-1',
        user: { id: 'user-1', username: 'jason', createdAt: '2026-05-06T00:00:00Z' },
        deviceId: 'tablet-1',
        deviceName: 'Jason Tablet',
        platform: 'android',
        relaySettings: bridgeSettings.traversalRelay,
        devices: [
          {
            deviceId: 'daemon-device-1',
            deviceName: 'Claw Mac',
            platform: 'mac',
            appVersion: '0.1.1',
            updatedAt: '2026-05-06T00:00:00Z',
            client: { connected: true, lastSeenAt: '2026-05-06T00:00:00Z' },
            daemon: {
              connected: true,
              lastSeenAt: '2026-05-06T00:00:00Z',
              hostId: 'daemon-host-a',
              version: '1.2.3',
            },
          },
          {
            deviceId: 'daemon-device-2',
            deviceName: 'Other Mac',
            platform: 'mac',
            appVersion: '0.1.1',
            updatedAt: '2026-05-06T00:00:00Z',
            client: { connected: true, lastSeenAt: '2026-05-06T00:00:00Z' },
            daemon: {
              connected: true,
              lastSeenAt: '2026-05-06T00:00:00Z',
              hostId: 'daemon-host-unmapped',
              version: '1.2.3',
            },
          },
        ],
        updatedAt: Date.now(),
      }),
    );

    render(
      <ConnectionPropertiesPage
        bridgeSettings={bridgeSettings}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('例如：MacStudio'), { target: { value: ' Relay Switch ' } });
    fireEvent.click(screen.getByText('Claw Mac'));
    expect(screen.getByText('bridgeHost: 100.64.0.10')).toBeTruthy();
    expect(screen.getByText('authToken: 已绑定')).toBeTruthy();

    fireEvent.click(screen.getByText('Other Mac'));

    expect(await screen.findByText('这个 daemon 还没有绑定 bridge preset。先手工填写 bridge host 和 token，然后保存会把它写入连接列表。')).toBeTruthy();
    expect(screen.queryByText('bridgeHost: 100.64.0.10')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('100.127.23.27[:40807] 或 macstudio.tailnet'), {
      target: { value: '100.86.84.63' },
    });
    fireEvent.change(screen.getByPlaceholderText('daemon 的共享 token'), { target: { value: 'token-new' } });

    fireEvent.click(screen.getByText('Connect'));
    await waitFor(() => {
      expect(tmuxSessionMocks.fetchTmuxSessions).toHaveBeenCalledWith(
        expect.objectContaining({
          bridgeHost: '100.86.84.63',
          bridgePort: 3333,
          authToken: 'token-new',
          daemonHostId: 'daemon-host-unmapped',
          relayHostId: 'daemon-host-unmapped',
          relayDeviceId: 'daemon-device-2',
        }),
        bridgeSettings,
      );
    });
    await screen.findByText('main');
    fireEvent.click(screen.getByText('Save'));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Relay Switch',
        bridgeHost: '100.86.84.63',
        bridgePort: 3333,
        authToken: 'token-new',
        daemonHostId: 'daemon-host-unmapped',
        relayHostId: 'daemon-host-unmapped',
        relayDeviceId: 'daemon-device-2',
        sessionName: 'main',
      }),
    );
  });

  it('blocks daemon-first save until manual bridge host and token are filled', async () => {
    const onSave = vi.fn();
    window.localStorage.setItem(
      RELAY_ACCOUNT_STORAGE_KEY,
      JSON.stringify({
        username: 'jason',
        password: 'pw',
        relayBaseUrl: 'http://159.75.134.56/relay/',
        accessToken: 'access-1',
        user: { id: 'user-1', username: 'jason', createdAt: '2026-05-06T00:00:00Z' },
        deviceId: 'tablet-1',
        deviceName: 'Jason Tablet',
        platform: 'android',
        relaySettings: bridgeSettings.traversalRelay,
        devices: [
          {
            deviceId: 'daemon-device-2',
            deviceName: 'Other Mac',
            platform: 'mac',
            appVersion: '0.1.1',
            updatedAt: '2026-05-06T00:00:00Z',
            client: { connected: true, lastSeenAt: '2026-05-06T00:00:00Z' },
            daemon: {
              connected: true,
              lastSeenAt: '2026-05-06T00:00:00Z',
              hostId: 'daemon-host-unmapped',
              version: '1.2.3',
            },
          },
        ],
        updatedAt: Date.now(),
      }),
    );

    render(
      <ConnectionPropertiesPage
        bridgeSettings={bridgeSettings}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('例如：MacStudio'), { target: { value: ' Relay Missing Values ' } });
    fireEvent.click(screen.getByText('Other Mac'));
    fireEvent.click(screen.getByText('Save'));

    expect(window.alert).toHaveBeenCalledWith('请先填写这个 daemon 对应的 bridge host 和 token。');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('blocks rtc-first save until a relay daemon device is selected', () => {
    const onSave = vi.fn();

    render(
      <ConnectionPropertiesPage
        bridgeSettings={bridgeSettings}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('例如：MacStudio'), { target: { value: ' Relay RTC ' } });
    fireEvent.change(screen.getByPlaceholderText('100.127.23.27[:40807] 或 macstudio.tailnet'), {
      target: { value: '100.64.0.10' },
    });
    fireEvent.change(screen.getByPlaceholderText('daemon 的共享 token'), { target: { value: 'token-a' } });
    fireEvent.click(screen.getByText('RTC First'));
    fireEvent.click(screen.getByText('Save'));

    expect(window.alert).toHaveBeenCalledWith('RTC First 模式下请先选择一个在线的 Relay Daemon 设备');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('renders a canonical share link and QR projection for an existing saved host', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const savedHost = makeHost({
      password: 'must-not-export',
      privateKey: 'must-not-export',
      lastConnected: 2000,
    });

    render(
      <ConnectionPropertiesPage
        host={savedHost}
        bridgeSettings={bridgeSettings}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const link = screen.getByTestId('connection-share-link') as HTMLTextAreaElement;
    expect(link.value.startsWith('zterm://connection/import?payload=')).toBe(true);
    const parsed = parseConnectionConfigShareLink(link.value);
    expect(parsed).toEqual(
      expect.objectContaining({
        ok: true,
        host: expect.objectContaining({
          name: 'Share Mac',
          bridgeHost: '100.127.23.27',
          bridgePort: 40807,
          password: undefined,
          privateKey: undefined,
          lastConnected: undefined,
        }),
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('connection-share-qr').innerHTML).toContain('<svg');
    });
    fireEvent.click(screen.getByText('Copy Link'));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(link.value);
      expect(screen.getByText('Copied')).toBeTruthy();
    });
  });

  it('imports a pasted connection share link from the add connection flow', () => {
    const onImportConnectionLink = vi.fn(() => ({ ok: true as const, name: 'Imported Mac' }));

    render(
      <ConnectionPropertiesPage
        bridgeSettings={bridgeSettings}
        onImportConnectionLink={onImportConnectionLink}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Connection share link'), {
      target: { value: 'zterm://connection/import?payload=abc' },
    });
    fireEvent.click(screen.getByText('Import'));

    expect(onImportConnectionLink).toHaveBeenCalledWith('zterm://connection/import?payload=abc');
    expect(screen.getByText('Imported Imported Mac')).toBeTruthy();
    expect((screen.getByLabelText('Connection share link') as HTMLTextAreaElement).value).toBe('');
  });

  it('surfaces malformed import links in the add connection flow without clearing input', () => {
    const onImportConnectionLink = vi.fn(() => ({ ok: false as const, error: 'connection share link is missing payload' }));

    render(
      <ConnectionPropertiesPage
        bridgeSettings={bridgeSettings}
        onImportConnectionLink={onImportConnectionLink}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Connection share link'), {
      target: { value: 'bad-link' },
    });
    fireEvent.click(screen.getByText('Import'));

    expect(screen.getByText('Import failed: connection share link is missing payload')).toBeTruthy();
    expect((screen.getByLabelText('Connection share link') as HTMLTextAreaElement).value).toBe('bad-link');
  });

  it('shares all existing saved connections by default from the add connection flow', async () => {
    const savedHost = makeHost({
      id: 'share-existing',
      name: 'Existing Mac',
      password: 'must-not-export',
      privateKey: 'must-not-export',
    });
    const linuxHost = makeHost({
      id: 'share-linux',
      name: 'Linux Box',
      bridgeHost: '100.64.0.20',
      bridgePort: 3334,
      sessionName: 'work',
      authToken: 'token-b',
    });

    render(
      <ConnectionPropertiesPage
        shareableHosts={[savedHost, linuxHost]}
        quickActions={[
          { id: 'qa-1', label: 'ls', sequence: 'ls -la\r', order: 0 },
        ]}
        shortcutActions={[
          { id: 'sc-1', label: 'Ctrl+C', sequence: '\x03', order: 0, row: 'bottom-scroll' },
        ]}
        bridgeSettings={bridgeSettings}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const link = screen.getByTestId('connection-share-link') as HTMLTextAreaElement;
    const parsed = parseConnectionConfigShareLink(link.value);
    expect(screen.getByText('Share All Connections: 2')).toBeTruthy();
    expect(parsed).toEqual(
      expect.objectContaining({
        ok: true,
        hosts: [
          expect.objectContaining({
            name: 'Existing Mac',
            password: undefined,
            privateKey: undefined,
          }),
          expect.objectContaining({
            name: 'Linux Box',
            bridgeHost: '100.64.0.20',
          }),
        ],
        host: expect.objectContaining({
          name: 'Existing Mac',
          password: undefined,
          privateKey: undefined,
        }),
        quickActions: [
          { id: 'qa-1', label: 'ls', sequence: 'ls -la\r', order: 0 },
        ],
        shortcutActions: [
          { id: 'sc-1', label: 'Ctrl+C', sequence: '\x03', order: 0, row: 'bottom-scroll' },
        ],
      }),
    );
    await waitFor(() => {
      expect(screen.getByTestId('connection-share-qr').innerHTML).toContain('<svg');
    });

    fireEvent.click(screen.getByText('Linux Box'));
    expect(screen.getByText('Share Single Connection: Linux Box')).toBeTruthy();
    const narrowed = parseConnectionConfigShareLink(link.value);
    expect(narrowed).toEqual(expect.objectContaining({
      ok: true,
      hosts: [
        expect.objectContaining({
          name: 'Linux Box',
          bridgeHost: '100.64.0.20',
        }),
      ],
    }));
  });
});
