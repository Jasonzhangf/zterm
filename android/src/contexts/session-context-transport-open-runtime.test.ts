import { describe, expect, it, vi } from 'vitest';
import {
  handleReconnectHandshakeFailureRuntime,
  openSessionMuxChannelByIntentRuntime,
  queueSessionTransportOpenIntentRuntime,
} from './session-context-transport-open-runtime';
import type { PendingSessionTransportOpenIntent } from './session-transport-open-helpers';

function makeHost() {
  return {
    id: 'host-1',
    createdAt: 1,
    name: 'conn-1',
    bridgeHost: '100.127.23.27',
    bridgePort: 3333,
    sessionName: 'tmux-1',
    authType: 'password' as const,
    tags: [],
    pinned: false,
  };
}

function makeIntent(sessionId: string, openRequestId: string): PendingSessionTransportOpenIntent {
  return {
    sessionId,
    openRequestId,
    createdAt: 1,
    host: makeHost(),
    resolvedSessionName: 'tmux-1',
    debugScope: 'connect',
    finalizeFailure: vi.fn(),
    onConnected: vi.fn(),
  };
}

describe('queueSessionTransportOpenIntentRuntime', () => {
  it('clears any stale handshake timeout before replacing the pending open intent for the same session', () => {
    const pendingSessionTransportOpenIntentsRef = {
      current: new Map<string, PendingSessionTransportOpenIntent>(),
    };
    const clearSessionHandshakeTimeout = vi.fn();
    const ensureControlTransportForSessionOpen = vi.fn();
    const finalizeSocketFailureBaseline = vi.fn().mockReturnValue({ shouldContinue: true, manualClosed: false });

    queueSessionTransportOpenIntentRuntime({
      intentOptions: {
        sessionId: 'session-1',
        host: makeHost(),
        debugScope: 'connect',
        onHandshakeFailure: vi.fn(),
      },
      clearSessionHandshakeTimeout,
      finalizeSocketFailureBaseline,
      pendingSessionTransportOpenIntentsRef,
      ensureControlTransportForSessionOpen,
    });

    queueSessionTransportOpenIntentRuntime({
      intentOptions: {
        sessionId: 'session-1',
        host: makeHost(),
        debugScope: 'reconnect',
        onHandshakeFailure: vi.fn(),
      },
      clearSessionHandshakeTimeout,
      finalizeSocketFailureBaseline,
      pendingSessionTransportOpenIntentsRef,
      ensureControlTransportForSessionOpen,
    });

    expect(clearSessionHandshakeTimeout).toHaveBeenCalledTimes(2);
    expect(clearSessionHandshakeTimeout).toHaveBeenNthCalledWith(1, 'session-1');
    expect(clearSessionHandshakeTimeout).toHaveBeenNthCalledWith(2, 'session-1');
    expect(pendingSessionTransportOpenIntentsRef.current.size).toBe(1);
    expect(pendingSessionTransportOpenIntentsRef.current.get('session-1')?.debugScope).toBe('reconnect');
    expect(ensureControlTransportForSessionOpen).toHaveBeenCalledTimes(2);
  });

  it('uses the mux opener when provided instead of the legacy control/session-ticket opener', () => {
    const pendingSessionTransportOpenIntentsRef = {
      current: new Map<string, PendingSessionTransportOpenIntent>(),
    };
    const ensureControlTransportForSessionOpen = vi.fn();
    const openSessionMuxChannelByIntent = vi.fn();

    queueSessionTransportOpenIntentRuntime({
      intentOptions: {
        sessionId: 'session-1',
        host: makeHost(),
        debugScope: 'connect',
        onHandshakeFailure: vi.fn(),
      },
      clearSessionHandshakeTimeout: vi.fn(),
      finalizeSocketFailureBaseline: vi.fn().mockReturnValue({ shouldContinue: true, manualClosed: false }),
      pendingSessionTransportOpenIntentsRef,
      ensureControlTransportForSessionOpen,
      openSessionMuxChannelByIntent,
    });

    expect(openSessionMuxChannelByIntent).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
    );
    expect(ensureControlTransportForSessionOpen).not.toHaveBeenCalled();
  });

  it('preserves mux channel allocation hooks on the pending open intent', () => {
    const pendingSessionTransportOpenIntentsRef = {
      current: new Map<string, PendingSessionTransportOpenIntent>(),
    };
    const onChannelAllocated = vi.fn();

    queueSessionTransportOpenIntentRuntime({
      intentOptions: {
        sessionId: 'session-1',
        host: makeHost(),
        debugScope: 'connect',
        onChannelAllocated,
      },
      clearSessionHandshakeTimeout: vi.fn(),
      finalizeSocketFailureBaseline: vi.fn().mockReturnValue({ shouldContinue: true, manualClosed: false }),
      pendingSessionTransportOpenIntentsRef,
      ensureControlTransportForSessionOpen: vi.fn(),
      openSessionMuxChannelByIntent: vi.fn(),
    });

    pendingSessionTransportOpenIntentsRef.current.get('session-1')?.onChannelAllocated?.();

    expect(onChannelAllocated).toHaveBeenCalledTimes(1);
  });
});

