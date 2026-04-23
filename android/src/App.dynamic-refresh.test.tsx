// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from './lib/types';

function makeSession(id: string, revision: number) {
  return {
    id,
    hostId: `host-${id}`,
    connectionName: `conn-${id}`,
    bridgeHost: '127.0.0.1',
    bridgePort: 3333,
    sessionName: `session-${id}`,
    title: `title-${id}`,
    ws: null,
    state: 'connected' as const,
    hasUnread: false,
    createdAt: 1,
    buffer: {
      lines: [],
      startIndex: 0,
      endIndex: 0,
      viewportEndIndex: 0,
      cols: 80,
      rows: 24,
      cursorKeysApp: false,
      updateKind: 'replace' as const,
      revision,
    },
  };
}

const sessionHarness = vi.hoisted(() => {
  let state = {
    sessions: [makeSession('s1', 1)],
    activeSessionId: 's1',
    connectedCount: 1,
  };
  let staleActiveSession = state.sessions[0];
  const reconnectAllSessions = vi.fn();
  const reconnectSession = vi.fn();
  const refreshSessionTail = vi.fn(() => true);
  const createSession = vi.fn();
  const switchSession = vi.fn();

  return {
    readState: () => state,
    readStaleActiveSession: () => staleActiveSession,
    reconnectAllSessions,
    reconnectSession,
    refreshSessionTail,
    createSession,
    switchSession,
    update(next: typeof state, stale = staleActiveSession) {
      state = next;
      staleActiveSession = stale;
    },
    reset() {
      state = {
        sessions: [makeSession('s1', 1)],
        activeSessionId: 's1',
        connectedCount: 1,
      };
      staleActiveSession = state.sessions[0];
      reconnectAllSessions.mockReset();
      reconnectSession.mockReset();
      refreshSessionTail.mockReset();
      refreshSessionTail.mockReturnValue(true);
      createSession.mockReset();
      switchSession.mockReset();
    },
  };
});

const hostHarness = vi.hoisted(() => {
  let hosts: any[] = [];
  let isLoaded = true;

  return {
    readHosts: () => hosts,
    readLoaded: () => isLoaded,
    setHosts(next: any[]) {
      hosts = next;
    },
    setLoaded(next: boolean) {
      isLoaded = next;
    },
    reset() {
      hosts = [];
      isLoaded = true;
    },
  };
});

const capacitorAppHarness = vi.hoisted(() => {
  let listeners: Array<(state: { isActive: boolean }) => void> = [];

  return {
    addListener: vi.fn(async (_eventName: string, listener: (state: { isActive: boolean }) => void) => {
      listeners.push(listener);
      return {
        remove: vi.fn(async () => {
          listeners = listeners.filter((item) => item !== listener);
        }),
      };
    }),
    emit(state: { isActive: boolean }) {
      const activeListeners = listeners.length > 0
        ? listeners
        : [this.addListener.mock.calls[this.addListener.mock.calls.length - 1]?.[1]].filter(
            (listener): listener is (state: { isActive: boolean }) => void => typeof listener === 'function',
          );
      activeListeners.forEach((listener) => listener(state));
    },
    reset() {
      listeners = [];
      this.addListener.mockReset();
    },
  };
});

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: capacitorAppHarness.addListener,
  },
}));

vi.mock('./contexts/SessionContext', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSession: () => ({
    state: sessionHarness.readState(),
    createSession: sessionHarness.createSession,
    closeSession: vi.fn(),
    switchSession: sessionHarness.switchSession,
    moveSession: vi.fn(),
    renameSession: vi.fn(),
    reconnectSession: sessionHarness.reconnectSession,
    reconnectAllSessions: sessionHarness.reconnectAllSessions,
    refreshSessionTail: sessionHarness.refreshSessionTail,
    getActiveSession: () => sessionHarness.readStaleActiveSession(),
    sendInput: vi.fn(),
    sendImagePaste: vi.fn(),
    resizeTerminal: vi.fn(),
    updateSessionViewport: vi.fn(),
    requestViewportPrefetch: vi.fn(),
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
    startUpdate: vi.fn(),
    resetIgnorePolicy: vi.fn(),
  }),
}));

