import { once } from 'node:events';
import { createServer, Socket, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WeakNetworkByteProxy,
  resolvePeriodicStallDelayMs,
  type WeakNetworkByteProxyProfile,
} from '../../scripts/weak-network-byte-proxy';

const openServers = new Set<Server>();
const openSockets = new Set<Socket>();

async function listen(server: Server) {
  openServers.add(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected TCP server address');
  }
  return address.port;
}

async function connect(port: number) {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const next = new Socket();
    next.once('connect', () => resolve(next));
    next.once('error', reject);
    next.connect(port, '127.0.0.1');
  });
  openSockets.add(socket);
  socket.once('close', () => openSockets.delete(socket));
  return socket;
}

async function closeServer(server: Server) {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  openServers.delete(server);
}

afterEach(async () => {
  for (const socket of openSockets) {
    socket.destroy();
  }
  openSockets.clear();
  await Promise.all(Array.from(openServers, closeServer));
});

describe('weak network byte proxy', () => {
  it('forwards exact bidirectional bytes without exposing payload in metrics', async () => {
    const upstream = createServer((socket) => {
      socket.once('data', (chunk) => {
        expect(Buffer.from(chunk)).toEqual(Buffer.from([0, 255, 1, 2, 3, 128]));
        socket.write(Buffer.from([7, 6, 5, 0, 255]));
      });
    });
    const targetPort = await listen(upstream);
    const proxy = new WeakNetworkByteProxy({
      listenHost: '127.0.0.1',
      listenPort: 0,
      targetHost: '127.0.0.1',
      targetPort,
      profile: {
        name: 'good',
        bandwidthBytesPerSecond: null,
        oneWayLatencyMs: 0,
        jitterMs: [0, 0],
        chunkBytes: 1024,
        periodicStall: null,
        disconnect: null,
      },
    });
    const address = await proxy.start();
    const client = await connect(address.port);
    const response = once(client, 'data');
    client.write(Buffer.from([0, 255, 1, 2, 3, 128]));
    expect(Buffer.from((await response)[0] as Buffer)).toEqual(
      Buffer.from([7, 6, 5, 0, 255]),
    );

    const snapshot = proxy.getSnapshot();
    expect(snapshot.totals.clientToTargetBytesRead).toBe(6);
    expect(snapshot.totals.clientToTargetBytesWritten).toBe(6);
    expect(snapshot.totals.targetToClientBytesRead).toBe(5);
    expect(snapshot.totals.targetToClientBytesWritten).toBe(5);
    expect(JSON.stringify(snapshot)).not.toMatch(/payload|terminal|text|cells|content|data/i);
    await proxy.stop();
    await closeServer(upstream);
  });

  it('enforces one-way latency and byte-rate without changing the bytes', async () => {
    const upstream = createServer((socket) => socket.pipe(socket));
    const targetPort = await listen(upstream);
    const profile: WeakNetworkByteProxyProfile = {
      name: 'shaped',
      bandwidthBytesPerSecond: 10_000,
      oneWayLatencyMs: 35,
      jitterMs: [0, 0],
      chunkBytes: 500,
      periodicStall: null,
      disconnect: null,
    };
    const proxy = new WeakNetworkByteProxy({
      listenHost: '127.0.0.1',
      listenPort: 0,
      targetHost: '127.0.0.1',
      targetPort,
      profile,
    });
    const address = await proxy.start();
    const client = await connect(address.port);
    const payload = Buffer.alloc(2_000, 0xa5);
    const received: Buffer[] = [];
    let receivedBytes = 0;
    const startedAt = Date.now();
    const complete = new Promise<void>((resolve) => {
      client.on('data', (chunk) => {
        received.push(Buffer.from(chunk));
        receivedBytes += chunk.length;
        if (receivedBytes >= payload.length) {
          resolve();
        }
      });
    });
    client.write(payload);
    await complete;
    const elapsedMs = Date.now() - startedAt;

    expect(Buffer.concat(received)).toEqual(payload);
    expect(elapsedMs).toBeGreaterThanOrEqual(300);
    expect(proxy.getSnapshot().totals.maxQueuedBytes).toBeLessThanOrEqual(
      profile.chunkBytes,
    );
    await proxy.stop();
    await closeServer(upstream);
  });

  it('computes deterministic periodic stall windows', () => {
    const stall = { everyMs: 1_000, durationMs: 200 };
    expect(resolvePeriodicStallDelayMs(999, stall)).toBe(0);
    expect(resolvePeriodicStallDelayMs(1_000, stall)).toBe(200);
    expect(resolvePeriodicStallDelayMs(1_125, stall)).toBe(75);
    expect(resolvePeriodicStallDelayMs(1_200, stall)).toBe(0);
    expect(resolvePeriodicStallDelayMs(2_050, stall)).toBe(150);
  });

  it('closes active sockets during an explicit disconnect window and accepts reconnect after recovery', async () => {
    const upstream = createServer((socket) => socket.pipe(socket));
    const targetPort = await listen(upstream);
    const proxy = new WeakNetworkByteProxy({
      listenHost: '127.0.0.1',
      listenPort: 0,
      targetHost: '127.0.0.1',
      targetPort,
      profile: {
        name: 'reconnect',
        bandwidthBytesPerSecond: null,
        oneWayLatencyMs: 0,
        jitterMs: [0, 0],
        chunkBytes: 1024,
        periodicStall: null,
        disconnect: { afterMs: 40, durationMs: 120 },
      },
    });
    const address = await proxy.start();
    const first = await connect(address.port);
    await once(first, 'close');
    expect(proxy.getSnapshot().totals.forcedDisconnects).toBe(1);

    const duringWindow = await connect(address.port);
    await once(duringWindow, 'close');
    await new Promise((resolve) => setTimeout(resolve, 140));

    const recovered = await connect(address.port);
    const response = once(recovered, 'data');
    recovered.write(Buffer.from('recovered'));
    expect(Buffer.from((await response)[0] as Buffer).toString()).toBe('recovered');
    await proxy.stop();
    await closeServer(upstream);
  });
});
