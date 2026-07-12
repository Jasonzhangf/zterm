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

function createResource(sessionId: string, socket: any = null) {
  return {
    sessionId,
    runtime: null,
    targetRuntime: null,
    targetKey: '100.64.0.1:3333:',
    host: null,
    socket,
    socketReadyState: socket?.readyState ?? null,
    socketState: socket
      ? (socket.readyState === WebSocket.OPEN ? 'open' : 'unknown')
      : 'missing',
    controlSocket: null,
    requestedTerminalGeometry: null,
  } as const;
}

function sendInput(overrides: Partial<Parameters<typeof sendInputThroughSessionTransport>[0]> = {}) {
  const ws = overrides.readSessionTransportSocket?.('session-2') ?? createSocket(WebSocket.OPEN);
  const options: Parameters<typeof sendInputThroughSessionTransport>[0] = {
    sessionId: 'session-2',
    data: 'pwd\r',
    refs: {
      sessionsRef: { current: [{ id: 'session-2' } as any] },
      stateRef: { current: { activeSessionId: 'session-2' } },
    },
    runtimeDebug: vi.fn(),
    readSessionTransportResource: (sessionId) => createResource(sessionId, ws),
    readSessionTransportSocket: () => ws,
    isReconnectInFlight: () => false,
    sendSocketPayload: vi.fn(),
    markPendingInputTailRefresh: vi.fn(() => true),
    readSessionBufferSnapshot: () => ({ revision: 3 }),
    requestSessionBufferHead: vi.fn(),
    hasPendingSessionTransportOpen: () => false,
    isPendingSessionTransportOpenStale: () => false,
    ...overrides,
  };
  sendInputThroughSessionTransport(options);
  return options;
}

describe('session-context-input-runtime', () => {
  it('sends input on an open transport without consulting reconnect policy', () => {
    const sendSocketPayload = vi.fn();
    const options = sendInput({ sendSocketPayload });

    expect(sendSocketPayload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(sendSocketPayload.mock.calls[0]![2]))).toEqual({
      type: 'input',
      payload: 'pwd\r',
    });
    expect(options.requestSessionBufferHead).not.toHaveBeenCalled();
  });

  it('defers the first pending input head refresh off the key event stack', async () => {
    const requestSessionBufferHead = vi.fn();
    const ws = createSocket(WebSocket.OPEN);
    sendInput({
      readSessionTransportSocket: () => ws,
      requestSessionBufferHead,
    });

    expect(requestSessionBufferHead).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(requestSessionBufferHead).toHaveBeenCalledWith('session-2', ws, { force: true });
  });

  it('coalesces burst input behind the same pending tail refresh into one deferred head refresh', async () => {
    const requestSessionBufferHead = vi.fn();
    const sendSocketPayload = vi.fn();
    const ws = createSocket(WebSocket.OPEN);
    let pending = false;
    const markPendingInputTailRefresh = vi.fn(() => {
      const first = !pending;
      pending = true;
      return first;
    });

    sendInput({
      data: 'a',
      readSessionTransportSocket: () => ws,
      sendSocketPayload,
      markPendingInputTailRefresh,
      requestSessionBufferHead,
    });
    sendInput({
      data: 'b',
      readSessionTransportSocket: () => ws,
      sendSocketPayload,
      markPendingInputTailRefresh,
      requestSessionBufferHead,
    });

    expect(sendSocketPayload).toHaveBeenCalledTimes(2);
    expect(requestSessionBufferHead).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(requestSessionBufferHead).toHaveBeenCalledTimes(1);
  });

  it('retargets deferred input head refresh to the current session transport', async () => {
    const oldWs = createSocket(WebSocket.OPEN);
    const newWs = createSocket(WebSocket.OPEN);
    let currentWs = oldWs;
    const requestSessionBufferHead = vi.fn();

    sendInput({
      readSessionTransportResource: (sessionId) => createResource(sessionId, currentWs),
      readSessionTransportSocket: () => currentWs,
      requestSessionBufferHead,
    });
    currentWs = newWs;

    await Promise.resolve();
    expect(requestSessionBufferHead).toHaveBeenCalledWith('session-2', newWs, { force: true });
    expect(requestSessionBufferHead).not.toHaveBeenCalledWith('session-2', oldWs, { force: true });
  });

  it('uses the transport resource socket even when direct socket accessor is stale', () => {
    const resourceWs = createSocket(WebSocket.OPEN);
    const sendSocketPayload = vi.fn();

    sendInput({
      refs: {
        sessionsRef: { current: [{ id: 'session-2' } as any] },
        stateRef: { current: { activeSessionId: 'session-1' } },
      },
      readSessionTransportResource: (sessionId) => createResource(sessionId, resourceWs),
      readSessionTransportSocket: () => null,
      sendSocketPayload,
    });

    expect(sendSocketPayload).toHaveBeenCalledWith(
      'session-2',
      resourceWs,
      JSON.stringify({ type: 'input', payload: 'pwd\r' }),
    );
  });

  it('does not enqueue input into a backpressured open transport and does not call reconnect directly', () => {
    const runtimeDebug = vi.fn();
    const sendSocketPayload = vi.fn();
    const requestSessionBufferHead = vi.fn();
    const markPendingInputTailRefresh = vi.fn();
    const ws = createSocket(WebSocket.OPEN, 256_000);

    sendInput({
      data: 'rm -rf should-not-flush-later\r',
      runtimeDebug,
      readSessionTransportSocket: () => ws,
      sendSocketPayload,
      markPendingInputTailRefresh,
      requestSessionBufferHead,
    });

    expect(sendSocketPayload).not.toHaveBeenCalled();
    expect(markPendingInputTailRefresh).not.toHaveBeenCalled();
    expect(requestSessionBufferHead).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalledWith(4000, 'input backpressure');
    expect(runtimeDebug).toHaveBeenCalledWith(
      'session.input.drop.backpressured-transport',
      expect.objectContaining({ sessionId: 'session-2', bufferedBytes: 256_000 }),
    );
  });

  it('drops input while a pending transport open exists, including stale pending intents', () => {
    const runtimeDebug = vi.fn();
    const sendSocketPayload = vi.fn();

    sendInput({
      runtimeDebug,
      readSessionTransportResource: (sessionId) => createResource(sessionId, null),
      readSessionTransportSocket: () => null,
      sendSocketPayload,
      hasPendingSessionTransportOpen: () => true,
      isPendingSessionTransportOpenStale: () => true,
    });

    expect(sendSocketPayload).not.toHaveBeenCalled();
    expect(runtimeDebug).toHaveBeenCalledWith(
      'session.input.drop.pending-transport-open',
      expect.objectContaining({
        sessionId: 'session-2',
        pendingTransportOpenStale: true,
        resourceSocketState: 'missing',
      }),
    );
  });

  it('reports transport unavailable without creating a replacement websocket', () => {
    const runtimeDebug = vi.fn();
    const sendSocketPayload = vi.fn();

    sendInput({
      runtimeDebug,
      readSessionTransportResource: (sessionId) => createResource(sessionId, null),
      readSessionTransportSocket: () => null,
      sendSocketPayload,
    });

    expect(sendSocketPayload).not.toHaveBeenCalled();
    expect(runtimeDebug).toHaveBeenCalledWith(
      'session.input.transport-unavailable',
      expect.objectContaining({
        sessionId: 'session-2',
        why: 'transport-unavailable',
      }),
    );
  });
});
