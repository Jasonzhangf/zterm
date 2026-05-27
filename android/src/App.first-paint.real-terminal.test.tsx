// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { DEFAULT_TERMINAL_CACHE_LINES } from './lib/mobile-config';
import { STORAGE_KEYS, type ServerMessage } from './lib/types';

const fetchTmuxSessionsMock = vi.fn();

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  static controlInstances: MockWebSocket[] = [];

  readonly url: string;
  readonly transportRole: 'control' | 'session';
  readyState = MockWebSocket.CONNECTING;
  sent: Array<string | ArrayBuffer> = [];
  onopen: ((event?: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    const role = (() => {
      try {
        const parsed = new URL(url);
        const explicitRole = parsed.searchParams.get('ztermTransport');
        if (explicitRole === 'control' || explicitRole === 'session') {
          return explicitRole;
        }
        const normalizedUrl = parsed.toString();
        const hasExistingControlForTarget = MockWebSocket.controlInstances.some((socket) => socket.url === normalizedUrl);
        return hasExistingControlForTarget ? 'session' : 'control';
      } catch {
        const hasExistingControlForTarget = MockWebSocket.controlInstances.some((socket) => socket.url === url);
        return hasExistingControlForTarget ? 'session' : 'control';
      }
    })();
    this.transportRole = role;
    if (role === 'control') {
      MockWebSocket.controlInstances.push(this);
      queueMicrotask(() => {
        if (this.readyState === MockWebSocket.CONNECTING) {
          this.triggerOpen();
        }
      });
      return;
    }
    MockWebSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer) {
    this.sent.push(data);
    if (this.transportRole !== 'control' || typeof data !== 'string') {
      return;
    }
    const message = JSON.parse(data);
    if (message?.type !== 'session-open') {
      return;
    }
    const payload = message.payload || {};
    this.triggerMessage({
      type: 'session-ticket',
      payload: {
        openRequestId: payload.openRequestId,
        sessionTransportToken: `ticket-${payload.openRequestId}`,
        sessionName: payload.sessionName,
      },
    } as ServerMessage);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  triggerOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  triggerMessage(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }

  static reset() {
    MockWebSocket.instances = [];
    MockWebSocket.controlInstances = [];
  }
}

class ResizeObserverMock {
  static instances = new Set<ResizeObserverMock>();

  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverMock.instances.add(this);
  }

  observe() {}
  unobserve() {}
  disconnect() {
    ResizeObserverMock.instances.delete(this);
  }

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }

  static triggerAll() {
    for (const instance of Array.from(ResizeObserverMock.instances)) {
      instance.trigger();
    }
  }

  static reset() {
    ResizeObserverMock.instances.clear();
  }
}

function readSentMessages(ws: MockWebSocket) {
  return ws.sent
    .filter((item): item is string => typeof item === 'string')
    .map((item) => JSON.parse(item));
}

function connectSessionSocket(ws: MockWebSocket, sessionId: string) {
  ws.triggerOpen();
  ws.triggerMessage({
    type: 'connected',
    payload: { sessionId },
  } as ServerMessage);
}

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
  },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'web',
  },
  registerPlugin: () => ({
    show: vi.fn(async () => ({})),
    hide: vi.fn(async () => undefined),
    blur: vi.fn(async () => undefined),
    getState: vi.fn(async () => ({})),
    debugEmitInput: vi.fn(async () => ({})),
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
  }),
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
  useHostStorage: () => ({
    hosts: [],
    isLoaded: true,
    addHost: vi.fn(),
    upsertHost: (host: any) => ({
      ...host,
      id: host.id || `host:${host.bridgeHost}:${host.bridgePort}:${host.sessionName}`,
      createdAt: host.createdAt || Date.now(),
    }),
    updateHost: vi.fn(),
    deleteHost: vi.fn(),
  }),
}));

vi.mock('./hooks/useQuickActionStorage', () => ({
  useQuickActionStorage: () => ({
    quickActions: [],
    setQuickActions: vi.fn(),
  }),
}));

