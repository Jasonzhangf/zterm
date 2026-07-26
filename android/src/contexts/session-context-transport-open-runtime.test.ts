import { describe, expect, it, vi } from 'vitest';
import {
  handleReconnectHandshakeFailureRuntime,
  openSessionMuxChannelByIntentRuntime,
  queueSessionTransportOpenIntentRuntime,
} from './session-context-transport-open-runtime';
import type { PendingSessionTransportOpenIntent } from './session-transport-open-helpers';
import { createSessionReconnectStore } from '../lib/session-reconnect-store';

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

function makeDaemonConnection(overrides: Record<string, any> = {}) {
  return {
    readSessionResource: vi.fn(),
    readSessionSocket: vi.fn(() => null),
    readSessionTargetSocket: vi.fn(() => null),
    readOpenSessionSocket: vi.fn(),
    openSessionTargetTransport: vi.fn(),
    sendSessionMessage: vi.fn(() => false),
    sendSessionRaw: vi.fn(() => false),
    ...overrides,
  } as any;
}

describe('queueSessionTransportOpenIntentRuntime', () => {
  it('clears any stale handshake timeout before replacing the pending open intent for the same session', () => {
    const pendingSessionTransportOpenIntentsRef = {
      current: new Map<string, PendingSessionTransportOpenIntent>(),
    };
    const clearSessionHandshakeTimeout = vi.fn();
    const openSessionMuxChannelByIntent = vi.fn();
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
      openSessionMuxChannelByIntent,
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
      openSessionMuxChannelByIntent,
    });

    expect(clearSessionHandshakeTimeout).toHaveBeenCalledTimes(2);
    expect(clearSessionHandshakeTimeout).toHaveBeenNthCalledWith(1, 'session-1');
    expect(clearSessionHandshakeTimeout).toHaveBeenNthCalledWith(2, 'session-1');
    expect(pendingSessionTransportOpenIntentsRef.current.size).toBe(1);
    expect(pendingSessionTransportOpenIntentsRef.current.get('session-1')?.debugScope).toBe('reconnect');
    expect(openSessionMuxChannelByIntent).toHaveBeenCalledTimes(2);
  });

  it('uses the mux opener instead of the legacy control/session-ticket opener', () => {
    const pendingSessionTransportOpenIntentsRef = {
      current: new Map<string, PendingSessionTransportOpenIntent>(),
    };
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
      openSessionMuxChannelByIntent,
    });

    expect(openSessionMuxChannelByIntent).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
    );
  });

  it('fails explicitly when the mux opener is unavailable instead of falling back to legacy session sockets', () => {
    const pendingSessionTransportOpenIntentsRef = {
      current: new Map<string, PendingSessionTransportOpenIntent>(),
    };
    const onHandshakeFailure = vi.fn();
    const finalizeSocketFailureBaseline = vi.fn().mockReturnValue({ shouldContinue: true, manualClosed: false });

    queueSessionTransportOpenIntentRuntime({
      intentOptions: {
        sessionId: 'session-1',
        host: makeHost(),
        debugScope: 'connect',
        onHandshakeFailure,
      },
      clearSessionHandshakeTimeout: vi.fn(),
      finalizeSocketFailureBaseline,
      pendingSessionTransportOpenIntentsRef,
    });

    expect(pendingSessionTransportOpenIntentsRef.current.has('session-1')).toBe(false);
    expect(finalizeSocketFailureBaseline).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      message: 'client.daemon_connection mux opener unavailable',
    }));
    expect(onHandshakeFailure).toHaveBeenCalledWith(
      'client.daemon_connection mux opener unavailable',
      true,
      'handshake',
    );
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
      daemonConnection: makeDaemonConnection({
        readSessionTargetSocket: () => targetSocket,
      }),
      readSessionTargetTerminalSocket: () => targetSocket,
      isSessionTargetMuxReady: () => true,
      ensureSessionTerminalChannel,
      isSessionBodySubscribed: () => false,
      updateSessionTerminalChannelState: vi.fn(),
      readRequestedTerminalGeometry: () => ({ cols: 88, widthMode: 'adaptive-phone' }),
      sendSocketPayload,
      runtimeDebug: vi.fn(),
    });

    expect(ensureSessionTerminalChannel).toHaveBeenCalledWith('session-1', { bodySubscribed: false });
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

  it('opens one target transport through client.daemon_connection when no reusable target transport exists', () => {
    const builtSocket = { readyState: WebSocket.CONNECTING } as any;
    const daemonConnection = makeDaemonConnection({
      openSessionTargetTransport: vi.fn(() => builtSocket),
    });
    const sendSocketPayload = vi.fn();
    const intent = makeIntent('session-1', 'open-1');

    openSessionMuxChannelByIntentRuntime({
      intent,
      daemonConnection,
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
      runtimeDebug: vi.fn(),
    });

    expect(daemonConnection.openSessionTargetTransport).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      host: intent.host,
      debugScope: 'connect',
      finalizeFailure: intent.finalizeFailure,
    }));
    expect(sendSocketPayload).not.toHaveBeenCalled();
  });

  it('waits for mux-ready on an open target transport before sending channel-open', () => {
    const targetSocket = { readyState: WebSocket.OPEN } as any;
    const sendSocketPayload = vi.fn();
    const updateSessionTerminalChannelState = vi.fn();

    openSessionMuxChannelByIntentRuntime({
      intent: makeIntent('session-1', 'open-1'),
      daemonConnection: makeDaemonConnection({
        readSessionTargetSocket: () => targetSocket,
      }),
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
      runtimeDebug: vi.fn(),
    });

    expect(sendSocketPayload).not.toHaveBeenCalled();
    expect(updateSessionTerminalChannelState).toHaveBeenCalledWith('session-1', 'opening');
  });

  it('queues a stale channel while the shared target transport is connecting without creating another socket', () => {
    const targetSocket = { readyState: WebSocket.CONNECTING } as any;
    const updateSessionTerminalChannelState = vi.fn();
    const sendSocketPayload = vi.fn();

    openSessionMuxChannelByIntentRuntime({
      intent: makeIntent('session-2', 'open-2'),
      daemonConnection: makeDaemonConnection({
        readSessionTargetSocket: () => targetSocket,
      }),
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
      runtimeDebug: vi.fn(),
    });

    expect(updateSessionTerminalChannelState).toHaveBeenCalledWith('session-2', 'opening');
    expect(sendSocketPayload).not.toHaveBeenCalled();
  });

  it('reuses an already-open channel only when the shared target mux is ready', () => {
    const targetSocket = { readyState: WebSocket.OPEN } as any;
    const updateSessionTerminalChannelState = vi.fn();
    const intent = makeIntent('session-1', 'open-1');

    openSessionMuxChannelByIntentRuntime({
      intent,
      daemonConnection: makeDaemonConnection({
        readSessionTargetSocket: () => targetSocket,
      }),
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
      runtimeDebug: vi.fn(),
    });

    expect(intent.onConnected).toHaveBeenCalledWith(targetSocket);
    expect(updateSessionTerminalChannelState).not.toHaveBeenCalled();
  });
});

