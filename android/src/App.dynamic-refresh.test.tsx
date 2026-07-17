// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConnectionConfigShareLink } from '@zterm/shared';
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
  const setLiveSessionIds = vi.fn();
  const createSession = vi.fn();
  const closeSession = vi.fn();
  const switchSession = vi.fn();
  const moveSession = vi.fn();
  const renameSession = vi.fn();
  const sendTerminalResize = vi.fn();
  const sendInput = vi.fn();
  const getSessionDebugMetrics = vi.fn(() => null);
  const getSession = vi.fn((id: string) => state.sessions.find((session) => session.id === id) || null);
  const getSessionRenderBufferSnapshot = vi.fn((sessionId: string) => bufferStore.getSnapshot(sessionId).buffer);
  const getSessionBufferStore = vi.fn(() => bufferStore);
  const getSessionRenderBufferStore = vi.fn(() => bufferStore);
  const getSessionHeadStore = vi.fn(() => headStore);
  const sendImagePaste = vi.fn();
  const sendFileAttach = vi.fn();
  const requestRemoteScreenshot = vi.fn();
  const sendMessageRaw = vi.fn();
  const onFileTransferMessage = vi.fn(() => vi.fn());
  const updateSessionViewport = vi.fn();
  const requestScheduleList = vi.fn();
  const upsertScheduleJob = vi.fn();
  const deleteScheduleJob = vi.fn();
  const toggleScheduleJob = vi.fn();
  const runScheduleJobNow = vi.fn();
  const getSessionScheduleState = vi.fn(() => ({ sessionName: '', jobs: [], loading: false }));

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
    setLiveSessionIds,
    createSession,
    closeSession,
    switchSession,
    moveSession,
    renameSession,
    sendTerminalResize,
    sendInput,
    getSessionDebugMetrics,
    getSession,
    getSessionRenderBufferSnapshot,
    getSessionBufferStore,
    getSessionRenderBufferStore,
    getSessionHeadStore,
    sendImagePaste,
    sendFileAttach,
    requestRemoteScreenshot,
    sendMessageRaw,
    onFileTransferMessage,
    updateSessionViewport,
    requestScheduleList,
    upsertScheduleJob,
    deleteScheduleJob,
    toggleScheduleJob,
    runScheduleJobNow,
    getSessionScheduleState,
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
      setLiveSessionIds.mockReset();
      createSession.mockReset();
      closeSession.mockReset();
      switchSession.mockReset();
      moveSession.mockReset();
      renameSession.mockReset();
      sendTerminalResize.mockReset();
      sendInput.mockReset();
      getSessionDebugMetrics.mockReset();
      getSessionDebugMetrics.mockImplementation(() => null);
      getSession.mockReset();
      getSession.mockImplementation((id: string) => state.sessions.find((session) => session.id === id) || null);
      getSessionRenderBufferSnapshot.mockReset();
      getSessionRenderBufferSnapshot.mockImplementation((sessionId: string) => bufferStore.getSnapshot(sessionId).buffer);
      getSessionBufferStore.mockReset();
      getSessionBufferStore.mockImplementation(() => bufferStore);
      getSessionRenderBufferStore.mockReset();
      getSessionRenderBufferStore.mockImplementation(() => bufferStore);
      getSessionHeadStore.mockReset();
      getSessionHeadStore.mockImplementation(() => headStore);
      sendImagePaste.mockReset();
      sendFileAttach.mockReset();
      requestRemoteScreenshot.mockReset();
      sendMessageRaw.mockReset();
      onFileTransferMessage.mockReset();
      onFileTransferMessage.mockImplementation(() => vi.fn());
      updateSessionViewport.mockReset();
      requestScheduleList.mockReset();
      upsertScheduleJob.mockReset();
      deleteScheduleJob.mockReset();
      toggleScheduleJob.mockReset();
      runScheduleJobNow.mockReset();
      getSessionScheduleState.mockReset();
      getSessionScheduleState.mockImplementation(() => ({ sessionName: '', jobs: [], loading: false }));
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

const quickActionHarness = vi.hoisted(() => {
  const quickActions: any[] = [];
  const setQuickActions = vi.fn();
  return {
    quickActions,
    setQuickActions,
    reset() {
      setQuickActions.mockReset();
    },
  };
});

const shortcutActionHarness = vi.hoisted(() => {
  const shortcutActions: any[] = [];
  const setShortcutActions = vi.fn();
  return {
    shortcutActions,
    setShortcutActions,
    reset() {
      setShortcutActions.mockReset();
    },
  };
});

const sessionDraftHarness = vi.hoisted(() => {
  const drafts: Record<string, string> = {};
  const setDraft = vi.fn();
  const clearDraft = vi.fn();
  const pruneDrafts = vi.fn();
  return {
    drafts,
    setDraft,
    clearDraft,
    pruneDrafts,
    reset() {
      setDraft.mockReset();
      clearDraft.mockReset();
      pruneDrafts.mockReset();
      Object.keys(drafts).forEach((key) => {
        delete drafts[key];
      });
    },
  };
});

