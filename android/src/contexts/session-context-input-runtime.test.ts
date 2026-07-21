// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TERMINAL_INPUT_CHUNK_BYTES,
  getTerminalInputUtf8ByteLength,
} from '@zterm/shared/terminal/input-chunking';
import {
  handleTerminalInputAck,
  resetTerminalReliableInputRuntimeForTests,
  sendInputThroughSessionTransport,
  TERMINAL_RELIABLE_INPUT_RETRY_MS,
} from './session-context-input-runtime';

function createSocket(readyState: number, bufferedAmount = 0) {
  return {
    readyState,
    bufferedAmount,
    close: vi.fn(),
    getDiagnostics: () => ({}),
  } as any;
}

function createResource(
  sessionId: string,
  socket: any = null,
  channel: ReturnType<Parameters<typeof sendInputThroughSessionTransport>[0]['readSessionTransportResource']>['channel'] = null,
) {
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
    terminalSocket: null,
    channel,
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

afterEach(() => {
  resetTerminalReliableInputRuntimeForTests();
  vi.useRealTimers();
});

function parseSentInputPayloads(sendSocketPayload: ReturnType<typeof vi.fn>) {
  return sendSocketPayload.mock.calls.map((call) => {
    const message = JSON.parse(String(call[2]));
    expect(message.type).toBe('input');
    expect(typeof message.payload).toBe('string');
    return String(message.payload);
  });
}

function parseSentReliableInputPayload(sendSocketPayload: ReturnType<typeof vi.fn>, index = 0) {
  const message = JSON.parse(String(sendSocketPayload.mock.calls[index]![2]));
  expect(message.type).toBe('input');
  expect(typeof message.payload).toBe('object');
  expect(message.payload).toMatchObject({
    version: 1,
    seq: expect.any(String),
    data: expect.any(String),
    sentAt: expect.any(Number),
    attempt: expect.any(Number),
  });
  return message.payload as {
    version: 1;
    seq: string;
    data: string;
    sentAt: number;
    attempt: number;
  };
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

  it('uses reliable seq ack retry only after the connected daemon advertises support', () => {
    vi.useFakeTimers();
    const sendSocketPayload = vi.fn();

    sendInput({
      refs: {
        sessionsRef: { current: [{ id: 'session-2', reliableInputSupported: true } as any] },
        stateRef: { current: { activeSessionId: 'session-2' } },
      },
      sendSocketPayload,
    });

    expect(sendSocketPayload).toHaveBeenCalledTimes(1);
    const first = parseSentReliableInputPayload(sendSocketPayload);
    expect(first).toMatchObject({
      data: 'pwd\r',
      attempt: 1,
    });

    vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_RETRY_MS);
    expect(sendSocketPayload).toHaveBeenCalledTimes(2);
    const retry = parseSentReliableInputPayload(sendSocketPayload, 1);
    expect(retry).toMatchObject({
      seq: first.seq,
      data: 'pwd\r',
      attempt: 2,
    });

    handleTerminalInputAck('session-2', {
      version: 1,
      seq: first.seq,
      accepted: true,
      bytes: 4,
    });
    vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_RETRY_MS * 2);
    expect(sendSocketPayload).toHaveBeenCalledTimes(2);
  });

  it('does not send the next reliable chunk until the daemon acks the current chunk', () => {
    vi.useFakeTimers();
    const sendSocketPayload = vi.fn();
    const longInput = `${'a'.repeat(TERMINAL_INPUT_CHUNK_BYTES - 3)}中文😀${'b'.repeat(128)}`;

    sendInput({
      data: longInput,
      refs: {
        sessionsRef: { current: [{ id: 'session-2', reliableInputSupported: true } as any] },
        stateRef: { current: { activeSessionId: 'session-2' } },
      },
      sendSocketPayload,
    });

    expect(sendSocketPayload).toHaveBeenCalledTimes(1);
    const first = parseSentReliableInputPayload(sendSocketPayload);
    expect(first.data.length).toBeLessThan(longInput.length);

    handleTerminalInputAck('session-2', {
      version: 1,
      seq: first.seq,
      accepted: true,
      bytes: getTerminalInputUtf8ByteLength(first.data),
    });

    expect(sendSocketPayload).toHaveBeenCalledTimes(2);
    const second = parseSentReliableInputPayload(sendSocketPayload, 1);
    expect(second.seq).not.toBe(first.seq);
    expect(first.data + second.data).toBe(longInput);
  });

  it('queues reliable input while the transport is not open and sends it when the same transport owner becomes open', () => {
    vi.useFakeTimers();
    const sendSocketPayload = vi.fn();
    let currentWs: any = null;

    sendInput({
      refs: {
        sessionsRef: { current: [{ id: 'session-2', reliableInputSupported: true } as any] },
        stateRef: { current: { activeSessionId: 'session-2' } },
      },
      readSessionTransportResource: (sessionId) => createResource(sessionId, currentWs),
      readSessionTransportSocket: () => currentWs,
      hasPendingSessionTransportOpen: () => true,
      sendSocketPayload,
    });

    expect(sendSocketPayload).not.toHaveBeenCalled();
    currentWs = createSocket(WebSocket.OPEN);
    vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_RETRY_MS);

    expect(sendSocketPayload).toHaveBeenCalledTimes(1);
    expect(parseSentReliableInputPayload(sendSocketPayload)).toMatchObject({
      data: 'pwd\r',
      attempt: 1,
    });
  });

  it('keeps reliable input queued after a retryable daemon nack and resends the same seq', () => {
    vi.useFakeTimers();
    const sendSocketPayload = vi.fn();

    sendInput({
      refs: {
        sessionsRef: { current: [{ id: 'session-2', reliableInputSupported: true } as any] },
        stateRef: { current: { activeSessionId: 'session-2' } },
      },
      sendSocketPayload,
    });

    const first = parseSentReliableInputPayload(sendSocketPayload);
    handleTerminalInputAck('session-2', {
      version: 1,
      seq: first.seq,
      accepted: false,
      bytes: 4,
      error: 'input_stale_transport',
    });

    vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_RETRY_MS);
    expect(sendSocketPayload).toHaveBeenCalledTimes(2);
    expect(parseSentReliableInputPayload(sendSocketPayload, 1)).toMatchObject({
      seq: first.seq,
      data: 'pwd\r',
      attempt: 2,
    });
  });

  it('drops non-retryable reliable input nack to avoid writing invalid payloads forever', () => {
    vi.useFakeTimers();
    const sendSocketPayload = vi.fn();

    sendInput({
      refs: {
        sessionsRef: { current: [{ id: 'session-2', reliableInputSupported: true } as any] },
        stateRef: { current: { activeSessionId: 'session-2' } },
      },
      sendSocketPayload,
    });

    const first = parseSentReliableInputPayload(sendSocketPayload);
    handleTerminalInputAck('session-2', {
      version: 1,
      seq: first.seq,
      accepted: false,
      bytes: 0,
      error: 'input_invalid',
    });

    vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_RETRY_MS * 2);
    expect(sendSocketPayload).toHaveBeenCalledTimes(1);
  });

  it('chunks long input into ordered string-only frames under the daemon payload cap', () => {
    const sendSocketPayload = vi.fn();
    const longInput = `${'a'.repeat(TERMINAL_INPUT_CHUNK_BYTES - 3)}中文😀${'b'.repeat(128)}`;

    sendInput({
      data: longInput,
      sendSocketPayload,
    });

    const payloads = parseSentInputPayloads(sendSocketPayload);
    expect(payloads.length).toBeGreaterThan(1);
    expect(payloads.join('')).toBe(longInput);
    for (const payload of payloads) {
      expect(getTerminalInputUtf8ByteLength(payload)).toBeLessThanOrEqual(TERMINAL_INPUT_CHUNK_BYTES);
    }
  });

  it('keeps unicode code points intact when chunking long input frames', () => {
    const sendSocketPayload = vi.fn();
    const longInput = `${'界'.repeat(Math.ceil(TERMINAL_INPUT_CHUNK_BYTES / 3) + 3)}😀tail\r`;

    sendInput({
      data: longInput,
      sendSocketPayload,
    });

    const payloads = parseSentInputPayloads(sendSocketPayload);
    expect(payloads.length).toBeGreaterThan(1);
    expect(payloads.join('')).toBe(longInput);
    for (const payload of payloads) {
      const first = payload.charCodeAt(0);
      const last = payload.charCodeAt(payload.length - 1);
      expect(first < 0xdc00 || first > 0xdfff).toBe(true);
      expect(last < 0xd800 || last > 0xdbff).toBe(true);
      expect(getTerminalInputUtf8ByteLength(payload)).toBeLessThanOrEqual(TERMINAL_INPUT_CHUNK_BYTES);
    }
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

  it('does not send terminal input while a mux channel is still opening on an open target socket', () => {
    const resourceWs = createSocket(WebSocket.OPEN);
    const sendSocketPayload = vi.fn();
    const runtimeDebug = vi.fn();

    sendInput({
      runtimeDebug,
      readSessionTransportResource: (sessionId) => createResource(sessionId, resourceWs, {
        channelId: 'channel-b',
        sessionId,
        sessionName: 'tmux-b',
        targetKey: 'target-a',
        state: 'opening',
        bodySubscribed: true,
        openedAt: 1,
        closedAt: null,
      }),
      readSessionTransportSocket: () => null,
      sendSocketPayload,
      hasPendingSessionTransportOpen: () => true,
    });

    expect(sendSocketPayload).not.toHaveBeenCalled();
    expect(runtimeDebug).toHaveBeenCalledWith(
      'session.input.drop.pending-transport-open',
      expect.objectContaining({
        sessionId: 'session-2',
        resourceSocketState: 'open',
      }),
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
