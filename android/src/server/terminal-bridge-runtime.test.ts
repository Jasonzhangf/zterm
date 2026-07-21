import { EventEmitter } from 'events';
import type { IncomingMessage } from 'http';
import { WebSocketServer, type RawData } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTerminalBridgeRuntime } from './terminal-bridge-runtime';
import type { TerminalTransportSubscriber } from './terminal-runtime';
import type { DaemonTransportConnection } from './terminal-transport-runtime';

class FakeWebSocket extends EventEmitter {
  send = vi.fn();
  close = vi.fn();
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createRequest(url = '/ws?token=test-token'): IncomingMessage {
  return {
    url,
    socket: {
      remoteAddress: '127.0.0.1',
    },
    headers: {},
  } as IncomingMessage;
}

function createConnection(id = 'connection-1'): DaemonTransportConnection {
  return {
    id,
    transportId: `${id}-transport`,
    requestOrigin: 'http://127.0.0.1:3333',
    role: 'session',
    boundSubscriberId: 'session-1',
    wsAlive: true,
    lastInboundAt: Date.now(),
    closeTransport: vi.fn(),
    transport: {
      kind: 'ws',
      readyState: 1,
      requestOrigin: undefined,
      connectedSent: false,
      sendText: vi.fn(),
      close: vi.fn(),
    },
  };
}

function createRuntime(handleMessage: (connection: DaemonTransportConnection, rawData: RawData, isBinary?: boolean) => Promise<void>) {
  const sessions = new Map<string, TerminalTransportSubscriber>();
  const connections = new Map<string, DaemonTransportConnection>();
  const wss = new WebSocketServer({ noServer: true });
  const connection = createConnection();
  const detachSubscriberTransportOnly = vi.fn();
  const refreshAdaptiveWidthLeaseHeartbeat = vi.fn();
  const runtime = createTerminalBridgeRuntime({
    requiredAuthToken: 'test-token',
    sessions,
    connections,
    wss,
    logTimePrefix: () => '2026-06-15 12:00:00',
    extractAuthToken: (rawUrl) => new URL(rawUrl || '/ws', 'http://127.0.0.1:3333').searchParams.get('token') || '',
    resolveRequestOrigin: () => 'http://127.0.0.1:3333',
    createWebSocketSessionTransport: () => connection.transport,
    createRtcSessionTransport: () => connection.transport,
    createTransportConnection: () => connection,
    detachSubscriberTransportOnly,
    refreshAdaptiveWidthLeaseHeartbeat,
    handleMessage,
  });
  return {
    connection,
    connections,
    detachSubscriberTransportOnly,
    refreshAdaptiveWidthLeaseHeartbeat,
    runtime,
    sessions,
    wss,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('terminal bridge runtime message scheduling', () => {
  it('lets input overtake a slow non-input message on the same transport', async () => {
    const events: string[] = [];
    let releaseControl: (() => void) | undefined;
    const { runtime, wss } = createRuntime(async (_connection, rawData) => {
      const message = JSON.parse(Buffer.from(rawData as ArrayBuffer).toString('utf8')) as {
        type: string;
        payload?: unknown;
      };
      if (message.type === 'buffer-head-request') {
        events.push('control:start');
        await new Promise<void>((resolve) => {
          releaseControl = resolve;
        });
        events.push('control:end');
        return;
      }
      if (message.type === 'input') {
        events.push(`input:${String(message.payload)}`);
      }
    });
    const ws = new FakeWebSocket();

    runtime.handleWebSocketConnection(ws as never, createRequest());
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'buffer-head-request', payload: {} })), false);
    await flushMicrotasks();
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', payload: 'ls' })), false);
    await flushMicrotasks();

    expect(events).toEqual(['control:start', 'input:ls']);

    if (releaseControl) {
      releaseControl();
    }
    await flushMicrotasks();
    await flushMicrotasks();

    expect(events).toEqual(['control:start', 'input:ls', 'control:end']);
    wss.close();
  });

