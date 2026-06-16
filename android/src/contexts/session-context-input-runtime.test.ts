// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { sendInputThroughSessionTransport } from './session-context-input-runtime';

function createSocket(readyState: number, bufferedAmount = 0) {
  return {
    readyState,
    bufferedAmount,
    close: vi.fn(),
    getDiagnostics: () => ({}),
  } as any;
}

describe('session-context-input-runtime', () => {
  it('reconnects explicit input immediately when transport is unavailable even if runtime active session has not switched yet', () => {
    const reconnectSession = vi.fn();

    sendInputThroughSessionTransport({
      sessionId: 'session-2',
      data: 'ls\r',
      refs: {
        sessionsRef: {
          current: [
            { id: 'session-1' } as any,
            { id: 'session-2' } as any,
          ],
        },
        stateRef: {
          current: { activeSessionId: 'session-1' },
        },
      },
      runtimeDebug: vi.fn(),
      readSessionTransportSocket: () => null,
      isSessionTransportActivityStale: () => false,
      isReconnectInFlight: () => false,
      sendSocketPayload: vi.fn(),
      markPendingInputTailRefresh: vi.fn(),
      readSessionBufferSnapshot: () => ({ revision: 0 }),
      requestSessionBufferHead: vi.fn(),
      probeOrReconnectStaleSessionTransport: vi.fn(),
      hasPendingSessionTransportOpen: () => false,
      isPendingSessionTransportOpenStale: () => false,
      shouldReconnectQueuedActiveInput: ({ isActiveTarget, wsReadyState, reconnectInFlight }) => (
        isActiveTarget
        && (wsReadyState === WebSocket.CLOSED || wsReadyState === WebSocket.CLOSING || wsReadyState === null)
        && !reconnectInFlight
      ),
      reconnectSession,
    });

    expect(reconnectSession).toHaveBeenCalledWith('session-2');
  });

  it('sends explicit input on an open transport even when refresh activity is stale', () => {
    const probeOrReconnectStaleSessionTransport = vi.fn();
    const requestSessionBufferHead = vi.fn();
    const sendSocketPayload = vi.fn();
    const reconnectSession = vi.fn();
    const runtimeDebug = vi.fn();
    const ws = createSocket(WebSocket.OPEN);

    sendInputThroughSessionTransport({
      sessionId: 'session-2',
      data: 'pwd\r',
      refs: {
        sessionsRef: {
          current: [
            { id: 'session-1' } as any,
            { id: 'session-2' } as any,
          ],
        },
        stateRef: {
          current: { activeSessionId: 'session-1' },
        },
      },
      runtimeDebug,
      readSessionTransportSocket: () => ws,
      isSessionTransportActivityStale: () => true,
      isReconnectInFlight: () => false,
      sendSocketPayload,
      markPendingInputTailRefresh: vi.fn(),
      readSessionBufferSnapshot: () => ({ revision: 3 }),
      requestSessionBufferHead,
      probeOrReconnectStaleSessionTransport,
      hasPendingSessionTransportOpen: () => false,
      isPendingSessionTransportOpenStale: () => false,
      shouldReconnectQueuedActiveInput: () => false,
      reconnectSession,
    });

    expect(sendSocketPayload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sendSocketPayload.mock.calls[0][2]).payload).toBe('pwd\r');
    expect(requestSessionBufferHead).not.toHaveBeenCalled();
    expect(probeOrReconnectStaleSessionTransport).toHaveBeenCalledWith('session-2', ws, 'input');
    expect(reconnectSession).not.toHaveBeenCalled();
    expect(runtimeDebug).toHaveBeenCalledWith(
      'session.input.send',
      expect.objectContaining({ sessionId: 'session-2', size: 4, transportStale: true }),
    );
  });

  it('sends explicit input on an open transport even when stale reconnect is already in flight', () => {
    const reconnectSession = vi.fn();
    const sendSocketPayload = vi.fn();
    const ws = createSocket(WebSocket.OPEN);

    sendInputThroughSessionTransport({
      sessionId: 'session-2',
      data: 'x',
      refs: {
        sessionsRef: {
          current: [{ id: 'session-2' } as any],
        },
        stateRef: {
          current: { activeSessionId: 'session-2' },
        },
      },
      runtimeDebug: vi.fn(),
      readSessionTransportSocket: () => ws,
      isSessionTransportActivityStale: () => true,
      isReconnectInFlight: () => true,
      sendSocketPayload,
      markPendingInputTailRefresh: vi.fn(),
      readSessionBufferSnapshot: () => ({ revision: 3 }),
      requestSessionBufferHead: vi.fn(),
      probeOrReconnectStaleSessionTransport: vi.fn(),
      hasPendingSessionTransportOpen: () => false,
      isPendingSessionTransportOpenStale: () => false,
      shouldReconnectQueuedActiveInput: () => false,
      reconnectSession,
    });

    expect(sendSocketPayload).toHaveBeenCalledTimes(1);
    expect(reconnectSession).not.toHaveBeenCalled();
  });

  it('sends input immediately and defers first pending input head refresh off the key event stack', async () => {
    const requestSessionBufferHead = vi.fn();
    const markPendingInputTailRefresh = vi.fn();
    const sendSocketPayload = vi.fn();
    const ws = createSocket(WebSocket.OPEN);

    sendInputThroughSessionTransport({
      sessionId: 'session-2',
      data: 'pwd\r',
      refs: {
        sessionsRef: {
          current: [
            { id: 'session-2' } as any,
          ],
        },
        stateRef: {
          current: { activeSessionId: 'session-2' },
        },
      },
      runtimeDebug: vi.fn(),
      readSessionTransportSocket: () => ws,
      isSessionTransportActivityStale: () => false,
      isReconnectInFlight: () => false,
      sendSocketPayload,
      markPendingInputTailRefresh: vi.fn((sessionId, localRevision) => {
        markPendingInputTailRefresh(sessionId, localRevision);
        return true;
      }),
      readSessionBufferSnapshot: () => ({ revision: 3 }),
      requestSessionBufferHead,
      probeOrReconnectStaleSessionTransport: vi.fn(),
      hasPendingSessionTransportOpen: () => false,
      isPendingSessionTransportOpenStale: () => false,
      shouldReconnectQueuedActiveInput: () => false,
      reconnectSession: vi.fn(),
    });

    expect(sendSocketPayload).toHaveBeenCalledTimes(1);
    expect(markPendingInputTailRefresh).toHaveBeenCalledWith('session-2', 3);
    expect(requestSessionBufferHead).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(requestSessionBufferHead).toHaveBeenCalledWith('session-2', ws, { force: true });
  });

  it('coalesces burst input behind the same pending tail-refresh into one deferred head refresh', async () => {
    const requestSessionBufferHead = vi.fn();
    const sendSocketPayload = vi.fn();
    const ws = createSocket(WebSocket.OPEN);
    let pending = false;

    const send = (data: string) => {
      sendInputThroughSessionTransport({
        sessionId: 'session-2',
        data,
        refs: {
          sessionsRef: {
            current: [
              { id: 'session-2' } as any,
            ],
          },
          stateRef: {
            current: { activeSessionId: 'session-2' },
          },
        },
        runtimeDebug: vi.fn(),
        readSessionTransportSocket: () => ws,
        isSessionTransportActivityStale: () => false,
        isReconnectInFlight: () => false,
        sendSocketPayload,
        markPendingInputTailRefresh: vi.fn(() => {
          const first = !pending;
          pending = true;
          return first;
        }),
        readSessionBufferSnapshot: () => ({ revision: 3 }),
        requestSessionBufferHead,
        probeOrReconnectStaleSessionTransport: vi.fn(),
        hasPendingSessionTransportOpen: () => false,
        isPendingSessionTransportOpenStale: () => false,
        shouldReconnectQueuedActiveInput: () => false,
        reconnectSession: vi.fn(),
      });
    };

    send('a');
    send('b');
    send('c');

    expect(sendSocketPayload).toHaveBeenCalledTimes(3);
    expect(requestSessionBufferHead).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(requestSessionBufferHead).toHaveBeenCalledTimes(1);
  });

  it('retargets deferred input head refresh to the current session transport when the active socket changes before the microtask runs', async () => {
    const sendSocketPayload = vi.fn();
    const oldWs = createSocket(WebSocket.OPEN);
    const newWs = createSocket(WebSocket.OPEN);
    let currentWs = oldWs;
    const requestSessionBufferHead = vi.fn();

    sendInputThroughSessionTransport({
      sessionId: 'session-2',
      data: 'pwd\r',
      refs: {
        sessionsRef: {
          current: [
            { id: 'session-2' } as any,
          ],
        },
        stateRef: {
          current: { activeSessionId: 'session-2' },
        },
      },
      runtimeDebug: vi.fn(),
      readSessionTransportSocket: () => currentWs,
      isSessionTransportActivityStale: () => false,
      isReconnectInFlight: () => false,
      sendSocketPayload,
      markPendingInputTailRefresh: vi.fn(() => true),
      readSessionBufferSnapshot: () => ({ revision: 3 }),
      requestSessionBufferHead,
      probeOrReconnectStaleSessionTransport: vi.fn(),
      hasPendingSessionTransportOpen: () => false,
      isPendingSessionTransportOpenStale: () => false,
      shouldReconnectQueuedActiveInput: () => false,
      reconnectSession: vi.fn(),
    });

    currentWs = newWs;
    await Promise.resolve();

    expect(sendSocketPayload).toHaveBeenCalledTimes(1);
    expect(requestSessionBufferHead).toHaveBeenCalledTimes(1);
    expect(requestSessionBufferHead).toHaveBeenCalledWith('session-2', newWs, { force: true });
    expect(requestSessionBufferHead).not.toHaveBeenCalledWith('session-2', oldWs, { force: true });
  });

  it('does not force another head request while input tail-refresh is already pending', () => {
    const requestSessionBufferHead = vi.fn();
    const markPendingInputTailRefresh = vi.fn(() => false);
    const sendSocketPayload = vi.fn();
    const ws = createSocket(WebSocket.OPEN);

    sendInputThroughSessionTransport({
      sessionId: 'session-2',
      data: 'pwd\r',
      refs: {
        sessionsRef: {
          current: [
            { id: 'session-2' } as any,
          ],
        },
        stateRef: {
          current: { activeSessionId: 'session-2' },
        },
      },
      runtimeDebug: vi.fn(),
      readSessionTransportSocket: () => ws,
      isSessionTransportActivityStale: () => false,
      isReconnectInFlight: () => false,
      sendSocketPayload,
      markPendingInputTailRefresh,
      readSessionBufferSnapshot: () => ({ revision: 3 }),
      requestSessionBufferHead,
      probeOrReconnectStaleSessionTransport: vi.fn(),
      hasPendingSessionTransportOpen: () => false,
      isPendingSessionTransportOpenStale: () => false,
      shouldReconnectQueuedActiveInput: () => false,
      reconnectSession: vi.fn(),
    });

    expect(sendSocketPayload).toHaveBeenCalledTimes(1);
    expect(markPendingInputTailRefresh).toHaveBeenCalledWith('session-2', 3);
    expect(requestSessionBufferHead).not.toHaveBeenCalled();
  });

  it('routes deferred input head refresh through the latest session transport after a tab switch replaces the socket', async () => {
    const requestSessionBufferHead = vi.fn();
    const sendSocketPayload = vi.fn();
    const firstWs = createSocket(WebSocket.OPEN);
    const secondWs = createSocket(WebSocket.OPEN);
    let currentWs = firstWs as any;

    sendInputThroughSessionTransport({
      sessionId: 'session-2',
      data: 'pwd\r',
      refs: {
        sessionsRef: {
          current: [
            { id: 'session-2' } as any,
          ],
        },
        stateRef: {
          current: { activeSessionId: 'session-2' },
        },
      },
      runtimeDebug: vi.fn(),
      readSessionTransportSocket: () => currentWs,
      isSessionTransportActivityStale: () => false,
      isReconnectInFlight: () => false,
      sendSocketPayload,
      markPendingInputTailRefresh: vi.fn(() => true),
      readSessionBufferSnapshot: () => ({ revision: 3 }),
      requestSessionBufferHead,
      probeOrReconnectStaleSessionTransport: vi.fn(),
      hasPendingSessionTransportOpen: () => false,
      isPendingSessionTransportOpenStale: () => false,
      shouldReconnectQueuedActiveInput: () => false,
      reconnectSession: vi.fn(),
    });

    expect(sendSocketPayload).toHaveBeenCalledTimes(1);
    currentWs = secondWs as any;

    await Promise.resolve();
    expect(requestSessionBufferHead).toHaveBeenCalledTimes(1);
    expect(requestSessionBufferHead).toHaveBeenCalledWith('session-2', secondWs, { force: true });
    expect(requestSessionBufferHead).not.toHaveBeenCalledWith('session-2', firstWs, { force: true });
  });

  it('does not enqueue input into a backpressured open transport and forces a fresh transport', () => {
    const runtimeDebug = vi.fn();
    const sendSocketPayload = vi.fn();
    const reconnectSession = vi.fn();
    const requestSessionBufferHead = vi.fn();
    const markPendingInputTailRefresh = vi.fn();
    const ws = createSocket(WebSocket.OPEN, 256_000);

    sendInputThroughSessionTransport({
      sessionId: 'session-2',
      data: 'rm -rf should-not-flush-later\r',
      refs: {
        sessionsRef: {
          current: [
            { id: 'session-2' } as any,
          ],
        },
        stateRef: {
          current: { activeSessionId: 'session-2' },
        },
      },
      runtimeDebug,
      readSessionTransportSocket: () => ws,
      isSessionTransportActivityStale: () => false,
      isReconnectInFlight: () => false,
      sendSocketPayload,
      markPendingInputTailRefresh,
      readSessionBufferSnapshot: () => ({ revision: 3 }),
      requestSessionBufferHead,
      probeOrReconnectStaleSessionTransport: vi.fn(),
      hasPendingSessionTransportOpen: () => false,
      isPendingSessionTransportOpenStale: () => false,
      shouldReconnectQueuedActiveInput: () => false,
      reconnectSession,
    });

    expect(sendSocketPayload).not.toHaveBeenCalled();
    expect(markPendingInputTailRefresh).not.toHaveBeenCalled();
    expect(requestSessionBufferHead).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalledWith(4000, 'input backpressure');
    expect(reconnectSession).toHaveBeenCalledWith('session-2');
    expect(runtimeDebug).toHaveBeenCalledWith(
      'session.input.drop.backpressured-transport',
      expect.objectContaining({
        sessionId: 'session-2',
        size: 30,
        bufferedBytes: 256_000,
      }),
    );
  });

  it('does not cache input behind a pending transport open when the target transport is unavailable', () => {
    const runtimeDebug = vi.fn();
    const reconnectSession = vi.fn();
    const sendSocketPayload = vi.fn();

    sendInputThroughSessionTransport({
      sessionId: 'session-2',
      data: 'date\r',
      refs: {
        sessionsRef: {
          current: [
            { id: 'session-1' } as any,
            { id: 'session-2' } as any,
          ],
        },
        stateRef: {
          current: { activeSessionId: 'session-1' },
        },
      },
      runtimeDebug,
      readSessionTransportSocket: () => null,
      isSessionTransportActivityStale: () => false,
      isReconnectInFlight: () => true,
      sendSocketPayload,
      markPendingInputTailRefresh: vi.fn(),
      readSessionBufferSnapshot: () => ({ revision: 0 }),
      requestSessionBufferHead: vi.fn(),
      probeOrReconnectStaleSessionTransport: vi.fn(),
      hasPendingSessionTransportOpen: () => true,
      isPendingSessionTransportOpenStale: () => false,
      shouldReconnectQueuedActiveInput: () => false,
      reconnectSession,
    });

    expect(sendSocketPayload).not.toHaveBeenCalled();
    expect(reconnectSession).not.toHaveBeenCalled();
    expect(runtimeDebug).toHaveBeenCalledWith(
      'session.input.drop.pending-transport-open',
      expect.objectContaining({ sessionId: 'session-2', size: 5 }),
    );
  });

  it('keeps explicit input reconnect scoped to its own session even when another session is active', () => {
    const reconnectSession = vi.fn();

    sendInputThroughSessionTransport({
      sessionId: 'session-2',
      data: 'whoami\r',
      refs: {
        sessionsRef: {
          current: [
            { id: 'session-1' } as any,
            { id: 'session-2' } as any,
          ],
        },
        stateRef: {
          current: { activeSessionId: 'session-1' },
        },
      },
      runtimeDebug: vi.fn(),
      readSessionTransportSocket: () => null,
      isSessionTransportActivityStale: () => false,
      isReconnectInFlight: () => false,
      sendSocketPayload: vi.fn(),
      markPendingInputTailRefresh: vi.fn(),
      readSessionBufferSnapshot: () => ({ revision: 0 }),
      requestSessionBufferHead: vi.fn(),
      probeOrReconnectStaleSessionTransport: vi.fn(),
      hasPendingSessionTransportOpen: () => true,
      isPendingSessionTransportOpenStale: () => false,
      shouldReconnectQueuedActiveInput: ({ isActiveTarget, reconnectInFlight }) => isActiveTarget && !reconnectInFlight,
      reconnectSession,
    });

    expect(reconnectSession).toHaveBeenCalledTimes(1);
    expect(reconnectSession).toHaveBeenCalledWith('session-2');
    expect(reconnectSession).not.toHaveBeenCalledWith('session-1');
  });

  it('reconnects explicit input immediately when a pending transport open intent is stale', () => {
    const runtimeDebug = vi.fn();
    const reconnectSession = vi.fn();

    sendInputThroughSessionTransport({
      sessionId: 'session-2',
      data: 'hostname\r',
      refs: {
        sessionsRef: {
          current: [
            { id: 'session-1' } as any,
            { id: 'session-2' } as any,
          ],
        },
        stateRef: {
          current: { activeSessionId: 'session-1' },
        },
      },
      runtimeDebug,
      readSessionTransportSocket: () => null,
      isSessionTransportActivityStale: () => false,
      isReconnectInFlight: () => false,
      sendSocketPayload: vi.fn(),
      markPendingInputTailRefresh: vi.fn(),
      readSessionBufferSnapshot: () => ({ revision: 0 }),
      requestSessionBufferHead: vi.fn(),
      probeOrReconnectStaleSessionTransport: vi.fn(),
      hasPendingSessionTransportOpen: () => true,
      isPendingSessionTransportOpenStale: () => true,
      shouldReconnectQueuedActiveInput: () => false,
      reconnectSession,
    });

    expect(reconnectSession).toHaveBeenCalledWith('session-2');
    expect(runtimeDebug).toHaveBeenCalledWith(
      'session.input.reconnect.stale-pending-transport-open',
      expect.objectContaining({ sessionId: 'session-2', size: 9 }),
    );
  });
});

