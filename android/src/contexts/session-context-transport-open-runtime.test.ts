import { describe, expect, it, vi } from 'vitest';
import { queueSessionTransportOpenIntentRuntime } from './session-context-transport-open-runtime';
import type { PendingSessionTransportOpenIntent } from './session-sync-helpers';

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
