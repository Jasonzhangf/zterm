// @vitest-environment jsdom

import { useEffect } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { DEFAULT_TERMINAL_CACHE_LINES } from './lib/mobile-config';
import { STORAGE_KEYS, type ServerMessage, type TerminalCell, type TerminalIndexedLine } from './lib/types';
import { useSessionRenderBufferSnapshot } from './lib/session-render-buffer-store';

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

function readSentMessages(ws: MockWebSocket) {
  return ws.sent
    .filter((item): item is string => typeof item === 'string')
    .map((item) => JSON.parse(item));
}

function encodeCells(cells: TerminalCell[]) {
  return cells.map((cell) => String.fromCodePoint(cell.char || 32)).join('');
}

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
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

vi.mock('./pages/TerminalPage', () => ({
  TerminalPage: ({
    sessions,
    activeSession,
    onSwitchSession,
    onTerminalViewportChange,
    sessionBufferStore,
  }: {
    sessions: any[];
    activeSession: any;
    onSwitchSession: (sessionId: string) => void;
    onTerminalViewportChange?: (sessionId: string, state: { mode: 'follow' | 'reading'; viewportEndIndex: number; viewportRows: number }) => void;
    sessionBufferStore?: { getSnapshot: (sessionId: string) => { buffer: { lines: any[]; bufferTailEndIndex: number; endIndex: number } } };
  }) => {
    const activeBufferSnapshot = useSessionRenderBufferSnapshot(sessionBufferStore as any, activeSession?.id || null);
    const liveBuffer = activeSession ? activeBufferSnapshot.buffer : activeSession?.buffer;

    useEffect(() => {
      if (!activeSession || !onTerminalViewportChange) {
        return;
      }
      onTerminalViewportChange(activeSession.id, {
        mode: 'follow',
        viewportEndIndex: Math.max(
          0,
          Math.floor(
            liveBuffer?.daemonHeadEndIndex
            || liveBuffer?.bufferTailEndIndex
            || liveBuffer?.endIndex
            || 0,
          ),
        ),
        viewportRows: 24,
      });
    }, [activeSession?.id, liveBuffer?.daemonHeadEndIndex, liveBuffer?.bufferTailEndIndex, liveBuffer?.endIndex, onTerminalViewportChange]);

    const activeLines = (liveBuffer?.lines || []).map(encodeCells).join('|');
    return (
      <div data-testid="terminal-page">
        <div data-testid="active-session-id">{activeSession?.id || 'missing'}</div>
        <div data-testid="active-session-lines">{activeLines}</div>
        {sessions.map((session) => (
          <button key={session.id} type="button" onClick={() => onSwitchSession(session.id)}>
            switch-{session.id}
          </button>
        ))}
      </div>
    );
  },
}));

describe('App first paint regression', () => {
  const originalWebSocket = globalThis.WebSocket;

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
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    globalThis.WebSocket = originalWebSocket;
  });

  it('cold start single active tab pulls head then latest range and paints without any input', async () => {
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

    render(<App />);

    await waitFor(() => expect(screen.getByTestId('terminal-page')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('active-session-id').textContent).toBe('session-1'));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.some((item) => item.type === 'buffer-head-request')).toBe(true);
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
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.some((item) => item.type === 'buffer-sync-request')).toBe(true);
    });

    ws.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['first-paint-001', 'first-paint-002', 'first-paint-003'], 9, 237),
    });

    await waitFor(() => {
      expect(screen.getByTestId('active-session-lines').textContent).toContain('first-paint-001');
      expect(screen.getByTestId('active-session-lines').textContent).toContain('first-paint-003');
    });
  });

  it('prefers the persisted latest active tab over a stale terminal page focus id during cold restore', async () => {
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
    localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, 'session-2');
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify({ kind: 'terminal', focusSessionId: 'session-1' }));

    render(<App />);

    await waitFor(() => expect(screen.getByTestId('terminal-page')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('active-session-id').textContent).toBe('session-2'));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });
    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.some((item) => item.type === 'connect' && item.payload?.sessionName === 'zterm_mirror_lab_2')).toBe(true);
      expect(sentMessages.some((item) => item.type === 'buffer-head-request')).toBe(true);
    });
  });

  it('ignores ACTIVE_PAGE terminal focus when ACTIVE_SESSION is missing and restores the first persisted tab', async () => {
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
    localStorage.removeItem(STORAGE_KEYS.ACTIVE_SESSION);
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify({ kind: 'terminal', focusSessionId: 'session-2' }));

    render(<App />);

    await waitFor(() => expect(screen.getByTestId('terminal-page')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('active-session-id').textContent).toBe('session-1'));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.some((item) => item.type === 'connect' && item.payload?.sessionName === 'zterm_mirror_lab')).toBe(true);
      expect(sentMessages.some((item) => item.type === 'buffer-head-request')).toBe(true);
    });
  });

  it('restores the last active tab after app relaunch instead of defaulting to the first tab', async () => {
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

    const firstMount = render(<App />);

    await waitFor(() => expect(screen.getByTestId('terminal-page')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('active-session-id').textContent).toBe('session-1'));

    fireEvent.click(screen.getByText('switch-session-2'));

    await waitFor(() => expect(screen.getByTestId('active-session-id').textContent).toBe('session-2'));
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBe('session-2'));

    firstMount.unmount();
    MockWebSocket.reset();

    render(<App />);

    await waitFor(() => expect(screen.getByTestId('terminal-page')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('active-session-id').textContent).toBe('session-2'));
  });

  it('switching to another tab pulls head then latest range and paints the new active tab without any input', async () => {
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

    render(<App />);

    await waitFor(() => expect(screen.getByTestId('terminal-page')).toBeTruthy());
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws1 = MockWebSocket.instances[0]!;
    ws1.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });

    await waitFor(() => expect(screen.getByTestId('active-session-id').textContent).toBe('session-1'));

    fireEvent.click(screen.getByText('switch-session-2'));

    await waitFor(() => expect(screen.getByTestId('active-session-id').textContent).toBe('session-2'));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const ws2 = MockWebSocket.instances[1]!;
    ws2.triggerOpen();
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });
    await waitFor(() => {
      const sentMessages = readSentMessages(ws2);
      expect(sentMessages.some((item) => item.type === 'buffer-head-request')).toBe(true);
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
      const sentMessages = readSentMessages(ws2);
      expect(sentMessages.some((item) => item.type === 'buffer-sync-request')).toBe(true);
    });

    ws2.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['tab-two-line-001', 'tab-two-line-002'], 6, 118),
    });

    await waitFor(() => {
      expect(screen.getByTestId('active-session-id').textContent).toBe('session-2');
      expect(screen.getByTestId('active-session-lines').textContent).toContain('tab-two-line-001');
      expect(screen.getByTestId('active-session-lines').textContent).toContain('tab-two-line-002');
    });
  });
});
