import { describe, expect, it, vi } from 'vitest';
import {
  bindSessionTransportSocketLifecycle,
  ensureControlTransportForSessionOpen,
  handleControlTransportMessage,
} from './session-context-transport-runtime';
import type { PendingSessionTransportOpenIntent } from './session-sync-helpers';
import type { ServerMessage } from '../lib/types';

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

function makeIntent(
  sessionId: string,
  openRequestId: string,
): PendingSessionTransportOpenIntent {
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

describe('handleControlTransportMessage', () => {
  it('falls back to legacy clientSessionId when matching a session-ticket from older daemon/client wire', () => {
    const pendingSessionTransportOpenIntentsRef = {
      current: new Map<string, PendingSessionTransportOpenIntent>([
        ['session-legacy', makeIntent('session-legacy', 'open-new-1')],
      ]),
    };
    const clearSessionHandshakeTimeout = vi.fn();
    const writeSessionTransportToken = vi.fn();
    const openSessionTransportByIntent = vi.fn();

    handleControlTransportMessage({
      sessionId: 'session-legacy',
      openSessionTransportByIntent,
      pendingSessionTransportOpenIntentsRef,
      clearSessionHandshakeTimeout,
      writeSessionTransportToken,
    }, {
      type: 'session-ticket',
      payload: {
        openRequestId: '',
        clientSessionId: 'session-legacy',
        sessionTransportToken: 'token-legacy',
        sessionName: 'tmux-1',
      },
    } as ServerMessage);

    expect(clearSessionHandshakeTimeout).toHaveBeenCalledWith('session-legacy');
    expect(writeSessionTransportToken).toHaveBeenCalledWith('session-legacy', 'token-legacy');
    expect(openSessionTransportByIntent).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-legacy' }),
    );
    expect(pendingSessionTransportOpenIntentsRef.current.has('session-legacy')).toBe(false);
  });

  it('fans out generic control error to all pending intents on the same target instead of only the anchor session', () => {
    const pendingSessionTransportOpenIntentsRef = {
      current: new Map<string, PendingSessionTransportOpenIntent>([
        ['session-1', makeIntent('session-1', 'open-1')],
        ['session-2', makeIntent('session-2', 'open-2')],
      ]),
    };
    const failPendingControlTargetIntents = vi.fn();

    handleControlTransportMessage({
      sessionId: 'session-1',
      openSessionTransportByIntent: null,
      pendingSessionTransportOpenIntentsRef,
      clearSessionHandshakeTimeout: vi.fn(),
      writeSessionTransportToken: vi.fn(),
      failPendingControlTargetIntents,
    }, {
      type: 'error',
      payload: {
        message: 'control transport error',
        code: 'control_failed',
      },
    } as ServerMessage);

    expect(failPendingControlTargetIntents).toHaveBeenCalledWith(
      'session-1',
      'control transport error',
      true,
    );
    expect(pendingSessionTransportOpenIntentsRef.current.size).toBe(2);
  });
});

describe('bindSessionTransportSocketLifecycle', () => {
  it('ignores late events from a socket that is no longer the current active transport for the session', () => {
    const staleWs = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      getDiagnostics: () => ({ reason: 'stale socket' }),
    } as any;
    const currentWs = {
      getDiagnostics: () => ({ reason: 'current socket' }),
    } as any;
    const handleSocketServerMessage = vi.fn();
    const recordSessionRx = vi.fn();
    const finalizeFailure = vi.fn();

    bindSessionTransportSocketLifecycle({
      sessionId: 'session-1',
      host: makeHost(),
      resolvedSessionName: 'tmux-1',
      ws: staleWs,
      debugScope: 'reconnect',
      readActiveSessionId: () => 'session-1',
      readSessionTransportSocket: () => currentWs,
      sendSocketPayload: vi.fn(),
      connectMessagePayload: {
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'tmux-1',
      } as any,
      runtimeDebug: vi.fn(),
      flushRuntimeDebugLogs: vi.fn(),
      startSocketHeartbeat: vi.fn(),
      applyTransportDiagnostics: vi.fn(),
      clearSessionHandshakeTimeout: vi.fn(),
      setSessionHandshakeTimeout: vi.fn(),
      recordSessionRx,
      handleSocketServerMessage,
      finalizeFailure,
      onConnected: vi.fn(),
      sessionHandshakeTimeoutMs: 5000,
    });

    staleWs.onmessage?.({ data: JSON.stringify({ type: 'connected', payload: { sessionId: 'session-1' } }) });
    staleWs.onerror?.();
    staleWs.onclose?.();

    expect(recordSessionRx).not.toHaveBeenCalled();
    expect(handleSocketServerMessage).not.toHaveBeenCalled();
    expect(finalizeFailure).not.toHaveBeenCalled();
  });
});

describe('ensureControlTransportForSessionOpen', () => {
  it('reopens a stale connecting control transport instead of leaving new session opens hanging forever', () => {
    const intent = {
      ...makeIntent('session-1', 'open-1'),
      hostConfigPayload: {
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'tmux-1',
        openRequestId: 'open-1',
      },
    };
    const connectingSocket = {
      readyState: WebSocket.CONNECTING,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      close: vi.fn(),
      getDiagnostics: () => ({ reason: 'stuck connecting' }),
    } as any;
    const replacementSocket = {
      readyState: WebSocket.CONNECTING,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      close: vi.fn(),
      getDiagnostics: () => ({ reason: '' }),
    } as any;

    let currentSocket: any = connectingSocket;
    const setSessionHandshakeTimeout = vi.fn((_sessionId: string, callback: () => void) => {
      callback();
      return 1;
    });
    const buildTraversalSocketForHost = vi.fn(() => {
      currentSocket = replacementSocket;
      return replacementSocket;
    });
    const writeSessionTargetControlSocket = vi.fn((_sessionId: string, socket: any | null) => {
      currentSocket = socket;
    });

    ensureControlTransportForSessionOpen({
      intent: intent as any,
      readSessionTargetControlSocket: () => currentSocket,
      readSessionTargetRuntime: () => ({ sessionIds: ['session-1'] }),
      readSessionTargetKey: () => 'daemon:host-1',
      pendingSessionTransportOpenIntentsRef: { current: new Map([['session-1', intent]]) },
      sendSocketPayload: vi.fn(),
      clearSessionHandshakeTimeout: vi.fn(),
      setSessionHandshakeTimeout,
      failPendingControlTargetIntents: vi.fn(),
      buildTraversalSocketForHost,
      writeSessionTargetControlSocket,
      applyTransportDiagnostics: vi.fn(),
      runtimeDebug: vi.fn(),
      recordControlTransportRxBytes: vi.fn(),
      handleControlTransportMessage: vi.fn(),
      cleanupControlSocket: vi.fn((_sessionId: string, shouldClose?: boolean) => {
        if (shouldClose) {
          currentSocket?.close?.();
        }
        currentSocket = null;
      }),
      sessionHandshakeTimeoutMs: 10,
    });

    expect(setSessionHandshakeTimeout).toHaveBeenCalled();
    expect(connectingSocket.close).toHaveBeenCalled();
    expect(buildTraversalSocketForHost).toHaveBeenCalledTimes(1);
    expect(writeSessionTargetControlSocket).toHaveBeenCalledWith('session-1', replacementSocket);
  });
});
