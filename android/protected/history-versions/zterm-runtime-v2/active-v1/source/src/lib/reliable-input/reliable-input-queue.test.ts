// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  enqueueReliableInputChunks,
  handleTerminalInputAck,
  resetTerminalReliableInputRuntimeForTests,
  TERMINAL_INPUT_BACKPRESSURE_BUFFERED_BYTES,
  TERMINAL_RELIABLE_INPUT_ACK_TIMEOUT_MS,
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

  it('does not send the next chunk until the current chunk is acked', () => {
    vi.useFakeTimers();
    const { options } = createOptions();
    const longInput = `${'a'.repeat(TERMINAL_INPUT_CHUNK_BYTES - 3)}中文😀${'b'.repeat(128)}`;
    const inputChunks = [longInput.slice(0, 100), longInput.slice(100)];

    enqueueReliableInputChunks(options, 'session-2', inputChunks);
    expect(options.sendSocketPayload).toHaveBeenCalledTimes(1);
    const first = parseReliablePayload(options.sendSocketPayload);

    handleTerminalInputAck('session-2', {
      version: 1,
      seq: first.seq,
      accepted: true,
      bytes: first.data.length,
    });
    expect(options.sendSocketPayload).toHaveBeenCalledTimes(2);
    expect(parseReliablePayload(options.sendSocketPayload, 1).seq).not.toBe(first.seq);
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
});
