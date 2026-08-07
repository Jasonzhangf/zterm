// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppContent } from './App';
import { DEFAULT_TERMINAL_CACHE_LINES } from './lib/mobile-config';
import { STORAGE_KEYS } from './lib/types';

class MockRelayWebSocket {
  static instances: MockRelayWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  readyState = MockRelayWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: Partial<CloseEvent>) => void) | null = null;
  sent: string[] = [];

  constructor() {
    MockRelayWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = '') {
    if (this.readyState === MockRelayWebSocket.CLOSED) {
      return;
    }
    this.readyState = MockRelayWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  triggerOpen() {
    this.readyState = MockRelayWebSocket.OPEN;
    this.onopen?.();
  }

  triggerClose(code = 1006, reason = 'server closed') {
    this.readyState = MockRelayWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  static reset() {
    MockRelayWebSocket.instances = [];
  }
}

const connectRelayDevicesStreamMock = vi.fn();
const readRelayAccountStateMock = vi.fn();
const traversalRelayRefreshMeMock = vi.fn();
const sendDebugSnapshotMock = vi.fn();
const sendDebugLogsMock = vi.fn();
const collectClientDebugSnapshotMock = vi.fn(() => ({}));
const runtimeDebugMock = vi.fn();
const useSessionOpenActionsMock = vi.fn();

vi.mock('./lib/traversal-relay-client', () => ({
  connectTraversalRelayDevicesStream: (...args: any[]) => (connectRelayDevicesStreamMock as any)(...args),
  readTraversalRelayAccountState: (...args: any[]) => (readRelayAccountStateMock as any)(...args),
  traversalRelayRefreshMe: (...args: any[]) => (traversalRelayRefreshMeMock as any)(...args),
  isTraversalRelayAuthenticationError: (error: unknown) => (
    error instanceof Error && error.name === 'TraversalRelayAuthenticationError'
  ),
  writeTraversalRelayAccountState: vi.fn(),
  sendTraversalRelayClientDebugSnapshot: (...args: any[]) => (sendDebugSnapshotMock as any)(...args),
  sendTraversalRelayClientDebugLogs: (...args: any[]) => (sendDebugLogsMock as any)(...args),
  applyTraversalRelaySettings: (base: any, relay: any) => ({ ...base, traversalRelay: relay }),
  getDefaultTraversalRelayBaseUrl: () => 'https://relay.codewhisper.cc:18443/relay/',
}));

vi.mock('./lib/client-debug-snapshot', () => ({
  collectClientDebugSnapshot: (...args: any[]) => (collectClientDebugSnapshotMock as any)(...args),
  registerClientDebugSnapshotSource: vi.fn(),
}));

vi.mock('./lib/runtime-debug', () => ({
  runtimeDebug: (...args: any[]) => (runtimeDebugMock as any)(...args),
}));

vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn(async () => ({ remove: vi.fn() })) },
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'web',
    isNativePlatform: () => false,
    registerPlugin: () => ({
      show: vi.fn(async () => ({})),
      hide: vi.fn(async () => undefined),
      blur: vi.fn(async () => undefined),
      getState: vi.fn(async () => ({})),
      debugEmitInput: vi.fn(async () => ({})),
      addListener: vi.fn(async () => ({ remove: vi.fn() })),
    }),
  },
}));
vi.mock('@capacitor/keyboard', () => ({
  Keyboard: {
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
    hide: vi.fn(async () => undefined),
    show: vi.fn(async () => undefined),
  },
}));

