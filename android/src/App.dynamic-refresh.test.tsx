// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  const resumeActiveSessionTransport = vi.fn(() => true);
  const createSession = vi.fn();
  const closeSession = vi.fn();
  const switchSession = vi.fn();
  const moveSession = vi.fn();
  const sendInput = vi.fn();

  return {
    readState: () => state,
    readStaleActiveSession: () => staleActiveSession,
    reconnectAllSessions,
    reconnectSession,
    resumeActiveSessionTransport,
    createSession,
    closeSession,
    switchSession,
    moveSession,
    sendInput,
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
      resumeActiveSessionTransport.mockReset();
      resumeActiveSessionTransport.mockReturnValue(true);
      createSession.mockReset();
      closeSession.mockReset();
      switchSession.mockReset();
      moveSession.mockReset();
      sendInput.mockReset();
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
    sessionDebugMetrics: {},
    createSession: sessionHarness.createSession,
    closeSession: sessionHarness.closeSession,
    switchSession: sessionHarness.switchSession,
    moveSession: sessionHarness.moveSession,
    renameSession: vi.fn(),
    reconnectSession: sessionHarness.reconnectSession,
    reconnectAllSessions: sessionHarness.reconnectAllSessions,
    resumeActiveSessionTransport: sessionHarness.resumeActiveSessionTransport,
    getActiveSession: () => sessionHarness.readStaleActiveSession(),
    sendInput: sessionHarness.sendInput,
    sendImagePaste: vi.fn(),
    resizeTerminal: vi.fn(),
    updateSessionViewport: vi.fn(),
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
  TerminalPage: ({
    activeSession,
    sessions,
    inputResetEpochBySession,
    onSwitchSession,
    onMoveSession,
    onCloseSession,
    onTerminalInput,
    onSessionDraftSend,
  }: {
    activeSession: { id: string; buffer: { revision: number } } | null;
    sessions: Array<{ id: string }>;
    inputResetEpochBySession?: Record<string, number>;
    onSwitchSession: (sessionId: string) => void;
    onMoveSession: (sessionId: string, toIndex: number) => void;
    onCloseSession: (sessionId: string) => void;
    onTerminalInput?: (sessionId: string, data: string) => void;
    onSessionDraftSend?: (value: string, sessionId?: string) => void;
  }) => (
    <div>
      <div data-testid="terminal-revision">{activeSession?.buffer.revision ?? -1}</div>
      <div data-testid="terminal-input-reset-epoch">{activeSession ? (inputResetEpochBySession?.[activeSession.id] || 0) : -1}</div>
      <button
        type="button"
        data-testid="close-active-tab"
        onClick={() => {
          if (activeSession) {
            onCloseSession(activeSession.id);
          }
        }}
      >
        close-active
      </button>
      <button
        type="button"
        data-testid="switch-second-tab"
        onClick={() => {
          const target = sessions[1];
          if (target) {
            onSwitchSession(target.id);
          }
        }}
      >
        switch-second
      </button>
      <button
        type="button"
        data-testid="move-second-tab-first"
        onClick={() => {
          const target = sessions[1];
          if (target) {
            onMoveSession(target.id, 0);
          }
        }}
      >
        move-second-first
      </button>
      <button
        type="button"
        data-testid="send-active-input"
        onClick={() => {
          if (activeSession) {
            onTerminalInput?.(activeSession.id, 'typed-from-terminal');
          }
        }}
      >
        send-active-input
      </button>
      <button
        type="button"
        data-testid="send-draft-to-second-tab"
        onClick={() => {
          const target = sessions[1];
          if (target) {
            onSessionDraftSend?.('draft-to-second-tab', target.id);
          }
        }}
      >
        send-draft-to-second-tab
      </button>
    </div>
  ),
}));

import { AppContent } from './App';