vi.mock('./hooks/useShortcutActionStorage', () => ({
  useShortcutActionStorage: () => ({
    shortcutActions: [],
    setShortcutActions: vi.fn(),
  }),
}));

vi.mock('./hooks/useSessionDraftStorage', () => ({
  useSessionDraftStorage: () => ({
    drafts: {},
    setDraft: vi.fn(),
    clearDraft: vi.fn(),
    pruneDrafts: vi.fn(),
  }),
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
    updateStage: 'idle',
    setPreferences: vi.fn(),
    checkForUpdates: vi.fn(),
    dismissAvailableManifest: vi.fn(),
    skipCurrentVersion: vi.fn(),
    ignoreUntilManualCheck: vi.fn(),
    resetIgnorePolicy: vi.fn(),
    startUpdate: vi.fn(),
  }),
}));

vi.mock('./lib/tmux-sessions', () => ({
  fetchTmuxSessions: (...args: unknown[]) => fetchTmuxSessionsMock(...args),
}));

vi.mock('./components/tmux/TmuxSessionPickerSheet', () => ({
  TmuxSessionPickerSheet: () => null,
}));

vi.mock('./pages/ConnectionsPage', () => ({
  ConnectionsPage: () => <div data-testid="connections-page" />,
}));

vi.mock('./pages/ConnectionPropertiesPage', () => ({
  ConnectionPropertiesPage: () => <div data-testid="connection-properties-page" />,
}));

vi.mock('./pages/SettingsPage', () => ({
  SettingsPage: () => <div data-testid="settings-page" />,
}));

