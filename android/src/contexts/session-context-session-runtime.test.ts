import { describe, expect, it, vi } from 'vitest';
import {
  closeSessionRuntime,
  connectSessionRuntime,
  createSessionRuntime,
  reconnectSessionRuntime,
  scheduleReconnectRuntime,
} from './session-context-session-runtime';
import {
  openSessionTransportByIntentRuntime,
} from './session-context-transport-open-runtime';
import { createSessionBufferState } from '../lib/terminal-buffer';
import type { Session } from '../lib/types';

const host = {
  id: 'host-1',
  createdAt: 1,
  name: 'conn',
  bridgeHost: '127.0.0.1',
  bridgePort: 3333,
  sessionName: 'tmux-1',
  authType: 'password' as const,
  tags: [],
  pinned: false,
};

const targetKey = '127.0.0.1:3333:';

describe('closeSessionRuntime', () => {
  it('closes the session socket instead of parking it as superseded', () => {
    const sendSocketPayload = vi.fn();
    const cleanupSocket = vi.fn();
    const cleanupControlSocket = vi.fn();
    const clearSessionTransportRuntime = vi.fn();
    const writeSessionTransportToken = vi.fn();
    const deleteSessionSync = vi.fn();
    const setScheduleStates = vi.fn();

    closeSessionRuntime({
      sessionId: 'session-1',
      refs: {
        manualCloseRef: { current: new Set() },
        pendingSessionTransportOpenIntentsRef: { current: new Map() },
        pendingInputTailRefreshRef: { current: new Map([['session-1', { requestedAt: 1, localRevision: 1 }]]) },
        pendingConnectTailRefreshRef: { current: new Set(['session-1']) },
        pendingResumeTailRefreshRef: { current: new Set(['session-1']) },
        lastActiveReentryAtRef: { current: new Map([['session-1', 1]]) },
        lastConnectedBaselineAtRef: { current: new Map([['session-1', 1]]) },
        sessionVisibleRangeRef: { current: new Map([['session-1', { startIndex: 0, endIndex: 1 }]]) },
        sessionBufferStoreRef: { current: { deleteSession: vi.fn() } },
        sessionRenderGateRef: { current: { deleteSession: vi.fn() } },
        sessionHeadStoreRef: { current: { deleteSession: vi.fn() } },
        sessionDebugMetricsStoreRef: { current: { clearSession: vi.fn() } },
      },
      clearReconnectForSession: vi.fn(),
      readSessionTransportRuntime: () => ({ targetKey: 'target-a' }),
      readSessionTargetRuntime: () => ({ sessionIds: ['session-1', 'session-2'] }),
      readSessionTransportSocket: () => ({ readyState: WebSocket.OPEN } as any),
      sendSocketPayload,
      runtimeDebug: vi.fn(),
      cleanupSocket,
      cleanupControlSocket,
      writeSessionTransportToken,
      clearSessionTransportRuntime,
      setScheduleStates,
      deleteSessionSync,
    });

    expect(sendSocketPayload).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ readyState: WebSocket.OPEN }),
      JSON.stringify({ type: 'close' }),
    );
    expect(cleanupSocket).toHaveBeenCalledWith('session-1', true);
    expect(cleanupControlSocket).not.toHaveBeenCalled();
    expect(writeSessionTransportToken).toHaveBeenCalledWith('session-1', null);
    expect(clearSessionTransportRuntime).toHaveBeenCalledWith('session-1');
    expect(deleteSessionSync).toHaveBeenCalledWith('session-1');
  });

  it('also closes the shared control transport when the last target session is closed', () => {
    const cleanupSocket = vi.fn();
    const cleanupControlSocket = vi.fn();

    closeSessionRuntime({
      sessionId: 'session-1',
      refs: {
        manualCloseRef: { current: new Set() },
        pendingSessionTransportOpenIntentsRef: { current: new Map() },
        pendingInputTailRefreshRef: { current: new Map() },
        pendingConnectTailRefreshRef: { current: new Set() },
        pendingResumeTailRefreshRef: { current: new Set() },
        lastActiveReentryAtRef: { current: new Map() },
        lastConnectedBaselineAtRef: { current: new Map() },
        sessionVisibleRangeRef: { current: new Map() },
        sessionBufferStoreRef: { current: { deleteSession: vi.fn() } },
        sessionRenderGateRef: { current: { deleteSession: vi.fn() } },
        sessionHeadStoreRef: { current: { deleteSession: vi.fn() } },
        sessionDebugMetricsStoreRef: { current: { clearSession: vi.fn() } },
      },
      clearReconnectForSession: vi.fn(),
      readSessionTransportRuntime: () => ({ targetKey: 'target-a' }),
      readSessionTargetRuntime: () => ({ sessionIds: ['session-1'] }),
      readSessionTransportSocket: () => null,
      sendSocketPayload: vi.fn(),
      runtimeDebug: vi.fn(),
      cleanupSocket,
      cleanupControlSocket,
      writeSessionTransportToken: vi.fn(),
      clearSessionTransportRuntime: vi.fn(),
      setScheduleStates: vi.fn(),
      deleteSessionSync: vi.fn(),
    });

    expect(cleanupSocket).toHaveBeenCalledWith('session-1', true);
    expect(cleanupControlSocket).toHaveBeenCalledWith('session-1', true);
  });
});

