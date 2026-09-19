// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  enqueueReliableInputChunks,
  handleTerminalInputAck,
  resetTerminalReliableInputRuntimeForTests,
  TERMINAL_INPUT_BACKPRESSURE_BUFFERED_BYTES,
  TERMINAL_RELIABLE_INPUT_ACK_TIMEOUT_MS,
  TERMINAL_RELIABLE_INPUT_MAX_IN_FLIGHT,
  TERMINAL_RELIABLE_INPUT_RETRY_MS,
  type SendInputTransportOptions,
} from './reliable-input-queue';
import { TERMINAL_INPUT_CHUNK_BYTES } from '@zterm/shared/terminal/input-chunking';
import type { ClientDaemonConnection } from '../client-daemon-connection';

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

function createOptions(overrides: Partial<Parameters<typeof enqueueReliableInputChunks>[0]> = {}) {
  const ws = createSocket(WebSocket.OPEN);
  const options: SendInputTransportOptions = {
    sessionId: 'session-2',
    data: 'pwd\r',
    refs: {
      sessionsRef: { current: [{ id: 'session-2', reliableInputSupported: true } as any] },
      stateRef: { current: { activeSessionId: 'session-2' } },
    },
    runtimeDebug: vi.fn(),
    daemonConnection: createDaemonConnection((sessionId) => createResource(sessionId, ws)),
    isReconnectInFlight: () => false,
    sendSocketPayload: vi.fn(),
    markPendingInputTailRefresh: vi.fn(() => true),
    readSessionBufferSnapshot: () => ({ revision: 3 }),
    requestSessionBufferHead: vi.fn(),
    hasPendingSessionTransportOpen: () => false,
    isPendingSessionTransportOpenStale: () => false,
    ...overrides,
  };
  return { options, ws };
}

function enqueueOne(overrides: Partial<Parameters<typeof enqueueReliableInputChunks>[0]> = {}) {
  const { options } = createOptions(overrides);
  enqueueReliableInputChunks(options, 'session-2', ['pwd\r']);
  return options;
}