vi.mock('./hooks/useBridgeSettingsStorage', () => ({
  useBridgeSettingsStorage: () => ({
    settings: {
      servers: [],
      targetHost: '127.0.0.1',
      targetPort: 3333,
      targetAuthToken: '',
      terminalCacheLines: DEFAULT_TERMINAL_CACHE_LINES,
      terminalThemeId: 'default',
      terminalWidthMode: 'mirror-fixed',
    },
    setSettings: vi.fn(),
  }),
}));
vi.mock('./hooks/useHostStorage', () => ({
  useHostStorage: () => ({ hosts: [], isLoaded: true, addHost: vi.fn(), updateHost: vi.fn(), deleteHost: vi.fn() }),
}));
vi.mock('./hooks/useQuickActionStorage', () => ({
  useQuickActionStorage: () => ({ quickActions: [], setQuickActions: vi.fn() }),
}));
vi.mock('./hooks/useShortcutActionStorage', () => ({
  useShortcutActionStorage: () => ({ shortcutActions: [], setShortcutActions: vi.fn() }),
}));
vi.mock('./hooks/useShortcutFrequencyStorage', () => ({
  useShortcutFrequencyStorage: () => ({ frequency: {}, increment: vi.fn(), reset: vi.fn() }),
}));
vi.mock('./hooks/useSessionDraftStorage', () => ({
  useSessionDraftStorage: () => ({ drafts: {}, setDraft: vi.fn(), clearDraft: vi.fn(), pruneDrafts: vi.fn() }),
}));
vi.mock('./hooks/useSessionHistoryStorage', () => ({
  useSessionHistoryStorage: () => ({
    sessionGroups: [],
    setSessionGroupSelection: vi.fn(),
    deleteSessionGroup: vi.fn(),
    pruneSessionGroupSelectionToRemoteTruth: vi.fn(),
  }),
}));
vi.mock('./hooks/useAppUpdate', () => ({
  useAppUpdate: () => ({
    preferences: { manifestUrl: '', autoCheckOnLaunch: false, ignoreUntilManualCheck: false, skippedVersionCode: undefined, lastCheckedAt: undefined, lastSeenVersionCode: undefined },
    runtimeVersionCode: 1011491,
    latestManifest: null,
    availableManifest: null,
    checking: false,
    installing: false,
    lastError: null,
    updateStage: null,
    hasNewVersion: false,
    hasUpdateIgnorePolicy: false,
    setPreferences: vi.fn(),
    applyRelayManifestSource: vi.fn(),
    checkForUpdates: vi.fn(),
    dismissAvailableManifest: vi.fn(),
    skipCurrentVersion: vi.fn(),
    ignoreUntilManualCheck: vi.fn(),
    resetIgnorePolicy: vi.fn(),
    startUpdate: vi.fn(),
    rollbackBackup: vi.fn(),
    isRollingBack: false,
    rollbackToPreviousVersion: vi.fn(),
  }),
}));

