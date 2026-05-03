// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
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
    daemonHeadRevision: revision,
    daemonHeadEndIndex: revision,
    buffer: {
      lines: [],
      gapRanges: [],
      startIndex: 0,
      endIndex: 0,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 0,
      cols: 80,
      rows: 24,
      cursorKeysApp: false,
      cursor: null,
      updateKind: 'replace' as const,
      revision,
    },
  };
}

const sessionHarness = vi.hoisted(() => {
  const snapshots = new Map<string, { buffer: any }>();
  const headSnapshots = new Map<string, { daemonHeadRevision: number; daemonHeadEndIndex: number }>();
  const bufferStore = {
    getSnapshot(sessionId: string) {
      return snapshots.get(sessionId) || {
        buffer: {
          lines: [],
          gapRanges: [],
          startIndex: 0,
          endIndex: 0,
          bufferHeadStartIndex: 0,
          bufferTailEndIndex: 0,
          cols: 80,
          rows: 24,
          cursorKeysApp: false,
          cursor: null,
          updateKind: 'replace',
          revision: 0,
        },
      };
    },
    subscribe() {
      return () => undefined;
    },
    setBuffer(sessionId: string, buffer: any) {
      snapshots.set(sessionId, { buffer });
      return true;
    },
  };
  const headStore = {
    getSnapshot(sessionId: string) {
      const snapshot = headSnapshots.get(sessionId);
      return snapshot ? { revision: snapshot.daemonHeadRevision, ...snapshot } : { revision: 0, daemonHeadRevision: 0, daemonHeadEndIndex: 0 };
    },
    subscribe() {
      return () => undefined;
    },
    setHead(sessionId: string, head: { daemonHeadRevision: number; daemonHeadEndIndex: number }) {
      headSnapshots.set(sessionId, { ...head });
      return true;
    },
  };
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
  const renameSession = vi.fn();
  const sendInput = vi.fn();

  const syncBuffersFromState = (nextState: typeof state) => {
    nextState.sessions.forEach((session) => {
      bufferStore.setBuffer(session.id, session.buffer);
      headStore.setHead(session.id, {
        daemonHeadRevision: session.daemonHeadRevision || 0,
        daemonHeadEndIndex: session.daemonHeadEndIndex || 0,
      });
    });
  };
  syncBuffersFromState(state);

  return {
    readState: () => state,
    readStaleActiveSession: () => staleActiveSession,
    readBufferStore: () => bufferStore,
    readHeadStore: () => headStore,
    reconnectAllSessions,
    reconnectSession,
    resumeActiveSessionTransport,
    createSession,
    closeSession,
    switchSession,
    moveSession,
    renameSession,
    sendInput,
    update(next: typeof state, stale = staleActiveSession) {
      state = next;
      staleActiveSession = stale;
      syncBuffersFromState(state);
    },
    reset() {
      state = {
        sessions: [makeSession('s1', 1)],
        activeSessionId: 's1',
        connectedCount: 1,
      };
      staleActiveSession = state.sessions[0];
      syncBuffersFromState(state);
      reconnectAllSessions.mockReset();
      reconnectSession.mockReset();
      resumeActiveSessionTransport.mockReset();
      resumeActiveSessionTransport.mockReturnValue(true);
      createSession.mockReset();
      closeSession.mockReset();
      switchSession.mockReset();
      moveSession.mockReset();
      renameSession.mockReset();
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
  SESSION_STATUS_EVENT: 'zterm:session-status',
  SessionProvider: ({ children, appForegroundActive }: { children: React.ReactNode; appForegroundActive?: boolean }) => (
    <div data-testid="provider-foreground">{appForegroundActive ? '1' : '0'}{children}</div>
  ),
  useSession: () => ({
    state: sessionHarness.readState(),
    scheduleStates: {},
    getSessionDebugMetrics: vi.fn(() => null),
    createSession: sessionHarness.createSession,
    closeSession: sessionHarness.closeSession,
    switchSession: sessionHarness.switchSession,
    moveSession: sessionHarness.moveSession,
    renameSession: sessionHarness.renameSession,
    reconnectSession: sessionHarness.reconnectSession,
    reconnectAllSessions: sessionHarness.reconnectAllSessions,
    resumeActiveSessionTransport: sessionHarness.resumeActiveSessionTransport,
    getActiveSession: () => sessionHarness.readStaleActiveSession(),
    getSession: vi.fn((id: string) => sessionHarness.readState().sessions.find((session) => session.id === id) || null),
    getSessionRenderBufferSnapshot: vi.fn((sessionId: string) => sessionHarness.readBufferStore().getSnapshot(sessionId).buffer),
    getSessionBufferStore: vi.fn(() => sessionHarness.readBufferStore()),
    getSessionHeadStore: vi.fn(() => sessionHarness.readHeadStore()),
    sendInput: sessionHarness.sendInput,
    sendImagePaste: vi.fn(),
    sendFileAttach: vi.fn(),
    requestRemoteScreenshot: vi.fn(),
    sendMessageRaw: vi.fn(),
    onFileTransferMessage: vi.fn(() => vi.fn()),
    resizeTerminal: vi.fn(),
    setTerminalWidthMode: vi.fn(),
    updateSessionViewport: vi.fn(),
    requestScheduleList: vi.fn(),
    upsertScheduleJob: vi.fn(),
    deleteScheduleJob: vi.fn(),
    toggleScheduleJob: vi.fn(),
    runScheduleJobNow: vi.fn(),
    getSessionScheduleState: vi.fn(() => ({ sessionName: '', jobs: [], loading: false })),
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
    upsertHost: vi.fn((host: any) => ({
      id: host.id || `persisted:${host.bridgeHost}:${host.bridgePort}:${host.sessionName}`,
      createdAt: host.createdAt || Date.now(),
      ...host,
    })),
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
    sessionBufferStore,
    inputResetEpochBySession,
    onSwitchSession,
    onMoveSession,
    onCloseSession,
    onTerminalInput,
    onSessionDraftSend,
    onLoadSavedTabList,
  }: {
    activeSession: { id: string } | null;
    sessions: Array<{ id: string }>;
    sessionBufferStore?: { getSnapshot: (sessionId: string) => { buffer: { revision: number } } };
    inputResetEpochBySession?: Record<string, number>;
    onSwitchSession: (sessionId: string) => void;
    onMoveSession: (sessionId: string, toIndex: number) => void;
    onCloseSession: (sessionId: string) => void;
    onTerminalInput?: (sessionId: string, data: string) => void;
    onSessionDraftSend?: (value: string, sessionId?: string) => void;
    onLoadSavedTabList?: (tabs: Array<any>, activeSessionId?: string) => void;
  }) => {
    const activeRevision = activeSession && sessionBufferStore
      ? sessionBufferStore.getSnapshot(activeSession.id).buffer.revision
      : -1;
    return (
    <div>
      <div data-testid="terminal-revision">{activeRevision}</div>
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
      <button
        type="button"
        data-testid="load-saved-tab-list"
        onClick={() => {
          onLoadSavedTabList?.([
            {
              sessionId: 'saved-a',
              hostId: 'host-a',
              connectionName: 'Conn A',
              bridgeHost: '100.127.23.27',
              bridgePort: 3333,
              sessionName: 'alpha',
              authToken: 'token-a',
              createdAt: 1,
            },
            {
              sessionId: 'saved-b-old',
              hostId: 'host-b',
              connectionName: 'Conn B',
              bridgeHost: '100.127.23.27',
              bridgePort: 3333,
              sessionName: 'beta',
              authToken: 'token-b',
              createdAt: 2,
            },
            {
              sessionId: 'saved-b-new',
              hostId: 'host-b',
              connectionName: 'Conn B',
              bridgeHost: '100.127.23.27',
              bridgePort: 3333,
              sessionName: 'beta',
              authToken: 'token-b',
              customName: 'Keep Me',
              createdAt: 3,
            },
          ], 'saved-b-new');
        }}
      >
        load-saved-tab-list
      </button>
    </div>
  );
  },
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

  it('drives SessionProvider foreground truth from lifecycle events', async () => {
    const view = render(<App />);

    expect(screen.getByTestId('provider-foreground').textContent?.startsWith('1')).toBe(true);

    act(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(screen.getByTestId('provider-foreground').textContent?.startsWith('0')).toBe(true);

    act(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(screen.getByTestId('provider-foreground').textContent?.startsWith('1')).toBe(true);

    view.unmount();
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

  it('delegates disconnected active-tab foreground resume to SessionContext transport truth', async () => {
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
    expect(sessionHarness.reconnectSession).not.toHaveBeenCalled();
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

  it('deduplicates restored persisted tabs that point to the same bridge target and tmux session', async () => {
    sessionHarness.update({
      sessions: [],
      activeSessionId: null,
      connectedCount: 0,
    } as any, null as any);
    hostHarness.setHosts([
      {
        id: 'host-z',
        createdAt: 1,
        name: 'Conn Z',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'zterm',
        authToken: 'token-z',
        authType: 'password',
        tags: [],
        pinned: false,
      },
    ]);
    localStorage.setItem(STORAGE_KEYS.OPEN_TABS, JSON.stringify([
      {
        sessionId: 'tab-z-old',
        hostId: 'host-z',
        connectionName: 'Conn Z',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'zterm',
        authToken: 'token-z',
        createdAt: 1,
      },
      {
        sessionId: 'tab-z-new',
        hostId: 'host-z',
        connectionName: 'Conn Z',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'zterm',
        authToken: 'token-z',
        customName: 'Keep Me',
        createdAt: 2,
      },
    ]));
    localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, 'tab-z-new');

    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(sessionHarness.createSession).toHaveBeenCalledTimes(1));
    expect(sessionHarness.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'host-z', sessionName: 'zterm' }),
      expect.objectContaining({ sessionId: 'tab-z-new', activate: true, connect: true, customName: 'Keep Me' }),
    );
    expect(sessionHarness.switchSession).toHaveBeenCalledWith('tab-z-new');
  });

  it('switches to the reused live session id when restore hits a semantic duplicate tab id', async () => {
    sessionHarness.update({
      sessions: [],
      activeSessionId: null,
      connectedCount: 0,
    } as any, null as any);
    hostHarness.setHosts([
      {
        id: 'host-z',
        createdAt: 1,
        name: 'Conn Z',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'zterm',
        authToken: 'token-z',
        authType: 'password',
        tags: [],
        pinned: false,
      },
    ]);
    sessionHarness.createSession.mockImplementation((_host: any, options?: any) => {
      if (options?.sessionId === 'tab-z-stale') {
        return 'session-live-z';
      }
      return options?.sessionId || 'unknown';
    });
    localStorage.setItem(STORAGE_KEYS.OPEN_TABS, JSON.stringify([
      {
        sessionId: 'tab-z-stale',
        hostId: 'host-z',
        connectionName: 'Conn Z',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'zterm',
        authToken: 'token-z',
        createdAt: 1,
      },
    ]));
    localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, 'tab-z-stale');

    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(sessionHarness.createSession).toHaveBeenCalledTimes(1));
    expect(sessionHarness.switchSession).toHaveBeenCalledWith('session-live-z');
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

  it('does not let App eagerly reconnect a restored closed active tab before SessionContext decides transport recovery', async () => {
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

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));
    expect(sessionHarness.reconnectSession).not.toHaveBeenCalled();
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

    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));
    fireEvent.click(screen.getByTestId('switch-second-tab'));

    expect(sessionHarness.switchSession).toHaveBeenCalledWith('s2');
    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBe('s2');
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

    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));
    fireEvent.click(screen.getByTestId('send-draft-to-second-tab'));

    expect(sessionHarness.switchSession).toHaveBeenCalledWith('s2');
    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBe('s2');
  });

  it('reuses matched imported tabs while creating only the missing semantic session and refreshes persisted metadata from the current draft truth', async () => {
    sessionHarness.update(
      {
        sessions: [
          {
            ...makeSession('s1', 1),
            bridgeHost: '100.127.23.27',
            bridgePort: 3333,
            sessionName: 'alpha',
            connectionName: 'Old Conn A',
            hostId: 'old-host-a',
            authToken: 'token-a',
            autoCommand: 'old-pwd',
            customName: 'Pinned A',
          },
        ],
        activeSessionId: 's1',
        connectedCount: 1,
      } as any,
      {
        ...makeSession('s1', 1),
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'alpha',
        connectionName: 'Old Conn A',
        hostId: 'old-host-a',
        authToken: 'token-a',
        autoCommand: 'old-pwd',
        customName: 'Pinned A',
      } as any,
    );
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
        autoCommand: 'pwd',
      },
    ]);
    sessionHarness.createSession.mockImplementation((_host: any, options?: any) => options?.sessionId || 'unknown');
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify({ kind: 'terminal', focusSessionId: 's1' }));

    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));
    fireEvent.click(screen.getByTestId('load-saved-tab-list'));

    expect(sessionHarness.createSession).toHaveBeenCalledTimes(1);
    expect(sessionHarness.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Conn B',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'beta',
        authToken: 'token-b',
      }),
      expect.objectContaining({
        activate: false,
        sessionId: 'saved-b-new',
      }),
    );
    expect(sessionHarness.switchSession).toHaveBeenCalledWith('saved-b-new');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.OPEN_TABS) || '[]')).toEqual([
      expect.objectContaining({
        sessionId: 's1',
        connectionName: 'Conn A',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'alpha',
        authToken: 'token-a',
        autoCommand: 'pwd',
      }),
      expect.objectContaining({
        sessionId: 'saved-b-new',
        connectionName: 'Conn B',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'beta',
        authToken: 'token-b',
        customName: 'Keep Me',
      }),
    ]);
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

    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));
    fireEvent.click(screen.getByTestId('move-second-tab-first'));

    expect(sessionHarness.moveSession).toHaveBeenCalledWith('s2', 0);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.OPEN_TABS) || '[]')).toEqual([
      expect.objectContaining({ sessionId: 's2' }),
      expect.objectContaining({ sessionId: 's1' }),
    ]);
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
    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBe('s2');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.OPEN_TABS) || '[]')).toEqual([
      expect.objectContaining({ sessionId: 's2' }),
    ]);

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

  it('does not repersist a closed tab from lingering runtime sessions after the explicit close intent already removed it', async () => {
    const view = render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));

    act(() => {
      sessionHarness.update(
        {
          sessions: [makeSession('s1', 1), makeSession('s2', 2)],
          activeSessionId: 's1',
          connectedCount: 2,
        } as any,
        makeSession('s1', 1),
      );
    });
    view.rerender(<AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />);

    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.OPEN_TABS) || '[]')).toEqual([
        expect.objectContaining({ sessionId: 's1' }),
        expect.objectContaining({ sessionId: 's2' }),
      ]);
    });

    fireEvent.click(screen.getByTestId('close-active-tab'));

    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.OPEN_TABS) || '[]')).toEqual([
      expect.objectContaining({ sessionId: 's2' }),
    ]);

    act(() => {
      sessionHarness.update(
        {
          sessions: [makeSession('s1', 3), makeSession('s2', 4)],
          activeSessionId: 's2',
          connectedCount: 2,
        } as any,
        makeSession('s2', 4),
      );
    });
    view.rerender(<AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('4'));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.OPEN_TABS) || '[]')).toEqual([
      expect.objectContaining({ sessionId: 's2' }),
    ]);
  });

  it('does not bootstrap open tabs back from runtime sessions after the user explicitly closed the final tab', async () => {
    sessionHarness.update(
      {
        sessions: [makeSession('s1', 1)],
        activeSessionId: 's1',
        connectedCount: 1,
      } as any,
      makeSession('s1', 1),
    );

    const view = render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));
    fireEvent.click(screen.getByTestId('close-active-tab'));

    expect(sessionHarness.closeSession).toHaveBeenCalledWith('s1');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.OPEN_TABS) || '[]')).toEqual([]);
    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBeNull();

    act(() => {
      sessionHarness.update(
        {
          sessions: [makeSession('s1', 2)],
          activeSessionId: 's1',
          connectedCount: 1,
        } as any,
        makeSession('s1', 2),
      );
    });
    view.rerender(<AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />);

    await waitFor(() => expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.OPEN_TABS) || '[]')).toEqual([]));
    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBeNull();
  });

  it('removes the persisted representative when closing a runtime session that reuses the same bridge target', async () => {
    localStorage.setItem(STORAGE_KEYS.OPEN_TABS, JSON.stringify([
      {
        sessionId: 'persisted-old',
        hostId: 'host-persisted-old',
        connectionName: 'conn-shared',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'session-shared',
        authToken: 'shared-token',
        createdAt: 1,
      },
      {
        sessionId: 's2',
        hostId: 'host-s2',
        connectionName: 'conn-s2',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'session-s2',
        authToken: 'token-s2',
        createdAt: 2,
      },
    ]));
    localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, 'persisted-old');

    sessionHarness.update(
      {
        sessions: [
          {
            ...makeSession('runtime-new', 1),
            bridgeHost: '127.0.0.1',
            bridgePort: 3333,
            sessionName: 'session-shared',
            authToken: 'shared-token',
          },
          makeSession('s2', 2),
        ],
        activeSessionId: 'runtime-new',
        connectedCount: 2,
      } as any,
      makeSession('runtime-new', 1),
    );

    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));
    fireEvent.click(screen.getByTestId('close-active-tab'));

    expect(sessionHarness.closeSession).toHaveBeenCalledWith('runtime-new');
    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBe('s2');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.OPEN_TABS) || '[]')).toEqual([
      expect.objectContaining({ sessionId: 's2' }),
    ]);
  });

  it('removes a remotely closed session from persisted open tabs via the session status event', async () => {
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

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('2'));
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.OPEN_TABS) || '[]')).toEqual([
        expect.objectContaining({ sessionId: 's1' }),
        expect.objectContaining({ sessionId: 's2' }),
      ]);
    });

    act(() => {
      window.dispatchEvent(new CustomEvent('zterm:session-status', {
        detail: { sessionId: 's2', type: 'closed' },
      }));
    });

    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBe('s1');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.OPEN_TABS) || '[]')).toEqual([
      expect.objectContaining({ sessionId: 's1' }),
    ]);
  });

  it('loads saved tab list with dedupe and keeps requested active tab truth over stale ACTIVE_PAGE focus', async () => {
    sessionHarness.update(
      {
        sessions: [makeSession('current-live', 1)],
        activeSessionId: 'current-live',
        connectedCount: 1,
      } as any,
      makeSession('current-live', 1),
    );
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
    sessionHarness.createSession.mockImplementation((_host: any, options?: any) => options?.sessionId || 'unknown');
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify({ kind: 'terminal', focusSessionId: 'current-live' }));

    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));
    fireEvent.click(screen.getByTestId('load-saved-tab-list'));

    expect(sessionHarness.createSession).toHaveBeenCalledTimes(2);
    expect(sessionHarness.createSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionName: 'alpha', bridgeHost: '100.127.23.27' }),
      expect.objectContaining({ activate: false }),
    );
    expect(sessionHarness.createSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionName: 'beta', bridgeHost: '100.127.23.27' }),
      expect.objectContaining({ activate: false }),
    );
    expect(sessionHarness.renameSession).toHaveBeenCalledWith?.('saved-b-new', 'Keep Me');
    expect(sessionHarness.switchSession).toHaveBeenCalledWith('saved-b-new');
    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBe('saved-b-new');
  });

  it('restores the saved-tab batch truth on next launch after the batch import persisted OPEN_TABS and ACTIVE_SESSION', async () => {
    sessionHarness.update(
      {
        sessions: [makeSession('current-live', 1)],
        activeSessionId: 'current-live',
        connectedCount: 1,
      } as any,
      makeSession('current-live', 1),
    );
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
    sessionHarness.createSession.mockImplementation((_host: any, options?: any) => options?.sessionId || 'unknown');
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify({ kind: 'terminal', focusSessionId: 'current-live' }));

    const firstMount = render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));
    fireEvent.click(screen.getByTestId('load-saved-tab-list'));

    await waitFor(() => expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBe('saved-b-new'));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.OPEN_TABS) || '[]')).toEqual([
      expect.objectContaining({ sessionId: 'saved-a', sessionName: 'alpha' }),
      expect.objectContaining({ sessionId: 'saved-b-new', sessionName: 'beta', customName: 'Keep Me' }),
    ]);

    firstMount.unmount();
    sessionHarness.reset();
    sessionHarness.update({
      sessions: [],
      activeSessionId: null,
      connectedCount: 0,
    } as any, null as any);
    sessionHarness.createSession.mockImplementation((_host: any, options?: any) => options?.sessionId || 'unknown');
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify({ kind: 'terminal', focusSessionId: 'current-live' }));

    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(sessionHarness.createSession).toHaveBeenCalledTimes(2));
    expect(sessionHarness.createSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionName: 'alpha',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        authToken: 'token-a',
      }),
      expect.objectContaining({ sessionId: 'saved-a', activate: false, connect: false }),
    );
    expect(sessionHarness.createSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionName: 'beta',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        authToken: 'token-b',
      }),
      expect.objectContaining({ sessionId: 'saved-b-new', activate: true, connect: true, customName: 'Keep Me' }),
    );
    expect(sessionHarness.switchSession).toHaveBeenCalledWith('saved-b-new');
    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBe('saved-b-new');
  });
});