function parseReliablePayload(sendSocketPayload: any, index = 0) {
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

afterEach(() => {
  resetTerminalReliableInputRuntimeForTests();
  vi.useRealTimers();
});

describe('client.reliable_input queue runtime', () => {
  it('does not close or replace the socket while the transport is backpressured', () => {
    vi.useFakeTimers();
    const ws = createSocket(WebSocket.OPEN, TERMINAL_INPUT_BACKPRESSURE_BUFFERED_BYTES);
    const options = createOptions({
      daemonConnection: createDaemonConnection((sessionId) => createResource(sessionId, ws)),
    }).options;

    enqueueReliableInputChunks(options, 'session-2', ['pwd\r']);

    expect(options.sendSocketPayload).not.toHaveBeenCalled();
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('waits for ack without a duplicate send', () => {
    vi.useFakeTimers();
    const options = enqueueOne();

    expect(options.sendSocketPayload).toHaveBeenCalledTimes(1);
    const first = parseReliablePayload(options.sendSocketPayload);
    vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_RETRY_MS * 5);
    expect(options.sendSocketPayload).toHaveBeenCalledTimes(1);

    handleTerminalInputAck('session-2', {
      version: 1,
      seq: first.seq,
      accepted: true,
      bytes: 4,
    });
    vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_RETRY_MS * 2);
    expect(options.sendSocketPayload).toHaveBeenCalledTimes(1);
  });

  it('retries the same seq after the ack timeout', () => {
    vi.useFakeTimers();
    const options = enqueueOne();

    const first = parseReliablePayload(options.sendSocketPayload);
    vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_ACK_TIMEOUT_MS - 1);
    expect(options.sendSocketPayload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);

    expect(options.sendSocketPayload).toHaveBeenCalledTimes(2);
    expect(parseReliablePayload(options.sendSocketPayload, 1)).toMatchObject({
      seq: first.seq,
      data: 'pwd\r',
      attempt: 2,
    });
  });

  it('retries the same seq when the physical transport changes', () => {
    vi.useFakeTimers();
    const oldWs = createSocket(WebSocket.OPEN);
    const newWs = createSocket(WebSocket.OPEN);
    let currentWs = oldWs;
    const options = createOptions({
      daemonConnection: createDaemonConnection((sessionId) => createResource(sessionId, currentWs)),
    }).options;

    enqueueReliableInputChunks(options, 'session-2', ['pwd\r']);
    const first = parseReliablePayload(options.sendSocketPayload);
    currentWs = newWs;
    vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_RETRY_MS);

    expect(options.sendSocketPayload).toHaveBeenCalledTimes(2);
    expect(parseReliablePayload(options.sendSocketPayload, 1)).toMatchObject({
      seq: first.seq,
      data: 'pwd\r',
      attempt: 2,
    });
  });

  it('does not retry when only route configuration changes under the same socket', () => {
    vi.useFakeTimers();
    const ws = createSocket(WebSocket.OPEN);
    let routeGeneration = 0;
    const options = createOptions({
      daemonConnection: createDaemonConnection((sessionId) => createResource(
        sessionId,
        ws,
        null,
        { routeGeneration },
      )),
    }).options;

    enqueueReliableInputChunks(options, 'session-2', ['pwd\r']);
    routeGeneration = 1;
    vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_RETRY_MS);
    expect(options.sendSocketPayload).toHaveBeenCalledTimes(1);
  });

  it('sends an ordered bounded burst before the first ack arrives', () => {
    vi.useFakeTimers();
    const { options } = createOptions();
    const longInput = `${'a'.repeat(TERMINAL_INPUT_CHUNK_BYTES - 3)}中文😀${'b'.repeat(128)}`;
    const inputChunks = [longInput.slice(0, 100), longInput.slice(100)];

    enqueueReliableInputChunks(options, 'session-2', inputChunks);
    expect(options.sendSocketPayload).toHaveBeenCalledTimes(2);
    const first = parseReliablePayload(options.sendSocketPayload);
    const second = parseReliablePayload(options.sendSocketPayload, 1);
    expect(second.seq).not.toBe(first.seq);
    expect(first.data + second.data).toBe(longInput);

    handleTerminalInputAck('session-2', {
      version: 1,
      seq: first.seq,
      accepted: true,
      bytes: first.data.length,
    });
    expect(options.sendSocketPayload).toHaveBeenCalledTimes(2);
  });

  it('keeps separate keystroke enqueues in flight without waiting for the first ack', () => {
    vi.useFakeTimers();
    const { options } = createOptions();

    enqueueReliableInputChunks(options, 'session-2', ['a']);
    enqueueReliableInputChunks(options, 'session-2', ['b']);
    enqueueReliableInputChunks(options, 'session-2', ['c']);

    expect(options.sendSocketPayload).toHaveBeenCalledTimes(3);
    expect(Array.from(
      { length: 3 },
      (_, index) => parseReliablePayload(options.sendSocketPayload, index).data,
    )).toEqual(['a', 'b', 'c']);
  });

  it('caps the ordered in-flight window', () => {
    vi.useFakeTimers();
    const { options } = createOptions();
    const chunks = Array.from(
      { length: TERMINAL_RELIABLE_INPUT_MAX_IN_FLIGHT + 2 },
      (_, index) => String(index),
    );

    enqueueReliableInputChunks(options, 'session-2', chunks);

    expect(options.sendSocketPayload).toHaveBeenCalledTimes(
      TERMINAL_RELIABLE_INPUT_MAX_IN_FLIGHT,
    );
    const payloads = Array.from(
      { length: TERMINAL_RELIABLE_INPUT_MAX_IN_FLIGHT },
      (_, index) => parseReliablePayload(options.sendSocketPayload, index),
    );
    expect(payloads.map((payload) => payload.data)).toEqual(
      chunks.slice(0, TERMINAL_RELIABLE_INPUT_MAX_IN_FLIGHT),
    );

    handleTerminalInputAck('session-2', {
      version: 1,
      seq: payloads[0]!.seq,
      accepted: true,
      bytes: 1,
    });
    expect(options.sendSocketPayload).toHaveBeenCalledTimes(
      TERMINAL_RELIABLE_INPUT_MAX_IN_FLIGHT + 1,
    );
  });

  it('slides the ordered window after an ack without waiting for earlier frames', () => {
    vi.useFakeTimers();
    const { options } = createOptions();
    const chunks = Array.from(
      { length: TERMINAL_RELIABLE_INPUT_MAX_IN_FLIGHT + 1 },
      (_, index) => String(index),
    );

    enqueueReliableInputChunks(options, 'session-2', chunks);
    expect(options.sendSocketPayload).toHaveBeenCalledTimes(
      TERMINAL_RELIABLE_INPUT_MAX_IN_FLIGHT,
    );

    const second = parseReliablePayload(options.sendSocketPayload, 1);
    handleTerminalInputAck('session-2', {
      version: 1,
      seq: second.seq,
      accepted: true,
      bytes: second.data.length,
    });

    expect(options.sendSocketPayload).toHaveBeenCalledTimes(
      TERMINAL_RELIABLE_INPUT_MAX_IN_FLIGHT + 1,
    );
    expect(parseReliablePayload(
      options.sendSocketPayload,
      TERMINAL_RELIABLE_INPUT_MAX_IN_FLIGHT,
    ).data).toBe(chunks[TERMINAL_RELIABLE_INPUT_MAX_IN_FLIGHT]);
  });

  it('keeps unsent frames behind an earlier in-flight frame on transport replacement', () => {
    vi.useFakeTimers();
    const oldWs = createSocket(WebSocket.OPEN);
    const newWs = createSocket(WebSocket.OPEN);
    let currentWs = oldWs;
    const { options } = createOptions({
      daemonConnection: createDaemonConnection((sessionId) => createResource(sessionId, currentWs)),
    });
    const chunks = ['a', 'b', 'c'];

    enqueueReliableInputChunks(options, 'session-2', chunks);
    const first = parseReliablePayload(options.sendSocketPayload);
    const second = parseReliablePayload(options.sendSocketPayload, 1);
    currentWs = newWs;
    vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_RETRY_MS);

    expect(options.sendSocketPayload).toHaveBeenCalledTimes(6);
    expect(parseReliablePayload(options.sendSocketPayload, 3)).toMatchObject({
      seq: first.seq,
      data: 'a',
      attempt: 2,
    });
    expect(parseReliablePayload(options.sendSocketPayload, 4)).toMatchObject({
      seq: second.seq,
      data: 'b',
      attempt: 2,
    });
    expect(parseReliablePayload(options.sendSocketPayload, 5)).toMatchObject({
      data: 'c',
      attempt: 2,
    });
  });

  it('retries a retryable daemon nack with the same seq', () => {
    vi.useFakeTimers();
    const options = enqueueOne();
    const first = parseReliablePayload(options.sendSocketPayload);

    handleTerminalInputAck('session-2', {
      version: 1,
      seq: first.seq,
      accepted: false,
      bytes: 4,
      error: 'input_stale_transport',
    });
    vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_RETRY_MS);

    expect(options.sendSocketPayload).toHaveBeenCalledTimes(2);
    expect(parseReliablePayload(options.sendSocketPayload, 1)).toMatchObject({
      seq: first.seq,
      data: 'pwd\r',
      attempt: 2,
    });
  });

  it('drops a non-retryable nack instead of retrying invalid payloads forever', () => {
    vi.useFakeTimers();
    const options = enqueueOne();
    const first = parseReliablePayload(options.sendSocketPayload);

    handleTerminalInputAck('session-2', {
      version: 1,
      seq: first.seq,
      accepted: false,
      bytes: 0,
      error: 'input_invalid',
    });
    vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_RETRY_MS * 2);
    expect(options.sendSocketPayload).toHaveBeenCalledTimes(1);
  });

  it('applies exponential backoff after repeated retries instead of an immediate retry loop', () => {
    vi.useFakeTimers();
    const oldWs = createSocket(WebSocket.OPEN);
    const newWs = createSocket(WebSocket.OPEN);
    let currentWs = oldWs;
    const options = createOptions({
      daemonConnection: createDaemonConnection((sessionId) => createResource(sessionId, currentWs)),
    }).options;

    enqueueReliableInputChunks(options, 'session-2', ['pwd\r']);
    const first = parseReliablePayload(options.sendSocketPayload);

    handleTerminalInputAck('session-2', {
      version: 1,
      seq: first.seq,
      accepted: false,
      bytes: 4,
      error: 'input_stale_transport',
    });
    vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_RETRY_MS);
    expect(options.sendSocketPayload).toHaveBeenCalledTimes(2);
    expect(parseReliablePayload(options.sendSocketPayload, 1).attempt).toBe(2);

    handleTerminalInputAck('session-2', {
      version: 1,
      seq: parseReliablePayload(options.sendSocketPayload, 1).seq,
      accepted: false,
      bytes: 4,
      error: 'input_stale_transport',
    });
    vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_RETRY_MS - 1);
    expect(options.sendSocketPayload).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(options.sendSocketPayload).toHaveBeenCalledTimes(3);
    expect(parseReliablePayload(options.sendSocketPayload, 2).attempt).toBe(3);

    // The next no-ack wait uses the exponential delay for attempt=3 (1000ms)
    // rather than resending on every 500ms poll. A transport change at 2500ms
    // proves the retry poll was backed off to that boundary.
    vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_RETRY_MS);
    expect(options.sendSocketPayload).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_RETRY_MS - 1);
    expect(options.sendSocketPayload).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_RETRY_MS);
    expect(options.sendSocketPayload).toHaveBeenCalledTimes(3);
    currentWs = newWs;
    vi.advanceTimersByTime(1);
    expect(options.sendSocketPayload).toHaveBeenCalledTimes(4);
    expect(parseReliablePayload(options.sendSocketPayload, 3).attempt).toBe(4);
  });

  it('uses the computed ACK-wait backoff delay instead of polling every retry interval', () => {
    vi.useFakeTimers();
    const retryWaits: Array<{ attempt: number; at: number }> = [];
    const options = enqueueOne({
      runtimeDebug: vi.fn((event, payload) => {
        if (event === 'session.input.reliable-wait.ack') {
          retryWaits.push({
            attempt: Number(payload?.attempt || 0),
            at: Date.now(),
          });
        }
      }),
    });

    const first = parseReliablePayload(options.sendSocketPayload);
    vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_ACK_TIMEOUT_MS);
    expect(options.sendSocketPayload).toHaveBeenCalledTimes(2);
    expect(parseReliablePayload(options.sendSocketPayload, 1)).toMatchObject({
      seq: first.seq,
      attempt: 2,
    });

    vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_ACK_TIMEOUT_MS);
    expect(options.sendSocketPayload).toHaveBeenCalledTimes(3);
    expect(parseReliablePayload(options.sendSocketPayload, 2)).toMatchObject({
      seq: first.seq,
      attempt: 3,
    });

    vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_ACK_TIMEOUT_MS);
    expect(options.sendSocketPayload).toHaveBeenCalledTimes(4);
    expect(parseReliablePayload(options.sendSocketPayload, 3)).toMatchObject({
      seq: first.seq,
      attempt: 4,
    });

    vi.advanceTimersByTime(TERMINAL_RELIABLE_INPUT_ACK_TIMEOUT_MS + 2000);
    expect(options.sendSocketPayload).toHaveBeenCalledTimes(5);
    expect(parseReliablePayload(options.sendSocketPayload, 4)).toMatchObject({
      seq: first.seq,
      attempt: 5,
    });

    const attempt3Waits = retryWaits.filter((entry) => entry.attempt === 3);
    expect(attempt3Waits.map((entry, index) => (
      index === 0 ? null : entry.at - attempt3Waits[index - 1]!.at
    )).filter((delay): delay is number => delay !== null)).toEqual([1000, 1000, 1000]);

    const attempt4Waits = retryWaits.filter((entry) => entry.attempt === 4);
    expect(attempt4Waits.map((entry, index) => (
      index === 0 ? null : entry.at - attempt4Waits[index - 1]!.at
    )).filter((delay): delay is number => delay !== null)).toEqual([2000]);
  });
});