  it('keeps input messages serialized in arrival order even while non-input work is still running', async () => {
    const events: string[] = [];
    let releaseControl: (() => void) | undefined;
    const { runtime, wss } = createRuntime(async (_connection, rawData) => {
      const message = JSON.parse(Buffer.from(rawData as ArrayBuffer).toString('utf8')) as {
        type: string;
        payload?: unknown;
      };
      if (message.type === 'buffer-sync-request') {
        events.push('sync:start');
        await new Promise<void>((resolve) => {
          releaseControl = resolve;
        });
        events.push('sync:end');
        return;
      }
      if (message.type === 'input') {
        events.push(`input:${String(message.payload)}`);
      }
    });
    const ws = new FakeWebSocket();

    runtime.handleWebSocketConnection(ws as never, createRequest());
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'buffer-sync-request', payload: {} })), false);
    await flushMicrotasks();
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', payload: 'a' })), false);
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', payload: 'b' })), false);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(events).toEqual(['sync:start', 'input:a', 'input:b']);

    if (releaseControl) {
      releaseControl();
    }
    await flushMicrotasks();
    wss.close();
  });

  it('lets a fresh input start while an older input is still awaiting its own write path', async () => {
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const { runtime, wss } = createRuntime(async (_connection, rawData) => {
      const message = JSON.parse(Buffer.from(rawData as ArrayBuffer).toString('utf8')) as {
        type: string;
        payload?: unknown;
      };
      if (message.type !== 'input') {
        return;
      }
      const text = String(message.payload);
      if (text === 'a') {
        events.push('input:a:start');
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        events.push('input:a:end');
        return;
      }
      events.push(`input:${text}`);
    });
    const ws = new FakeWebSocket();

    runtime.handleWebSocketConnection(ws as never, createRequest());
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', payload: 'a' })), false);
    await flushMicrotasks();
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', payload: 'b' })), false);
    await flushMicrotasks();

    expect(events).toEqual(['input:a:start', 'input:b']);

    if (releaseFirst) {
      releaseFirst();
    }
    await flushMicrotasks();
    await flushMicrotasks();

    expect(events).toEqual(['input:a:start', 'input:b', 'input:a:end']);
    wss.close();
  });

  it('does not let input overtake a pending connect attach barrier', async () => {
    const events: string[] = [];
    let releaseConnect: (() => void) | undefined;
    const { runtime, wss } = createRuntime(async (_connection, rawData) => {
      const message = JSON.parse(Buffer.from(rawData as ArrayBuffer).toString('utf8')) as {
        type: string;
        payload?: unknown;
      };
      if (message.type === 'connect') {
        events.push('connect:start');
        await new Promise<void>((resolve) => {
          releaseConnect = resolve;
        });
        events.push('connect:end');
        return;
      }
      if (message.type === 'input') {
        events.push(`input:${String(message.payload)}`);
      }
    });
    const ws = new FakeWebSocket();

    runtime.handleWebSocketConnection(ws as never, createRequest());
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'connect', payload: { sessionName: 'demo' } })), false);
    await flushMicrotasks();
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', payload: 'pwd' })), false);
    await flushMicrotasks();

    expect(events).toEqual(['connect:start']);

    if (releaseConnect) {
      releaseConnect();
    }
    await flushMicrotasks();
    await flushMicrotasks();

    expect(events).toEqual(['connect:start', 'connect:end', 'input:pwd']);
    wss.close();
  });

  it('detaches every mux channel subscriber when the physical websocket closes', async () => {
    const { connection, detachSubscriberTransportOnly, runtime, sessions, wss } = createRuntime(async () => {});
    connection.boundSubscriberId = null;
    connection.muxChannels = new Map([
      ['channel-a', 'subscriber-a'],
      ['channel-b', 'subscriber-b'],
    ]);
    const subscriberA = {
      id: 'subscriber-a',
      transportId: connection.transportId,
      transport: connection.transport,
      sessionName: 'alpha',
      mirrorKey: 'alpha',
      pendingPasteImage: null,
      pendingAttachFile: null,
    } as TerminalTransportSubscriber;
    const subscriberB = {
      id: 'subscriber-b',
      transportId: connection.transportId,
      transport: connection.transport,
      sessionName: 'beta',
      mirrorKey: 'beta',
      pendingPasteImage: null,
      pendingAttachFile: null,
    } as TerminalTransportSubscriber;
    sessions.set(subscriberA.id, subscriberA);
    sessions.set(subscriberB.id, subscriberB);
    const ws = new FakeWebSocket();

    runtime.handleWebSocketConnection(ws as never, createRequest());
    ws.emit('close', 1006, Buffer.from('network gone'));
    await flushMicrotasks();

    expect(detachSubscriberTransportOnly).toHaveBeenCalledWith(
      subscriberA,
      'websocket closed',
      connection.transportId,
    );
    expect(detachSubscriberTransportOnly).toHaveBeenCalledWith(
      subscriberB,
      'websocket closed',
      connection.transportId,
    );
    expect(connection.muxChannels.size).toBe(0);
    wss.close();
  });
});