const mockSessionProvider = vi.fn();
vi.mock('./contexts/SessionContext', async () => {
  const actual = await vi.importActual<typeof import('./contexts/SessionContext')>('./contexts/SessionContext');
  return {
    ...actual,
    useSession: () => ({
      state: { sessions: [], activeSessionId: null, connectedCount: 0 },
      scheduleStates: {},
      getSessionDebugMetrics: vi.fn(() => null),
      createSession: vi.fn(),
      closeSession: vi.fn(),
      switchSession: vi.fn(),
      moveSession: vi.fn(),
      renameSession: vi.fn(),
      setLiveSessionIds: vi.fn(),
      resumeActiveSessionTransport: vi.fn(),
      sendTerminalResize: vi.fn(),
      sendInput: vi.fn(),
      sendImagePaste: vi.fn(),
      sendFileAttach: vi.fn(),
      requestRemoteScreenshot: vi.fn(),
      requestRemoteWindowTargets: vi.fn(),
      sendMessageRaw: vi.fn(),
      onFileTransferMessage: vi.fn(),
      updateSessionViewport: vi.fn(),
      requestScheduleList: vi.fn(),
      upsertScheduleJob: vi.fn(),
      deleteScheduleJob: vi.fn(),
      toggleScheduleJob: vi.fn(),
      runScheduleJobNow: vi.fn(),
      getSessionRenderBufferStore: vi.fn(() => ({ get: vi.fn(), set: vi.fn(), subscribe: vi.fn() })),
    }),
    SessionProvider: ({ children }: { children: React.ReactNode }) => {
      mockSessionProvider(children);
      return <>{children}</>;
    },
  };
});
vi.mock('./hooks/useSessionOpenActions', () => ({
  useSessionOpenActions: (options: any) => {
    useSessionOpenActionsMock(options);
    return {
    handleOpenTmuxSession: vi.fn(),
    handleRestoreSession: vi.fn(),
    handleOpenTerminalByHost: vi.fn(),
    };
  },
}));
vi.mock('./hooks/useAppPageState', () => ({
  useAppPageState: () => ({
    pageState: { kind: 'connections' },
    setPageState: vi.fn(),
    editingHost: null,
    editingDraft: null,
    handleEdit: vi.fn(),
    handleSaveHost: vi.fn(),
    handleCancelHostForm: vi.fn(),
    handleDelete: vi.fn(),
    handleOpenConnectionsPage: vi.fn(),
    handleOpenSettingsPage: vi.fn(),
  }),
}));
vi.mock('./hooks/useTerminalShellActions', () => ({
  useTerminalShellActions: () => ({
    handleShareScreenshot: vi.fn(),
    handleShareCurrentPaneText: vi.fn(),
    handleCopyAllScrollback: vi.fn(),
    handleCopyCurrentPaneText: vi.fn(),
    handleExportTerminalHtml: vi.fn(),
  }),
}));
vi.mock('./lib/terminal-width-mode-manager', () => ({
  updateBridgeSettingsTerminalWidthMode: vi.fn(),
}));
vi.mock('./lib/page-state', () => ({
  openTerminalPage: vi.fn(() => ({ kind: 'terminal' })),
}));
vi.mock('./lib/tmux-sessions', () => ({
  fetchTmuxSessions: vi.fn(async () => []),
}));
vi.mock('./components/connections/ConnectionsPage', () => ({
  ConnectionsPage: () => <div data-testid="connections-page" />,
}));
vi.mock('./components/connection-form/ConnectionPropertiesPage', () => ({
  ConnectionPropertiesPage: () => <div data-testid="connection-properties-page" />,
}));
vi.mock('./pages/ConnectionPropertiesPage', () => ({
  ConnectionPropertiesPage: () => <div data-testid="connection-properties-page" />,
}));
vi.mock('./pages/SettingsPage', () => ({
  SettingsPage: () => <div data-testid="settings-page" />,
}));
vi.mock('./pages/TerminalPage', () => ({
  TerminalPage: () => <div data-testid="terminal-page" />,
}));
vi.mock('./components/tmux/TmuxSessionPickerSheet', () => ({
  TmuxSessionPickerSheet: () => null,
}));

const storageBacking = new Map<string, string>();
const storageShim = {
  get length() { return storageBacking.size; },
  clear() { storageBacking.clear(); },
  getItem(key: string) { return storageBacking.get(key) ?? null; },
  key(index: number) { return Array.from(storageBacking.keys())[index] ?? null; },
  removeItem(key: string) { storageBacking.delete(key); },
  setItem(key: string, value: string) { storageBacking.set(key, String(value)); },
} as Storage;

function setupRelayAccount(enabled: boolean) {
  if (enabled) {
    readRelayAccountStateMock.mockReturnValue({
      username: 'jason',
      password: 'pw',
      relayBaseUrl: 'https://relay.example.com/relay/',
      accessToken: 'token-1',
      user: { id: 'u1', username: 'jason', createdAt: 'now' },
      deviceId: 'android-1',
      deviceName: 'ZTerm Android',
      platform: 'android',
      devices: [],
      directory: null,
      updatedAt: 1,
      relaySettings: makeRelayBridgeSettings(true).traversalRelay,
    });
  } else {
    readRelayAccountStateMock.mockReturnValue(null);
  }
}

function makeRelayBridgeSettings(relayEnabled: boolean) {
  return {
    servers: [],
    targetHost: '127.0.0.1',
    targetPort: 3333,
    targetAuthToken: '',
    traversalRelay: relayEnabled
      ? {
          relayBaseUrl: 'https://relay.example.com/relay/',
          accessToken: 'token-1',
          userId: 'u1',
          username: 'jason',
          deviceId: 'android-1',
          deviceName: 'ZTerm Android',
          platform: 'android',
          wsDevicesUrl: 'wss://relay.example.com/relay/ws/devices',
          wsHostUrl: 'wss://relay.example.com/relay/ws/host',
          wsClientUrl: 'wss://relay.example.com/relay/ws/client',
          turnUrl: '',
          turnUsername: '',
          turnCredential: '',
          updatedAt: 1,
        }
      : undefined,
  } as any;
}

