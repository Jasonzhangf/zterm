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
  TERMINAL_RELIABLE_INPUT_ACK_TIMEOUT_MS,
  TERMINAL_RELIABLE_INPUT_RETRY_MS,
} from './session-context-input-runtime';
import type { ClientDaemonConnection } from '../lib/client-daemon-connection';

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
  channel: any = null,
  targetRuntime: any = null,
) {
  return {
    sessionId,
    runtime: null,
    targetRuntime,
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

function createDaemonConnection(
  resourceFactory: (sessionId: string) => ReturnType<typeof createResource>,
) {
  return {
    readSessionResource: vi.fn((sessionId: string) => resourceFactory(sessionId)),
    readSessionSocket: vi.fn((sessionId: string) => resourceFactory(sessionId).socket || null),
    readSessionTargetSocket: vi.fn((sessionId: string) => resourceFactory(sessionId).terminalSocket || resourceFactory(sessionId).socket || null),
    readOpenSessionSocket: vi.fn((sessionId: string) => resourceFactory(sessionId).socket || null),
    sendSessionRaw: vi.fn(),
    sendSessionMessage: vi.fn(),
  } as unknown as ClientDaemonConnection;
}

function createDaemonConnectionForSocket(
  socket: any,
  channel: any = null,
) {
  return createDaemonConnection((sessionId) => createResource(sessionId, socket, channel));
}

function sendInput(overrides: Partial<Parameters<typeof sendInputThroughSessionTransport>[0]> = {}) {
  const ws = createSocket(WebSocket.OPEN);
  const options: Parameters<typeof sendInputThroughSessionTransport>[0] = {
    sessionId: 'session-2',
    data: 'pwd\r',
    refs: {
      sessionsRef: { current: [{ id: 'session-2' } as any] },
      stateRef: { current: { activeSessionId: 'session-2' } },
    },
    runtimeDebug: vi.fn(),
    daemonConnection: createDaemonConnectionForSocket(ws),
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

  it('waits for reliable input ack without timer-based duplicate sends', () => {
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

    vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_RETRY_MS * 5);
    expect(sendSocketPayload).toHaveBeenCalledTimes(1);

    handleTerminalInputAck('session-2', {
      version: 1,
      seq: first.seq,
      accepted: true,
      bytes: 4,
    });
    vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_RETRY_MS * 2);
    expect(sendSocketPayload).toHaveBeenCalledTimes(1);
  });

  it('retries the same reliable input seq after the ack timeout', () => {
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
    vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_ACK_TIMEOUT_MS - 1);
    expect(sendSocketPayload).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(sendSocketPayload).toHaveBeenCalledTimes(2);
    expect(parseSentReliableInputPayload(sendSocketPayload, 1)).toMatchObject({
      seq: first.seq,
      data: 'pwd\r',
      attempt: 2,
    });
  });

  it('retries the same reliable input seq when the physical transport changes on the same route', () => {
    vi.useFakeTimers();
    const sendSocketPayload = vi.fn();
    const oldWs = createSocket(WebSocket.OPEN);
    const newWs = createSocket(WebSocket.OPEN);
    let currentWs = oldWs;

    sendInput({
      refs: {
        sessionsRef: { current: [{ id: 'session-2', reliableInputSupported: true } as any] },
        stateRef: { current: { activeSessionId: 'session-2' } },
      },
      daemonConnection: createDaemonConnection((sessionId) => createResource(sessionId, currentWs)),
      sendSocketPayload,
    });

    expect(sendSocketPayload).toHaveBeenCalledTimes(1);
    const first = parseSentReliableInputPayload(sendSocketPayload);
    currentWs = newWs;
    vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_RETRY_MS);

    expect(sendSocketPayload).toHaveBeenCalledTimes(2);
    expect(parseSentReliableInputPayload(sendSocketPayload, 1)).toMatchObject({
      seq: first.seq,
      data: 'pwd\r',
      attempt: 2,
    });
  });

  it('does not retry reliable input when only route configuration changes under the same socket', () => {
    vi.useFakeTimers();
    const sendSocketPayload = vi.fn();
    const ws = createSocket(WebSocket.OPEN);
    let routeGeneration = 0;

    sendInput({
      refs: {
        sessionsRef: { current: [{ id: 'session-2', reliableInputSupported: true } as any] },
        stateRef: { current: { activeSessionId: 'session-2' } },
      },
      daemonConnection: createDaemonConnection((sessionId) => createResource(
        sessionId,
        ws,
        null,
        { routeGeneration },
      )),
      sendSocketPayload,
    });

    expect(sendSocketPayload).toHaveBeenCalledTimes(1);
    routeGeneration = 1;
    vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_RETRY_MS);

    expect(sendSocketPayload).toHaveBeenCalledTimes(1);
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
      daemonConnection: createDaemonConnection((sessionId) => createResource(sessionId, currentWs)),
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
      daemonConnection: createDaemonConnectionForSocket(ws),
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
      daemonConnection: createDaemonConnectionForSocket(ws),
      sendSocketPayload,
      markPendingInputTailRefresh,
      requestSessionBufferHead,
    });
    sendInput({
      data: 'b',
      daemonConnection: createDaemonConnectionForSocket(ws),
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
      daemonConnection: createDaemonConnection((sessionId) => createResource(sessionId, currentWs)),
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
      daemonConnection: createDaemonConnectionForSocket(resourceWs),
      sendSocketPayload,
    });

    expect(sendSocketPayload).toHaveBeenCalledWith(
      'session-2',
      resourceWs,
      JSON.stringify({ type: 'input', payload: 'pwd\r' }),
    );
  });

  it('uses client.daemon_connection before raw socket accessors for terminal input', () => {
    const daemonSocket = createSocket(WebSocket.OPEN);
    const staleSocket = createSocket(WebSocket.OPEN);
    const sendSocketPayload = vi.fn();
    const readSessionResource = vi.fn((sessionId) => createResource(sessionId, staleSocket));
    const readSessionSocket = vi.fn(() => daemonSocket);

    sendInputThroughSessionTransport({
      sessionId: 'session-2',
      data: 'pwd\r',
      refs: {
        sessionsRef: { current: [{ id: 'session-2' } as any] },
        stateRef: { current: { activeSessionId: 'session-2' } },
      },
      runtimeDebug: vi.fn(),
      daemonConnection: {
        readSessionResource,
        readSessionSocket,
        readOpenSessionSocket: () => daemonSocket,
        sendSessionMessage: vi.fn(),
        sendSessionRaw: vi.fn(),
      } as any,
      isReconnectInFlight: () => false,
      sendSocketPayload,
      markPendingInputTailRefresh: vi.fn(() => false),
      readSessionBufferSnapshot: () => ({ revision: 3 }),
      requestSessionBufferHead: vi.fn(),
      hasPendingSessionTransportOpen: () => false,
      isPendingSessionTransportOpenStale: () => false,
    });

    expect(sendSocketPayload).toHaveBeenCalledWith(
      'session-2',
      daemonSocket,
      JSON.stringify({ type: 'input', payload: 'pwd\r' }),
    );
    expect(readSessionResource).toHaveBeenCalledWith('session-2');
    expect(readSessionSocket).toHaveBeenCalledWith('session-2');
  });

  it('does not send terminal input while a mux channel is still opening on an open target socket', () => {
    const resourceWs = createSocket(WebSocket.OPEN);
    const sendSocketPayload = vi.fn();
    const runtimeDebug = vi.fn();

    sendInput({
      runtimeDebug,
      daemonConnection: createDaemonConnection((sessionId) => createResource(sessionId, resourceWs, {
        channelId: 'channel-b',
        sessionId,
        sessionName: 'tmux-b',
        targetKey: 'target-a',
        state: 'opening',
        bodySubscribed: true,
        openedAt: 1,
        closedAt: null,
      })),
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
      daemonConnection: createDaemonConnectionForSocket(ws),
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
      daemonConnection: createDaemonConnection((sessionId) => createResource(sessionId, null)),
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
      daemonConnection: createDaemonConnection((sessionId) => createResource(sessionId, null)),
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

  // 2026-08-09 BUG #2: backpressure close 后 reliable 协议路径立即 retry 死循环
  // 红测预期：close 后 retry 必须有指数 backoff（至少 100ms 起步，封顶 2000ms）
  describe('long-voice-commit input backpressure resilience (BUG #2/#3 regression)', () => {
    it('applies exponential backoff after a reliable backpressure close, not immediate retry', () => {
      vi.useFakeTimers();
      const sendSocketPayload = vi.fn();
      // long input forces backpressure close once bufferedAmount >= 128KB
      const bigInput = 'a'.repeat(200 * 1024);
      const ws = createSocket(WebSocket.OPEN, 130 * 1024); // already past threshold

      sendInputThroughSessionTransport({
        sessionId: 'session-backpressure',
        data: bigInput,
        refs: {
          sessionsRef: { current: [{ id: 'session-backpressure', reliableInputSupported: true } as any] },
          stateRef: { current: { activeSessionId: 'session-backpressure' } },
        },
        runtimeDebug: vi.fn(),
        daemonConnection: createDaemonConnectionForSocket(ws),
        isReconnectInFlight: () => false,
        sendSocketPayload,
        markPendingInputTailRefresh: vi.fn(() => true),
        readSessionBufferSnapshot: () => ({ revision: 3 }),
        requestSessionBufferHead: vi.fn(),
        hasPendingSessionTransportOpen: () => false,
        isPendingSessionTransportOpenStale: () => false,
      });

      expect(ws.close).toHaveBeenCalledWith(4000, 'input backpressure');

      // CRITICAL: immediately advancing time by TERMINAL_RELIABLE_INPUT_RETRY_MS
      // (which is typically 50-200ms) MUST NOT trigger another retry / close cycle
      // while bufferedAmount is still over threshold.
      // 红测：第一次 retry 必须至少延迟 100ms，且再次 retry 必须 backoff
      const initialRetryDelay = TERMINAL_RELIABLE_INPUT_RETRY_MS;
      const fastRetryWindowMs = initialRetryDelay; // first allowed retry window

      // ws stays backpressured
      ws.readyState = WebSocket.CLOSED;
      // schedule retry fires within the first retry window — bufferedAmount stays high
      vi.advanceTimersByTime(fastRetryWindowMs);

      // 红测断言：retry 不应该再次调用 ws.close (死循环)
      // 如果当前实现立即 retry，会再次触发 close / 死循环
      expect(ws.close.mock.calls.length).toBeLessThanOrEqual(1);
    });

    it('does not re-send a backpressure-closed input within the first retry window (BUG #2 strict)', () => {
      vi.useFakeTimers();
      const sendSocketPayload = vi.fn();
      // long input forces backpressure close once bufferedAmount >= 128KB
      const bigInput = 'a'.repeat(200 * 1024);
      let bufferedAmount = 130 * 1024; // already over threshold
      const ws = {
        readyState: WebSocket.OPEN,
        get bufferedAmount() {
          return bufferedAmount;
        },
        set bufferedAmount(v: number) {
          bufferedAmount = v;
        },
        close: vi.fn((_code?: number, _reason?: string) => {
          // simulate real browser: ws flips to CLOSED immediately on close()
          ws.readyState = WebSocket.CLOSED;
        }),
      } as any;

      sendInputThroughSessionTransport({
        sessionId: 'session-bp-strict',
        data: bigInput,
        refs: {
          sessionsRef: { current: [{ id: 'session-bp-strict', reliableInputSupported: true } as any] },
          stateRef: { current: { activeSessionId: 'session-bp-strict' } },
        },
        runtimeDebug: vi.fn(),
        daemonConnection: createDaemonConnectionForSocket(ws),
        isReconnectInFlight: () => false,
        sendSocketPayload,
        markPendingInputTailRefresh: vi.fn(() => true),
        readSessionBufferSnapshot: () => ({ revision: 3 }),
        requestSessionBufferHead: vi.fn(),
        hasPendingSessionTransportOpen: () => false,
        isPendingSessionTransportOpenStale: () => false,
      });

      expect(ws.close).toHaveBeenCalledTimes(1);
      const sendsAfterFirstClose = sendSocketPayload.mock.calls.length;

      // simulate ws recovery with backlog — ws.open again, bufferedAmount still high
      ws.readyState = WebSocket.OPEN;
      bufferedAmount = 130 * 1024;

      // fire scheduled retry (immediate retry window)
      vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_RETRY_MS + 1);

      // 红测：retry 时如果 bufferedAmount 仍超阈值，应该再次 close 而不是 send
      // 当前实现 BUG：retry 立即 send,不管 bufferedAmount → 触发新一轮 close → 死循环
      // 红测期望：retry 期间 sendSocketPayload 不应该新增调用
      expect(sendSocketPayload.mock.calls.length - sendsAfterFirstClose).toBe(0);
    });

    it('re-checks ws.bufferedAmount after each send within a flush cycle (BUG #3)', () => {
      vi.useFakeTimers();
      const sendSocketPayload = vi.fn();
      // multiple chunks that cumulatively exceed 128KB but each chunk stays under
      const longInput = 'a'.repeat(200 * 1024);

      // simulate bufferedAmount increasing AS we send chunks
      let buffered = 0;
      const ws = {
        readyState: WebSocket.OPEN,
        get bufferedAmount() {
          return buffered;
        },
        set bufferedAmount(v: number) {
          buffered = v;
        },
        close: vi.fn((_code?: number, _reason?: string) => {
          // when close is called, ws flips to CLOSING (real browser behavior)
          ws.readyState = WebSocket.CLOSING;
        }),
      } as any;

      sendInputThroughSessionTransport({
        sessionId: 'session-flush-loop',
        data: longInput,
        refs: {
          // BUG #3 fix is in the legacy (non-reliable) path. 100-char input
          // is split into 1 chunk by splitTerminalInputUtf8Chunks but we want
          // multiple chunks; force 5 chunks of 40160 chars each (chunk size
          // 64KB → 200KB total).
          sessionsRef: { current: [{ id: 'session-flush-loop', reliableInputSupported: false } as any] },
          stateRef: { current: { activeSessionId: 'session-flush-loop' } },
        },
        runtimeDebug: vi.fn(),
        daemonConnection: createDaemonConnectionForSocket(ws),
        isReconnectInFlight: () => false,
        sendSocketPayload: vi.fn(((sid: string, w: any, payload: string) => {
          sendSocketPayload(sid, w, payload);
          // simulate kernel: each send adds to bufferedAmount
          buffered += payload.length;
        }) as any),
        markPendingInputTailRefresh: vi.fn(() => true),
        readSessionBufferSnapshot: () => ({ revision: 3 }),
        requestSessionBufferHead: vi.fn(),
        hasPendingSessionTransportOpen: () => false,
        isPendingSessionTransportOpenStale: () => false,
      });

      // BUG #3 红测：如果当前实现只在入口读 bufferedAmount, 在 flush 期间
      // 会持续 send 远超 128KB 阈值的 payload 但不再次触发 close
      // 修复后，每次 send 都应该 check bufferedAmount，达到阈值立即 close
      expect(ws.close).toHaveBeenCalled();
    });
  });
});
