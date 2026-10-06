import { EventEmitter } from 'events';
import type { IncomingMessage } from 'http';
import { createServer as createHttpServer } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
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
    listMuxChannelSubscriberIds: (target) => Array.from(target.muxChannels?.values() || []),
    releaseAllMuxChannelSubscribers: (target) => {
      const subscriberIds = Array.from(target.muxChannels?.values() || []);
      target.muxChannels?.clear();
      return subscriberIds;
    },
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

function waitMs(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  it('detaches mux subscribers even when connection.closed was already set by a stale heartbeat closeout', async () => {
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
    connection.closed = true;
    const ws = new FakeWebSocket();

    runtime.handleWebSocketConnection(ws as never, createRequest());
    ws.emit('close', 1006, Buffer.from('late network close after heartbeat stale closeout'));
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

  it('does not treat websocket pong as app heartbeat or adaptive lease refresh', async () => {
    const { connection, refreshAdaptiveWidthLeaseHeartbeat, runtime, wss } = createRuntime(async () => {});
    connection.lastInboundAt = 1;
    connection.wsAlive = false;
    const ws = new FakeWebSocket();

    runtime.handleWebSocketConnection(ws as never, createRequest());
    ws.emit('pong');
    await flushMicrotasks();

    expect(connection.lastInboundAt).toBe(1);
    expect(connection.wsAlive).toBe(true);
    expect(refreshAdaptiveWidthLeaseHeartbeat).not.toHaveBeenCalled();
    wss.close();
  });

  it('treats mux-ping as physical transport liveness but not adaptive lease refresh', async () => {
    const handled: string[] = [];
    const { connection, refreshAdaptiveWidthLeaseHeartbeat, runtime, wss } = createRuntime(async (_connection, rawData) => {
      const message = JSON.parse(Buffer.from(rawData as ArrayBuffer).toString('utf8')) as { type: string };
      handled.push(message.type);
    });
    connection.lastInboundAt = 1;
    connection.wsAlive = false;
    const ws = new FakeWebSocket();

    runtime.handleWebSocketConnection(ws as never, createRequest());
    const inboundBeforePing = Date.now();
    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'mux-ping',
      payload: { sentAt: Date.now() },
    })), false);
    await flushMicrotasks();

    expect(handled).toEqual(['mux-ping']);
    // mux-ping is the background keepalive: it renews physical transport
    // liveness (lastInboundAt) so the target link survives, but it must never
    // renew the adaptive width lease (that would keep tmux geometry held).
    expect(connection.lastInboundAt).toBeGreaterThanOrEqual(inboundBeforePing);
    expect(connection.wsAlive).toBe(true);
    expect(refreshAdaptiveWidthLeaseHeartbeat).not.toHaveBeenCalled();
    wss.close();
  });

  it('does not run a queued attach after the physical websocket closes', async () => {
    const events: string[] = [];
    let releaseHead: (() => void) | undefined;
    const { connection, runtime, wss } = createRuntime(async (_connection, rawData) => {
      const message = JSON.parse(Buffer.from(rawData as ArrayBuffer).toString('utf8')) as { type: string };
      if (message.type === 'buffer-head-request') {
        await new Promise<void>((resolve) => {
          releaseHead = resolve;
        });
        events.push('head');
        return;
      }
      events.push(message.type);
    });
    const ws = new FakeWebSocket();

    runtime.handleWebSocketConnection(ws as never, createRequest());
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'buffer-head-request', payload: {} })), false);
    await flushMicrotasks();
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'session-open', payload: { sessionName: 'demo' } })), false);
    ws.emit('close', 1006, Buffer.from('network gone'));

    releaseHead?.();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(connection.closed).toBe(true);
    expect(events).toEqual(['head']);
    wss.close();
  });
});

