import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import {
  APP_FILE_CHUNK_BYTES,
  computeAppChunkCount,
  encodeAppPathSegment,
  type AppClientFrame,
  type AppServerFrame,
} from '@zterm/shared/app-protocol';
import {
  createDaemonAppMessagingRuntime,
  type AppLink,
  type DaemonAppMessagingRuntime,
} from './daemon-app-messaging-runtime';

type Listener = (...args: unknown[]) => void;

class FakeSocket {
  readyState = 1;
  peer!: FakeSocket;
  private readonly listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener) {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  once(event: string, listener: Listener) {
    if (event === 'open' && this.readyState === 1) {
      queueMicrotask(() => listener());
      return this;
    }
    const wrapped: Listener = (...args) => {
      this.listeners.get(event)?.delete(wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  send(text: string, callback?: (error?: Error) => void) {
    queueMicrotask(() => {
      this.peer.emit('message', Buffer.from(text, 'utf8'), false);
      callback?.();
    });
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => {
      this.emit('close', code, reason);
      this.peer.readyState = 3;
      this.peer.emit('close', code, reason);
    });
  }

  terminate() {
    this.close(1006, 'terminated');
  }
}

function socketPair(): [FakeSocket, FakeSocket] {
  const left = new FakeSocket();
  const right = new FakeSocket();
  left.peer = right;
  right.peer = left;
  left.readyState = 1;
  return [left, right];
}

type Bridge = {
  runtime: DaemonAppMessagingRuntime;
  appRootDir: string;
  daemonHostId: string;
  deviceId: string;
};

function captureLink(role: 'local' | 'peer', deviceId: string, daemonHostId: string) {
  const frames: AppServerFrame[] = [];
  const closes: string[] = [];
  const link: AppLink = {
    id: `link-${randomUUID()}`,
    role,
    deviceId,
    daemonHostId,
    send(frame) {
      frames.push(frame);
      return true;
    },
    close(reason) {
      closes.push(reason);
    },
  };
  return { link, frames, closes };
}

/**
 * Bridges a peer transport to a daemon runtime the same way the gateway does:
 * answer `app-hello` once, then delegate every frame to `daemon.app_messaging`.
 */
function attachPeerTransport(bridge: Bridge, socket: FakeSocket) {
  let link: AppLink | null = null;
  socket.on('message', (raw) => {
    const frame = JSON.parse(Buffer.from(raw as Buffer).toString('utf8')) as AppClientFrame;
    if (frame.type === 'app-hello') {
      link = {
        id: `peer-${randomUUID()}`,
        role: 'peer',
        deviceId: frame.payload.deviceId,
        daemonHostId: frame.payload.daemonHostId,
        send(serverFrame) {
          socket.send(JSON.stringify(serverFrame));
          return true;
        },
        close(reason) {
          socket.close(1000, reason);
        },
      };
      socket.send(JSON.stringify({
        type: 'app-ready',
        payload: {
          requestId: frame.payload.requestId,
          protocolVersion: 1,
          deviceId: bridge.deviceId,
          daemonHostId: bridge.daemonHostId,
          capabilities: {},
        },
      }));
      return;
    }
    if (link) void bridge.runtime.handleFrame(link, frame);
  });
}

async function createBridge(options: {
  root: string;
  deviceId: string;
  daemonHostId: string;
  maxInboxRecords?: number;
  peerRequestTimeoutMs?: number;
  createWebSocket?: (url: string, token: string) => WebSocket;
}) {
  const runtime = createDaemonAppMessagingRuntime({
    appRootDir: join(options.root, 'app'),
    deviceId: options.deviceId,
    daemonHostId: options.daemonHostId,
    ...(options.maxInboxRecords === undefined ? {} : { maxInboxRecords: options.maxInboxRecords }),
    peerRequestTimeoutMs: options.peerRequestTimeoutMs ?? 2_000,
    ...(options.createWebSocket ? { createWebSocket: options.createWebSocket } : {}),
  });
  await runtime.initialize();
  return { runtime, appRootDir: join(options.root, 'app'), deviceId: options.deviceId, daemonHostId: options.daemonHostId } satisfies Bridge;
}

function target(bridge: Bridge) {
  return {
    deviceId: bridge.deviceId,
    daemonHostId: bridge.daemonHostId,
    wsUrl: `ws://in-memory/${bridge.daemonHostId}`,
    authToken: 'test-token',
  };
}

async function waitForFrames<T extends AppServerFrame>(
  frames: AppServerFrame[],
  predicate: (frame: AppServerFrame) => boolean,
  timeoutMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = frames.find(predicate);
    if (found) return found as T;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`frame not observed: ${JSON.stringify(frames)}`);
}

function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'zterm-app-'));
  roots.push(root);
  return root;
}