const sessionHistoryHarness = vi.hoisted(() => {
  const sessionGroups: any[] = [];
  const setSessionGroupSelection = vi.fn();
  const deleteSessionGroup = vi.fn();
  const pruneSessionGroupSelectionToRemoteTruth = vi.fn();
  return {
    sessionGroups,
    setSessionGroupSelection,
    deleteSessionGroup,
    pruneSessionGroupSelectionToRemoteTruth,
    reset() {
      setSessionGroupSelection.mockReset();
      deleteSessionGroup.mockReset();
      pruneSessionGroupSelectionToRemoteTruth.mockReset();
      sessionGroups.splice(0, sessionGroups.length);
    },
  };
});

const capacitorAppHarness = vi.hoisted(() => {
  let listenersByEventName: Record<string, Array<(payload: any) => void>> = {};

  return {
    addListener: vi.fn(async (eventName: string, listener: (payload: any) => void) => {
      listenersByEventName[eventName] = [...(listenersByEventName[eventName] || []), listener];
      return {
        remove: vi.fn(async () => {
          listenersByEventName[eventName] = (listenersByEventName[eventName] || []).filter((item) => item !== listener);
        }),
      };
    }),
    emit(state: { isActive: boolean }) {
      const listeners = listenersByEventName.appStateChange || [];
      const activeListeners = listeners.length > 0
        ? listeners
        : this.addListener.mock.calls
          .filter((call) => call[0] === 'appStateChange')
          .map((call) => call[1])
          .filter(
            (listener): listener is (state: { isActive: boolean }) => void => typeof listener === 'function',
          );
      activeListeners.forEach((listener) => listener(state));
    },
    emitUrlOpen(url: string) {
      const listeners = (listenersByEventName.appUrlOpen || []).length > 0
        ? listenersByEventName.appUrlOpen
        : this.addListener.mock.calls
          .filter((call) => call[0] === 'appUrlOpen')
          .map((call) => call[1])
          .filter(
            (listener): listener is (payload: { url: string }) => void => typeof listener === 'function',
          );
      listeners.forEach((listener) => listener({ url }));
    },
    eventCallCount(eventName: string) {
      return this.addListener.mock.calls.filter((call) => call[0] === eventName).length;
    },
    reset() {
      listenersByEventName = {};
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
    getSessionDebugMetrics: sessionHarness.getSessionDebugMetrics,
    createSession: sessionHarness.createSession,
    closeSession: sessionHarness.closeSession,
    switchSession: sessionHarness.switchSession,
    moveSession: sessionHarness.moveSession,
    renameSession: sessionHarness.renameSession,
    reconnectSession: sessionHarness.reconnectSession,
    reconnectAllSessions: sessionHarness.reconnectAllSessions,
    setLiveSessionIds: sessionHarness.setLiveSessionIds,
    resumeActiveSessionTransport: sessionHarness.resumeActiveSessionTransport,
    getActiveSession: () => sessionHarness.readStaleActiveSession(),
    getSession: sessionHarness.getSession,
    getSessionRenderBufferSnapshot: sessionHarness.getSessionRenderBufferSnapshot,
    getSessionBufferStore: sessionHarness.getSessionBufferStore,
    getSessionRenderBufferStore: sessionHarness.getSessionRenderBufferStore,
    getSessionHeadStore: sessionHarness.getSessionHeadStore,
    sendTerminalResize: sessionHarness.sendTerminalResize,
    sendInput: sessionHarness.sendInput,
    sendImagePaste: sessionHarness.sendImagePaste,
    sendFileAttach: sessionHarness.sendFileAttach,
    requestRemoteScreenshot: sessionHarness.requestRemoteScreenshot,
    sendMessageRaw: sessionHarness.sendMessageRaw,
    onFileTransferMessage: sessionHarness.onFileTransferMessage,
    updateSessionViewport: sessionHarness.updateSessionViewport,
    requestScheduleList: sessionHarness.requestScheduleList,
    upsertScheduleJob: sessionHarness.upsertScheduleJob,
    deleteScheduleJob: sessionHarness.deleteScheduleJob,
    toggleScheduleJob: sessionHarness.toggleScheduleJob,
    runScheduleJobNow: sessionHarness.runScheduleJobNow,
    getSessionScheduleState: sessionHarness.getSessionScheduleState,
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
    quickActions: quickActionHarness.quickActions,
    setQuickActions: quickActionHarness.setQuickActions,
  }),
}));

vi.mock('./hooks/useShortcutActionStorage', () => ({
  useShortcutActionStorage: () => ({
    shortcutActions: shortcutActionHarness.shortcutActions,
    setShortcutActions: shortcutActionHarness.setShortcutActions,
  }),
}));