describe('terminal bridge runtime transport close cleanup', () => {
  async function createOwnedLoopbackRuntime(options: {
    handleTransportClosed?: (connection: DaemonTransportConnection) => void | Promise<void>;
  }) {
    const httpServer = createHttpServer();
    const wss = new WebSocketServer({ noServer: true });
    httpServer.on('upgrade', (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (clientSocket) => {
        wss.emit('connection', clientSocket, request);
      });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address() as AddressInfo;
    const connectionUrl = `ws://127.0.0.1:${address.port}/ws?token=test-token`;

    const sessions = new Map<string, TerminalTransportSubscriber>();
    const connections = new Map<string, DaemonTransportConnection>();
    const createdConnections: DaemonTransportConnection[] = [];
    const serverSocketClosed = new Promise<number>((resolve) => {
      wss.once('connection', (ws) => {
        ws.once('close', (code) => resolve(code));
      });
    });
    const runtime = createTerminalBridgeRuntime({
      requiredAuthToken: 'test-token',
      sessions,
      connections,
      wss,
      logTimePrefix: () => '2026-06-15 12:00:00',
      extractAuthToken: (rawUrl) =>
        new URL(rawUrl || '/ws', 'http://127.0.0.1').searchParams.get('token') || '',
      resolveRequestOrigin: () => `http://127.0.0.1:${address.port}`,
      createWebSocketSessionTransport: (ws) =>
        ({
          kind: 'ws',
          readyState: 1,
          requestOrigin: undefined,
          connectedSent: false,
          sendText: vi.fn(),
          close: vi.fn(),
          ws,
        }) as never,
      createRtcSessionTransport: () => undefined as never,
      createTransportConnection: (transport, requestOrigin) => {
        const connection = {
          id: `loopback-connection-${createdConnections.length + 1}`,
          transportId: `loopback-transport-${createdConnections.length + 1}`,
          requestOrigin,
          role: 'session',
          boundSubscriberId: null,
          wsAlive: true,
          lastInboundAt: Date.now(),
          closeTransport: vi.fn(),
          transport,
        } as unknown as DaemonTransportConnection;
        createdConnections.push(connection);
        connections.set(connection.id, connection);
        return connection;
      },
      detachSubscriberTransportOnly: vi.fn(),
      refreshAdaptiveWidthLeaseHeartbeat: vi.fn(),
      listMuxChannelSubscriberIds: () => [],
      releaseAllMuxChannelSubscribers: () => [],
      handleMessage: async () => {},
      handleTransportClosed: options.handleTransportClosed,
    });
    wss.on('connection', (ws) => runtime.handleWebSocketConnection(ws, createRequest()));

    const client = new WebSocket(connectionUrl);
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });

    async function closeOwnedClient() {
      const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
      client.close(1000, 'owned close');
      await Promise.race([closed, waitMs(500)]);
      await serverSocketClosed;
    }

    async function teardown() {
      for (const clientSocket of [...wss.clients]) {
        clientSocket.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }

    return {
      closeOwnedClient,
      connection: createdConnections[0],
      connections,
      sessions,
      teardown,
    };
  }

  it('observes one genuine rejecting cleanup promise and keeps the owned transport closed', async () => {
    const cleanupFailures: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
      cleanupFailures.push(message);
    });
    let observed = 0;
    const { closeOwnedClient, teardown } = await createOwnedLoopbackRuntime({
      handleTransportClosed: () => {
        observed += 1;
        return Promise.reject(new Error('close-cleanup-failed'));
      },
    });

    await closeOwnedClient();
    await waitMs(50);

    expect(observed).toBe(1);
    expect(cleanupFailures).toEqual([
      '[2026-06-15 12:00:00] transport loopback-connection-1 cleanup failed after detach: close-cleanup-failed',
    ]);
    await teardown();
    consoleError.mockRestore();
  });

  it('reports a delayed cleanup rejection once with the original error', async () => {
    const cleanupFailures: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
      cleanupFailures.push(message);
    });
    const { closeOwnedClient, teardown } = await createOwnedLoopbackRuntime({
      handleTransportClosed: () =>
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(new Error('delayed-close-cleanup-failed')), 60);
        }),
    });

    await closeOwnedClient();
    await waitMs(150);

    expect(cleanupFailures).toEqual([
      '[2026-06-15 12:00:00] transport loopback-connection-1 cleanup failed after detach: delayed-close-cleanup-failed',
    ]);
    await teardown();
    consoleError.mockRestore();
  });

  it('reports a synchronous cleanup throw once with the original error', async () => {
    const cleanupFailures: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
      cleanupFailures.push(message);
    });
    const { closeOwnedClient, teardown } = await createOwnedLoopbackRuntime({
      handleTransportClosed: () => {
        throw new Error('sync-close-cleanup-threw');
      },
    });

    await closeOwnedClient();

    expect(cleanupFailures).toEqual([
      '[2026-06-15 12:00:00] transport loopback-connection-1 cleanup failed after detach: sync-close-cleanup-threw',
    ]);
    await teardown();
    consoleError.mockRestore();
  });
});
