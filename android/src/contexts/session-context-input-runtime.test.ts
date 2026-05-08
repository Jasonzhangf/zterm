// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { sendInputThroughSessionTransport } from './session-context-input-runtime';

function createSocket(readyState: number) {
  return {
    readyState,
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
      shouldReconnectQueuedActiveInput: ({ isActiveTarget, wsReadyState, reconnectInFlight }) => (
        isActiveTarget
        && (wsReadyState === WebSocket.CLOSED || wsReadyState === WebSocket.CLOSING || wsReadyState === null)
        && !reconnectInFlight
      ),
      reconnectSession,
    });

    expect(reconnectSession).toHaveBeenCalledWith('session-2');
  });

  it('probes stale-open transport after explicit input even when runtime active pointer is stale', () => {
    const probeOrReconnectStaleSessionTransport = vi.fn();
    const requestSessionBufferHead = vi.fn();
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
      runtimeDebug: vi.fn(),
      readSessionTransportSocket: () => ws,
      isSessionTransportActivityStale: () => true,
      isReconnectInFlight: () => false,
      sendSocketPayload: vi.fn(),
      markPendingInputTailRefresh: vi.fn(),
      readSessionBufferSnapshot: () => ({ revision: 3 }),
      requestSessionBufferHead,
      probeOrReconnectStaleSessionTransport,
      hasPendingSessionTransportOpen: () => false,
      shouldReconnectQueuedActiveInput: () => false,
      reconnectSession: vi.fn(),
    });

    expect(probeOrReconnectStaleSessionTransport).toHaveBeenCalledWith('session-2', ws, 'input');
    expect(requestSessionBufferHead).toHaveBeenCalledWith('session-2', ws, { force: true });
  });

  it('forces a head request immediately after explicit input on an open transport', () => {
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
      markPendingInputTailRefresh,
      readSessionBufferSnapshot: () => ({ revision: 3 }),
      requestSessionBufferHead,
      probeOrReconnectStaleSessionTransport: vi.fn(),
      hasPendingSessionTransportOpen: () => false,
      shouldReconnectQueuedActiveInput: () => false,
      reconnectSession: vi.fn(),
    });

    expect(sendSocketPayload).toHaveBeenCalledTimes(1);
    expect(markPendingInputTailRefresh).toHaveBeenCalledWith('session-2', 3);
    expect(requestSessionBufferHead).toHaveBeenCalledWith('session-2', ws, { force: true });
  });
});