vi.mock('./hooks/useSessionDraftStorage', () => ({
  useSessionDraftStorage: () => ({
    drafts: sessionDraftHarness.drafts,
    setDraft: sessionDraftHarness.setDraft,
    clearDraft: sessionDraftHarness.clearDraft,
    pruneDrafts: sessionDraftHarness.pruneDrafts,
  }),
}));

vi.mock('./hooks/useSessionHistoryStorage', () => ({
  useSessionHistoryStorage: () => ({
    sessionGroups: sessionHistoryHarness.sessionGroups,
    setSessionGroupSelection: sessionHistoryHarness.setSessionGroupSelection,
    deleteSessionGroup: sessionHistoryHarness.deleteSessionGroup,
    pruneSessionGroupSelectionToRemoteTruth: sessionHistoryHarness.pruneSessionGroupSelectionToRemoteTruth,
  }),
}));

const openTerminalPageSpy = vi.fn();
const fetchTmuxSessionsMock = vi.fn();
const createTmuxSessionMock = vi.fn();

const tmuxPickerHarness = vi.hoisted(() => {
  let latestProps: any = null;
  return {
    setProps(next: any) {
      latestProps = next;
    },
    readProps() {
      return latestProps;
    },
    reset() {
      latestProps = null;
    },
  };
});

const connectionsPageHarness = vi.hoisted(() => {
  let latestProps: any = null;
  return {
    setProps(next: any) {
      latestProps = next;
    },
    readProps() {
      return latestProps;
    },
    reset() {
      latestProps = null;
    },
  };
});

const settingsPageHarness = vi.hoisted(() => {
  let latestProps: any = null;
  return {
    setProps(next: any) {
      latestProps = next;
    },
    readProps() {
      return latestProps;
    },
    reset() {
      latestProps = null;
    },
  };
});

vi.mock('./lib/page-state', async () => {
  const actual = await vi.importActual<typeof import('./lib/page-state')>('./lib/page-state');
  return {
    ...actual,
    openTerminalPage: vi.fn(() => {
      openTerminalPageSpy();
      return actual.openTerminalPage();
    }),
  };
});

vi.mock('./components/tmux/TmuxSessionPickerSheet', () => ({
  TmuxSessionPickerSheet: (props: any) => {
    tmuxPickerHarness.setProps(props);
    return null;
  },
}));

vi.mock('./pages/ConnectionsPage', () => ({
  ConnectionsPage: (props: any) => {
    connectionsPageHarness.setProps(props);
    return null;
  },
}));

vi.mock('./pages/ConnectionPropertiesPage', () => ({
  ConnectionPropertiesPage: () => null,
}));

vi.mock('./pages/SettingsPage', () => ({
  SettingsPage: (props: any) => {
    settingsPageHarness.setProps(props);
    return (
      <button
        type="button"
        data-testid="save-settings-adaptive-width"
        onClick={() => props.onSave?.({
          ...props.settings,
          terminalWidthMode: 'adaptive-phone',
        })}
      >
        save-settings-adaptive-width
      </button>
    );
  },
}));

const terminalPageRenderSpy = vi.fn();

