import { describe, expect, it, vi } from 'vitest';
import { closeSessionRuntime, scheduleReconnectRuntime } from './session-context-session-runtime';

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
        pendingInputQueueRef: { current: new Map([['session-1', ['pwd']]]) },
        pendingSessionTransportOpenIntentsRef: { current: new Map() },
        pendingInputTailRefreshRef: { current: new Map([['session-1', { requestedAt: 1, localRevision: 1 }]]) },
        pendingConnectTailRefreshRef: { current: new Set(['session-1']) },
        pendingResumeTailRefreshRef: { current: new Set(['session-1']) },
        lastActiveReentryAtRef: { current: new Map([['session-1', 1]]) },
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
        pendingInputQueueRef: { current: new Map() },
        pendingSessionTransportOpenIntentsRef: { current: new Map() },
        pendingInputTailRefreshRef: { current: new Map() },
        pendingConnectTailRefreshRef: { current: new Set() },
        pendingResumeTailRefreshRef: { current: new Set() },
        lastActiveReentryAtRef: { current: new Map() },
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

  it('clears queued reconnect timer when auto reconnect is blocked for inactive session', () => {
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
        stateRef: { current: { sessions: [], activeSessionId: 'session-2' } },
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
    expect(emitSessionStatus).toHaveBeenCalledWith('session-1', 'error', 'inactive-blocked');
    vi.useRealTimers();
  });
});