it('anchors stale-open explicit input to an immediate probe instead of passively waiting for lifecycle tick', () => {
  const probeOrReconnectStaleSessionTransport = vi.fn();
  const sendSocketPayload = vi.fn();
  const ws = createSocket(WebSocket.OPEN);

  sendInputThroughSessionTransport({
    sessionId: 'session-2',
    data: 'pwd\r',
    refs: {
      sessionsRef: {
        current: [
          { id: 'session-2' } as any,
        ],
      },
      stateRef: {
        current: { activeSessionId: 'session-2' },
      },
    },
    runtimeDebug: vi.fn(),
    readSessionTransportSocket: () => ws,
    isSessionTransportActivityStale: () => true,
    isReconnectInFlight: () => false,
    sendSocketPayload,
    markPendingInputTailRefresh: vi.fn(),
    readSessionBufferSnapshot: () => ({ revision: 3 }),
    requestSessionBufferHead: vi.fn(),
    probeOrReconnectStaleSessionTransport,
    hasPendingSessionTransportOpen: () => false,
    isPendingSessionTransportOpenStale: () => false,
    shouldReconnectQueuedActiveInput: () => false,
    reconnectSession: vi.fn(),
  });

  expect(sendSocketPayload).toHaveBeenCalledTimes(1);
  expect(probeOrReconnectStaleSessionTransport).toHaveBeenCalledWith('session-2', ws, 'input');
});