vi.mock('./pages/TerminalPage', () => ({
  TerminalPage: React.memo(({
    activeSession,
    sessions,
    inputResetEpochBySession,
    onSwitchSession,
    onMoveSession,
    onCloseSession,
    onOpenConnections,
    onTerminalInput,
    onTerminalWidthModeChange,
    onSessionDraftSend,
    followResetEpoch,
    serverIdentityAliasInputs = [],
  }: {
    activeSession: { id: string; buffer?: { revision?: number } } | null;
    sessions: Array<{ id: string }>;
    inputResetEpochBySession?: Record<string, number>;
    onSwitchSession: (sessionId: string) => void;
    onMoveSession: (sessionId: string, toIndex: number) => void;
    onCloseSession: (sessionId: string) => void;
    onOpenConnections: () => void;
    onTerminalInput?: (sessionId: string, data: string) => void;
    onTerminalWidthModeChange?: (sessionId: string, mode: 'adaptive-phone' | 'mirror-fixed', cols?: number | null) => void;
    onSessionDraftSend?: (value: string, sessionId?: string) => void;
    followResetEpoch?: number;
    serverIdentityAliasInputs?: Array<{ bridgeHost?: string; bridgePort?: number; daemonHostId?: string; name?: string }>;
  }) => {
    const activeRevision = activeSession?.buffer?.revision ?? -1;
    terminalPageRenderSpy({
      activeSessionId: activeSession?.id || null,
      sessionIds: sessions.map((session) => session.id),
      activeRevision,
      serverIdentityAliasInputs,
    });
    return (
      <div>
        <div data-testid="terminal-revision">{activeRevision}</div>
        <div data-testid="terminal-session-ids">{sessions.map((session) => session.id).join(',')}</div>
        <div data-testid="terminal-input-reset-epoch">{activeSession ? (inputResetEpochBySession?.[activeSession.id] || 0) : -1}</div>
        <div data-testid="terminal-follow-reset-epoch">{String(followResetEpoch ?? -1)}</div>
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
          data-testid="set-active-adaptive-width"
          onClick={() => {
            if (activeSession) {
              onTerminalWidthModeChange?.(activeSession.id, 'adaptive-phone', 72);
            }
          }}
        >
          set-active-adaptive-width
        </button>
        <button
          type="button"
          data-testid="open-connections"
          onClick={() => {
            onOpenConnections();
          }}
        >
          open-connections
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
    );
  }, (prev, next) => {
    const prevActiveId = prev.activeSession?.id || null;
    const nextActiveId = next.activeSession?.id || null;
    const prevSessionIds = prev.sessions.map((session) => session.id).join('||');
    const nextSessionIds = next.sessions.map((session) => session.id).join('||');
    const prevRevision = prev.activeSession?.buffer?.revision ?? -1;
    const nextRevision = next.activeSession?.buffer?.revision ?? -1;
    const prevInputResetEpoch = prevActiveId ? (prev.inputResetEpochBySession?.[prevActiveId] || 0) : -1;
    const nextInputResetEpoch = nextActiveId ? (next.inputResetEpochBySession?.[nextActiveId] || 0) : -1;
    const prevAliasInputs = (prev.serverIdentityAliasInputs || [])
      .map((input: any) => [input.bridgeHost || '', input.bridgePort || '', input.daemonHostId || '', input.name || ''].join('|'))
      .join('||');
    const nextAliasInputs = (next.serverIdentityAliasInputs || [])
      .map((input: any) => [input.bridgeHost || '', input.bridgePort || '', input.daemonHostId || '', input.name || ''].join('|'))
      .join('||');
    const equal = (
      prevActiveId === nextActiveId
      && prevSessionIds === nextSessionIds
      && prevRevision === nextRevision
      && prevInputResetEpoch === nextInputResetEpoch
      && prevAliasInputs === nextAliasInputs
      && (prev.followResetEpoch ?? -1) === (next.followResetEpoch ?? -1)
      && prev.onSwitchSession === next.onSwitchSession
      && prev.onMoveSession === next.onMoveSession
      && prev.onCloseSession === next.onCloseSession
      && prev.onTerminalInput === next.onTerminalInput
      && prev.onSessionDraftSend === next.onSessionDraftSend
    );
    return equal;
  }),
}));

vi.mock('./lib/tmux-sessions', () => ({
  createTmuxSession: (...args: unknown[]) => createTmuxSessionMock(...args),
  fetchTmuxSessions: (...args: unknown[]) => fetchTmuxSessionsMock(...args),
}));

import { AppContent } from './App';

