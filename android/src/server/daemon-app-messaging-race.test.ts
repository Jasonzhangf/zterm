import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { connect as netConnect, createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeAppPathSegment, type AppClientFrame, type AppServerFrame } from '@zterm/shared/app-protocol';
import { createDaemonAppGateway } from './daemon-app-websocket-runtime';
import { createDaemonAppMessagingRuntime, type DaemonAppMessagingRuntime } from './daemon-app-messaging-runtime';

type RealDaemon = {
  runtime: DaemonAppMessagingRuntime;
  appRootDir: string;
  port: number;
  server: Server;
  gateway: ReturnType<typeof createDaemonAppGateway>;
};

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    try {
      await fn();
    } catch {
      // best-effort cleanup
    }
  }
});

function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function startRealDaemon(options: {
  root: string;
  deviceId: string;
  daemonHostId: string;
  token: string;
}): Promise<RealDaemon> {
  const appRootDir = join(options.root, 'app');
  const runtime = createDaemonAppMessagingRuntime({
    appRootDir,
    deviceId: options.deviceId,
    daemonHostId: options.daemonHostId,
    peerRequestTimeoutMs: 8_000,
  });
  await runtime.initialize();
  const server = createServer((_request, response) => {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });
  const gateway = createDaemonAppGateway({
    requiredAuthToken: options.token,
    daemonHostId: options.daemonHostId,
    deviceId: options.deviceId,
    messaging: runtime,
    log: () => undefined,
  });
  server.on('upgrade', (request, socket, head) => {
    if (gateway.handleServerUpgrade(request, socket, head)) return;
    socket.destroy();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  cleanups.push(async () => {
    gateway.dispose();
    runtime.dispose();
    await new Promise<void>((done) => server.close(() => done()));
  });
  return { runtime, appRootDir, port, server, gateway };
}

/** Raw TCP proxy that withholds the upstream->client handshake bytes until released. */
function startHoldProxy(targetPort: number) {
  let releaseNow = false;
  let activeClient: Socket | null = null;
  const buffered: Buffer[] = [];
  const sockets = new Set<Socket>();
  let accept!: () => void;
  const accepted = new Promise<void>((resolve) => { accept = resolve; });
  const server: NetServer = createNetServer((client) => {
    accept();
    activeClient = client;
    sockets.add(client);
    const upstream = netConnect(targetPort, '127.0.0.1');
    sockets.add(upstream);
    client.on('data', (data) => { if (!upstream.destroyed) upstream.write(data); });
    upstream.on('data', (data) => {
      if (releaseNow) {
        if (!client.destroyed) client.write(data);
      } else {
        buffered.push(Buffer.from(data));
      }
    });
    client.on('close', () => { upstream.destroy(); sockets.delete(client); sockets.delete(upstream); });
    client.on('error', () => undefined);
    upstream.on('error', () => undefined);
    upstream.on('close', () => { client.destroy(); sockets.delete(client); sockets.delete(upstream); });
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  });
  return {
    accepted,
    async listen() {
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      return (server.address() as { port: number }).port;
    },
    release() {
      releaseNow = true;
      const client = activeClient;
      if (client && !client.destroyed) {
        for (const chunk of buffered.splice(0)) client.write(chunk);
      }
    },
  };
}

/** Stand-in for a peer daemon that must receive nothing: records connections and frames. */
async function startRecorder() {
  const frames: string[] = [];
  let connections = 0;
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((done) => wss.once('listening', () => done()));
  wss.on('connection', (ws) => {
    connections += 1;
    ws.on('message', (raw) => {
      const text = raw.toString();
      frames.push(text);
      const frame = JSON.parse(text) as AppClientFrame;
      if (frame.type === 'app-hello') {
        ws.send(JSON.stringify({
          type: 'app-ready',
          payload: { requestId: frame.payload.requestId, protocolVersion: 1, deviceId: 'device-c', daemonHostId: 'daemon-c', capabilities: {} },
        }));
        return;
      }
      if (frame.type === 'app-send-file-start') {
        ws.send(JSON.stringify({
          type: 'app-send-result',
          payload: {
            requestId: frame.payload.requestId,
            messageId: frame.payload.messageId,
            transferId: frame.payload.file.transferId,
            status: 'receiving',
            stage: 'prepared',
            persistedOffset: 0,
          },
        }));
      }
    });
  });
  cleanups.push(async () => {
    await new Promise<void>((done) => wss.close(() => done()));
  });
  return {
    port: (wss.address() as { port: number }).port,
    get connections() { return connections; },
    frames,
  };
}

async function connectLocal(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/app`, { headers: { Authorization: `Bearer ${token}` } });
  const frames: AppServerFrame[] = [];
  const waiters: Array<{ predicate: (frame: AppServerFrame) => boolean; resolve: (frame: AppServerFrame) => void }> = [];
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as AppServerFrame;
    frames.push(frame);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    }
  });
  ws.on('error', () => undefined);
  await new Promise<void>((done, fail) => {
    ws.once('open', () => done());
    ws.once('error', fail);
  });
  function waitFor(predicate: (frame: AppServerFrame) => boolean, timeoutMs = 8_000) {
    const found = frames.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise<AppServerFrame>((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiters.push(waiter);
      setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) {
          waiters.splice(index, 1);
          reject(new Error(`frame not observed within ${timeoutMs}ms`));
        }
      }, timeoutMs);
    });
  }
  const helloId = `local-${randomUUID()}`;
  ws.send(JSON.stringify({
    type: 'app-hello',
    payload: {
      protocolVersion: 1,
      requestId: helloId,
      role: 'local',
      clientInstanceId: `race-${randomUUID()}`,
      deviceId: 'device-a',
      daemonHostId: 'daemon-a',
      capabilities: {},
    },
  }));
  await waitFor((frame) => frame.type === 'app-ready' && frame.payload.requestId === helloId);
  cleanups.push(async () => { ws.close(); });
  return {
    frames,
    waitFor,
    send(frame: AppClientFrame) { ws.send(JSON.stringify(frame)); },
  };
}

describe('daemon /app real WebSocket file-start conflict race', () => {
  it('rejects a parallel conflicting start on one real /app connection before any peer connect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zterm-app-race-'));
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }); });

    const tokenA = 'race-token-a';
    const tokenB = 'race-token-b';
    const daemonA = await startRealDaemon({ root: join(root, 'a'), deviceId: 'device-a', daemonHostId: 'daemon-a', token: tokenA });
    const daemonB = await startRealDaemon({ root: join(root, 'b'), deviceId: 'device-b', daemonHostId: 'daemon-b', token: tokenB });
    const proxy = startHoldProxy(daemonB.port);
    const proxyPort = await proxy.listen();
    const recorder = await startRecorder();
    const local = await connectLocal(daemonA.port, tokenA);

    const messageId = `race-${randomUUID()}`;
    const transferId = messageId;
    const data = Buffer.alloc(4, 9);
    const file = { transferId, fileName: 'race.bin', totalBytes: data.length, chunkCount: 1, sha256: sha256(data) };
    const targetB = { deviceId: 'device-b', daemonHostId: 'daemon-b', wsUrl: `ws://127.0.0.1:${proxyPort}/app`, authToken: tokenB };
    const targetC = { deviceId: 'device-c', daemonHostId: 'daemon-c', wsUrl: `ws://127.0.0.1:${recorder.port}/app`, authToken: 'race-token-c' };
    const requestIdOf = (frame: AppServerFrame) => (frame.payload as { requestId?: string }).requestId;

    // Start to B; the proxy holds B's app-ready so A is inside connectPeer with
    // the route already reserved for B.
    const reqB = `reqB-${randomUUID()}`;
    local.send({ type: 'app-send-file-start', payload: { requestId: reqB, messageId, target: targetB, subject: 'race', file } } as AppClientFrame);
    await proxy.accepted;

    // Conflicting start to C on the SAME real local connection while the first
    // start is still in flight. It must be rejected before A connects to C.
    const reqC = `reqC-${randomUUID()}`;
    local.send({ type: 'app-send-file-start', payload: { requestId: reqC, messageId, target: targetC, subject: 'race', file } } as AppClientFrame);
    const conflict = await local.waitFor((frame) => requestIdOf(frame) === reqC);
    expect(conflict).toMatchObject({ type: 'app-error', payload: { code: 'transfer_conflict' } });
    expect(recorder.connections).toBe(0);
    expect(recorder.frames).toHaveLength(0);

    // Release B and confirm the original route still completes to B only.
    proxy.release();
    const started = await local.waitFor((frame) => requestIdOf(frame) === reqB);
    expect(started).toMatchObject({ type: 'app-send-result', payload: { status: 'receiving' } });

    const reqChunk = `chunk-${randomUUID()}`;
    local.send({ type: 'app-send-file-chunk', payload: { requestId: reqChunk, messageId, transferId, offset: 0, chunkIndex: 0, dataBase64: data.toString('base64') } } as AppClientFrame);
    expect(await local.waitFor((frame) => requestIdOf(frame) === reqChunk)).toMatchObject({
      type: 'app-send-result',
      payload: { persistedOffset: data.length },
    });

    const reqCommit = `commit-${randomUUID()}`;
    local.send({ type: 'app-send-file-commit', payload: { requestId: reqCommit, messageId, transferId } } as AppClientFrame);
    expect(await local.waitFor((frame) => requestIdOf(frame) === reqCommit)).toMatchObject({
      type: 'app-send-result',
      payload: { status: 'received' },
    });

    const bPath = join(
      daemonB.appRootDir,
      'app-inbox/files',
      encodeAppPathSegment('daemon-a'),
      encodeAppPathSegment(messageId),
      file.fileName,
    );
    expect((await readFile(bPath)).equals(data)).toBe(true);
    expect(recorder.connections).toBe(0);
  });
});