describe('daemon /app transport', () => {
  it('delivers a multiline message, persists it, replays on subscribe, and settles ack/consume', async () => {
    const root = await tempRoot();
    const bridgeB = await createBridge({ root: join(root, 'b'), deviceId: 'device-b', daemonHostId: 'daemon-b' });
    const [clientSocket, serverSocket] = socketPair();
    attachPeerTransport(bridgeB, serverSocket);
    const bridgeA = await createBridge({
      root: join(root, 'a'),
      deviceId: 'device-a',
      daemonHostId: 'daemon-a',
      createWebSocket: () => clientSocket as unknown as WebSocket,
    });
    const local = captureLink('local', 'device-a', 'daemon-a');
    const messageId = `msg-${randomUUID()}`;
    const body = 'line one\nline two\n{"json":"exact"}';

    await bridgeA.runtime.handleFrame(local.link, {
      type: 'app-send-message',
      payload: {
        requestId: randomUUID(),
        messageId,
        target: target(bridgeB),
        subject: 'multiline',
        body,
      },
    });
    const receipt = await waitForFrames(local.frames, (frame) => frame.type === 'app-send-result');
    expect(receipt).toMatchObject({ type: 'app-send-result', payload: { status: 'received' } });

    const recordPath = join(
      bridgeB.appRootDir,
      'app-inbox/records',
      encodeAppPathSegment('daemon-a'),
      encodeAppPathSegment(messageId),
      'record.json',
    );
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record.body).toBe(body);
    expect(record.state).toBe('received');

    const subscriber = captureLink('local', 'device-b', 'daemon-b');
    await bridgeB.runtime.subscribeLocal(subscriber.link);
    const replay = subscriber.frames.find((frame) => frame.type === 'app-inbound-message');
    expect(replay).toMatchObject({ type: 'app-inbound-message', payload: { messageId, body, state: 'received' } });

    await bridgeB.runtime.handleFrame(subscriber.link, {
      type: 'app-ack',
      payload: { requestId: randomUUID(), messageId },
    });
    const acked = await waitForFrames(subscriber.frames, (frame) => frame.type === 'app-status-result');
    expect(acked).toMatchObject({ type: 'app-status-result', payload: { state: 'delivered' } });
    await bridgeB.runtime.handleFrame(subscriber.link, {
      type: 'app-consume',
      payload: { requestId: randomUUID(), messageId },
    });
    const consumed = subscriber.frames.filter((frame) => frame.type === 'app-status-result').at(-1);
    expect(consumed).toMatchObject({ type: 'app-status-result', payload: { state: 'consumed' } });
    const lateAckRequestId = randomUUID();
    await bridgeB.runtime.handleFrame(subscriber.link, {
      type: 'app-ack',
      payload: { requestId: lateAckRequestId, messageId },
    });
    const lateAck = subscriber.frames.find(
      (frame) => frame.type === 'app-status-result' && frame.payload.requestId === lateAckRequestId,
    );
    expect(lateAck).toMatchObject({ type: 'app-status-result', payload: { state: 'consumed' } });

    // Consumed records are acknowledged and must not replay on a new subscriber.
    const lateSubscriber = captureLink('local', 'device-b', 'daemon-b');
    await bridgeB.runtime.subscribeLocal(lateSubscriber.link);
    expect(lateSubscriber.frames.filter((frame) => frame.type === 'app-inbound-message')).toHaveLength(0);
  });

  it('keeps identical retries idempotent and rejects conflicting content', async () => {
    const root = await tempRoot();
    const bridgeB = await createBridge({ root: join(root, 'b'), deviceId: 'device-b', daemonHostId: 'daemon-b' });
    const [clientSocket, serverSocket] = socketPair();
    attachPeerTransport(bridgeB, serverSocket);
    const bridgeA = await createBridge({
      root: join(root, 'a'),
      deviceId: 'device-a',
      daemonHostId: 'daemon-a',
      createWebSocket: () => clientSocket as unknown as WebSocket,
    });
    const local = captureLink('local', 'device-a', 'daemon-a');
    const messageId = `msg-${randomUUID()}`;
    const send = (body: string) => bridgeA.runtime.handleFrame(local.link, {
      type: 'app-send-message',
      payload: { requestId: randomUUID(), messageId, target: target(bridgeB), subject: 'dedupe', body },
    });

    await send('same');
    await waitForFrames(local.frames, (frame) => frame.type === 'app-send-result');
    local.frames.length = 0;
    await send('same');
    await waitForFrames(local.frames, (frame) => frame.type === 'app-send-result');
    local.frames.length = 0;
    await send('different');
    const conflict = await waitForFrames(local.frames, (frame) => frame.type === 'app-error');
    expect(conflict).toMatchObject({ type: 'app-error', payload: { code: 'message_id_conflict' } });
  });

  it('rejects a parallel transfer and a racing message that reuse a staged message key', async () => {
    const root = await tempRoot();
    const bridgeB = await createBridge({ root: join(root, 'b'), deviceId: 'device-b', daemonHostId: 'daemon-b' });
    const peer = captureLink('peer', 'device-a', 'daemon-a');
    const request = async (frame: AppClientFrame) => {
      peer.frames.length = 0;
      await bridgeB.runtime.handleFrame(peer.link, frame);
      return waitForFrames(peer.frames, () => true);
    };
    const bytes = Buffer.alloc(10_000, 7);
    const messageId = `file-${randomUUID()}`;
    const metadata = (transferId: string) => ({
      transferId,
      fileName: 'a.bin',
      totalBytes: bytes.length,
      chunkCount: computeAppChunkCount(bytes.length),
      sha256: sha256(bytes),
    });
    const first = await request({
      type: 'app-send-file-start',
      payload: { requestId: randomUUID(), messageId, subject: 'x', file: metadata(`t1-${randomUUID()}`) },
    });
    expect(first).toMatchObject({ type: 'app-send-result', payload: { status: 'receiving' } });

    const parallel = await request({
      type: 'app-send-file-start',
      payload: { requestId: randomUUID(), messageId, subject: 'x', file: metadata(`t2-${randomUUID()}`) },
    });
    expect(parallel).toMatchObject({ type: 'app-error', payload: { code: 'message_id_conflict' } });

    const racingMessage = await request({
      type: 'app-send-message',
      payload: { requestId: randomUUID(), messageId, subject: 'x', body: 'racing' },
    });
    expect(racingMessage).toMatchObject({ type: 'app-error', payload: { code: 'message_id_conflict' } });
  });

  it('keeps two senders with the same messageId independent for scoped ack', async () => {
    const root = await tempRoot();
    const bridgeB = await createBridge({ root: join(root, 'b'), deviceId: 'device-b', daemonHostId: 'daemon-b' });
    const sent = async (senderDaemonHostId: string) => {
      const sender = captureLink('peer', `device-${senderDaemonHostId}`, senderDaemonHostId);
      sender.frames.length = 0;
      await bridgeB.runtime.handleFrame(sender.link, {
        type: 'app-send-message',
        payload: { requestId: randomUUID(), messageId: 'shared', subject: 'shared', body: senderDaemonHostId },
      });
      return waitForFrames(sender.frames, (frame) => frame.type === 'app-send-result');
    };
    await sent('daemon-a');
    await sent('daemon-c');

    const local = captureLink('local', 'device-b', 'daemon-b');
    await bridgeB.runtime.handleFrame(local.link, {
      type: 'app-ack',
      payload: { requestId: randomUUID(), messageId: 'shared', senderDaemonHostId: 'daemon-a' },
    });
    const acked = await waitForFrames(local.frames, (frame) => frame.type === 'app-status-result');
    expect(acked).toMatchObject({ type: 'app-status-result', payload: { senderDaemonHostId: 'daemon-a', state: 'delivered' } });

    local.frames.length = 0;
    await bridgeB.runtime.handleFrame(local.link, {
      type: 'app-status',
      payload: { requestId: randomUUID(), messageId: 'shared', senderDaemonHostId: 'daemon-c' },
    });
    const other = await waitForFrames(local.frames, (frame) => frame.type === 'app-status-result');
    expect(other).toMatchObject({ type: 'app-status-result', payload: { senderDaemonHostId: 'daemon-c', state: 'received' } });
  });

  it('accepts files only after commit and enforces integrity and resume', async () => {
    const root = await tempRoot();
    const bridgeB = await createBridge({ root: join(root, 'b'), deviceId: 'device-b', daemonHostId: 'daemon-b' });
    const [clientSocket, serverSocket] = socketPair();
    attachPeerTransport(bridgeB, serverSocket);
    const bridgeA = await createBridge({
      root: join(root, 'a'),
      deviceId: 'device-a',
      daemonHostId: 'daemon-a',
      createWebSocket: () => clientSocket as unknown as WebSocket,
    });
    const local = captureLink('local', 'device-a', 'daemon-a');
    const bytes = Buffer.alloc(40_000);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31) % 251;
    const messageId = `file-${randomUUID()}`;
    const transferId = `transfer-${randomUUID()}`;
    const file = {
      transferId,
      fileName: 'evidence.bin',
      totalBytes: bytes.length,
      chunkCount: Math.ceil(bytes.length / APP_FILE_CHUNK_BYTES),
      sha256: sha256(bytes),
    };

    await bridgeA.runtime.handleFrame(local.link, {
      type: 'app-send-file-start',
      payload: { requestId: randomUUID(), messageId, target: target(bridgeB), subject: 'file', file },
    });
    await waitForFrames(local.frames, (frame) => frame.type === 'app-send-result' && frame.payload.status === 'receiving');
    const finalPath = join(
      bridgeB.appRootDir,
      'app-inbox/files',
      encodeAppPathSegment('daemon-a'),
      encodeAppPathSegment(messageId),
      file.fileName,
    );
    await expect(readFile(finalPath)).rejects.toThrow();

    for (const chunkIndex of [0, 1]) {
      const offset = chunkIndex * APP_FILE_CHUNK_BYTES;
      const chunk = bytes.subarray(offset, offset + APP_FILE_CHUNK_BYTES);
      local.frames.length = 0;
      await bridgeA.runtime.handleFrame(local.link, {
        type: 'app-send-file-chunk',
        payload: {
          requestId: randomUUID(), messageId, transferId, offset, chunkIndex,
          dataBase64: chunk.toString('base64'),
        },
      });
      const result = await waitForFrames(local.frames, (frame) => frame.type === 'app-send-result');
      expect(result).toMatchObject({ payload: { persistedOffset: offset + chunk.length } });
    }

    // Reconnect: a peer transport that resumes from the persisted offset.
    const peerLink = captureLink('peer', 'device-a', 'daemon-a');
    const bridgeToPeer = async (frame: AppClientFrame) => {
      peerLink.frames.length = 0;
      await bridgeB.runtime.handleFrame(peerLink.link, frame);
      return waitForFrames(peerLink.frames, () => true);
    };
    const resumed = await bridgeToPeer({
      type: 'app-send-file-start',
      payload: { requestId: randomUUID(), messageId, subject: 'file', file },
    });
    expect(resumed).toMatchObject({
      type: 'app-send-result',
      payload: { status: 'receiving', persistedOffset: APP_FILE_CHUNK_BYTES * 2 },
    });
    const duplicate = bytes.subarray(0, APP_FILE_CHUNK_BYTES);
    const duplicateResult = await bridgeToPeer({
      type: 'app-send-file-chunk',
      payload: {
        requestId: randomUUID(), messageId, transferId, offset: 0, chunkIndex: 0,
        dataBase64: duplicate.toString('base64'),
      },
    });
    expect(duplicateResult).toMatchObject({ payload: { persistedOffset: APP_FILE_CHUNK_BYTES * 2 } });
    const corrupted = Buffer.from(duplicate);
    corrupted[0] = (corrupted[0]! + 1) % 256;
    const conflict = await bridgeToPeer({
      type: 'app-send-file-chunk',
      payload: {
        requestId: randomUUID(), messageId, transferId, offset: 0, chunkIndex: 0,
        dataBase64: corrupted.toString('base64'),
      },
    });
    expect(conflict).toMatchObject({ type: 'app-error', payload: { code: 'chunk_conflict' } });

    for (let chunkIndex = 2; chunkIndex < file.chunkCount; chunkIndex += 1) {
      const offset = chunkIndex * APP_FILE_CHUNK_BYTES;
      const chunk = bytes.subarray(offset, offset + APP_FILE_CHUNK_BYTES);
      await bridgeToPeer({
        type: 'app-send-file-chunk',
        payload: {
          requestId: randomUUID(), messageId, transferId, offset, chunkIndex,
          dataBase64: chunk.toString('base64'),
        },
      });
    }
    const committed = await bridgeToPeer({
      type: 'app-send-file-commit',
      payload: { requestId: randomUUID(), messageId, transferId },
    });
    expect(committed).toMatchObject({ type: 'app-send-result', payload: { status: 'received' } });
    expect((await readFile(finalPath)).equals(bytes)).toBe(true);
  });

  it('does not publish before commit and completes commit after a daemon restart', async () => {
    const root = await tempRoot();
    const bridgeB = await createBridge({ root: join(root, 'b'), deviceId: 'device-b', daemonHostId: 'daemon-b' });
    const peer = captureLink('peer', 'device-a', 'daemon-a');
    const bytes = Buffer.alloc(20_000, 3);
    const messageId = `file-${randomUUID()}`;
    const transferId = `transfer-${randomUUID()}`;
    const file = {
      transferId,
      fileName: 'crash.bin',
      totalBytes: bytes.length,
      chunkCount: Math.ceil(bytes.length / APP_FILE_CHUNK_BYTES),
      sha256: sha256(bytes),
    };
    const request = async (frame: AppClientFrame) => {
      peer.frames.length = 0;
      await bridgeB.runtime.handleFrame(peer.link, frame);
      return waitForFrames(peer.frames, () => true);
    };
    await request({ type: 'app-send-file-start', payload: { requestId: randomUUID(), messageId, subject: 'crash', file } });
    for (let chunkIndex = 0; chunkIndex < file.chunkCount; chunkIndex += 1) {
      const offset = chunkIndex * APP_FILE_CHUNK_BYTES;
      const chunk = bytes.subarray(offset, offset + APP_FILE_CHUNK_BYTES);
      await request({
        type: 'app-send-file-chunk',
        payload: {
          requestId: randomUUID(), messageId, transferId, offset, chunkIndex,
          dataBase64: chunk.toString('base64'),
        },
      });
    }
    const finalPath = join(
      bridgeB.appRootDir,
      'app-inbox/files',
      encodeAppPathSegment('daemon-a'),
      encodeAppPathSegment(messageId),
      file.fileName,
    );
    await expect(readFile(finalPath)).rejects.toThrow();

    bridgeB.runtime.dispose();
    const restarted = await createBridge({ root: join(root, 'b'), deviceId: 'device-b', daemonHostId: 'daemon-b' });
    const peer2 = captureLink('peer', 'device-a', 'daemon-a');
    peer2.frames.length = 0;
    await restarted.runtime.handleFrame(peer2.link, {
      type: 'app-send-file-commit',
      payload: { requestId: randomUUID(), messageId, transferId },
    });
    const committed = await waitForFrames(peer2.frames, () => true);
    expect(committed).toMatchObject({ type: 'app-send-result', payload: { status: 'received' } });
    expect((await readFile(finalPath)).equals(bytes)).toBe(true);
  });

  it('completes a self-target file transfer and settles its outbox', async () => {
    const root = await tempRoot();
    const bridge = await createBridge({ root: join(root, 'b'), deviceId: 'device-b', daemonHostId: 'daemon-b' });
    const local = captureLink('local', 'device-b', 'daemon-b');
    const selfTarget = {
      deviceId: 'device-b',
      daemonHostId: 'daemon-b',
      wsUrl: 'ws://self/loopback',
      authToken: 'test-token',
    };
    const request = async (frame: AppClientFrame) => {
      local.frames.length = 0;
      await bridge.runtime.handleFrame(local.link, frame);
      return waitForFrames(local.frames, () => true);
    };
    const bytes = Buffer.alloc(5_000, 9);
    const messageId = `self-${randomUUID()}`;
    const transferId = `self-transfer-${randomUUID()}`;
    const file = {
      transferId,
      fileName: 'self.bin',
      totalBytes: bytes.length,
      chunkCount: computeAppChunkCount(bytes.length),
      sha256: sha256(bytes),
    };

    const start = await request({
      type: 'app-send-file-start',
      payload: { requestId: randomUUID(), messageId, target: selfTarget, subject: 'self', file },
    });
    expect(start).toMatchObject({ type: 'app-send-result', payload: { status: 'receiving' } });
    for (let chunkIndex = 0; chunkIndex < file.chunkCount; chunkIndex += 1) {
      const offset = chunkIndex * APP_FILE_CHUNK_BYTES;
      const chunk = bytes.subarray(offset, offset + APP_FILE_CHUNK_BYTES);
      const result = await request({
        type: 'app-send-file-chunk',
        payload: { requestId: randomUUID(), messageId, transferId, offset, chunkIndex, dataBase64: chunk.toString('base64') },
      });
      expect(result).toMatchObject({ type: 'app-send-result', payload: { persistedOffset: offset + chunk.length } });
    }
    const committed = await request({
      type: 'app-send-file-commit',
      payload: { requestId: randomUUID(), messageId, transferId },
    });
    expect(committed).toMatchObject({ type: 'app-send-result', payload: { status: 'received' } });

    const finalPath = join(
      bridge.appRootDir,
      'app-inbox/files',
      encodeAppPathSegment('daemon-b'),
      encodeAppPathSegment(messageId),
      file.fileName,
    );
    expect((await readFile(finalPath)).equals(bytes)).toBe(true);
    const outbox = JSON.parse(await readFile(
      join(bridge.appRootDir, 'app-outbox/records', encodeAppPathSegment('daemon-b'), encodeAppPathSegment(messageId), 'record.json'),
      'utf8',
    )) as { state: string };
    expect(outbox.state).toBe('received');
  });

  it('keeps interleaved file transfers with the same transferId on their own peer routes', async () => {
    const root = await tempRoot();
    const bridgeB = await createBridge({ root: join(root, 'b'), deviceId: 'device-b', daemonHostId: 'daemon-b' });
    const bridgeC = await createBridge({ root: join(root, 'c'), deviceId: 'device-c', daemonHostId: 'daemon-c' });
    const [toB, serverB] = socketPair();
    attachPeerTransport(bridgeB, serverB);
    const [toC, serverC] = socketPair();
    attachPeerTransport(bridgeC, serverC);
    const bridgeA = await createBridge({
      root: join(root, 'a'),
      deviceId: 'device-a',
      daemonHostId: 'daemon-a',
      createWebSocket: (url) => (url.endsWith('daemon-c') ? toC : toB) as unknown as WebSocket,
    });
    const localOne = captureLink('local', 'device-a', 'daemon-a');
    const localTwo = captureLink('local', 'device-a', 'daemon-a');
    // Two local CLIs pass the same --message-id; the CLI derives transferId from it.
    const messageId = `shared-${randomUUID()}`;
    const transferId = messageId;
    const bytesOne = Buffer.alloc(40_000);
    for (let index = 0; index < bytesOne.length; index += 1) bytesOne[index] = index % 251;
    const bytesTwo = Buffer.alloc(24_000);
    for (let index = 0; index < bytesTwo.length; index += 1) bytesTwo[index] = (index * 7 + 3) % 251;
    const fileOne = {
      transferId,
      fileName: 'one.bin',
      totalBytes: bytesOne.length,
      chunkCount: Math.ceil(bytesOne.length / APP_FILE_CHUNK_BYTES),
      sha256: sha256(bytesOne),
    };
    const fileTwo = {
      transferId,
      fileName: 'two.bin',
      totalBytes: bytesTwo.length,
      chunkCount: Math.ceil(bytesTwo.length / APP_FILE_CHUNK_BYTES),
      sha256: sha256(bytesTwo),
    };
    const request = async (link: ReturnType<typeof captureLink>, frame: AppClientFrame) => {
      link.frames.length = 0;
      await bridgeA.runtime.handleFrame(link.link, frame);
      return waitForFrames<AppServerFrame>(link.frames, () => true);
    };
    const startFile = (link: ReturnType<typeof captureLink>, file: typeof fileOne, peer: Bridge) => request(
      link,
      {
        type: 'app-send-file-start',
        payload: { requestId: randomUUID(), messageId, target: target(peer), subject: file.fileName, file },
      },
    );
    const sendChunk = (
      link: ReturnType<typeof captureLink>,
      file: typeof fileOne,
      bytes: Buffer,
      chunkIndex: number,
    ) => {
      const offset = chunkIndex * APP_FILE_CHUNK_BYTES;
      const chunk = bytes.subarray(offset, offset + APP_FILE_CHUNK_BYTES);
      return request(link, {
        type: 'app-send-file-chunk',
        payload: {
          requestId: randomUUID(),
          messageId,
          transferId: file.transferId,
          offset,
          chunkIndex,
          dataBase64: chunk.toString('base64'),
        },
      });
    };

    expect(await startFile(localOne, fileOne, bridgeB)).toMatchObject({ payload: { status: 'receiving' } });
    expect(await startFile(localTwo, fileTwo, bridgeC)).toMatchObject({ payload: { status: 'receiving' } });
    expect(await sendChunk(localOne, fileOne, bytesOne, 0)).toMatchObject({ payload: { persistedOffset: APP_FILE_CHUNK_BYTES } });
    expect(await sendChunk(localTwo, fileTwo, bytesTwo, 0)).toMatchObject({ payload: { persistedOffset: APP_FILE_CHUNK_BYTES } });
    expect(await sendChunk(localOne, fileOne, bytesOne, 1)).toMatchObject({ payload: { persistedOffset: APP_FILE_CHUNK_BYTES * 2 } });
    expect(await sendChunk(localOne, fileOne, bytesOne, 2)).toMatchObject({ payload: { persistedOffset: bytesOne.length } });
    const commitOne = await request(localOne, {
      type: 'app-send-file-commit',
      payload: { requestId: randomUUID(), messageId, transferId },
    });
    expect(commitOne).toMatchObject({ type: 'app-send-result', payload: { status: 'received', transferId } });

    // The finished route must not disturb the second transfer.
    expect(await sendChunk(localTwo, fileTwo, bytesTwo, 1)).toMatchObject({ payload: { persistedOffset: bytesTwo.length } });
    const commitTwo = await request(localTwo, {
      type: 'app-send-file-commit',
      payload: { requestId: randomUUID(), messageId, transferId },
    });
    expect(commitTwo).toMatchObject({ type: 'app-send-result', payload: { status: 'received', transferId } });

    const finalOne = join(
      bridgeB.appRootDir,
      'app-inbox/files',
      encodeAppPathSegment('daemon-a'),
      encodeAppPathSegment(messageId),
      fileOne.fileName,
    );
    const finalTwo = join(
      bridgeC.appRootDir,
      'app-inbox/files',
      encodeAppPathSegment('daemon-a'),
      encodeAppPathSegment(messageId),
      fileTwo.fileName,
    );
    expect((await readFile(finalOne)).equals(bytesOne)).toBe(true);
    expect((await readFile(finalTwo)).equals(bytesTwo)).toBe(true);

    // A late chunk from the finished route is rejected instead of reaching the other peer.
    const stale = await sendChunk(localOne, fileOne, bytesOne, 0);
    expect(stale).toMatchObject({ type: 'app-error', payload: { code: 'invalid_state' } });
    expect((await readFile(finalTwo)).equals(bytesTwo)).toBe(true);

    // One connection cannot rebind a live transferId to another message.
    const otherTransfer = `rebind-${randomUUID()}`;
    expect(await request(localOne, {
      type: 'app-send-file-start',
      payload: {
        requestId: randomUUID(),
        messageId: 'rebind-a',
        target: target(bridgeB),
        subject: 'rebind',
        file: { ...fileOne, transferId: otherTransfer },
      },
    })).toMatchObject({ payload: { status: 'receiving' } });
    const conflict = await request(localOne, {
      type: 'app-send-file-start',
      payload: {
        requestId: randomUUID(),
        messageId: 'rebind-b',
        target: target(bridgeC),
        subject: 'rebind',
        file: { ...fileOne, transferId: otherTransfer },
      },
    });
    expect(conflict).toMatchObject({ type: 'app-error', payload: { code: 'transfer_conflict' } });
  });

  it('reports resultUnknown after a transport loss following send and unreachable when offline', async () => {
    const root = await tempRoot();
    const dropping = new FakeSocket();
    const remote = new FakeSocket();
    dropping.peer = remote;
    remote.peer = dropping;
    dropping.readyState = 1;
    remote.on('message', (raw) => {
      const frame = JSON.parse(Buffer.from(raw as Buffer).toString('utf8')) as AppClientFrame;
      if (frame.type === 'app-hello') {
        remote.send(JSON.stringify({
          type: 'app-ready',
          payload: {
            requestId: frame.payload.requestId,
            protocolVersion: 1,
            deviceId: 'device-b',
            daemonHostId: 'daemon-b',
            capabilities: {},
          },
        }));
        return;
      }
      remote.terminate();
    });
    const bridgeA = await createBridge({
      root: join(root, 'a'),
      deviceId: 'device-a',
      daemonHostId: 'daemon-a',
      createWebSocket: () => dropping as unknown as WebSocket,
    });
    const local = captureLink('local', 'device-a', 'daemon-a');
    await bridgeA.runtime.handleFrame(local.link, {
      type: 'app-send-message',
      payload: {
        requestId: randomUUID(),
        messageId: `msg-${randomUUID()}`,
        target: { deviceId: 'device-b', daemonHostId: 'daemon-b', wsUrl: 'ws://drop/app', authToken: 'x' },
        subject: 'unknown',
        body: 'drop',
      },
    });
    const unknown = await waitForFrames(local.frames, (frame) => frame.type === 'app-send-result');
    expect(unknown).toMatchObject({ type: 'app-send-result', payload: { status: 'resultUnknown' } });

    const offline = new FakeSocket();
    offline.readyState = 0;
    queueMicrotask(() => {
      offline.readyState = 3;
      offline.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:1'));
    });
    const bridgeOffline = await createBridge({
      root: join(root, 'offline'),
      deviceId: 'device-a',
      daemonHostId: 'daemon-a',
      createWebSocket: () => offline as unknown as WebSocket,
    });
    const offlineLink = captureLink('local', 'device-a', 'daemon-a');
    await bridgeOffline.runtime.handleFrame(offlineLink.link, {
      type: 'app-send-message',
      payload: {
        requestId: randomUUID(),
        messageId: `msg-${randomUUID()}`,
        target: { deviceId: 'device-b', daemonHostId: 'daemon-b', wsUrl: 'ws://offline/app', authToken: 'x' },
        subject: 'offline',
        body: 'offline',
      },
    });
    const unreachable = await waitForFrames(offlineLink.frames, (frame) => frame.type === 'app-error');
    expect(unreachable).toMatchObject({ type: 'app-error', payload: { code: 'unreachable' } });
  });

  it('reports unreachable when a new peer refuses the connection during the handshake', async () => {
    const root = await tempRoot();
    const offline = new FakeSocket();
    offline.readyState = 0;
    const bridge = await createBridge({
      root: join(root, 'offline-handshake'),
      deviceId: 'device-a',
      daemonHostId: 'daemon-a',
      createWebSocket: () => {
        setTimeout(() => {
          offline.readyState = 3;
          offline.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:1'));
        }, 0);
        return offline as unknown as WebSocket;
      },
    });
    const local = captureLink('local', 'device-a', 'daemon-a');

    await bridge.runtime.handleFrame(local.link, {
      type: 'app-send-message',
      payload: {
        requestId: randomUUID(),
        messageId: `msg-${randomUUID()}`,
        target: { deviceId: 'device-b', daemonHostId: 'daemon-b', wsUrl: 'ws://offline/app', authToken: 'x' },
        subject: 'offline handshake',
        body: 'refused',
      },
    });

    const outcome = await waitForFrames(
      local.frames,
      (frame) => frame.type === 'app-error' || frame.type === 'app-send-result',
    );
    expect(outcome).toMatchObject({ type: 'app-error', payload: { code: 'unreachable' } });
  });

  it('reports unreachable when a reused peer link is stale after the remote closed', async () => {
    const root = await tempRoot();
    const [clientSocket, serverSocket] = socketPair();
    let businessAnswered = false;
    serverSocket.on('message', (raw) => {
      const frame = JSON.parse(Buffer.from(raw as Buffer).toString('utf8')) as AppClientFrame;
      if (frame.type === 'app-hello') {
        serverSocket.send(JSON.stringify({
          type: 'app-ready',
          payload: {
            requestId: frame.payload.requestId,
            protocolVersion: 1,
            deviceId: 'device-b',
            daemonHostId: 'daemon-b',
            capabilities: {},
          },
        }));
        return;
      }
      if (frame.type === 'app-send-message' && !businessAnswered) {
        businessAnswered = true;
        serverSocket.send(JSON.stringify({
          type: 'app-send-result',
          payload: {
            requestId: frame.payload.requestId,
            messageId: frame.payload.messageId,
            status: 'received',
            stage: 'received',
          },
        }));
        return;
      }
      // The remote is gone, but the local socket has not observed the close
      // yet: it stays OPEN and never answers app-ping or the next request.
    });
    let createCalls = 0;
    const bridgeA = await createBridge({
      root: join(root, 'a'),
      deviceId: 'device-a',
      daemonHostId: 'daemon-a',
      peerRequestTimeoutMs: 200,
      createWebSocket: () => {
        createCalls += 1;
        if (createCalls === 1) return clientSocket as unknown as WebSocket;
        const offline = new FakeSocket();
        offline.readyState = 0;
        const offlinePeer = new FakeSocket();
        offline.peer = offlinePeer;
        offlinePeer.peer = offline;
        return offline as unknown as WebSocket;
      },
    });
    const local = captureLink('local', 'device-a', 'daemon-a');
    const peerTarget = {
      deviceId: 'device-b',
      daemonHostId: 'daemon-b',
      wsUrl: 'ws://in-memory/daemon-b',
      authToken: 'test-token',
    };

    await bridgeA.runtime.handleFrame(local.link, {
      type: 'app-send-message',
      payload: {
        requestId: randomUUID(),
        messageId: `msg-${randomUUID()}`,
        target: peerTarget,
        subject: 'prime',
        body: 'prime the peer link',
      },
    });
    expect(await waitForFrames(local.frames, (frame) => frame.type === 'app-send-result')).toMatchObject({
      type: 'app-send-result',
      payload: { status: 'received' },
    });

    local.frames.length = 0;
    await bridgeA.runtime.handleFrame(local.link, {
      type: 'app-send-message',
      payload: {
        requestId: randomUUID(),
        messageId: `msg-${randomUUID()}`,
        target: peerTarget,
        subject: 'stale',
        body: 'reuse the stale link',
      },
    });
    const stale = await waitForFrames(local.frames, () => true);
    expect(stale).toMatchObject({ type: 'app-error', payload: { code: 'unreachable' } });
  });

  it('enforces inbox limits, peer role restrictions, and slow-consumer release', async () => {
    const root = await tempRoot();
    const bridge = await createBridge({
      root,
      deviceId: 'device-b',
      daemonHostId: 'daemon-b',
      maxInboxRecords: 1,
    });
    const peer = captureLink('peer', 'device-a', 'daemon-a');
    const send = async (body: string) => {
      peer.frames.length = 0;
      await bridge.runtime.handleFrame(peer.link, {
        type: 'app-send-message',
        payload: { requestId: randomUUID(), messageId: `msg-${randomUUID()}`, subject: 'limit', body },
      });
      return waitForFrames(peer.frames, () => true);
    };
    expect(await send('first')).toMatchObject({ type: 'app-send-result' });
    expect(await send('second')).toMatchObject({ type: 'app-error', payload: { code: 'inbox_full' } });

    peer.frames.length = 0;
    await bridge.runtime.handleFrame(peer.link, {
      type: 'app-ack',
      payload: { requestId: randomUUID(), messageId: 'any' },
    });
    expect(await waitForFrames(peer.frames, () => true)).toMatchObject({
      type: 'app-error',
      payload: { code: 'forbidden_role' },
    });

    const slow = {
      id: 'slow',
      role: 'local' as const,
      deviceId: 'device-b',
      daemonHostId: 'daemon-b',
      send: () => false,
      close: () => undefined,
    };
    const closes: string[] = [];
    const slowLink: AppLink = {
      ...slow,
      close: (reason) => {
        closes.push(reason);
      },
    };
    await bridge.runtime.subscribeLocal(slowLink);
    expect(closes).toContain('slow_consumer');
  });
});