describe('App dynamic refresh matrix', () => {
  const originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');

  beforeEach(() => {
    vi.useRealTimers();
    openTerminalPageSpy.mockClear();
    terminalPageRenderSpy.mockClear();
    fetchTmuxSessionsMock.mockReset();
    createTmuxSessionMock.mockReset();
    createTmuxSessionMock.mockResolvedValue([]);
    connectionsPageHarness.reset();
    fetchTmuxSessionsMock.mockImplementation(async (target: { bridgeHost?: string; bridgePort?: number }) => {
      if (target?.bridgeHost === '100.127.23.27' && target?.bridgePort === 3333) {
        return ['alpha', 'beta', 'zterm', 'session-s1', 'session-s2', 'session-shared'];
      }
      if (target?.bridgeHost === '127.0.0.1' && target?.bridgePort === 3333) {
        return ['session-s1', 'session-s2', 'session-shared', 'shared', 'alpha', 'beta'];
      }
      return [];
    });
    sessionHarness.reset();
    hostHarness.reset();
    quickActionHarness.reset();
    shortcutActionHarness.reset();
    sessionDraftHarness.reset();
    sessionHistoryHarness.reset();
    settingsPageHarness.reset();
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
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify({ kind: 'terminal' }));
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('persists terminal width-mode intent back to bridge settings', async () => {
    const setBridgeSettings = vi.fn();
    const bridgeSettings = {
      servers: [],
      terminalWidthMode: 'mirror-fixed',
    } as any;

    render(<AppContent bridgeSettings={bridgeSettings} setBridgeSettings={setBridgeSettings} />);

    fireEvent.click(screen.getByTestId('set-active-adaptive-width'));

    expect(sessionHarness.sendTerminalResize).toHaveBeenCalledWith('s1', 72, undefined, 'adaptive-phone');
    expect(setBridgeSettings).toHaveBeenCalledTimes(1);
    const updater = setBridgeSettings.mock.calls[0]?.[0];
    expect(typeof updater).toBe('function');
    expect(updater(bridgeSettings).terminalWidthMode).toBe('adaptive-phone');
  });

  it('persists Settings save width mode from the draft instead of stale current settings', async () => {
    const setBridgeSettings = vi.fn();
    const bridgeSettings = {
      servers: [],
      terminalWidthMode: 'mirror-fixed',
    } as any;

    render(<AppContent bridgeSettings={bridgeSettings} setBridgeSettings={setBridgeSettings} />);

    fireEvent.click(screen.getByTestId('open-connections'));
    await waitFor(() => expect(connectionsPageHarness.readProps()).toBeTruthy());
    act(() => {
      connectionsPageHarness.readProps()?.onOpenSettings?.();
    });

    await waitFor(() => expect(screen.getByTestId('save-settings-adaptive-width')).toBeTruthy());
    fireEvent.click(screen.getByTestId('save-settings-adaptive-width'));

    expect(setBridgeSettings).toHaveBeenCalledTimes(1);
    const updater = setBridgeSettings.mock.calls[0]?.[0];
    expect(typeof updater).toBe('function');
    expect(updater(bridgeSettings).terminalWidthMode).toBe('adaptive-phone');
  });

  it('follows state activeSession switch even when stale getter still points to previous session', async () => {
    sessionHarness.update(
      {
        sessions: [makeSession('s1', 1), makeSession('s2', 9)],
        activeSessionId: 's1',
        connectedCount: 2,
      } as any,
      makeSession('s1', 1),
    );

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

  it('does not rerender TerminalPage when only an inactive session runtime state changes', async () => {
    const bridgeSettings = { servers: [] } as any;
    sessionHarness.update(
      {
        sessions: [makeSession('s1', 1), makeSession('s2', 9)],
        activeSessionId: 's1',
        connectedCount: 2,
      } as any,
      makeSession('s1', 1),
    );

    const view = render(
      <AppContent bridgeSettings={bridgeSettings} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));
    terminalPageRenderSpy.mockClear();

    act(() => {
      sessionHarness.update(
        {
          sessions: [
            makeSession('s1', 1),
            {
              ...makeSession('s2', 9),
              state: 'reconnecting',
              lastError: 'probe-timeout',
            },
          ],
          activeSessionId: 's1',
          connectedCount: 2,
        } as any,
        makeSession('s1', 1),
      );
    });
    view.rerender(<AppContent bridgeSettings={bridgeSettings} setBridgeSettings={vi.fn()} />);

    expect(screen.getByTestId('terminal-revision').textContent).toBe('1');
    expect(terminalPageRenderSpy).not.toHaveBeenCalled();
  });

  it('switches to the requested tab and rerenders TerminalPage when sending a draft to another tab', async () => {
    const bridgeSettings = { servers: [] } as any;
    sessionHarness.update(
      {
        sessions: [makeSession('s1', 1), makeSession('s2', 9)],
        activeSessionId: 's1',
        connectedCount: 2,
      } as any,
      makeSession('s1', 1),
    );

    const view = render(
      <AppContent bridgeSettings={bridgeSettings} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));
    terminalPageRenderSpy.mockClear();

    fireEvent.click(screen.getByTestId('send-draft-to-second-tab'));
    view.rerender(<AppContent bridgeSettings={bridgeSettings} setBridgeSettings={vi.fn()} />);

    expect(terminalPageRenderSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('terminal-revision').textContent).toBe('9');
  });

  it('keeps TerminalPage memo stable across a plain App rerender when terminal-facing props have no semantic change', async () => {
    const bridgeSettings = { servers: [] } as any;
    const view = render(
      <AppContent bridgeSettings={bridgeSettings} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));
    terminalPageRenderSpy.mockClear();

    view.rerender(
      <AppContent bridgeSettings={bridgeSettings} setBridgeSettings={vi.fn()} />,
    );

    expect(terminalPageRenderSpy).not.toHaveBeenCalled();
  });

  it('switches tab without rewriting page state when terminal page is already active', async () => {
    sessionHarness.update(
      {
        sessions: [makeSession('s1', 1), makeSession('s2', 9)],
        activeSessionId: 's1',
        connectedCount: 2,
      } as any,
      makeSession('s1', 1),
    );

    const view = render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));
    openTerminalPageSpy.mockClear();
    sessionHarness.switchSession.mockClear();

    fireEvent.click(screen.getByTestId('switch-second-tab'));

    act(() => {
      sessionHarness.update(
        {
          sessions: [makeSession('s1', 1), makeSession('s2', 9)],
          activeSessionId: 's2',
          connectedCount: 2,
        } as any,
        makeSession('s2', 9),
      );
    });
    view.rerender(<AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('9'));

    expect(sessionHarness.switchSession).toHaveBeenCalledTimes(1);
    expect(sessionHarness.switchSession).toHaveBeenCalledWith('s2', { refreshSource: 'explicit-resume' });
    expect(sessionHarness.resumeActiveSessionTransport).not.toHaveBeenCalled();
    expect(openTerminalPageSpy).not.toHaveBeenCalled();
  });

  it('projects active Sessions on Home without reviving group management or tab persistence', async () => {
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify({ kind: 'connections' }));
    sessionHarness.update(
      {
        sessions: [makeSession('s1', 1), makeSession('s2', 9)],
        activeSessionId: 's1',
        connectedCount: 2,
      } as any,
      makeSession('s1', 1),
    );

    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(connectionsPageHarness.readProps()).toBeTruthy());
    const props = connectionsPageHarness.readProps();
    expect(props.activeSessions.map((session: { id: string }) => session.id)).toEqual(['s1', 's2']);
    expect(props.activeSessionId).toBe('s1');
    expect(props.onResumeSession).toEqual(expect.any(Function));
    expect('onOpenServerGroups' in props).toBe(false);
    expect('onSaveServerGroupSelection' in props).toBe(false);
    expect('onLoadSavedTabList' in props).toBe(false);
    expect(localStorage.getItem(STORAGE_KEYS.OPEN_TABS)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBeNull();

    act(() => {
      props.onResumeSession('s2');
    });
    expect(sessionHarness.switchSession).toHaveBeenCalledWith('s2', { refreshSource: 'explicit-resume' });
    expect(openTerminalPageSpy).toHaveBeenCalledTimes(1);
  });

  it('projects bridge server presets on Home and opens them directly without requiring Relay login', async () => {
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify({ kind: 'connections' }));
    const bridgeSettings = {
      servers: [{
        id: '100.66.1.82:3333::daemon:mac-studio',
        name: 'Mac Studio Tailscale',
        targetHost: '100.66.1.82',
        targetPort: 3333,
        authToken: 'token-a',
        relayHostId: 'mac-studio',
      }],
      targetHost: '100.66.1.82',
      targetPort: 3333,
      targetAuthToken: 'token-a',
      traversalRelay: undefined,
    };

    render(
      <AppContent bridgeSettings={bridgeSettings as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(connectionsPageHarness.readProps()).toBeTruthy());
    const props = connectionsPageHarness.readProps();
    expect(props.relaySettings).toBeUndefined();
    expect(props.savedConnections).toEqual([
      expect.objectContaining({
        id: 'bridge-preset:100.66.1.82:3333::daemon:mac-studio',
        name: 'Mac Studio Tailscale',
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
        authToken: 'token-a',
      }),
    ]);

    sessionHarness.createSession.mockClear();
    sessionHarness.createSession.mockReturnValueOnce('runtime:mac-studio:zterm-20260715-060708');
    openTerminalPageSpy.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T06:07:08.000Z'));
    await act(async () => {
      props.onOpenSavedConnection(props.savedConnections[0]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(createTmuxSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
        authToken: 'token-a',
      }),
      expect.any(Object),
      'zterm-20260715-060708',
    );
    expect(sessionHarness.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
        sessionName: 'zterm-20260715-060708',
        authToken: 'token-a',
      }),
      expect.objectContaining({ activate: false }),
    );
    vi.useRealTimers();
    await waitFor(() => expect(screen.getByTestId('terminal-session-ids').textContent).toContain('runtime:mac-studio:zterm-20260715-060708'));
    expect(tmuxPickerHarness.readProps()).toEqual(expect.objectContaining({ open: false }));
  });

  it('passes Home server identity aliases into the TerminalPage drawer projection', async () => {
    const bridgeSettings = {
      servers: [{
        id: '100.66.1.82:3333::daemon:mac-studio',
        name: 'Mac Studio Tailscale',
        targetHost: '100.66.1.82',
        targetPort: 3333,
        authToken: 'token-a',
        relayHostId: 'mac-studio',
      }],
      traversalRelay: undefined,
    };

    render(
      <AppContent bridgeSettings={bridgeSettings as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(terminalPageRenderSpy).toHaveBeenCalled());
    const lastRender = terminalPageRenderSpy.mock.calls[terminalPageRenderSpy.mock.calls.length - 1]?.[0];
    expect(lastRender.serverIdentityAliasInputs).toEqual([
      expect.objectContaining({
        name: 'Mac Studio Tailscale',
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
      }),
    ]);
  });

  // NOTE: d505c65 changed inputResetEpoch from React state to a ref to eliminate
  // keystroke-triggered React state cascades. Keystrokes no longer bump the epoch.
  // The epoch only increments on real session switches (applySessionSwitchRenderReset
  // in TerminalView).
  it('forwards terminal input WITHOUT bumping input reset epoch on keystroke (ref-based)', async () => {
    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-input-reset-epoch').textContent).toBe('0'));

    fireEvent.click(screen.getByTestId('send-active-input'));

    expect(screen.getByTestId('terminal-input-reset-epoch').textContent).toBe('0');
    expect(sessionHarness.sendInput).toHaveBeenCalledWith('s1', 'typed-from-terminal');
  });

  it('probes only the active tab on foreground online recovery without rebuilding websockets', async () => {
    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));

    act(() => {
      window.dispatchEvent(new Event('online'));
    });

    expect(sessionHarness.reconnectAllSessions).not.toHaveBeenCalled();
    expect(sessionHarness.reconnectSession).not.toHaveBeenCalled();
    expect(sessionHarness.resumeActiveSessionTransport).toHaveBeenCalledTimes(1);
    expect(sessionHarness.resumeActiveSessionTransport).toHaveBeenCalledWith('s1');
  });

  it('does not resume transports for online events while the app is hidden', async () => {
    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));

    act(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      window.dispatchEvent(new Event('online'));
    });

    expect(sessionHarness.resumeActiveSessionTransport).not.toHaveBeenCalled();
    expect(sessionHarness.reconnectSession).not.toHaveBeenCalled();
    expect(sessionHarness.reconnectAllSessions).not.toHaveBeenCalled();
  });

  it('keeps foreground restore separate from online recovery', async () => {
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
    });

    expect(sessionHarness.resumeActiveSessionTransport).not.toHaveBeenCalled();
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

    expect(sessionHarness.resumeActiveSessionTransport).not.toHaveBeenCalled();
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

    expect(sessionHarness.resumeActiveSessionTransport).not.toHaveBeenCalled();
    expect(sessionHarness.reconnectSession).not.toHaveBeenCalled();
    expect(sessionHarness.reconnectAllSessions).not.toHaveBeenCalled();
  });

  it('bumps follow reset epoch exactly once for each foreground resume signal', async () => {
    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-follow-reset-epoch').textContent).toBe('0'));

    act(() => {
      document.dispatchEvent(new Event('resume'));
    });
    await waitFor(() => expect(screen.getByTestId('terminal-follow-reset-epoch').textContent).toBe('1'));

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
    await waitFor(() => expect(screen.getByTestId('terminal-follow-reset-epoch').textContent).toBe('2'));

    act(() => {
      capacitorAppHarness.emit({ isActive: false });
      capacitorAppHarness.emit({ isActive: true });
    });
    await waitFor(() => expect(screen.getByTestId('terminal-follow-reset-epoch').textContent).toBe('3'));
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

    expect(sessionHarness.resumeActiveSessionTransport).not.toHaveBeenCalled();
    expect(sessionHarness.reconnectSession).not.toHaveBeenCalled();
  });

  it('delegates disconnected active-tab foreground resume to SessionContext transport truth', async () => {
    sessionHarness.update(
      {
        sessions: [
          {
            ...makeSession('s1', 1),
            state: 'disconnected',
          },
          {
            ...makeSession('s2', 2),
            state: 'disconnected',
          },
        ],
        activeSessionId: 's1',
        connectedCount: 0,
      } as any,
      {
        ...makeSession('s1', 1),
        state: 'disconnected',
      } as any,
    );

    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));

    act(() => {
      document.dispatchEvent(new Event('resume'));
    });

    expect(sessionHarness.resumeActiveSessionTransport).not.toHaveBeenCalled();
    expect(sessionHarness.reconnectSession).not.toHaveBeenCalled();
    expect(sessionHarness.reconnectAllSessions).not.toHaveBeenCalled();
  });


  it('does not add App-side reconnect fallback when foreground resume returns false', async () => {
    sessionHarness.resumeActiveSessionTransport.mockReturnValue(false);

    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('1'));

    act(() => {
      document.dispatchEvent(new Event('resume'));
    });

    expect(sessionHarness.resumeActiveSessionTransport).not.toHaveBeenCalled();
    expect(sessionHarness.reconnectSession).not.toHaveBeenCalled();
    expect(sessionHarness.reconnectAllSessions).not.toHaveBeenCalled();
  });

  it('registers Capacitor appStateChange only once across session rerenders', async () => {
    const view = render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(capacitorAppHarness.eventCallCount('appStateChange')).toBe(1));
    expect(capacitorAppHarness.eventCallCount('appUrlOpen')).toBeGreaterThan(0);

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

    expect(capacitorAppHarness.eventCallCount('appStateChange')).toBe(1);
    expect(capacitorAppHarness.eventCallCount('appUrlOpen')).toBeGreaterThan(0);
  });

  it('imports shared quick actions and shortcut actions from connection config deep links', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(capacitorAppHarness.eventCallCount('appUrlOpen')).toBeGreaterThan(0));

    const link = buildConnectionConfigShareLink({
      hosts: [
        {
          name: 'Imported Mac',
          bridgeHost: '100.64.0.10',
          bridgePort: 3333,
          sessionName: 'main',
          authToken: 'token-a',
          authType: 'password',
          tags: [],
          pinned: false,
        },
      ],
      quickActions: [
        { id: 'qa-1', label: 'ls', sequence: 'ls -la\r', order: 0 },
      ],
      shortcutActions: [
        { id: 'sc-1', label: 'Ctrl+C', sequence: '\x03', order: 0, row: 'bottom-scroll' },
      ],
      exportedAt: 3000,
    });

    act(() => {
      capacitorAppHarness.emitUrlOpen(link);
    });

    expect(quickActionHarness.setQuickActions).toHaveBeenCalledWith([
      { id: 'qa-1', label: 'ls', sequence: 'ls -la\r', order: 0 },
    ]);
    expect(shortcutActionHarness.setShortcutActions).toHaveBeenCalledWith([
      { id: 'sc-1', label: 'Ctrl+C', sequence: '\x03', order: 0, row: 'bottom-scroll' },
    ]);
    expect(alertSpy).toHaveBeenCalledWith('Imported connection: Imported Mac，1 个文本快捷指令，1 个终端快捷键');
  });

  it('clears legacy persisted tab keys on cold launch instead of restoring them', async () => {
    localStorage.setItem(STORAGE_KEYS.OPEN_TABS, JSON.stringify([
      {
        sessionId: 'legacy-a',
        hostId: 'host-a',
        connectionName: 'Legacy A',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'alpha',
        authToken: 'token-a',
        createdAt: 1,
      },
    ]));
    localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, 'legacy-a');
    localStorage.setItem(STORAGE_KEYS.SAVED_TAB_LISTS, JSON.stringify([{ id: 'saved-list-a', tabs: [] }]));
    sessionHarness.update({
      sessions: [],
      activeSessionId: null,
      connectedCount: 0,
    } as any, null as any);

    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(localStorage.getItem(STORAGE_KEYS.OPEN_TABS)).toBeNull());
    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.SAVED_TAB_LISTS)).toBeNull();
    expect(screen.getByTestId('terminal-session-ids').textContent).toBe('');
    expect(sessionHarness.createSession).not.toHaveBeenCalled();
  });

  it('materializes current-process runtime sessions without saving tab keys', async () => {
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

    await waitFor(() => expect(screen.getByTestId('terminal-session-ids').textContent).toBe('s1,s2'));
    expect(screen.getByTestId('terminal-revision').textContent).toBe('1');
    expect(localStorage.getItem(STORAGE_KEYS.OPEN_TABS)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.SAVED_TAB_LISTS)).toBeNull();
  });

  it('switches the current-process active tab without saving tab keys', async () => {
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

    await waitFor(() => expect(screen.getByTestId('terminal-session-ids').textContent).toBe('s1,s2'));
    fireEvent.click(screen.getByTestId('switch-second-tab'));

    expect(sessionHarness.switchSession).toHaveBeenCalledWith('s2', { refreshSource: 'explicit-resume' });
    expect(localStorage.getItem(STORAGE_KEYS.OPEN_TABS)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBeNull();
  });

  it('reorders current-process tabs without saving tab keys', async () => {
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

    await waitFor(() => expect(screen.getByTestId('terminal-session-ids').textContent).toBe('s1,s2'));
    fireEvent.click(screen.getByTestId('move-second-tab-first'));

    await waitFor(() => expect(screen.getByTestId('terminal-session-ids').textContent).toBe('s2,s1'));
    expect(localStorage.getItem(STORAGE_KEYS.OPEN_TABS)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBeNull();
  });

  it('closes current-process tabs without saving tab keys or saved lists', async () => {
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

    await waitFor(() => expect(screen.getByTestId('terminal-session-ids').textContent).toBe('s1,s2'));
    fireEvent.click(screen.getByTestId('close-active-tab'));

    await waitFor(() => expect(screen.getByTestId('terminal-session-ids').textContent).toBe('s2'));
    expect(sessionHarness.closeSession).toHaveBeenCalledWith('s1');
    expect(localStorage.getItem(STORAGE_KEYS.OPEN_TABS)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.SAVED_TAB_LISTS)).toBeNull();
  });

  it('does not expose saved-tab list loading from the terminal page shell', async () => {
    sessionHarness.update(
      {
        sessions: [makeSession('s1', 1)],
        activeSessionId: 's1',
        connectedCount: 1,
      } as any,
      makeSession('s1', 1),
    );

    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-session-ids').textContent).toBe('s1'));
    expect(screen.queryByTestId('load-saved-tab-list')).toBeNull();
    expect(screen.queryByTestId('load-daemon-owned-saved-tab-list')).toBeNull();
  });

  it('keeps ACTIVE_PAGE terminal focus without persisting active tabs across foreground resume', async () => {
    sessionHarness.update(
      {
        sessions: [makeSession('s1', 1), makeSession('s2', 2)],
        activeSessionId: 's2',
        connectedCount: 2,
      } as any,
      makeSession('s2', 2),
    );
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PAGE, JSON.stringify({ kind: 'terminal' }));

    render(
      <AppContent bridgeSettings={{ servers: [] } as any} setBridgeSettings={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-revision').textContent).toBe('2'));
    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBeNull();
    await waitFor(() => expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.ACTIVE_PAGE) || '{}')).toEqual({
      kind: 'terminal',
    }));

    act(() => {
      document.dispatchEvent(new Event('resume'));
    });

    expect(sessionHarness.resumeActiveSessionTransport).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBeNull();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.ACTIVE_PAGE) || '{}')).toEqual({
      kind: 'terminal',
    });

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

    expect(sessionHarness.resumeActiveSessionTransport).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)).toBeNull();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.ACTIVE_PAGE) || '{}')).toEqual({
      kind: 'terminal',
    });
  });
});