describe('App dynamic refresh matrix', () => {
  const originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');

  beforeEach(() => {
    sessionHarness.reset();
    hostHarness.reset();
    capacitorAppHarness.reset();
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

  it('bumps the active session input reset epoch before forwarding terminal input', async () => {
    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-input-reset-epoch').textContent).toBe('0'));

    fireEvent.click(screen.getByTestId('send-active-input'));

    await waitFor(() => {
      expect(screen.getByTestId('terminal-input-reset-epoch').textContent).toBe('1');
    });
    expect(sessionHarness.sendInput).toHaveBeenCalledWith('s1', 'typed-from-terminal');
  });

  it('ignores plain online noise and only resumes on real foreground restore', async () => {
    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));

    act(() => {
      window.dispatchEvent(new Event('online'));
    });

    expect(sessionHarness.reconnectAllSessions).not.toHaveBeenCalled();
    expect(sessionHarness.reconnectSession).not.toHaveBeenCalled();
    expect(sessionHarness.resumeActiveSessionTransport).not.toHaveBeenCalled();

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
    });

    expect(sessionHarness.resumeActiveSessionTransport).toHaveBeenCalledTimes(1);
    expect(sessionHarness.resumeActiveSessionTransport).toHaveBeenCalledWith('s1');
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
      document.dispatchEvent(new Event('resume'));
    });

    expect(sessionHarness.resumeActiveSessionTransport).toHaveBeenCalledTimes(1);
    expect(sessionHarness.resumeActiveSessionTransport).toHaveBeenCalledWith('s1');
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

    expect(sessionHarness.resumeActiveSessionTransport).toHaveBeenCalledTimes(1);
    expect(sessionHarness.resumeActiveSessionTransport).toHaveBeenCalledWith('s1');
    expect(sessionHarness.reconnectSession).not.toHaveBeenCalled();
    expect(sessionHarness.reconnectAllSessions).not.toHaveBeenCalled();
  });

  it('does not reconnect hidden unhealthy tabs during foreground resume', async () => {
    sessionHarness.update(
      {
        sessions: [
          makeSession('s1', 1),
          {
            ...makeSession('s2', 2),
            state: 'closed',
          },
        ],
        activeSessionId: 's1',
        connectedCount: 1,
      } as any,
      makeSession('s1', 1),
    );

    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));
    sessionHarness.reconnectSession.mockClear();

    act(() => {
      document.dispatchEvent(new Event('resume'));
    });

    expect(sessionHarness.resumeActiveSessionTransport).toHaveBeenCalledWith('s1');
    expect(sessionHarness.reconnectSession).not.toHaveBeenCalled();
  });

  it('reconnects only the active tab when foreground resume finds the active session disconnected', async () => {
    sessionHarness.update(
      {
        sessions: [
          {
            ...makeSession('s1', 1),
            state: 'closed',
          },
          {
            ...makeSession('s2', 2),
            state: 'closed',
          },
        ],
        activeSessionId: 's1',
        connectedCount: 0,
      } as any,
      {
        ...makeSession('s1', 1),
        state: 'closed',
      } as any,
    );

    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));

    act(() => {
      document.dispatchEvent(new Event('resume'));
    });

    expect(sessionHarness.resumeActiveSessionTransport).toHaveBeenCalledWith('s1');
    expect(sessionHarness.reconnectSession).toHaveBeenCalled();
    expect(sessionHarness.reconnectSession.mock.calls.every(([sessionId]) => sessionId === 's1')).toBe(true);
    expect(sessionHarness.reconnectAllSessions).not.toHaveBeenCalled();
  });


  it('reconnects the active session when foreground resume cannot immediately poke transport', async () => {
    sessionHarness.resumeActiveSessionTransport.mockReturnValue(false);

    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));

    act(() => {
      document.dispatchEvent(new Event('resume'));
    });

    expect(sessionHarness.resumeActiveSessionTransport).toHaveBeenCalledWith('s1');
    expect(sessionHarness.reconnectSession).toHaveBeenCalledWith('s1');
    expect(sessionHarness.reconnectAllSessions).not.toHaveBeenCalled();
  });

  it('registers Capacitor appStateChange only once across session rerenders', async () => {
    const view = render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(capacitorAppHarness.addListener).toHaveBeenCalledTimes(1));

    sessionHarness.update(
      {
        sessions: [makeSession('s1', 2)],
        activeSessionId: 's1',
        connectedCount: 1,
      } as any,
      makeSession('s1', 2),
    );
    view.rerender(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    sessionHarness.update(
      {
        sessions: [makeSession('s2', 3)],
        activeSessionId: 's2',
        connectedCount: 1,
      } as any,
      makeSession('s2', 3),
    );
    view.rerender(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    expect(capacitorAppHarness.addListener).toHaveBeenCalledTimes(1);
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
      expect.objectContaining({ sessionId: 'tab-a', activate: false, connect: false }),
    );
    expect(sessionHarness.createSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 'host-b', sessionName: 'beta' }),
      expect.objectContaining({ sessionId: 'tab-b', activate: true, connect: true }),
    );
    expect(sessionHarness.switchSession).toHaveBeenCalledWith('tab-b');
  });

  it('does not let a stale terminal page focus id override the restored latest active tab truth', async () => {
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
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify({ kind: 'terminal', focusSessionId: 'tab-a' }));

    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(sessionHarness.createSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(sessionHarness.switchSession).toHaveBeenCalledWith('tab-b'));
    expect(sessionHarness.switchSession).not.toHaveBeenCalledWith('tab-a');
    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBe('tab-b');
  });

  it('reconnects the active tab when the restored active session is closed', async () => {
    sessionHarness.update(
      {
        sessions: [
          {
            ...makeSession('s1', 1),
            state: 'closed',
          },
        ],
        activeSessionId: 's1',
        connectedCount: 0,
      } as any,
      {
        ...makeSession('s1', 1),
        state: 'closed',
      } as any,
    );

    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(sessionHarness.reconnectSession).toHaveBeenCalledWith('s1'));
  });

  it('persists current open tabs and active tab automatically', async () => {
    sessionHarness.update(
      {
        sessions: [makeSession('s1', 1), makeSession('s2', 2)],
        activeSessionId: 's2',
        connectedCount: 2,
      } as any,
      makeSession('s2', 2),
    );

    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.OPEN_TABS) || '[]')).toEqual([
        expect.objectContaining({ sessionId: 's1' }),
        expect.objectContaining({ sessionId: 's2' }),
      ]);
    });
    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBe('s2');
  });

  it('persists active tab switch immediately from terminal UI intent', async () => {
    sessionHarness.update(
      {
        sessions: [makeSession('s1', 1), makeSession('s2', 2)],
        activeSessionId: 's1',
        connectedCount: 2,
      } as any,
      makeSession('s1', 1),
    );

    const view = render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));
    fireEvent.click(screen.getByTestId('switch-second-tab'));

    expect(sessionHarness.switchSession).toHaveBeenCalledWith('s2');

    // Simulate the state change that switchSession causes in real SessionContext
    sessionHarness.update(
      {
        sessions: [makeSession('s1', 1), makeSession('s2', 2)],
        activeSessionId: 's2',
        connectedCount: 2,
      } as any,
      makeSession('s2', 2),
    );
    view.rerender(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => {
      expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBe('s2');
    });
  });

  it('persists programmatic tab activation immediately when sending draft to another tab', async () => {
    sessionHarness.update(
      {
        sessions: [makeSession('s1', 1), makeSession('s2', 2)],
        activeSessionId: 's1',
        connectedCount: 2,
      } as any,
      makeSession('s1', 1),
    );

    const view = render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));
    fireEvent.click(screen.getByTestId('send-draft-to-second-tab'));

    expect(sessionHarness.switchSession).toHaveBeenCalledWith('s2');

    // Simulate state change
    sessionHarness.update(
      {
        sessions: [makeSession('s1', 1), makeSession('s2', 2)],
        activeSessionId: 's2',
        connectedCount: 2,
      } as any,
      makeSession('s2', 2),
    );
    view.rerender(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => {
      expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBe('s2');
    });
  });

  it('persists manual tab reorder immediately from terminal UI intent', async () => {
    sessionHarness.update(
      {
        sessions: [makeSession('s1', 1), makeSession('s2', 2)],
        activeSessionId: 's1',
        connectedCount: 2,
      } as any,
      makeSession('s1', 1),
    );

    const view = render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));
    fireEvent.click(screen.getByTestId('move-second-tab-first'));

    expect(sessionHarness.moveSession).toHaveBeenCalledWith('s2', 0);

    // Simulate reordered state
    sessionHarness.update(
      {
        sessions: [makeSession('s2', 2), makeSession('s1', 1)],
        activeSessionId: 's1',
        connectedCount: 2,
      } as any,
      makeSession('s1', 1),
    );
    view.rerender(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.OPEN_TABS) || '[]')).toEqual([
        expect.objectContaining({ sessionId: 's2' }),
        expect.objectContaining({ sessionId: 's1' }),
      ]);
    });
  });

  it('persists closed tabs immediately and does not restore them on next launch', async () => {
    sessionHarness.update(
      {
        sessions: [makeSession('s1', 1), makeSession('s2', 2)],
        activeSessionId: 's1',
        connectedCount: 2,
      } as any,
      makeSession('s1', 1),
    );

    const view = render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));
    fireEvent.click(screen.getByTestId('close-active-tab'));

    expect(sessionHarness.closeSession).toHaveBeenCalledWith('s1');

    // Simulate what SessionContext DELETE_SESSION does: remove s1, set active to s2
    sessionHarness.update(
      {
        sessions: [makeSession('s2', 2)],
        activeSessionId: 's2',
        connectedCount: 2,
      } as any,
      makeSession('s2', 2),
    );

    // Re-render to trigger state change and auto-persist useEffect
    view.rerender(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => {
      expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBe('s2');
    });
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.OPEN_TABS) || '[]')).toEqual([
        expect.objectContaining({ sessionId: 's2' }),
      ]);
    });

    view.unmount();
    sessionHarness.reset();
    sessionHarness.update({
      sessions: [],
      activeSessionId: null,
      connectedCount: 0,
    } as any, null as any);

    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(sessionHarness.createSession).toHaveBeenCalledTimes(1));
    expect(sessionHarness.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'session-s2' }),
      expect.objectContaining({ sessionId: 's2', activate: true, connect: true }),
    );
  });
});