describe('openSessionMuxChannelByIntentRuntime', () => {
  it('opens a channel over an existing ready target transport instead of creating a session socket', () => {
    const targetSocket = { readyState: WebSocket.OPEN } as any;
    const sendSocketPayload = vi.fn();
    const buildTraversalSocketForHost = vi.fn();
    const primeTargetTerminalTransportSocket = vi.fn();
    const bindTargetMuxTransportSocketLifecycle = vi.fn();
    const ensureSessionTerminalChannel = vi.fn(() => ({
      channelId: 'channel-a',
      sessionId: 'session-1',
      sessionName: 'tmux-1',
      targetKey: 'target-a',
      state: 'opening' as const,
      bodySubscribed: false,
      openedAt: 1,
      closedAt: null,
    }));
    const intent = {
      ...makeIntent('session-1', 'open-1'),
      resolvedSessionName: 'tmux-1',
    };

    openSessionMuxChannelByIntentRuntime({
      intent,
      readSessionTargetTerminalSocket: () => targetSocket,
      isSessionTargetMuxReady: () => true,
      ensureSessionTerminalChannel,
      isSessionBodySubscribed: () => false,
      updateSessionTerminalChannelState: vi.fn(),
      readRequestedTerminalGeometry: () => ({ cols: 88, widthMode: 'adaptive-phone' }),
      sendSocketPayload,
      buildTraversalSocketForHost,
      primeTargetTerminalTransportSocket,
      bindTargetMuxTransportSocketLifecycle,
      runtimeDebug: vi.fn(),
    });

    expect(buildTraversalSocketForHost).not.toHaveBeenCalled();
    expect(ensureSessionTerminalChannel).toHaveBeenCalledWith('session-1', { bodySubscribed: false });
    expect(primeTargetTerminalTransportSocket).not.toHaveBeenCalled();
    expect(bindTargetMuxTransportSocketLifecycle).not.toHaveBeenCalled();
    expect(sendSocketPayload).toHaveBeenCalledWith(
      'session-1',
      targetSocket,
      JSON.stringify({
        type: 'mux-channel-open',
        payload: {
          channelId: 'channel-a',
          sessionName: 'tmux-1',
          cols: 88,
          widthMode: 'adaptive-phone',
          bodySubscribed: false,
        },
      }),
    );
  });

  it('creates one target transport when no reusable target transport exists', () => {
    const builtSocket = { readyState: WebSocket.CONNECTING } as any;
    const buildTraversalSocketForHost = vi.fn(() => builtSocket);
    const primeTargetTerminalTransportSocket = vi.fn();
    const bindTargetMuxTransportSocketLifecycle = vi.fn();
    const sendSocketPayload = vi.fn();
    const intent = makeIntent('session-1', 'open-1');

    openSessionMuxChannelByIntentRuntime({
      intent,
      readSessionTargetTerminalSocket: () => null,
      isSessionTargetMuxReady: () => false,
      ensureSessionTerminalChannel: vi.fn(() => ({
        channelId: 'channel-a',
        sessionId: 'session-1',
        sessionName: 'tmux-1',
        targetKey: 'target-a',
        state: 'opening',
        bodySubscribed: true,
        openedAt: 1,
        closedAt: null,
      })),
      updateSessionTerminalChannelState: vi.fn(),
      readRequestedTerminalGeometry: () => null,
      sendSocketPayload,
      buildTraversalSocketForHost,
      primeTargetTerminalTransportSocket,
      bindTargetMuxTransportSocketLifecycle,
      runtimeDebug: vi.fn(),
    });

    expect(buildTraversalSocketForHost).toHaveBeenCalledWith(intent.host, 'session');
    expect(primeTargetTerminalTransportSocket).toHaveBeenCalledWith('session-1', builtSocket);
    expect(bindTargetMuxTransportSocketLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      host: intent.host,
      ws: builtSocket,
      debugScope: 'connect',
    }));
    expect(sendSocketPayload).not.toHaveBeenCalled();
  });

  it('waits for mux-ready on an open target transport before sending channel-open', () => {
    const targetSocket = { readyState: WebSocket.OPEN } as any;
    const sendSocketPayload = vi.fn();
    const updateSessionTerminalChannelState = vi.fn();

    openSessionMuxChannelByIntentRuntime({
      intent: makeIntent('session-1', 'open-1'),
      readSessionTargetTerminalSocket: () => targetSocket,
      isSessionTargetMuxReady: () => false,
      ensureSessionTerminalChannel: vi.fn(() => ({
        channelId: 'channel-a',
        sessionId: 'session-1',
        sessionName: 'tmux-1',
        targetKey: 'target-a',
        state: 'opening',
        bodySubscribed: true,
        openedAt: 1,
        closedAt: null,
      })),
      updateSessionTerminalChannelState,
      readRequestedTerminalGeometry: () => null,
      sendSocketPayload,
      buildTraversalSocketForHost: vi.fn(),
      primeTargetTerminalTransportSocket: vi.fn(),
      bindTargetMuxTransportSocketLifecycle: vi.fn(),
      runtimeDebug: vi.fn(),
    });

    expect(sendSocketPayload).not.toHaveBeenCalled();
    expect(updateSessionTerminalChannelState).toHaveBeenCalledWith('session-1', 'opening');
  });

  it('queues a stale channel while the shared target transport is connecting without creating another socket', () => {
    const targetSocket = { readyState: WebSocket.CONNECTING } as any;
    const updateSessionTerminalChannelState = vi.fn();
    const buildTraversalSocketForHost = vi.fn();
    const primeTargetTerminalTransportSocket = vi.fn();
    const bindTargetMuxTransportSocketLifecycle = vi.fn();
    const sendSocketPayload = vi.fn();

    openSessionMuxChannelByIntentRuntime({
      intent: makeIntent('session-2', 'open-2'),
      readSessionTargetTerminalSocket: () => targetSocket,
      isSessionTargetMuxReady: () => false,
      ensureSessionTerminalChannel: vi.fn(() => ({
        channelId: 'channel-b',
        sessionId: 'session-2',
        sessionName: 'tmux-1',
        targetKey: 'target-a',
        state: 'open',
        bodySubscribed: false,
        openedAt: 1,
        closedAt: null,
      })),
      updateSessionTerminalChannelState,
      readRequestedTerminalGeometry: () => null,
      sendSocketPayload,
      buildTraversalSocketForHost,
      primeTargetTerminalTransportSocket,
      bindTargetMuxTransportSocketLifecycle,
      runtimeDebug: vi.fn(),
    });

    expect(updateSessionTerminalChannelState).toHaveBeenCalledWith('session-2', 'opening');
    expect(buildTraversalSocketForHost).not.toHaveBeenCalled();
    expect(primeTargetTerminalTransportSocket).not.toHaveBeenCalled();
    expect(bindTargetMuxTransportSocketLifecycle).not.toHaveBeenCalled();
    expect(sendSocketPayload).not.toHaveBeenCalled();
  });

  it('reuses an already-open channel only when the shared target mux is ready', () => {
    const targetSocket = { readyState: WebSocket.OPEN } as any;
    const updateSessionTerminalChannelState = vi.fn();
    const intent = makeIntent('session-1', 'open-1');

    openSessionMuxChannelByIntentRuntime({
      intent,
      readSessionTargetTerminalSocket: () => targetSocket,
      isSessionTargetMuxReady: () => true,
      ensureSessionTerminalChannel: vi.fn(() => ({
        channelId: 'channel-a',
        sessionId: 'session-1',
        sessionName: 'tmux-1',
        targetKey: 'target-a',
        state: 'open',
        bodySubscribed: true,
        openedAt: 1,
        closedAt: null,
      })),
      updateSessionTerminalChannelState,
      readRequestedTerminalGeometry: () => null,
      sendSocketPayload: vi.fn(),
      buildTraversalSocketForHost: vi.fn(),
      primeTargetTerminalTransportSocket: vi.fn(),
      bindTargetMuxTransportSocketLifecycle: vi.fn(),
      runtimeDebug: vi.fn(),
    });

    expect(intent.onConnected).toHaveBeenCalledWith(targetSocket);
    expect(updateSessionTerminalChannelState).not.toHaveBeenCalled();
  });
});

