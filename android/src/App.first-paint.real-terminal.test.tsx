// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { DEFAULT_TERMINAL_CACHE_LINES } from './lib/mobile-config';
import { STORAGE_KEYS, type ServerMessage, type TerminalCell, type TerminalIndexedLine } from './lib/types';

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
        clientSessionId: payload.clientSessionId,
        sessionTransportToken: `ticket-${payload.clientSessionId}`,
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

function row(text: string): TerminalCell[] {
  return Array.from(text).map((char) => ({
    char: char.codePointAt(0) || 32,
    fg: 256,
    bg: 256,
    flags: 0,
    width: 1,
  }));
}

function linesToPayload(lines: string[], revision: number, startIndex = 0) {
  const indexedLines: TerminalIndexedLine[] = lines.map((line, offset) => ({
    index: startIndex + offset,
    cells: row(line),
  }));
  return {
    revision,
    startIndex,
    endIndex: startIndex + lines.length,
    availableStartIndex: startIndex,
    availableEndIndex: startIndex + lines.length,
    cols: 80,
    rows: 24,
    cursorKeysApp: false,
    lines: indexedLines,
  };
}

function fullTailWindowPayload(options: {
  revision: number;
  startIndex: number;
  endIndex: number;
  tailLines: string[];
}) {
  const lines: string[] = [];
  const fillerCount = Math.max(0, (options.endIndex - options.startIndex) - options.tailLines.length);
  for (let index = 0; index < fillerCount; index += 1) {
    lines.push(`line-${String(options.startIndex + index).padStart(3, '0')}`);
  }
  lines.push(...options.tailLines);
  return linesToPayload(lines, options.revision, options.startIndex);
}

function readSentMessages(ws: MockWebSocket) {
  return ws.sent
    .filter((item): item is string => typeof item === 'string')
    .map((item) => JSON.parse(item));
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
    recordSessionOpen: vi.fn(),
    recordSessionGroupOpen: vi.fn(),
    setSessionGroupSelection: vi.fn(),
    deleteSessionGroup: vi.fn(),
  }),
}));

vi.mock('./hooks/useAppUpdate', () => ({
  useAppUpdate: () => ({
    latestManifest: null,
    availableManifest: null,
    updateChecking: false,
    updateInstalling: false,
    updateError: null,
    appUpdatePreferences: { manifestUrl: '', ignoredVersionName: null, ignoredVersionCode: null },
    setAppUpdatePreferences: vi.fn(),
    checkForUpdates: vi.fn(),
    dismissAvailableManifest: vi.fn(),
    skipCurrentVersion: vi.fn(),
    ignoreUntilManualCheck: vi.fn(),
    resetIgnorePolicy: vi.fn(),
    startUpdate: vi.fn(),
  }),
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
    localStorage.clear();
    MockWebSocket.reset();
    ResizeObserverMock.reset();
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
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

  it('cold start single active tab does head -> sync -> visible rows without any input', async () => {
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
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify({ kind: 'terminal', focusSessionId: 'session-1' }));

    const view = render(<App />);

    await waitFor(() => expect(screen.getByTestId('terminal-header')).toBeTruthy());
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });

    await waitFor(() => {
      const sent = readSentMessages(ws);
      expect(sent.some((item) => item.type === 'buffer-head-request')).toBe(true);
    });

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 9,
        latestEndIndex: 240,
        availableStartIndex: 0,
        availableEndIndex: 240,
      },
    });

    await waitFor(() => {
      const sent = readSentMessages(ws);
      expect(sent.some((item) => item.type === 'buffer-sync-request')).toBe(true);
    });

    ws.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['first-paint-001', 'first-paint-002', 'first-paint-003'], 9, 237),
    });

    await waitFor(() => {
      expect(view.container.textContent).toContain('first-paint-001');
      expect(view.container.textContent).toContain('first-paint-003');
    });
  });

  it('switching to another tab does head -> sync -> visible rows on the new tab without input', async () => {
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
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify({ kind: 'terminal', focusSessionId: 'session-1' }));

    const view = render(<App />);

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws1 = MockWebSocket.instances[0]!;
    ws1.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });

    await waitFor(() => expect(screen.getByTestId('terminal-header')).toBeTruthy());

    fireEvent.click(screen.getByText('switch-session-2'));

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const ws2 = MockWebSocket.instances[1]!;
    ws2.triggerOpen();
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });
    await waitFor(() => {
      const sent = readSentMessages(ws2);
      expect(sent.some((item) => item.type === 'buffer-head-request')).toBe(true);
    });

    ws2.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-2',
        revision: 6,
        latestEndIndex: 120,
        availableStartIndex: 0,
        availableEndIndex: 120,
      },
    });

    await waitFor(() => {
      const sent = readSentMessages(ws2);
      expect(sent.some((item) => item.type === 'buffer-sync-request')).toBe(true);
    });

    ws2.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['tab-two-line-001', 'tab-two-line-002'], 6, 118),
    });

    await waitFor(() => {
      expect(view.container.textContent).toContain('tab-two-line-001');
      expect(view.container.textContent).toContain('tab-two-line-002');
    });
  });

  it('foreground resume on the active tab does head -> sync -> visible body repaint without switching tabs', async () => {
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
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify({ kind: 'terminal', focusSessionId: 'session-1' }));

    const view = render(<App />);

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });

    await waitFor(() => {
      const sent = readSentMessages(ws);
      expect(sent.some((item) => item.type === 'buffer-head-request')).toBe(true);
    });

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 3,
        latestEndIndex: 240,
        availableStartIndex: 0,
        availableEndIndex: 240,
      },
    });

    await waitFor(() => {
      const sent = readSentMessages(ws);
      expect(sent.some((item) => item.type === 'buffer-sync-request')).toBe(true);
    });

    const firstSync = readSentMessages(ws).find((item) => item.type === 'buffer-sync-request');
    expect(firstSync?.payload).toBeTruthy();
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: fullTailWindowPayload({
        revision: 3,
        startIndex: firstSync.payload.requestStartIndex,
        endIndex: firstSync.payload.requestEndIndex,
        tailLines: ['before-resume-line-001', 'before-resume-line-002'],
      }),
    });

    await waitFor(() => {
      expect(view.container.textContent).toContain('before-resume-line-001');
      expect(view.container.textContent).toContain('before-resume-line-002');
    });

    ws.sent.length = 0;

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

    await waitFor(() => {
      const sent = readSentMessages(ws);
      expect(sent.some((item) => item.type === 'buffer-head-request')).toBe(true);
    });

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 4,
        latestEndIndex: 240,
        availableStartIndex: 0,
        availableEndIndex: 240,
      },
    });

    await waitFor(() => {
      const sent = readSentMessages(ws);
      expect(sent.some((item) => item.type === 'buffer-sync-request' && item.payload?.knownRevision === 3)).toBe(true);
    });

    const resumeSyncRequests = readSentMessages(ws)
      .filter((item) => item.type === 'buffer-sync-request');
    const resumeSync = resumeSyncRequests[resumeSyncRequests.length - 1];
    expect(resumeSync?.payload).toBeTruthy();
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: fullTailWindowPayload({
        revision: 4,
        startIndex: resumeSync.payload.requestStartIndex,
        endIndex: resumeSync.payload.requestEndIndex,
        tailLines: ['after-resume-line-001', 'after-resume-line-002'],
      }),
    });

    await waitFor(() => {
      expect(view.container.textContent).toContain('after-resume-line-001');
      expect(view.container.textContent).toContain('after-resume-line-002');
      expect(view.container.textContent).not.toContain('before-resume-line-001');
    });
  });
});