vi.mock('./hooks/useHostStorage', () => ({
  useHostStorage: () => ({
    hosts: hostHarness.readHosts(),
    isLoaded: hostHarness.readLoaded(),
    addHost: vi.fn(),
    upsertHost: vi.fn(),
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

vi.mock('./components/tmux/TmuxSessionPickerSheet', () => ({
  TmuxSessionPickerSheet: () => null,
}));

vi.mock('./pages/ConnectionsPage', () => ({
  ConnectionsPage: () => null,
}));

vi.mock('./pages/ConnectionPropertiesPage', () => ({
  ConnectionPropertiesPage: () => null,
}));

vi.mock('./pages/SettingsPage', () => ({
  SettingsPage: () => null,
}));

vi.mock('./pages/TerminalPage', () => ({
  TerminalPage: ({ activeSession }: { activeSession: { buffer: { revision: number } } | null }) => (
    <div data-testid="terminal-revision">{activeSession?.buffer.revision ?? -1}</div>
  ),
}));

import { AppContent } from './App';

describe('App dynamic refresh matrix', () => {
  const originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');

  beforeEach(() => {
    sessionHarness.reset();
    hostHarness.reset();
    capacitorAppHarness.reset();
    localStorage.clear();
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify({ kind: 'terminal', focusSessionId: 's1' }));
  });

  afterEach(() => {
    cleanup();
    if (originalVisibilityState) {
      Object.defineProperty(document, 'visibilityState', originalVisibilityState);
    }
  });

  it('keeps terminal rendering in sync across sequential active-session buffer updates', async () => {
    const view = render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));

    act(() => {
      sessionHarness.update(
        {
          sessions: [makeSession('s1', 2)],
          activeSessionId: 's1',
          connectedCount: 1,
        },
        makeSession('s1', 1),
      );
    });
    view.rerender(<AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('2'));

    act(() => {
      sessionHarness.update(
        {
          sessions: [makeSession('s1', 3)],
          activeSessionId: 's1',
          connectedCount: 1,
        },
        makeSession('s1', 2),
      );
    });
    view.rerender(<AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('3'));
  });

  it('follows state activeSession switch even when stale getter still points to previous session', async () => {
    const view = render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));

    act(() => {
      sessionHarness.update(
        {
          sessions: [makeSession('s1', 1), makeSession('s2', 9)],
          activeSessionId: 's2',
          connectedCount: 2,
        },
        makeSession('s1', 1),
      );
    });
    view.rerender(<AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('9'));
  });

  it('reconnects on pageshow foreground restore but ignores plain online noise', async () => {
    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));

    act(() => {
      window.dispatchEvent(new Event('online'));
    });

    expect(sessionHarness.reconnectAllSessions).not.toHaveBeenCalled();
    expect(sessionHarness.reconnectSession).not.toHaveBeenCalled();
    expect(sessionHarness.refreshSessionTail).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new Event('pageshow'));
    });

    expect(sessionHarness.refreshSessionTail).toHaveBeenCalledTimes(1);
    expect(sessionHarness.refreshSessionTail).toHaveBeenCalledWith('s1');
    expect(sessionHarness.reconnectSession).not.toHaveBeenCalled();
    expect(sessionHarness.reconnectAllSessions).not.toHaveBeenCalled();
  });

  it('coalesces hidden-resume lifecycle burst into a single reconnect sweep', async () => {
    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));

    act(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    act(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('resume'));
    });

    expect(sessionHarness.refreshSessionTail).toHaveBeenCalledTimes(1);
    expect(sessionHarness.refreshSessionTail).toHaveBeenCalledWith('s1');
    expect(sessionHarness.reconnectSession).not.toHaveBeenCalled();
    expect(sessionHarness.reconnectAllSessions).not.toHaveBeenCalled();
  });

  it('reconnects on Capacitor appStateChange foreground resume', async () => {
    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));
    await waitFor(() => expect(capacitorAppHarness.addListener).toHaveBeenCalled());

    act(() => {
      capacitorAppHarness.emit({ isActive: false });
      capacitorAppHarness.emit({ isActive: true });
    });

    expect(sessionHarness.refreshSessionTail).toHaveBeenCalledTimes(1);
    expect(sessionHarness.refreshSessionTail).toHaveBeenCalledWith('s1');
    expect(sessionHarness.reconnectSession).not.toHaveBeenCalled();
    expect(sessionHarness.reconnectAllSessions).not.toHaveBeenCalled();
  });


  it('falls back to reconnect when tail refresh cannot run on foreground resume', async () => {
    sessionHarness.refreshSessionTail.mockReturnValue(false);

    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));

    act(() => {
      window.dispatchEvent(new Event('pageshow'));
    });

    expect(sessionHarness.refreshSessionTail).toHaveBeenCalledWith('s1');
    expect(sessionHarness.reconnectSession).toHaveBeenCalledTimes(1);
    expect(sessionHarness.reconnectSession).toHaveBeenCalledWith('s1');
  });

  it('restores persisted open tabs using the stored latest tab set and active tab id', async () => {
    sessionHarness.update({
      sessions: [],
      activeSessionId: null,
      connectedCount: 0,
    } as any, null as any);
    hostHarness.setHosts([
      {
        id: 'host-a',
        createdAt: 1,
        name: 'Conn A',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'alpha',
        authToken: 'token-a',
        authType: 'password',
        tags: [],
        pinned: false,
      },
      {
        id: 'host-b',
        createdAt: 2,
        name: 'Conn B',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'beta',
        authToken: 'token-b',
        authType: 'password',
        tags: [],
        pinned: false,
      },
    ]);
    localStorage.setItem(STORAGE_KEYS.OPEN_TABS, JSON.stringify([
      {
        sessionId: 'tab-a',
        hostId: 'host-a',
        connectionName: 'Conn A',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'alpha',
        authToken: 'token-a',
        createdAt: 1,
      },
      {
        sessionId: 'tab-b',
        hostId: 'host-b',
        connectionName: 'Conn B',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'beta',
        authToken: 'token-b',
        createdAt: 2,
      },
    ]));
    localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, 'tab-b');
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify({ kind: 'terminal', focusSessionId: 'tab-b' }));

    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(sessionHarness.createSession).toHaveBeenCalledTimes(2));
    expect(sessionHarness.createSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 'host-a', sessionName: 'alpha' }),
      expect.objectContaining({ sessionId: 'tab-a', activate: false }),
    );
    expect(sessionHarness.createSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 'host-b', sessionName: 'beta' }),
      expect.objectContaining({ sessionId: 'tab-b', activate: false }),
    );
    expect(sessionHarness.switchSession).toHaveBeenCalledWith('tab-b');
  });
});