describe('handleReconnectHandshakeFailureRuntime', () => {
  it('keeps retryable reconnect handshake failures out of terminal error projection', () => {
    const reconnectRuntimesRef = {
      current: new Map([
        ['session-1', {
          attempt: 1,
          timer: null,
          nextDelayMs: null,
          connecting: true,
        }],
      ]),
    };
    const updateSessionSync = vi.fn();
    const emitSessionStatus = vi.fn();
    const startReconnectAttempt = vi.fn();

    handleReconnectHandshakeFailureRuntime({
      sessionId: 'session-1',
      message: 'control socket closed before attach',
      retryable: true,
      reconnectRuntimesRef,
      clearSupersededSockets: vi.fn(),
      updateSessionSync,
      emitSessionStatus,
      createSessionReconnectRuntime: () => ({
        attempt: 0,
        timer: null,
        nextDelayMs: null,
        connecting: false,
      }),
      startReconnectAttempt,
    });

    expect(reconnectRuntimesRef.current.get('session-1')).toEqual(expect.objectContaining({
      attempt: 2,
      connecting: false,
    }));
    expect(updateSessionSync).toHaveBeenCalledWith('session-1', {
      state: 'reconnecting',
      lastError: 'control socket closed before attach',
      reconnectAttempt: 2,
      ws: null,
    });
    expect(emitSessionStatus).not.toHaveBeenCalled();
    expect(startReconnectAttempt).toHaveBeenCalledWith('session-1');
  });

  it('projects terminal error only for nonretryable reconnect handshake failures', () => {
    const reconnectRuntimesRef = {
      current: new Map([
        ['session-1', {
          attempt: 1,
          timer: null,
          nextDelayMs: null,
          connecting: true,
        }],
      ]),
    };
    const updateSessionSync = vi.fn();
    const emitSessionStatus = vi.fn();
    const startReconnectAttempt = vi.fn();

    handleReconnectHandshakeFailureRuntime({
      sessionId: 'session-1',
      message: 'auth rejected',
      retryable: false,
      reconnectRuntimesRef,
      clearSupersededSockets: vi.fn(),
      updateSessionSync,
      emitSessionStatus,
      createSessionReconnectRuntime: () => ({
        attempt: 0,
        timer: null,
        nextDelayMs: null,
        connecting: false,
      }),
      startReconnectAttempt,
    });

    expect(reconnectRuntimesRef.current.has('session-1')).toBe(false);
    expect(updateSessionSync).toHaveBeenCalledWith('session-1', {
      state: 'error',
      lastError: 'auth rejected',
    });
    expect(emitSessionStatus).toHaveBeenCalledWith('session-1', 'error', 'auth rejected');
    expect(startReconnectAttempt).not.toHaveBeenCalled();
  });

  it('stops retryable reconnect without terminal error projection after the session becomes inactive', () => {
    const reconnectRuntimesRef = {
      current: new Map([
        ['session-1', {
          attempt: 1,
          timer: null,
          nextDelayMs: null,
          connecting: true,
        }],
      ]),
    };
    const updateSessionSync = vi.fn();
    const emitSessionStatus = vi.fn();
    const startReconnectAttempt = vi.fn();

    handleReconnectHandshakeFailureRuntime({
      sessionId: 'session-1',
      message: "Tmux session unavailable: can't find session: routecodex",
      retryable: true,
      reconnectRuntimesRef,
      clearSupersededSockets: vi.fn(),
      updateSessionSync,
      emitSessionStatus,
      createSessionReconnectRuntime: () => ({
        attempt: 0,
        timer: null,
        nextDelayMs: null,
        connecting: false,
      }),
      shouldContinueRetryableReconnect: () => false,
      startReconnectAttempt,
    });

    expect(reconnectRuntimesRef.current.has('session-1')).toBe(false);
    expect(updateSessionSync).toHaveBeenCalledWith('session-1', {
      state: 'idle',
      lastError: "Tmux session unavailable: can't find session: routecodex",
      reconnectAttempt: 0,
      ws: null,
    });
    expect(emitSessionStatus).not.toHaveBeenCalled();
    expect(startReconnectAttempt).not.toHaveBeenCalled();
  });
});