describe('App relay device stream reconnect lifecycle', () => {
  beforeEach(() => {
    MockRelayWebSocket.reset();
    vi.stubGlobal('window', globalThis.window);
    vi.stubGlobal('localStorage', storageShim);
    vi.stubGlobal('WebSocket', MockRelayWebSocket as any);
    localStorage.clear();
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify({ kind: 'connections' }));
    connectRelayDevicesStreamMock.mockReset();
    readRelayAccountStateMock.mockReset();
    traversalRelayRefreshMeMock.mockReset();
    runtimeDebugMock.mockReset();
    sendDebugSnapshotMock.mockReset();
    sendDebugLogsMock.mockReset();
    collectClientDebugSnapshotMock.mockReset();
    useSessionOpenActionsMock.mockReset();
    setupRelayAccount(true);
    traversalRelayRefreshMeMock.mockImplementation(async (account) => ({
      account,
      relaySettings: account.relaySettings,
    }));
    connectRelayDevicesStreamMock.mockImplementation((options: {
      onOpen?: () => void;
      onClose?: (event: CloseEvent) => void;
      onDevices?: (devices: unknown[]) => void;
      onDirectory?: (directory: unknown) => void;
    }) => {
      const socket = new MockRelayWebSocket();
      socket.onopen = () => options.onOpen?.();
      socket.onclose = (event) => options.onClose?.(event as CloseEvent);
      socket.onmessage = (event) => {
        const payload = JSON.parse(String(event.data));
        if (Array.isArray(payload.payload?.devices)) {
          options.onDevices?.(payload.payload.devices);
        }
        if (payload.payload?.directory) {
          options.onDirectory?.(payload.payload.directory);
        }
      };
      return socket;
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('opens a relay device stream when relay settings are enabled', { timeout: 10000 }, async () => {
    render(<AppContent bridgeSettings={makeRelayBridgeSettings(true)} setBridgeSettings={vi.fn()} />);
    await waitFor(() => expect(connectRelayDevicesStreamMock).toHaveBeenCalled(), { timeout: 10000 });
    expect(traversalRelayRefreshMeMock.mock.invocationCallOrder[0]).toBeLessThan(
      connectRelayDevicesStreamMock.mock.invocationCallOrder[0],
    );
    expect(connectRelayDevicesStreamMock.mock.calls[0]?.[0].onControlPong).toEqual(expect.any(Function));
    expect(MockRelayWebSocket.instances).toHaveLength(1);
  });

  it('refreshes relay account control truth before opening the device stream', { timeout: 10000 }, async () => {
    const staleRelaySettings = {
      ...makeRelayBridgeSettings(true).traversalRelay,
      turnUrl: 'turn:claw.codewhisper.cc:3479?transport=udp',
      turnUsername: 'old-turn-user',
      turnCredential: 'old-turn-secret',
    };
    const freshRelaySettings = {
      ...makeRelayBridgeSettings(true).traversalRelay,
      turnUrl: 'turn:relay.codewhisper.cc:3479?transport=udp',
      turnUsername: 'fresh-turn-user',
      turnCredential: 'fresh-turn-secret',
      updatedAt: 2,
    };
    const staleAccount = {
      username: 'jason',
      password: '',
      relayBaseUrl: 'https://relay.example.com/relay/',
      accessToken: 'token-1',
      user: { id: 'u1', username: 'jason', createdAt: 'now' },
      deviceId: 'android-1',
      deviceName: 'ZTerm Android',
      platform: 'android',
      devices: [],
      directory: null,
      updatedAt: 1,
      relaySettings: staleRelaySettings,
    };
    const freshAccount = {
      ...staleAccount,
      updatedAt: 2,
      relaySettings: freshRelaySettings,
    };
    readRelayAccountStateMock.mockReturnValue(staleAccount);
    traversalRelayRefreshMeMock.mockResolvedValueOnce({
      account: freshAccount,
      relaySettings: freshRelaySettings,
    });
    const setBridgeSettings = vi.fn();

    render(<AppContent bridgeSettings={{ ...makeRelayBridgeSettings(true), traversalRelay: staleRelaySettings }} setBridgeSettings={setBridgeSettings} />);

    await waitFor(() => expect(connectRelayDevicesStreamMock).toHaveBeenCalled(), { timeout: 10000 });
    expect(connectRelayDevicesStreamMock.mock.calls[0]?.[0].account.relaySettings.turnUrl).toBe('turn:relay.codewhisper.cc:3479?transport=udp');
    expect(setBridgeSettings).toHaveBeenCalledWith(expect.any(Function));
    const updater = setBridgeSettings.mock.calls[0]?.[0];
    expect(updater({ ...makeRelayBridgeSettings(true), traversalRelay: staleRelaySettings }).traversalRelay.turnUrl).toBe(
      'turn:relay.codewhisper.cc:3479?transport=udp',
    );
  });

  it('keeps route-bearing directory devices when legacy devices snapshots omit endpoints and sessions', { timeout: 10000 }, async () => {
    render(<AppContent bridgeSettings={makeRelayBridgeSettings(true)} setBridgeSettings={vi.fn()} />);
    await waitFor(() => expect(connectRelayDevicesStreamMock).toHaveBeenCalled(), { timeout: 10000 });
    const options = connectRelayDevicesStreamMock.mock.calls[0]?.[0];

    await act(async () => {
      options.onDirectory?.({
        schemaVersion: 1,
        user: { id: 'u1', username: 'jason' },
        updatedAt: '2026-07-21T00:00:00.000Z',
        devices: [{
          deviceId: 'daemon-device-1',
          deviceName: 'mac-studio',
          platform: 'darwin',
          appVersion: '0.1.3',
          client: { connected: false, lastSeenAt: '2026-07-21T00:00:00.000Z' },
          daemon: {
            hostId: 'mac-studio',
            version: '0.1.3',
            presence: { connected: true, lastSeenAt: '2026-07-21T00:00:00.000Z' },
            endpoints: [{
              id: 'relay-rtc:mac-studio',
              kind: 'relay-rtc',
              relayHostId: 'mac-studio',
              authRequired: true,
              lastSeenAt: '2026-07-21T00:00:00.000Z',
            }],
            sessions: [{
              name: 'zterm',
              updatedAt: '2026-07-21T00:00:00.000Z',
            }],
            lastPublishedAt: '2026-07-21T00:00:00.000Z',
          },
        }],
      });
    });

    await waitFor(() => {
      const latest = useSessionOpenActionsMock.mock.lastCall?.[0]?.relayDevices;
      expect(latest).toHaveLength(1);
      expect(latest[0].daemon.endpoints).toHaveLength(1);
      expect(latest[0].daemon.sessions).toEqual([
        expect.objectContaining({ name: 'zterm' }),
      ]);
    });

    await act(async () => {
      options.onDevices?.([{
        deviceId: 'daemon-device-1',
        deviceName: 'mac-studio',
        platform: 'darwin',
        appVersion: '0.1.3',
        updatedAt: '2026-07-21T00:00:01.000Z',
        client: { connected: false, lastSeenAt: '2026-07-21T00:00:01.000Z' },
        daemon: {
          connected: true,
          lastSeenAt: '2026-07-21T00:00:01.000Z',
          hostId: 'mac-studio',
          version: '0.1.3',
        },
      }]);
    });

    await waitFor(() => {
      const latest = useSessionOpenActionsMock.mock.lastCall?.[0]?.relayDevices;
      expect(latest).toHaveLength(1);
      expect(latest[0]).toEqual(expect.objectContaining({
        deviceId: 'daemon-device-1',
        updatedAt: '2026-07-21T00:00:01.000Z',
      }));
      expect(latest[0].daemon).toEqual(expect.objectContaining({
        hostId: 'mac-studio',
        connected: true,
        endpoints: [expect.objectContaining({ id: 'relay-rtc:mac-studio' })],
        sessions: [expect.objectContaining({ name: 'zterm' })],
      }));
    });
  });

  it('syncs normalized relay device identity into bridge settings on startup', { timeout: 10000 }, async () => {
    const migratedRelaySettings = {
      ...makeRelayBridgeSettings(true).traversalRelay,
      deviceId: 'zterm-android-install-1',
      updatedAt: 2,
    };
    const migratedAccount = {
      username: 'jason',
      password: '',
      relayBaseUrl: 'https://relay.example.com/relay/',
      accessToken: 'token-1',
      user: { id: 'u1', username: 'jason', createdAt: 'now' },
      deviceId: 'zterm-android-install-1',
      deviceName: 'ZTerm Android',
      platform: 'android',
      devices: [],
      directory: null,
      updatedAt: 2,
      relaySettings: migratedRelaySettings,
    };
    readRelayAccountStateMock.mockReturnValue(migratedAccount);
    traversalRelayRefreshMeMock.mockResolvedValue({
      account: migratedAccount,
      relaySettings: migratedRelaySettings,
    });
    const setBridgeSettings = vi.fn();
    const staleBridgeSettings = {
      ...makeRelayBridgeSettings(true),
      traversalRelay: {
        ...makeRelayBridgeSettings(true).traversalRelay,
        deviceId: 'zterm-android',
      },
    };

    render(<AppContent bridgeSettings={staleBridgeSettings} setBridgeSettings={setBridgeSettings} />);

    await waitFor(() => expect(setBridgeSettings).toHaveBeenCalledWith(expect.any(Function)), { timeout: 10000 });
    const updater = setBridgeSettings.mock.calls[0]?.[0];
    expect(updater(staleBridgeSettings).traversalRelay.deviceId).toBe('zterm-android-install-1');
  });

  it('does not open a relay device stream when account refresh fails', { timeout: 10000 }, async () => {
    traversalRelayRefreshMeMock.mockRejectedValueOnce(new Error('relay control unavailable'));

    render(<AppContent bridgeSettings={makeRelayBridgeSettings(true)} setBridgeSettings={vi.fn()} />);

    await waitFor(() => expect(runtimeDebugMock).toHaveBeenCalledWith(
      'relay.device-stream.account-refresh.error',
      { message: 'relay control unavailable' },
    ), { timeout: 10000 });
    expect(connectRelayDevicesStreamMock).not.toHaveBeenCalled();
  });

  it('reconnects with backoff after a relay device stream closes', { timeout: 10000 }, async () => {
    render(<AppContent bridgeSettings={makeRelayBridgeSettings(true)} setBridgeSettings={vi.fn()} />);
    await waitFor(() => expect(connectRelayDevicesStreamMock).toHaveBeenCalled(), { timeout: 10000 });
    const firstSocket = MockRelayWebSocket.instances[0];
    expect(firstSocket).toBeDefined();

    firstSocket.triggerOpen();
    expect(runtimeDebugMock).toHaveBeenCalledWith(
      'relay.device-stream.open',
      expect.objectContaining({ deviceId: 'android-1' }),
    );

    firstSocket.triggerClose(1006, 'server closed');
    await waitFor(() => expect(runtimeDebugMock).toHaveBeenCalledWith(
      'relay.device-stream.reconnect.scheduled',
      expect.objectContaining({ reason: 'server closed' }),
    ), { timeout: 10000 });

    expect(MockRelayWebSocket.instances).toHaveLength(1);
    await waitFor(() => expect(MockRelayWebSocket.instances).toHaveLength(2), { timeout: 10000 });
  });

  it('does not reconnect after the component unmounts', { timeout: 10000 }, async () => {
    const view = render(<AppContent bridgeSettings={makeRelayBridgeSettings(true)} setBridgeSettings={vi.fn()} />);
    await waitFor(() => expect(connectRelayDevicesStreamMock).toHaveBeenCalled(), { timeout: 10000 });
    MockRelayWebSocket.instances[0].triggerOpen();
    view.unmount();

    MockRelayWebSocket.instances[0].triggerClose(1006, 'unmount');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(MockRelayWebSocket.instances).toHaveLength(1);
  });
});
