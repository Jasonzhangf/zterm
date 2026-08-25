import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  createTerminalTransportRuntime,
  readTerminalTransportBackpressureSnapshot,
} from './terminal-transport-runtime';
import type { TerminalSession, TerminalSessionTransport } from './terminal-runtime-types';

function createRuntime() {
  return createTerminalTransportRuntime({
    sessions: new Map(),
    connections: new Map(),
    daemonRuntimeDebug: vi.fn(),
    summarizePayload: () => null,
  });
}

describe('terminal transport performance truth', () => {
  it('reports websocket bufferedAmount as backpressure truth', () => {
    const transport: TerminalSessionTransport = {
      kind: 'ws',
      readyState: WebSocket.OPEN,
      bufferedAmount: 256_000,
      sendText: vi.fn(),
      close: vi.fn(),
    };

    expect(readTerminalTransportBackpressureSnapshot(transport)).toMatchObject({
      kind: 'ws',
      ready: true,
      bufferedBytes: 256_000,
      backpressure: true,
    });
  });

  it('reports rtc data-channel bufferedAmount through the same abstraction', () => {
    const transport: TerminalSessionTransport = {
      kind: 'rtc',
      readyState: WebSocket.OPEN,
      bufferedAmount: 128_000,
      sendText: vi.fn(),
      close: vi.fn(),
    };

    expect(readTerminalTransportBackpressureSnapshot(transport)).toMatchObject({
      kind: 'rtc',
      ready: true,
      bufferedBytes: 128_000,
      backpressure: true,
    });
  });

  it('records send failures instead of silently treating them as success', () => {
    const runtime = createRuntime();
    const transport: TerminalSessionTransport = {
      kind: 'ws',
      readyState: WebSocket.OPEN,
      sendText: vi.fn(() => {
        throw new Error('socket send failed');
      }),
      close: vi.fn(),
    };

    expect(() => runtime.sendTransportMessage(transport, {
      type: 'title',
      payload: 'demo',
    })).toThrow('socket send failed');
    expect(transport.lastSendError).toContain('socket send failed');
  });

  it('updates send byte counters for session messages', () => {
    const runtime = createRuntime();
    const transport: TerminalSessionTransport = {
      kind: 'ws',
      readyState: WebSocket.OPEN,
      sendText: vi.fn(),
      close: vi.fn(),
    };
    const session: TerminalSession = {
      id: 'session-1',
      transportId: 'transport-1',
      transport,
      sessionName: 'demo',
      mirrorKey: 'demo',
      pendingPasteImage: null,
      pendingAttachFile: null,
    };

    runtime.sendMessage(session, { type: 'title', payload: 'demo' });

    expect(transport.lastSendBytes).toBeGreaterThan(0);
    expect(transport.totalSendBytes).toBeGreaterThan(0);
    expect(transport.lastSendAt).toBeGreaterThan(0);
  });

  it('updates the same send accounting for pre-serialized text fanout', () => {
    const runtime = createRuntime();
    const transport: TerminalSessionTransport = {
      kind: 'ws',
      readyState: WebSocket.OPEN,
      bufferedAmount: 64,
      sendText: vi.fn(),
      close: vi.fn(),
    };

    runtime.sendText(transport, '{"type":"buffer-sync","payload":{"revision":7}}');

    expect(transport.lastSendBytes).toBe(Buffer.byteLength('{"type":"buffer-sync","payload":{"revision":7}}', 'utf8'));
    expect(transport.totalSendBytes).toBe(transport.lastSendBytes);
    expect(transport.lastSendAt).toBeGreaterThan(0);
    expect(transport.lastSendError).toBeNull();
    expect(transport.backpressureCount).toBe(0);
  });

  it('returns explicit send truth for closed and failed transports', () => {
    const runtime = createRuntime();
    const closed: TerminalSessionTransport = {
      kind: 'ws',
      readyState: WebSocket.CLOSED,
      sendText: vi.fn(),
      close: vi.fn(),
    };
    expect(runtime.sendText(closed, 'closed')).toEqual({ status: 'not-open' });

    const failed: TerminalSessionTransport = {
      kind: 'ws',
      readyState: WebSocket.OPEN,
      sendText: vi.fn(() => {
        throw new Error('socket send failed');
      }),
      close: vi.fn(),
    };
    expect(runtime.sendText(failed, 'failed')).toEqual({
      status: 'error',
      error: 'socket send failed',
    });
  });
});