describe('handleReconnectHandshakeFailureRuntime', () => {
  it('keeps retryable reconnect handshake failures out of terminal error projection', () => {
    const reconnectStore = createSessionReconnectStore();
    reconnectStore.write('session-1', {
      phase: 'connecting' as const,
      attempt: 1,
      nextDelayMs: null,
    });
    const updateSessionSync = vi.fn();
    const emitSessionStatus = vi.fn();
    const startReconnectAttempt = vi.fn();

    handleReconnectHandshakeFailureRuntime({
      sessionId: 'session-1',
      message: 'control socket closed before attach',
      retryable: true,
      reconnectStore,
      clearSupersededSockets: vi.fn(),
      updateSessionSync,
      emitSessionStatus,
      startReconnectAttempt,
    });

    expect(reconnectStore.read('session-1')).toEqual(expect.objectContaining({
      phase: 'idle',
      attempt: 2,
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
    const reconnectStore = createSessionReconnectStore();
    reconnectStore.write('session-1', {
      phase: 'connecting' as const,
      attempt: 1,
      nextDelayMs: null,
    });
    const updateSessionSync = vi.fn();
    const emitSessionStatus = vi.fn();
    const startReconnectAttempt = vi.fn();

    handleReconnectHandshakeFailureRuntime({
      sessionId: 'session-1',
      message: 'auth rejected',
      retryable: false,
      reconnectStore,
      clearSupersededSockets: vi.fn(),
      updateSessionSync,
      emitSessionStatus,
      startReconnectAttempt,
    });

    expect(reconnectStore.read('session-1')).toBeNull();
    expect(updateSessionSync).toHaveBeenCalledWith('session-1', {
      state: 'error',
      lastError: 'auth rejected',
    });
    expect(emitSessionStatus).toHaveBeenCalledWith('session-1', 'error', 'auth rejected');
    expect(startReconnectAttempt).not.toHaveBeenCalled();
  });

  it('stops retryable reconnect without terminal error projection after the session becomes inactive', () => {
    const reconnectStore = createSessionReconnectStore();
    reconnectStore.write('session-1', {
      phase: 'connecting' as const,
      attempt: 1,
      nextDelayMs: null,
    });
    const updateSessionSync = vi.fn();
    const emitSessionStatus = vi.fn();
    const startReconnectAttempt = vi.fn();

    handleReconnectHandshakeFailureRuntime({
      sessionId: 'session-1',
      message: "Tmux session unavailable: can't find session: routecodex",
      retryable: true,
      reconnectStore,
      clearSupersededSockets: vi.fn(),
      updateSessionSync,
      emitSessionStatus,
      shouldContinueRetryableReconnect: () => false,
      startReconnectAttempt,
    });

    expect(reconnectStore.read('session-1')).toBeNull();
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
