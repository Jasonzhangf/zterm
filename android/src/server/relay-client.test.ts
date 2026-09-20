import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildRelayDirectoryUpdateEnvelope,
  createRelayHostDirectoryPublishLoop,
  createTraversalRelayHostClient,
  DIRECTORY_PUBLISH_INTERVAL_MS,
  publishRelayDirectoryUpdate,
} from './relay-client';

const { MockWebSocket, sockets } = vi.hoisted(() => {
  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = MockWebSocket.OPEN;
    sent: string[] = [];
    ping = vi.fn();
    terminate = vi.fn();
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor(public readonly url: URL) {
      sockets.push(this);
    }

    on(event: string, listener: (...args: unknown[]) => void) {
      const listeners = this.listeners.get(event) || [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string, ...args: unknown[]) {
      for (const listener of this.listeners.get(event) || []) {
        listener(...args);
      }
    }

    send(payload: string) {
      this.sent.push(payload);
    }

    close() {
      this.readyState = MockWebSocket.CLOSING;
    }
  }

  const sockets: MockWebSocket[] = [];
  return { MockWebSocket, sockets };
});

vi.mock('ws', () => ({
  WebSocket: MockWebSocket,
}));

function createOpenSocket() {
  const sent: string[] = [];
  return {
    sent,
    socket: {
      readyState: 1,
      send: (payload: string) => sent.push(payload),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  MockWebSocket.OPEN = 1;
  MockWebSocket.CLOSING = 2;
  MockWebSocket.CLOSED = 3;
});

describe('traversal relay host reconnect ownership', () => {
  beforeEach(() => {
    sockets.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ accessToken: 'test-token' }),
    })));
  });

  it('ignores a stale socket close after a newer socket is current', async () => {
    const closeRelayPeer = vi.fn();
    const client = createTraversalRelayHostClient({
      config: {
        relayUrl: 'https://relay.example.test/',
        username: 'test',
        password: 'test',
        hostId: 'mac-studio',
        deviceId: 'device-1',
        deviceName: 'Mac Studio',
        platform: 'darwin',
        appVersion: '1.0.0',
        daemonVersion: '1.0.0',
      },
      handleRelaySignal: async () => {},
      closeRelayPeer,
      listEndpointCandidates: () => [],
      listTerminalSessionCatalog: () => [],
    });

    client.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const staleSocket = sockets[0];
    staleSocket.emit('open');
    staleSocket.emit('message', JSON.stringify({ type: 'relay-ready', hostId: 'mac-studio' }));

    staleSocket.readyState = MockWebSocket.CLOSING;
    staleSocket.emit('close', 1012, Buffer.from('host relay replaced'));
    client.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    const currentSocket = sockets[1];
    currentSocket.emit('open');
    currentSocket.emit('message', JSON.stringify({ type: 'relay-ready', hostId: 'mac-studio' }));

    staleSocket.emit('message', JSON.stringify({
      type: 'relay-peer-close',
      peerId: 'stale-peer',
      reason: 'stale close event',
    }));

    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets).toHaveLength(2);
    expect(currentSocket.sent.length).toBeGreaterThan(0);
    expect(closeRelayPeer).not.toHaveBeenCalled();
  });

  it('does not open another socket while the current socket is live', async () => {
    const client = createTraversalRelayHostClient({
      config: {
        relayUrl: 'https://relay.example.test/',
        username: 'test',
        password: 'test',
        hostId: 'mac-studio',
        deviceId: 'device-1',
        deviceName: 'Mac Studio',
        platform: 'darwin',
        appVersion: '1.0.0',
        daemonVersion: '1.0.0',
      },
      handleRelaySignal: async () => {},
      closeRelayPeer: () => {},
      listEndpointCandidates: () => [],
      listTerminalSessionCatalog: () => [],
    });

    client.start();
    client.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].emit('open');
    client.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(sockets).toHaveLength(1);
  });

  it('does not open a replacement socket while the current socket is closing', async () => {
    const client = createTraversalRelayHostClient({
      config: {
        relayUrl: 'https://relay.example.test/',
        username: 'test',
        password: 'test',
        hostId: 'mac-studio',
        deviceId: 'device-1',
        deviceName: 'Mac Studio',
        platform: 'darwin',
        appVersion: '1.0.0',
        daemonVersion: '1.0.0',
      },
      handleRelaySignal: async () => {},
      closeRelayPeer: () => {},
      listEndpointCandidates: () => [],
      listTerminalSessionCatalog: () => [],
    });

    client.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].emit('open');
    sockets[0].readyState = MockWebSocket.CLOSING;
    client.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(sockets).toHaveLength(1);
  });
});

