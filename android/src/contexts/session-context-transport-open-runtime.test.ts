import { describe, expect, it, vi } from 'vitest';
import {
  handleReconnectHandshakeFailureRuntime,
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
});