describe('scheduleReconnectRuntime', () => {
  it('clears stale reconnect timer when host truth is already missing', () => {
    vi.useFakeTimers();
    const timer = setTimeout(() => undefined, 10_000) as unknown as number;
    const reconnectRuntime = {
      attempt: 2,
      timer,
      nextDelayMs: null,
      connecting: false,
    };
    const reconnectRuntimesRef = {
      current: new Map([
        ['session-1', reconnectRuntime],
      ]),
    };

    scheduleReconnectRuntime({
      sessionId: 'session-1',
      message: 'missing-host',
      retryable: true,
      refs: {
        manualCloseRef: { current: new Set() },
        reconnectRuntimesRef,
        stateRef: { current: { sessions: [], activeSessionId: 'session-1' } },
      },
      readSessionTransportHost: () => null,
      shouldAutoReconnectSessionFn: () => true,
      createSessionReconnectRuntime: () => ({
        attempt: 0,
        timer: null,
        nextDelayMs: null,
        connecting: false,
      }),
      updateSessionSync: vi.fn(),
      emitSessionStatus: vi.fn(),
      startReconnectAttempt: vi.fn(),
    });

    expect(reconnectRuntimesRef.current.has('session-1')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('clears queued reconnect timer without projecting terminal error when auto reconnect is blocked for inactive session', () => {
    vi.useFakeTimers();
    const timer = setTimeout(() => undefined, 10_000) as unknown as number;
    const reconnectRuntimesRef = {
      current: new Map([
        ['session-1', {
          attempt: 1,
          timer,
          nextDelayMs: null,
          connecting: false,
        }],
      ]),
    };
    const updateSessionSync = vi.fn();
    const emitSessionStatus = vi.fn();

    scheduleReconnectRuntime({
      sessionId: 'session-1',
      message: 'inactive-blocked',
      retryable: true,
      refs: {
        manualCloseRef: { current: new Set() },
        reconnectRuntimesRef,
        stateRef: { current: { sessions: [], activeSessionId: 'session-2', liveSessionIds: [] } },
      },
      readSessionTransportHost: () => ({
        id: 'host-1',
        createdAt: 1,
        name: 'conn',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'tmux-1',
        authType: 'password',
        tags: [],
        pinned: false,
      }),
      shouldAutoReconnectSessionFn: () => false,
      createSessionReconnectRuntime: () => ({
        attempt: 0,
        timer: null,
        nextDelayMs: null,
        connecting: false,
      }),
      updateSessionSync,
      emitSessionStatus,
      startReconnectAttempt: vi.fn(),
    });

    expect(reconnectRuntimesRef.current.has('session-1')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(updateSessionSync).toHaveBeenCalled();
    expect(emitSessionStatus).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('keeps retryable reconnect out of terminal error projection for a visible live pane', () => {
    vi.useFakeTimers();
    const reconnectRuntimesRef = {
      current: new Map<string, any>(),
    };
    const updateSessionSync = vi.fn();
    const emitSessionStatus = vi.fn();
    const startReconnectAttempt = vi.fn();

    scheduleReconnectRuntime({
      sessionId: 'session-2',
      message: 'visible-pane-stale',
      retryable: true,
      refs: {
        manualCloseRef: { current: new Set() },
        reconnectRuntimesRef,
        stateRef: { current: { sessions: [], activeSessionId: 'session-1', liveSessionIds: ['session-2'] } },
      },
      readSessionTransportHost: () => ({
        id: 'host-2',
        createdAt: 1,
        name: 'conn-2',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'tmux-2',
        authType: 'password',
        tags: [],
        pinned: false,
      }),
      shouldAutoReconnectSessionFn: (options) => (
        options.sessionId === options.activeSessionId
        || Boolean(options.liveSessionIds?.includes(options.sessionId))
      ),
      createSessionReconnectRuntime: () => ({
        attempt: 0,
        timer: null,
        nextDelayMs: null,
        connecting: false,
      }),
      updateSessionSync,
      emitSessionStatus,
      startReconnectAttempt,
    });

    expect(reconnectRuntimesRef.current.has('session-2')).toBe(true);
    expect(updateSessionSync).toHaveBeenCalled();
    expect(emitSessionStatus).not.toHaveBeenCalled();
    expect(startReconnectAttempt).toHaveBeenCalledWith('session-2');
    vi.useRealTimers();
  });
});

describe('active truth ownership gates', () => {
  it('connectSessionRuntime does not mutate active truth directly', () => {
    const setActiveSessionSync = vi.fn();
    const queueConnectTransportOpenIntent = vi.fn();

    connectSessionRuntime({
      sessionId: 'session-1',
      host: {
        id: 'host-1',
        createdAt: 1,
        name: 'conn',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'tmux-1',
        authType: 'password',
        tags: [],
        pinned: false,
      },
      refs: {
        manualCloseRef: { current: new Set() },
      },
      clearReconnectForSession: vi.fn(),
      cleanupSocket: vi.fn(),
      writeSessionTransportHost: vi.fn(),
      writeSessionTransportToken: vi.fn(),
      readSessionTransportSocket: vi.fn(() => null),
      readSessionTargetKey: vi.fn(() => null),
      hasPendingSessionTransportOpen: vi.fn(() => false),
      isPendingSessionTransportOpenStale: vi.fn(() => false),
      updateSessionSync: vi.fn(),
      setScheduleStateForSession: vi.fn(),
      setActiveSessionSync,
      queueConnectTransportOpenIntent,
    } as any);

    expect(setActiveSessionSync).not.toHaveBeenCalled();
    expect(queueConnectTransportOpenIntent).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ sessionName: 'tmux-1' }),
    );
  });

  it('createSessionRuntime reuses an existing managed session without mutating active truth directly', () => {
    const connectSession = vi.fn();
    const writeSessionTransportHost = vi.fn();

    const existingSession: Session = {
      id: 'session-existing',
      hostId: 'host-1',
      connectionName: 'conn',
      bridgeHost: '127.0.0.1',
      bridgePort: 3333,
      daemonHostId: undefined,
      sessionName: 'tmux-1',
      authToken: undefined,
      autoCommand: undefined,
      title: 'tmux-1',
      ws: null,
      state: 'connected',
      hasUnread: false,
      customName: undefined,
      buffer: createSessionBufferState({ cols: 80, rows: 24, cacheLines: 1000 }),
      daemonHeadRevision: 0,
      daemonHeadEndIndex: 0,
      reconnectAttempt: 0,
      createdAt: 1,
    };

    const sessionId = createSessionRuntime({
      host: {
        id: 'host-1',
        createdAt: 1,
        name: 'conn',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'tmux-1',
        authType: 'password',
        tags: [],
        pinned: false,
      },
      createOptions: {
        connect: false,
      },
      refs: {
        stateRef: {
          current: {
            sessions: [existingSession],
            activeSessionId: 'other-session',
          },
        },
        pendingSessionTransportOpenIntentsRef: { current: new Map() },
        sessionBufferStoreRef: { current: { commitBuffer: vi.fn(), setBuffer: vi.fn() } },
        sessionHeadStoreRef: { current: { setHead: vi.fn() } },
      },
      runtimeDebug: vi.fn(),
      resolveSessionCacheLines: vi.fn(() => 1000),
      createSessionSync: vi.fn(),
      updateSessionSync: vi.fn(),
      writeSessionTransportHost,
      readSessionTransportSocket: vi.fn(() => null),
      connectSession,
      defaultViewport: { cols: 80, rows: 24 },
    });

    expect(sessionId).toBe('session-existing');
    expect(connectSession).not.toHaveBeenCalled();
    expect(writeSessionTransportHost).toHaveBeenCalledWith(
      'session-existing',
      expect.objectContaining({
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'tmux-1',
      }),
    );
  });

  it('createSessionRuntime restores transport identity for a closed local shell without opening websocket', () => {
    const connectSession = vi.fn();
    const writeSessionTransportHost = vi.fn();

    const sessionId = createSessionRuntime({
      host: {
        id: 'host-1',
        createdAt: 1,
        name: 'conn',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'tmux-1',
        authType: 'password',
        tags: [],
        pinned: false,
      },
      createOptions: {
        connect: false,
        sessionId: 'session-restored',
      },
      refs: {
        stateRef: {
          current: {
            sessions: [],
            activeSessionId: null,
          },
        },
        pendingSessionTransportOpenIntentsRef: { current: new Map() },
        sessionBufferStoreRef: { current: { commitBuffer: vi.fn(), setBuffer: vi.fn() } },
        sessionHeadStoreRef: { current: { setHead: vi.fn() } },
      },
      runtimeDebug: vi.fn(),
      resolveSessionCacheLines: vi.fn(() => 1000),
      createSessionSync: vi.fn(),
      updateSessionSync: vi.fn(),
      writeSessionTransportHost,
      readSessionTransportSocket: vi.fn(() => null),
      connectSession,
      defaultViewport: { cols: 80, rows: 24 },
    });

    expect(sessionId).toBe('session-restored');
    expect(connectSession).not.toHaveBeenCalled();
    expect(writeSessionTransportHost).toHaveBeenCalledWith(
      'session-restored',
      expect.objectContaining({
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'tmux-1',
      }),
    );
  });

  it('reopens transport when reusing a managed session whose label is connected but transport truth is missing', () => {
    const connectSession = vi.fn();

    const existingSession: Session = {
      id: 'session-existing',
      hostId: 'host-1',
      connectionName: 'conn',
      bridgeHost: '127.0.0.1',
      bridgePort: 3333,
      daemonHostId: undefined,
      sessionName: 'tmux-1',
      authToken: undefined,
      autoCommand: undefined,
      title: 'tmux-1',
      ws: null,
      state: 'connected',
      hasUnread: false,
      customName: undefined,
      buffer: createSessionBufferState({ cols: 80, rows: 24, cacheLines: 1000 }),
      daemonHeadRevision: 0,
      daemonHeadEndIndex: 0,
      reconnectAttempt: 0,
      createdAt: 1,
    };

    const sessionId = createSessionRuntime({
      host: {
        id: 'host-1',
        createdAt: 1,
        name: 'conn',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'tmux-1',
        authType: 'password',
        tags: [],
        pinned: false,
      },
      createOptions: {
        connect: true,
      },
      refs: {
        stateRef: {
          current: {
            sessions: [existingSession],
            activeSessionId: 'session-existing',
          },
        },
        pendingSessionTransportOpenIntentsRef: { current: new Map() },
        sessionBufferStoreRef: { current: { commitBuffer: vi.fn(), setBuffer: vi.fn() } },
        sessionHeadStoreRef: { current: { setHead: vi.fn() } },
      },
      runtimeDebug: vi.fn(),
      resolveSessionCacheLines: vi.fn(() => 1000),
      createSessionSync: vi.fn(),
      updateSessionSync: vi.fn(),
      readSessionTransportSocket: vi.fn(() => null),
      connectSession,
      defaultViewport: { cols: 80, rows: 24 },
    });

    expect(sessionId).toBe('session-existing');
    expect(connectSession).toHaveBeenCalledWith(
      'session-existing',
      expect.objectContaining({
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'tmux-1',
      }),
    );
  });
});

describe('session transport reuse runtime gates', () => {
  it('connectSessionRuntime reuses an open same-target session transport without cleanup or new open intent', () => {
    const cleanupSocket = vi.fn();
    const queueConnectTransportOpenIntent = vi.fn();

    connectSessionRuntime({
      sessionId: 'session-1',
      host,
      refs: {
        manualCloseRef: { current: new Set() },
      },
      clearReconnectForSession: vi.fn(),
      cleanupSocket,
      writeSessionTransportHost: vi.fn(),
      writeSessionTransportToken: vi.fn(),
      updateSessionSync: vi.fn(),
      setScheduleStateForSession: vi.fn(),
      queueConnectTransportOpenIntent,
      readSessionTransportSocket: () => ({ readyState: WebSocket.OPEN } as any),
      readSessionTargetKey: () => targetKey,
      hasPendingSessionTransportOpen: () => false,
      isPendingSessionTransportOpenStale: () => false,
    } as any);

    expect(cleanupSocket).not.toHaveBeenCalled();
    expect(queueConnectTransportOpenIntent).not.toHaveBeenCalled();
  });

  it('connectSessionRuntime waits for a connecting same-target transport with a fresh pending open', () => {
    const cleanupSocket = vi.fn();
    const queueConnectTransportOpenIntent = vi.fn();

    connectSessionRuntime({
      sessionId: 'session-1',
      host,
      refs: {
        manualCloseRef: { current: new Set() },
      },
      clearReconnectForSession: vi.fn(),
      cleanupSocket,
      writeSessionTransportHost: vi.fn(),
      writeSessionTransportToken: vi.fn(),
      updateSessionSync: vi.fn(),
      setScheduleStateForSession: vi.fn(),
      queueConnectTransportOpenIntent,
      readSessionTransportSocket: () => ({ readyState: WebSocket.CONNECTING } as any),
      readSessionTargetKey: () => targetKey,
      hasPendingSessionTransportOpen: () => true,
      isPendingSessionTransportOpenStale: () => false,
    } as any);

    expect(cleanupSocket).not.toHaveBeenCalled();
    expect(queueConnectTransportOpenIntent).not.toHaveBeenCalled();
  });

  it('reconnectSessionRuntime reuses an open same-target socket without cleanup or forced reconnect', () => {
    const cleanupSocket = vi.fn();
    const scheduleReconnect = vi.fn();

    reconnectSessionRuntime({
      sessionId: 'session-1',
      refs: {
        stateRef: {
          current: {
            sessions: [{
              id: 'session-1',
              hostId: 'host-1',
              connectionName: 'conn',
              bridgeHost: '127.0.0.1',
              bridgePort: 3333,
              sessionName: 'tmux-1',
              authToken: undefined,
              autoCommand: undefined,
              createdAt: 1,
            } as Session],
            activeSessionId: 'session-1',
          },
        },
        manualCloseRef: { current: new Set() },
      },
      clearReconnectForSession: vi.fn(),
      readSessionTransportHost: () => host,
      readSessionTargetKey: () => targetKey,
      readSessionTargetRuntime: () => ({ sessionIds: ['session-1'] }),
      readSessionTransportSocket: () => ({ readyState: WebSocket.OPEN } as any),
      hasPendingSessionTransportOpen: () => false,
      isPendingSessionTransportOpenStale: () => false,
      runtimeDebug: vi.fn(),
      cleanupSocket,
      writeSessionTransportHost: vi.fn(),
      updateSessionSync: vi.fn(),
      scheduleReconnect,
    } as any);

    expect(cleanupSocket).not.toHaveBeenCalled();
    expect(scheduleReconnect).not.toHaveBeenCalled();
  });

  it('reconnectSessionRuntime clears stale pending open bookkeeping and rebuilds the same target', () => {
    const cleanupSocket = vi.fn();
    const cleanupControlSocket = vi.fn();
    const scheduleReconnect = vi.fn();
    const pendingStore = new Map<string, any>([
      ['session-1', { sessionId: 'session-1', createdAt: 1 }],
    ]);

    reconnectSessionRuntime({
      sessionId: 'session-1',
      refs: {
        stateRef: {
          current: {
            sessions: [{
              id: 'session-1',
              hostId: 'host-1',
              connectionName: 'conn',
              bridgeHost: '127.0.0.1',
              bridgePort: 3333,
              sessionName: 'tmux-1',
              authToken: undefined,
              autoCommand: undefined,
              createdAt: 1,
            } as Session],
            activeSessionId: 'session-1',
          },
        },
        manualCloseRef: { current: new Set() },
        pendingSessionTransportOpenIntentsRef: { current: pendingStore },
      },
      clearReconnectForSession: vi.fn(),
      readSessionTransportHost: () => host,
      readSessionTargetKey: () => targetKey,
      readSessionTargetRuntime: () => ({ sessionIds: ['session-1'] }),
      readSessionTransportSocket: () => ({ readyState: WebSocket.CONNECTING } as any),
      hasPendingSessionTransportOpen: () => true,
      isPendingSessionTransportOpenStale: () => true,
      runtimeDebug: vi.fn(),
      cleanupSocket,
      cleanupControlSocket,
      writeSessionTransportHost: vi.fn(),
      updateSessionSync: vi.fn(),
      scheduleReconnect,
    } as any);

    expect(pendingStore.has('session-1')).toBe(false);
    expect(cleanupControlSocket).toHaveBeenCalledWith('session-1', true);
    expect(cleanupSocket).toHaveBeenCalledWith('session-1', false);
    expect(scheduleReconnect).toHaveBeenCalledWith('session-1', 'manual reconnect', true, {
      immediate: true,
      resetAttempt: true,
      force: true,
    });
  });

  it('reconnectSessionRuntime still rebuilds a closed same-target socket', () => {
    const cleanupSocket = vi.fn();
    const scheduleReconnect = vi.fn();

    reconnectSessionRuntime({
      sessionId: 'session-1',
      refs: {
        stateRef: {
          current: {
            sessions: [{
              id: 'session-1',
              hostId: 'host-1',
              connectionName: 'conn',
              bridgeHost: '127.0.0.1',
              bridgePort: 3333,
              sessionName: 'tmux-1',
              authToken: undefined,
              autoCommand: undefined,
              createdAt: 1,
            } as Session],
            activeSessionId: 'session-1',
          },
        },
        manualCloseRef: { current: new Set() },
      },
      clearReconnectForSession: vi.fn(),
      readSessionTransportHost: () => host,
      readSessionTargetKey: () => targetKey,
      readSessionTargetRuntime: () => ({ sessionIds: ['session-1'] }),
      readSessionTransportSocket: () => ({ readyState: WebSocket.CLOSED } as any),
      hasPendingSessionTransportOpen: () => false,
      isPendingSessionTransportOpenStale: () => false,
      runtimeDebug: vi.fn(),
      cleanupSocket,
      writeSessionTransportHost: vi.fn(),
      updateSessionSync: vi.fn(),
      scheduleReconnect,
    } as any);

    expect(cleanupSocket).toHaveBeenCalledWith('session-1', false);
    expect(scheduleReconnect).toHaveBeenCalledWith('session-1', 'manual reconnect', true, {
      immediate: true,
      resetAttempt: true,
      force: true,
    });
  });

  it('openSessionTransportByIntentRuntime reuses an open same-target socket instead of creating another session socket', () => {
    const existingSocket = { readyState: WebSocket.OPEN } as any;
    const cleanupSocket = vi.fn();
    const buildTraversalSocketForHost = vi.fn();
    const onConnected = vi.fn();
    const writeSessionTransportToken = vi.fn();

    openSessionTransportByIntentRuntime({
      intent: {
        sessionId: 'session-1',
        openRequestId: 'open-1',
        host,
        resolvedSessionName: 'tmux-1',
        debugScope: 'reconnect',
        finalizeFailure: vi.fn(),
        onConnected,
      },
      readSessionTransportToken: () => 'ticket-1',
      readSessionTransportSocket: () => existingSocket,
      readSessionTargetKey: () => targetKey,
      cleanupSocket,
      buildTraversalSocketForHost,
      runtimeDebug: vi.fn(),
      primeSessionTransportSocket: vi.fn(),
      bindSessionTransportSocketLifecycle: vi.fn(),
      writeSessionTransportToken,
    } as any);

    expect(cleanupSocket).not.toHaveBeenCalled();
    expect(buildTraversalSocketForHost).not.toHaveBeenCalled();
    expect(writeSessionTransportToken).toHaveBeenCalledWith('session-1', null);
    expect(onConnected).toHaveBeenCalledWith(existingSocket);
  });

  it('openSessionTransportByIntentRuntime waits for an existing connecting same-target socket without clearing its token', () => {
    const existingSocket = { readyState: WebSocket.CONNECTING } as any;
    const cleanupSocket = vi.fn();
    const buildTraversalSocketForHost = vi.fn();
    const onConnected = vi.fn();
    const writeSessionTransportToken = vi.fn();

    openSessionTransportByIntentRuntime({
      intent: {
        sessionId: 'session-1',
        openRequestId: 'open-1',
        host,
        resolvedSessionName: 'tmux-1',
        debugScope: 'reconnect',
        finalizeFailure: vi.fn(),
        onConnected,
      },
      readSessionTransportToken: () => 'ticket-1',
      readSessionTransportSocket: () => existingSocket,
      readSessionTargetKey: () => targetKey,
      cleanupSocket,
      buildTraversalSocketForHost,
      runtimeDebug: vi.fn(),
      primeSessionTransportSocket: vi.fn(),
      bindSessionTransportSocketLifecycle: vi.fn(),
      writeSessionTransportToken,
    } as any);

    expect(cleanupSocket).not.toHaveBeenCalled();
    expect(buildTraversalSocketForHost).not.toHaveBeenCalled();
    expect(writeSessionTransportToken).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('openSessionTransportByIntentRuntime still rebuilds when the current socket is closed', () => {
    const cleanupSocket = vi.fn();
    const builtSocket = { readyState: WebSocket.CONNECTING } as any;
    const buildTraversalSocketForHost = vi.fn(() => builtSocket);
    const primeSessionTransportSocket = vi.fn();

    openSessionTransportByIntentRuntime({
      intent: {
        sessionId: 'session-1',
        openRequestId: 'open-1',
        host,
        resolvedSessionName: 'tmux-1',
        debugScope: 'reconnect',
        finalizeFailure: vi.fn(),
        onConnected: vi.fn(),
      },
      readSessionTransportToken: () => 'ticket-1',
      readSessionTransportSocket: () => ({ readyState: WebSocket.CLOSED } as any),
      readSessionTargetKey: () => targetKey,
      cleanupSocket,
      buildTraversalSocketForHost,
      runtimeDebug: vi.fn(),
      primeSessionTransportSocket,
      bindSessionTransportSocketLifecycle: vi.fn(),
      writeSessionTransportToken: vi.fn(),
    } as any);

    expect(cleanupSocket).toHaveBeenCalledWith('session-1', false);
    expect(buildTraversalSocketForHost).toHaveBeenCalledWith(host, 'session');
    expect(primeSessionTransportSocket).toHaveBeenCalledWith('session-1', builtSocket);
  });
});