describe('traversal relay daemon directory publisher', () => {
  it('keeps the daemon relay heartbeat and directory publish cadence at thirty seconds', () => {
    expect(DIRECTORY_PUBLISH_INTERVAL_MS).toBe(30_000);
  });

  it('builds a directory-update with gateway endpoint candidates and tmux sessions', () => {
    const endpoints = [
      {
        id: 'lan:192.168.50.20:3333',
        kind: 'lan' as const,
        host: '192.168.50.20',
        port: 3333,
        authRequired: true,
        lastSeenAt: '2026-06-28T10:00:00.000Z',
      },
      {
        id: 'relay-rtc:daemon-host-1',
        kind: 'relay-rtc' as const,
        relayHostId: 'daemon-host-1',
        authRequired: true,
        lastSeenAt: '2026-06-28T10:00:00.000Z',
      },
    ];
    const envelope = buildRelayDirectoryUpdateEnvelope({
      endpoints,
      sessionCatalog: [
        { name: 'main', cwd: '/tmp/main' },
        { name: 'work', cwd: '/tmp/work' },
        { name: 'main', cwd: '/tmp/duplicate' },
        { name: '  ' },
      ],
      now: '2026-06-28T10:00:00.000Z',
    });

    expect(envelope).toEqual({
      type: 'directory-update',
      directory: {
        endpoints,
        sessions: [
          { name: 'main', cwd: '/tmp/main', updatedAt: '2026-06-28T10:00:00.000Z' },
          { name: 'work', cwd: '/tmp/work', updatedAt: '2026-06-28T10:00:00.000Z' },
        ],
        publishedAt: '2026-06-28T10:00:00.000Z',
      },
    });
  });

  it('publishes directory-update after tmux sessions are read successfully', () => {
    const { socket, sent } = createOpenSocket();
    const result = publishRelayDirectoryUpdate({
      socket,
      listEndpointCandidates: () => [{
        id: 'relay-rtc:daemon-host-1',
        kind: 'relay-rtc',
        relayHostId: 'daemon-host-1',
        authRequired: true,
        lastSeenAt: '2026-06-28T10:01:00.000Z',
      }],
      listTerminalSessionCatalog: () => [{ name: 'main', cwd: '/tmp/main' }],
      now: () => '2026-06-28T10:01:00.000Z',
    });

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toMatchObject({
      type: 'directory-update',
      directory: {
        endpoints: [{ kind: 'relay-rtc', relayHostId: 'daemon-host-1' }],
        sessions: [{ name: 'main' }],
      },
    });
  });

  it('reports tmux session read failure explicitly instead of publishing an empty success directory', () => {
    const { socket, sent } = createOpenSocket();
    const result = publishRelayDirectoryUpdate({
      socket,
      listEndpointCandidates: () => [{
        id: 'relay-rtc:daemon-host-1',
        kind: 'relay-rtc',
        relayHostId: 'daemon-host-1',
        authRequired: true,
        lastSeenAt: '2026-06-28T10:02:00.000Z',
      }],
      listTerminalSessionCatalog: () => {
        throw new Error('tmux unavailable');
      },
      now: () => '2026-06-28T10:02:00.000Z',
    });

    expect(result).toEqual({ ok: false, reason: 'tmux unavailable' });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toEqual({
      type: 'relay-error',
      reason: 'directory-update failed: tmux unavailable',
    });
  });

  it('reports endpoint discovery failure explicitly instead of publishing Relay-only fallback truth', () => {
    const { socket, sent } = createOpenSocket();
    const result = publishRelayDirectoryUpdate({
      socket,
      listEndpointCandidates: () => {
        throw new Error('network endpoint discovery failed');
      },
      listTerminalSessionCatalog: () => [{ name: 'main' }],
      now: () => '2026-06-28T10:03:00.000Z',
    });

    expect(result).toEqual({ ok: false, reason: 'network endpoint discovery failed' });
    expect(JSON.parse(sent[0])).toEqual({
      type: 'relay-error',
      reason: 'directory-update failed: network endpoint discovery failed',
    });
  });
});

describe('relay host directory publish loop', () => {
  function makeSocket() {
    return {
      readyState: 1,
      ping: () => {},
      terminate: () => {},
    };
  }

  it('publishes on every interval while the socket is open', () => {
    vi.useFakeTimers();
    const socket = makeSocket();
    let publishCount = 0;
    const loop = createRelayHostDirectoryPublishLoop({
      socket,
      publish: () => {
        publishCount += 1;
        return true;
      },
      intervalMs: 1000,
      pongTimeoutMs: 3000,
    });
    loop.start();
    vi.advanceTimersByTime(3500);
    loop.stop();
    expect(publishCount).toBe(3);
  });

  it('terminates a half-open socket after pong timeout and stops publishing', () => {
    vi.useFakeTimers();
    const socket = makeSocket();
    const terminate = vi.spyOn(socket, 'terminate');
    let publishCount = 0;
    const loop = createRelayHostDirectoryPublishLoop({
      socket,
      publish: () => {
        publishCount += 1;
        return true;
      },
      intervalMs: 1000,
      pongTimeoutMs: 3000,
    });
    loop.start();
    vi.advanceTimersByTime(1000); // t1: now-lastPongAt=1000 < 3000 -> ping + publish
    vi.advanceTimersByTime(1000); // t2: 2000 < 3000 -> ping + publish
    vi.advanceTimersByTime(1000); // t3: 3000 边界未超 -> ping + publish
    expect(publishCount).toBe(3);
    vi.advanceTimersByTime(1000); // t4: 4000 > 3000 => timeout -> terminate
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(publishCount).toBe(3);
    // 超时后循环不再 publish
    vi.advanceTimersByTime(3000);
    expect(publishCount).toBe(3);
    loop.stop();
  });

  it('keeps publishing when pongs keep the connection fresh', () => {
    vi.useFakeTimers();
    const socket = makeSocket();
    let publishCount = 0;
    const loop = createRelayHostDirectoryPublishLoop({
      socket,
      publish: () => {
        publishCount += 1;
        return true;
      },
      intervalMs: 1000,
      pongTimeoutMs: 3000,
    });
    loop.start();
    // 每次 publish 前模拟收到 pong（服务端正常回 pong）
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(1000);
      loop.markPong();
    }
    expect(publishCount).toBe(5);
    loop.stop();
  });

  it('skips publishing while the socket is not open', () => {
    vi.useFakeTimers();
    const socket = makeSocket();
    socket.readyState = 0;
    let publishCount = 0;
    const loop = createRelayHostDirectoryPublishLoop({
      socket,
      publish: () => {
        publishCount += 1;
        return true;
      },
      intervalMs: 1000,
      pongTimeoutMs: 3000,
    });
    loop.start();
    vi.advanceTimersByTime(3000);
    expect(publishCount).toBe(0);
    loop.stop();
  });
});
