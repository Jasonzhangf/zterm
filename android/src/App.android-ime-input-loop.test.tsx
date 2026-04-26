// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: Array<string | ArrayBuffer> = [];
  onopen: ((event?: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer) {
    this.sent.push(data);
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
  }
}

class ResizeObserverMock {
  static instances = new Set<ResizeObserverMock>();

  constructor(callback: ResizeObserverCallback) {
    void callback;
    ResizeObserverMock.instances.add(this);
  }

  observe() {}
  unobserve() {}
  disconnect() {
    ResizeObserverMock.instances.delete(this);
  }

  static reset() {
    ResizeObserverMock.instances.clear();
  }
}

const imeListeners = new Map<string, (event: any) => void>();

function row(text: string): TerminalCell[] {
  return Array.from(text).map((char) => ({
    char: char.codePointAt(0) || 32,
    fg: 256,
    bg: 256,
    flags: 0,
    width: 1,
  }));
}

function payload(lines: Array<[number, string]>, revision: number, startIndex: number, endIndex: number) {
  const indexedLines: TerminalIndexedLine[] = lines.map(([index, line]) => ({
    index,
    cells: row(line),
  }));
  return {
    revision,
    startIndex,
    endIndex,
    availableStartIndex: 0,
    availableEndIndex: endIndex,
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
  tailLine: string;
}) {
  const lines: Array<[number, string]> = [];
  for (let index = options.startIndex; index < options.endIndex - 1; index += 1) {
    lines.push([index, `line-${String(index).padStart(3, '0')}`]);
  }
  lines.push([options.endIndex - 1, options.tailLine]);
  return payload(lines, options.revision, options.startIndex, options.endIndex);
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
    getPlatform: () => 'android',
  },
  registerPlugin: () => ({
    show: vi.fn(async () => ({})),
    hide: vi.fn(async () => undefined),
    blur: vi.fn(async () => undefined),
    getState: vi.fn(async () => ({})),
    debugEmitInput: vi.fn(async () => ({})),
    setEditorActive: vi.fn(async () => ({})),
    addListener: vi.fn(async (eventName: string, listener: (event: any) => void) => {
      imeListeners.set(eventName, listener);
      return {
        remove: vi.fn(async () => {
          imeListeners.delete(eventName);
        }),
      };
    }),
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
  TerminalHeader: () => <div data-testid="terminal-header" />,
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

describe('App Android IME input closed loop', () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  const originalResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    cleanup();
    localStorage.clear();
    MockWebSocket.reset();
    ResizeObserverMock.reset();
    imeListeners.clear();
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
    imeListeners.clear();
    if (originalClientWidth) {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
    }
    if (originalClientHeight) {
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
    }
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    ResizeObserverMock.reset();
  });

  it('routes native Android IME input through App -> SessionContext -> renderer without waiting for DOM textarea input', async () => {
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
    await waitFor(() => expect(imeListeners.has('input')).toBe(true));

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

    ws.triggerMessage({
      type: 'buffer-sync',
      payload: fullTailWindowPayload({
        revision: 3,
        startIndex: 45,
        endIndex: 240,
        tailLine: 'prompt-before-input',
      }),
    });

    await waitFor(() => {
      expect(view.container.textContent).toContain('prompt-before-input');
    });

    ws.sent.length = 0;
    imeListeners.get('input')?.({ text: 'ls' });

    await waitFor(() => {
      const sent = readSentMessages(ws);
      expect(sent.some((item) => item.type === 'input' && item.payload === 'ls')).toBe(true);
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

    ws.triggerMessage({
      type: 'buffer-sync',
      payload: fullTailWindowPayload({
        revision: 4,
        startIndex: 45,
        endIndex: 240,
        tailLine: 'prompt-before-inputls',
      }),
    });

    await waitFor(() => {
      expect(view.container.textContent).toContain('prompt-before-inputls');
    });
  });
});