vi.mock('./components/terminal/TerminalHeader', () => ({
  TerminalHeader: ({ sessions, activeSession, onSwitchSession }: { sessions: Array<{ id: string }>; activeSession?: { id: string } | null; onSwitchSession: (sessionId: string) => void }) => (
    <div data-testid="terminal-header" data-active-session-id={activeSession?.id || ''}>
      {sessions.map((session) => (
        <button key={session.id} type="button" onClick={() => onSwitchSession(session.id)}>
          switch-{session.id}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('./components/terminal/TabManagerSheet', () => ({
  TabManagerSheet: () => null,
}));

vi.mock('./components/terminal/SessionScheduleSheet', () => ({
  SessionScheduleSheet: () => null,
}));

vi.mock('./components/terminal/TerminalQuickBar', () => ({
  TerminalQuickBar: () => <div data-testid="terminal-quickbar" />,
}));

describe('App first paint regression with real TerminalPage/TerminalView', () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');

  beforeEach(() => {
    cleanup();
    const storageBacking = new Map<string, string>();
    const storageShim = {
      get length() {
        return storageBacking.size;
      },
      clear() {
        storageBacking.clear();
      },
      getItem(key: string) {
        return storageBacking.has(key) ? storageBacking.get(key)! : null;
      },
      key(index: number) {
        return Array.from(storageBacking.keys())[index] ?? null;
      },
      removeItem(key: string) {
        storageBacking.delete(key);
      },
      setItem(key: string, value: string) {
        storageBacking.set(key, String(value));
      },
    } as Storage;
    vi.stubGlobal('localStorage', storageShim);
    localStorage.clear();
    MockWebSocket.reset();
    ResizeObserverMock.reset();
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    fetchTmuxSessionsMock.mockReset();
    fetchTmuxSessionsMock.mockImplementation(async (target: { bridgeHost?: string; bridgePort?: number }) => {
      if (target?.bridgeHost === '127.0.0.1' && target?.bridgePort === 3333) {
        return ['zterm_mirror_lab', 'zterm_mirror_lab_2'];
      }
      return [];
    });
    globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return 640;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return 408;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.textContent === 'W') {
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 6,
          bottom: 17,
          width: 6,
          height: 17,
          toJSON() {
            return {};
          },
        } as DOMRect;
      }
      if (this.textContent === '你') {
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 14,
          bottom: 17,
          width: 14,
          height: 17,
          toJSON() {
            return {};
          },
        } as DOMRect;
      }
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 640,
        bottom: 408,
        width: 640,
        height: 17,
        toJSON() {
          return {};
        },
      } as DOMRect;
    };
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    globalThis.WebSocket = originalWebSocket;
    globalThis.ResizeObserver = originalResizeObserver;
    if (originalVisibilityState) {
      Object.defineProperty(document, 'visibilityState', originalVisibilityState);
    }
    if (originalClientWidth) {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
    }
    if (originalClientHeight) {
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
    }
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    ResizeObserverMock.reset();
  });

  it('cold start terminal page explicitly resumes the restored active tab', async () => {
    localStorage.setItem(STORAGE_KEYS.OPEN_TABS, JSON.stringify([
      {
        sessionId: 'session-1',
        hostId: 'host-1',
        connectionName: 'local-test',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'zterm_mirror_lab',
        createdAt: 1,
      },
    ]));
    localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, 'session-1');
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify({ kind: 'terminal' }));

    render(<App />);

    await waitFor(() => expect(screen.getByTestId('terminal-header')).toBeTruthy());
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
  });

  it('switching to another restored tab explicitly opens a second daemon transport after the cold-start active tab resumed', async () => {
    localStorage.setItem(STORAGE_KEYS.OPEN_TABS, JSON.stringify([
      {
        sessionId: 'session-1',
        hostId: 'host-1',
        connectionName: 'local-test-1',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'zterm_mirror_lab',
        createdAt: 1,
      },
      {
        sessionId: 'session-2',
        hostId: 'host-2',
        connectionName: 'local-test-2',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'zterm_mirror_lab_2',
        createdAt: 2,
      },
    ]));
    localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, 'session-1');
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify({ kind: 'terminal' }));

    render(<App />);

    await waitFor(() => expect(screen.getByTestId('terminal-header')).toBeTruthy());
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    fireEvent.click(screen.getByText('switch-session-2'));

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
  });

  it('cold-start split layout immediately marks non-active panes live and requests their head', async () => {
    localStorage.setItem(STORAGE_KEYS.OPEN_TABS, JSON.stringify([
      {
        sessionId: 'session-1',
        hostId: 'host-1',
        connectionName: 'local-test-1',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'zterm_mirror_lab',
        createdAt: 1,
      },
      {
        sessionId: 'session-2',
        hostId: 'host-2',
        connectionName: 'local-test-2',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'zterm_mirror_lab_2',
        createdAt: 2,
      },
    ]));
    localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, 'session-1');
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify({ kind: 'terminal' }));
    localStorage.setItem(STORAGE_KEYS.TERMINAL_LAYOUT, JSON.stringify({
      panes: [
        { id: 'pane-1', size: 0.5, activeTabId: 'tab-session-1', tabs: [{ id: 'tab-session-1', sessionId: 'session-1' }] },
        { id: 'pane-2', size: 0.5, activeTabId: 'tab-session-2', tabs: [{ id: 'tab-session-2', sessionId: 'session-2' }] },
      ],
      activePaneId: 'pane-1',
    }));

    render(<App />);

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    connectSessionSocket(ws1, 'session-1');
    connectSessionSocket(ws2, 'session-2');
    ws1.sent.length = 0;
    ws2.sent.length = 0;

    ResizeObserverMock.triggerAll();

    await waitFor(() => {
      expect(readSentMessages(ws2).some((message) => message.type === 'buffer-head-request')).toBe(true);
    });
  });

  it('foreground resume on the active restored tab does not open a second transport after the initial explicit resume', async () => {
    localStorage.setItem(STORAGE_KEYS.OPEN_TABS, JSON.stringify([
      {
        sessionId: 'session-1',
        hostId: 'host-1',
        connectionName: 'local-test',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'zterm_mirror_lab',
        createdAt: 1,
      },
    ]));
    localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, 'session-1');
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify({ kind: 'terminal' }));

    render(<App />);

    await waitFor(() => expect(screen.getByTestId('terminal-header')).toBeTruthy());
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
  });
});
