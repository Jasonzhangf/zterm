import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import {
  APP_FILE_CHUNK_BYTES,
  computeAppChunkCount,
  encodeAppPathSegment,
  type AppClientFrame,
  type AppServerFrame,
} from '@zterm/shared/app-protocol';
import type { AppInboxRecord, AppStagingMetadata } from './daemon-app-messaging-store';
import { DaemonAppMessagingStore } from './daemon-app-messaging-store';
import {
  attachPeerTransport,
  FakeSocket,
  type Bridge,
  captureLink,
  createBridge,
  peerTarget,
  sha256,
  socketPair,
  tempRootRegistry,
  waitForFrames,
} from './daemon-app-messaging-test-harness';

const registry = tempRootRegistry();

afterEach(async () => {
  await registry.cleanup();
});

function sendFileMetadata(bytes: Buffer, transferId: string, fileName: string) {
  return {
    transferId,
    fileName,
    totalBytes: bytes.length,
    chunkCount: computeAppChunkCount(bytes.length),
    sha256: sha256(bytes),
  };
}

describe('daemon /app messaging recovery', () => {
  it('publishes an empty file whose commit crashed after the verified metadata write', async () => {
    const root = await registry.root();
    const bridgeB = await createBridge({ root: join(root, 'b'), deviceId: 'device-b', daemonHostId: 'daemon-b' });
    const [, serverSocket] = socketPair();
    attachPeerTransport(bridgeB, serverSocket);
    const peer = captureLink('peer', 'device-a', 'daemon-a');
    const messageId = `empty-${randomUUID()}`;
    const transferId = messageId;
    const bytes = Buffer.alloc(0);
    const file = sendFileMetadata(bytes, transferId, 'empty.bin');
    const request = async (frame: AppClientFrame) => {
      peer.frames.length = 0;
      await bridgeB.runtime.handleFrame(peer.link, frame);
      return waitForFrames<AppServerFrame>(peer.frames, () => true);
    };

    const started = await request({
      type: 'app-send-file-start',
      payload: { requestId: randomUUID(), messageId, subject: 'empty', file },
    });
    expect(started).toMatchObject({ type: 'app-send-result', payload: { status: 'receiving' } });

    // A directory at the final path makes the post-verification rename fail.
    // The durable state is then exactly "verified metadata + 0-byte part".
    const blockedTarget = join(
      bridgeB.appRootDir,
      'app-inbox/files',
      encodeAppPathSegment('daemon-a'),
      encodeAppPathSegment(messageId),
      file.fileName,
    );
    await mkdir(blockedTarget, { recursive: true });
    const failed = await request({
      type: 'app-send-file-commit',
      payload: { requestId: randomUUID(), messageId, transferId },
    });
    expect(failed.type).toBe('app-error');
    await rm(blockedTarget, { recursive: true, force: true });

    bridgeB.runtime.dispose();
    const restarted = await createBridge({ root: join(root, 'b'), deviceId: 'device-b', daemonHostId: 'daemon-b' });
    expect(restarted.runtime.getInitializationError()).toBeNull();

    const subscriber = captureLink('local', 'device-b', 'daemon-b');
    await restarted.runtime.subscribeLocal(subscriber.link);
    const replays = subscriber.frames.filter((frame) => frame.type === 'app-inbound-file');
    expect(replays).toHaveLength(1);
    const replay = replays[0] as Extract<AppServerFrame, { type: 'app-inbound-file' }>;
    expect(replay.payload).toMatchObject({ messageId, totalBytes: 0, state: 'received', transferId });
    expect((await stat(replay.payload.absolutePath)).size).toBe(0);

    // A single crashed empty transfer must not block later traffic.
    const peer2 = captureLink('peer', 'device-a', 'daemon-a');
    await restarted.runtime.handleFrame(peer2.link, {
      type: 'app-send-message',
      payload: { requestId: randomUUID(), messageId: 'after-empty', subject: 'after', body: 'still works' },
    });
    expect(await waitForFrames(peer2.frames, (frame) => frame.type === 'app-send-result')).toMatchObject({
      type: 'app-send-result',
      payload: { status: 'received' },
    });
  });

  it('releases verified staging metadata when the inbox record survived the crash', async () => {
    const root = await registry.root();
    const appRootDir = join(root, 'app');
    const bytes = Buffer.alloc(1_000, 5);
    const messageId = 'crash-record';
    const transferId = 'crash-transfer';
    const finalPath = await arrangeCommittedTransfer(appRootDir, {
      senderDaemonHostId: 'daemon-a',
      messageId,
      transferId,
      fileName: 'crash.bin',
      bytes,
      state: 'delivered',
    });

    // Capacity is the observable: 1000 bytes of file + 400 bytes of new
    // transfer fit in 1500 bytes only when the 1000 reserved staging bytes are
    // released.
    const bridgeB = await createBridge({
      root,
      deviceId: 'device-b',
      daemonHostId: 'daemon-b',
      maxInboxBytes: 1_500,
    });
    expect(bridgeB.runtime.getInitializationError()).toBeNull();

    const subscriber = captureLink('local', 'device-b', 'daemon-b');
    await bridgeB.runtime.subscribeLocal(subscriber.link);
    expect(subscriber.frames.filter((frame) => frame.type === 'app-inbound-file')).toHaveLength(0);

    const status = captureLink('local', 'device-b', 'daemon-b');
    await bridgeB.runtime.handleFrame(status.link, {
      type: 'app-status',
      payload: { requestId: randomUUID(), messageId, senderDaemonHostId: 'daemon-a' },
    });
    expect(await waitForFrames(status.frames, (frame) => frame.type === 'app-status-result')).toMatchObject({
      type: 'app-status-result',
      payload: { found: true, state: 'delivered', transferId, absolutePath: finalPath },
    });

    const peer = captureLink('peer', 'device-a', 'daemon-a');
    const nextBytes = Buffer.alloc(400, 6);
    const nextFile = sendFileMetadata(nextBytes, 'next-transfer', 'next.bin');
    await bridgeB.runtime.handleFrame(peer.link, {
      type: 'app-send-file-start',
      payload: { requestId: randomUUID(), messageId: 'next-record', subject: 'next', file: nextFile },
    });
    expect(await waitForFrames(peer.frames, () => true)).toMatchObject({
      type: 'app-send-result',
      payload: { status: 'receiving' },
    });
  });

  it('stays usable after retention removes a recovered record', async () => {
    const root = await registry.root();
    const appRootDir = join(root, 'app');
    const bytes = Buffer.alloc(700, 9);
    const messageId = 'retained-record';
    const transferId = 'retained-transfer';
    await arrangeCommittedTransfer(appRootDir, {
      senderDaemonHostId: 'daemon-a',
      messageId,
      transferId,
      fileName: 'retained.bin',
      bytes,
      state: 'delivered',
    });

    const first = await createBridge({ root, deviceId: 'device-b', daemonHostId: 'daemon-b' });
    expect(first.runtime.getInitializationError()).toBeNull();
    const local = captureLink('local', 'device-b', 'daemon-b');
    await first.runtime.handleFrame(local.link, {
      type: 'app-consume',
      payload: { requestId: randomUUID(), messageId, senderDaemonHostId: 'daemon-a' },
    });
    expect(await waitForFrames(local.frames, (frame) => frame.type === 'app-status-result')).toMatchObject({
      type: 'app-status-result',
      payload: { state: 'consumed' },
    });
    first.runtime.dispose();

    const retained = await createBridge({
      root,
      deviceId: 'device-b',
      daemonHostId: 'daemon-b',
      retentionMs: 0,
    });
    expect(retained.runtime.getInitializationError()).toBeNull();
    retained.runtime.dispose();

    const rebooted = await createBridge({ root, deviceId: 'device-b', daemonHostId: 'daemon-b' });
    expect(rebooted.runtime.getInitializationError()).toBeNull();
    const afterReboot = captureLink('local', 'device-b', 'daemon-b');
    await rebooted.runtime.handleFrame(afterReboot.link, {
      type: 'app-status',
      payload: { requestId: randomUUID(), messageId, senderDaemonHostId: 'daemon-a' },
    });
    expect(await waitForFrames(afterReboot.frames, (frame) => frame.type === 'app-status-result')).toMatchObject({
      type: 'app-status-result',
      payload: { found: false },
    });

    const peer = captureLink('peer', 'device-a', 'daemon-a');
    await rebooted.runtime.handleFrame(peer.link, {
      type: 'app-send-message',
      payload: { requestId: randomUUID(), messageId: 'post-retention', subject: 'after', body: 'ok' },
    });
    expect(await waitForFrames(peer.frames, (frame) => frame.type === 'app-send-result')).toMatchObject({
      type: 'app-send-result',
      payload: { status: 'received' },
    });
  });

  it('persists 191-byte and 188-byte identities through send and send-file', async () => {
    const root = await registry.root();
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
    const request = async (frame: AppClientFrame) => {
      local.frames.length = 0;
      await bridgeA.runtime.handleFrame(local.link, frame);
      return waitForFrames(local.frames, () => true);
    };

    for (const messageId of ['m'.repeat(191), 'n'.repeat(188)]) {
      const receipt = await request({
        type: 'app-send-message',
        payload: { requestId: randomUUID(), messageId, target: peerTarget(bridgeB), subject: 'long id', body: `body-${messageId.length}` },
      });
      expect(receipt).toMatchObject({ type: 'app-send-result', payload: { status: 'received', messageId } });
      const status = await request({
        type: 'app-status',
        payload: { requestId: randomUUID(), messageId },
      });
      expect(status).toMatchObject({ type: 'app-status-result', payload: { found: true, kind: 'outbox', outboxState: 'received' } });
    }

    const bytes = Buffer.alloc(5_000, 11);
    const fileMessageId = 'f'.repeat(191);
    const transferId = fileMessageId;
    const file = sendFileMetadata(bytes, transferId, 'long.bin');
    const started = await request({
      type: 'app-send-file-start',
      payload: { requestId: randomUUID(), messageId: fileMessageId, target: peerTarget(bridgeB), subject: 'long file', file },
    });
    expect(started).toMatchObject({ type: 'app-send-result', payload: { status: 'receiving' } });
    for (let chunkIndex = 0; chunkIndex < file.chunkCount; chunkIndex += 1) {
      const offset = chunkIndex * APP_FILE_CHUNK_BYTES;
      const chunk = bytes.subarray(offset, offset + APP_FILE_CHUNK_BYTES);
      const chunkResult = await request({
        type: 'app-send-file-chunk',
        payload: { requestId: randomUUID(), messageId: fileMessageId, transferId, offset, chunkIndex, dataBase64: chunk.toString('base64') },
      });
      expect(chunkResult).toMatchObject({ type: 'app-send-result', payload: { persistedOffset: offset + chunk.length } });
    }
    const committed = await request({
      type: 'app-send-file-commit',
      payload: { requestId: randomUUID(), messageId: fileMessageId, transferId },
    });
    expect(committed).toMatchObject({ type: 'app-send-result', payload: { status: 'received' } });

    const receiver = captureLink('local', 'device-b', 'daemon-b');
    await bridgeB.runtime.subscribeLocal(receiver.link);
    const inbound = await waitForFrames<Extract<AppServerFrame, { type: 'app-inbound-file' }>>(
      receiver.frames,
      (frame) => frame.type === 'app-inbound-file',
    );
    expect(inbound.payload).toMatchObject({ messageId: fileMessageId, transferId, totalBytes: bytes.length });
    expect((await readFile(inbound.payload.absolutePath)).equals(bytes)).toBe(true);

    // The CLI retry path reuses the same identity and must stay idempotent.
    const retried = await request({
      type: 'app-send-file-start',
      payload: { requestId: randomUUID(), messageId: fileMessageId, target: peerTarget(bridgeB), subject: 'long file', file },
    });
    expect(retried).toMatchObject({ type: 'app-send-result', payload: { status: 'received' } });

    const overLimit = await request({
      type: 'app-send-message',
      payload: { requestId: randomUUID(), messageId: 'x'.repeat(192), target: peerTarget(bridgeB), subject: 'too long', body: 'x' },
    });
    expect(overLimit).toMatchObject({ type: 'app-error', payload: { code: 'storage_error' } });
  });
});

/**
 * Reproduces the durable state of a crash between inbox record publication and
 * staging metadata deletion. The crash window itself cannot be reached from the
 * public entry without fault injection, so the durable files are written
 * explicitly; every assertion afterwards runs through the public runtime entry.
 */
async function arrangeCommittedTransfer(
  appRootDir: string,
  options: {
    senderDaemonHostId: string;
    messageId: string;
    transferId: string;
    fileName: string;
    bytes: Buffer;
    state: 'delivered' | 'consumed';
  },
) {
  const store = new DaemonAppMessagingStore({ appRootDir });
  await store.initialize();
  const finalPath = store.finalFilePath(options.senderDaemonHostId, options.messageId, options.fileName);
  await mkdir(dirname(finalPath), { recursive: true });
  await writeFile(finalPath, options.bytes);
  const settledAt = new Date(Date.now() - 60_000).toISOString();
  const record: AppInboxRecord = {
    schemaVersion: 1,
    senderDeviceId: 'device-a',
    senderDaemonHostId: options.senderDaemonHostId,
    receiverDeviceId: 'device-b',
    receiverDaemonHostId: 'daemon-b',
    messageId: options.messageId,
    kind: 'file',
    subject: 'crash',
    file: {
      transferId: options.transferId,
      fileName: options.fileName,
      totalBytes: options.bytes.length,
      chunkCount: computeAppChunkCount(options.bytes.length),
      sha256: sha256(options.bytes),
      absolutePath: finalPath,
    },
    state: options.state,
    receivedAt: settledAt,
    deliveredAt: settledAt,
    ...(options.state === 'consumed' ? { consumedAt: settledAt } : {}),
  };
  await store.writeInboxRecord(record);
  const metadata: AppStagingMetadata = {
    schemaVersion: 1,
    senderDaemonHostId: options.senderDaemonHostId,
    senderDeviceId: 'device-a',
    receiverDeviceId: 'device-b',
    receiverDaemonHostId: 'daemon-b',
    transferId: options.transferId,
    messageId: options.messageId,
    subject: 'crash',
    fileName: options.fileName,
    totalBytes: options.bytes.length,
    chunkCount: computeAppChunkCount(options.bytes.length),
    sha256: sha256(options.bytes),
    reservedBytes: options.bytes.length,
    persistedOffset: options.bytes.length,
    phase: 'verified',
    absolutePath: finalPath,
  };
  await store.writeStagingMetadata(metadata);
  return finalPath;
}

describe('daemon /app file route reservation', () => {
  it('rejects a parallel conflicting start before forwarding and keeps the original target', async () => {
    const root = await registry.root();
    const bridgeB = await createBridge({ root: join(root, 'b'), deviceId: 'device-b', daemonHostId: 'daemon-b' });
    const bridgeC = await createBridge({ root: join(root, 'c'), deviceId: 'device-c', daemonHostId: 'daemon-c' });
    const [toB, serverB] = socketPair();
    attachPeerTransport(bridgeB, serverB);
    const [toC, serverC] = socketPair();
    attachPeerTransport(bridgeC, serverC);
    const cClientFrames: string[] = [];
    const toCSend = toC.send.bind(toC);
    toC.send = ((text: string, callback?: (error?: Error) => void) => {
      cClientFrames.push(text);
      return toCSend(text, callback);
    }) as FakeSocket['send'];

    // Hold B's handshake so the first start is still inside connectPeer (past
    // its route admission, before any bind) when the conflicting second start
    // runs. Without the held window the first start binds before the second
    // checks and the race never happens.
    const serverBSend = serverB.send.bind(serverB);
    let releaseB = false;
    let bHandshakeStarted = false;
    const heldB: { send: (() => void) | null } = { send: null };
    serverB.send = ((text: string, callback?: (error?: Error) => void) => {
      if (!releaseB) {
        bHandshakeStarted = true;
        heldB.send = () => serverBSend(text, callback);
        return;
      }
      serverBSend(text, callback);
    }) as FakeSocket['send'];

    const bridgeA = await createBridge({
      root: join(root, 'a'),
      deviceId: 'device-a',
      daemonHostId: 'daemon-a',
      createWebSocket: (url) => (url.endsWith('daemon-c') ? toC : toB) as unknown as WebSocket,
    });
    const local = captureLink('local', 'device-a', 'daemon-a');
    const messageId = `parallel-${randomUUID()}`;
    const transferId = messageId;
    const file = sendFileMetadata(Buffer.alloc(1, 1), transferId, 'one.bin');

    const sendStart = (target: Bridge, requestId: string) => bridgeA.runtime.handleFrame(local.link, {
      type: 'app-send-file-start',
      payload: {
        requestId,
        messageId,
        target: peerTarget(target),
        subject: 'parallel',
        file,
      },
    });

    // First start to B. It admits the route and then blocks in connectPeer(B)
    // because B's app-ready is held.
    const firstRequestId = randomUUID();
    const first = sendStart(bridgeB, firstRequestId);
    const deadline = Date.now() + 3_000;
    while (!bHandshakeStarted && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(bHandshakeStarted).toBe(true);

    // Second start to C on the same physical connection + transferId. It must
    // be rejected with transfer_conflict before A connects to C or forwards.
    const secondRequestId = randomUUID();
    await sendStart(bridgeC, secondRequestId);
    expect(local.frames.some(
      (frame) => frame.type === 'app-error'
        && frame.payload.code === 'transfer_conflict'
        && frame.payload.transferId === transferId
        && frame.payload.requestId === secondRequestId,
    )).toBe(true);
    // No hello or file-start reached C: the conflict is rejected before the
    // second route connects or forwards.
    expect(cClientFrames).toEqual([]);

    // Release B so the first start completes against its reserved target only.
    releaseB = true;
    heldB.send?.();
    await first;
    expect(await waitForFrames(
      local.frames,
      (frame) => frame.type === 'app-send-result' && frame.payload.requestId === firstRequestId && frame.payload.status === 'receiving',
    )).toMatchObject({ type: 'app-send-result', payload: { status: 'receiving' } });

    // The first route must still point at B. Deliver its full transfer and
    // verify the file lands on B, never on C.
    const sendChunk = async (chunkIndex: number, offset: number, data: Buffer) => {
      local.frames.length = 0;
      await bridgeA.runtime.handleFrame(local.link, {
        type: 'app-send-file-chunk',
        payload: {
          requestId: randomUUID(),
          messageId,
          transferId,
          offset,
          chunkIndex,
          dataBase64: data.toString('base64'),
        },
      });
      return waitForFrames(local.frames, () => true);
    };
    const data = Buffer.alloc(1, 1);
    expect(await sendChunk(0, 0, data)).toMatchObject({ type: 'app-send-result', payload: { persistedOffset: 1 } });
    const commit = await (async () => {
      local.frames.length = 0;
      await bridgeA.runtime.handleFrame(local.link, {
        type: 'app-send-file-commit',
        payload: { requestId: randomUUID(), messageId, transferId },
      });
      return waitForFrames(local.frames, () => true);
    })();
    expect(commit).toMatchObject({ type: 'app-send-result', payload: { status: 'received' } });

    const bPath = join(
      bridgeB.appRootDir,
      'app-inbox/files',
      encodeAppPathSegment('daemon-a'),
      encodeAppPathSegment(messageId),
      file.fileName,
    );
    const cPath = join(
      bridgeC.appRootDir,
      'app-inbox/files',
      encodeAppPathSegment('daemon-a'),
      encodeAppPathSegment(messageId),
      file.fileName,
    );
    expect((await readFile(bPath)).equals(data)).toBe(true);
    await expect(stat(cPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('daemon /app file route peer reconnect retry (review-8)', () => {
  it('rebinds the route to a new peer transport on a same-id retry after the peer disconnects', async () => {
    const root = await registry.root();
    const bridgeB = await createBridge({ root: join(root, 'b'), deviceId: 'device-b', daemonHostId: 'daemon-b' });

    // Every connectPeer() call returns a fresh socket pair whose server side
    // answers as daemon-b, so a retry after a disconnect can re-establish a
    // live transport instead of reusing the closed one.
    const clientSockets: FakeSocket[] = [];
    const makeSocket = () => {
      const [client, server] = socketPair();
      attachPeerTransport(bridgeB, server);
      clientSockets.push(client);
      return client as unknown as WebSocket;
    };

    const bridgeA = await createBridge({
      root: join(root, 'a'),
      deviceId: 'device-a',
      daemonHostId: 'daemon-a',
      createWebSocket: () => makeSocket(),
    });
    const local = captureLink('local', 'device-a', 'daemon-a');
    const messageId = `retry-${randomUUID()}`;
    const transferId = messageId;
    const data = Buffer.alloc(4, 7);
    const file = sendFileMetadata(data, transferId, 'retry.bin');
    const startFrame = (requestId: string): AppClientFrame => ({
      type: 'app-send-file-start',
      payload: { requestId, messageId, target: peerTarget(bridgeB), subject: 'retry', file },
    });

    // First start succeeds over peer transport #1.
    local.frames.length = 0;
    await bridgeA.runtime.handleFrame(local.link, startFrame(randomUUID()));
    expect(await waitForFrames(local.frames, (f) => f.type === 'app-send-result' && f.payload.status === 'receiving')).toMatchObject({
      type: 'app-send-result',
      payload: { status: 'receiving' },
    });
    expect(clientSockets).toHaveLength(1);

    // The peer transport drops, but the local /app link stays open (a client
    // reconnect retry uses the same local connection and transfer id).
    clientSockets[0].close();
    await new Promise((done) => setTimeout(done, 25));

    // Same-id retry must reconnect and rebind the registered route to transport #2.
    local.frames.length = 0;
    await bridgeA.runtime.handleFrame(local.link, startFrame(randomUUID()));
    expect(await waitForFrames(local.frames, (f) => f.type === 'app-send-result' && f.payload.status === 'receiving')).toMatchObject({
      type: 'app-send-result',
      payload: { status: 'receiving' },
    });
    expect(clientSockets).toHaveLength(2);

    // Chunk and commit must now travel over the rebuilt transport and finish.
    local.frames.length = 0;
    await bridgeA.runtime.handleFrame(local.link, {
      type: 'app-send-file-chunk',
      payload: { requestId: randomUUID(), messageId, transferId, offset: 0, chunkIndex: 0, dataBase64: data.toString('base64') },
    });
    expect(await waitForFrames(local.frames, (f) => f.type === 'app-send-result')).toMatchObject({
      type: 'app-send-result',
      payload: { persistedOffset: data.length },
    });

    local.frames.length = 0;
    await bridgeA.runtime.handleFrame(local.link, {
      type: 'app-send-file-commit',
      payload: { requestId: randomUUID(), messageId, transferId },
    });
    expect(await waitForFrames(local.frames, (f) => f.type === 'app-send-result')).toMatchObject({
      type: 'app-send-result',
      payload: { status: 'received' },
    });

    const bPath = join(
      bridgeB.appRootDir,
      'app-inbox/files',
      encodeAppPathSegment('daemon-a'),
      encodeAppPathSegment(messageId),
      file.fileName,
    );
    expect((await readFile(bPath)).equals(data)).toBe(true);
  });
});

describe('daemon /app inbox capacity counts message bodies (P1-C)', () => {
  function peerLink() {
    return captureLink('peer', 'device-a', 'daemon-a');
  }

  async function nextResult(link: ReturnType<typeof peerLink>, predicate: (frame: AppServerFrame) => boolean) {
    const frame = await waitForFrames(link.frames, predicate);
    link.frames.length = 0;
    return frame;
  }

  const BODY = (n: number) => 'a'.repeat(n);

  it('blocks the second message when the first message body already fills the limit', async () => {
    const root = await registry.root();
    const bridgeB = await createBridge({ root, deviceId: 'device-b', daemonHostId: 'daemon-b', maxInboxBytes: 3000 });
    const peer = peerLink();
    await bridgeB.runtime.handleFrame(peer.link, {
      type: 'app-send-message',
      payload: { requestId: randomUUID(), messageId: 'm1', subject: 's', body: BODY(2048) },
    });
    expect(await nextResult(peer, (f) => f.type === 'app-send-result')).toMatchObject({
      type: 'app-send-result',
      payload: { status: 'received' },
    });
    await bridgeB.runtime.handleFrame(peer.link, {
      type: 'app-send-message',
      payload: { requestId: randomUUID(), messageId: 'm2', subject: 's', body: BODY(2048) },
    });
    expect(await nextResult(peer, (f) => f.type === 'app-error')).toMatchObject({
      type: 'app-error',
      payload: { code: 'inbox_full' },
    });
  });

  it('blocks a file start whose bytes push the persisted message body over the limit', async () => {
    const root = await registry.root();
    const bridgeB = await createBridge({ root, deviceId: 'device-b', daemonHostId: 'daemon-b', maxInboxBytes: 3000 });
    const peer = peerLink();
    await bridgeB.runtime.handleFrame(peer.link, {
      type: 'app-send-message',
      payload: { requestId: randomUUID(), messageId: 'm1', subject: 's', body: BODY(2048) },
    });
    expect(await nextResult(peer, (f) => f.type === 'app-send-result')).toMatchObject({
      type: 'app-send-result',
      payload: { status: 'received' },
    });
    // 2048 + 1500 = 3548 > 3000 must block; the small file below must still pass.
    const tooBig = sendFileMetadata(Buffer.alloc(1500, 1), 't-big', 'big.bin');
    await bridgeB.runtime.handleFrame(peer.link, {
      type: 'app-send-file-start',
      payload: { requestId: randomUUID(), messageId: 'f-big', subject: 's', file: tooBig },
    });
    expect(await nextResult(peer, (f) => f.type === 'app-error')).toMatchObject({
      type: 'app-error',
      payload: { code: 'inbox_full' },
    });
    const rejectedStaging = join(
      bridgeB.appRootDir,
      'app-inbox/staging',
      encodeAppPathSegment('daemon-a'),
      encodeAppPathSegment('t-big'),
      'meta.json',
    );
    await expect(stat(rejectedStaging)).rejects.toMatchObject({ code: 'ENOENT' });
    const small = sendFileMetadata(Buffer.alloc(100, 1), 't-small', 'small.bin');
    await bridgeB.runtime.handleFrame(peer.link, {
      type: 'app-send-file-start',
      payload: { requestId: randomUUID(), messageId: 'f-small', subject: 's', file: small },
    });
    expect(await nextResult(peer, (f) => f.type === 'app-send-result')).toMatchObject({
      type: 'app-send-result',
      payload: { status: 'receiving' },
    });
  });

  it('blocks a message when an existing committed file plus the body exceeds the limit', async () => {
    const root = await registry.root();
    const bridgeB = await createBridge({ root, deviceId: 'device-b', daemonHostId: 'daemon-b', maxInboxBytes: 3000 });
    const peer = peerLink();
    const fileBytes = Buffer.alloc(1500, 2);
    const file = sendFileMetadata(fileBytes, 't-file', 'committed.bin');
    await bridgeB.runtime.handleFrame(peer.link, {
      type: 'app-send-file-start',
      payload: { requestId: randomUUID(), messageId: 'f1', subject: 's', file },
    });
    expect(await nextResult(peer, (f) => f.type === 'app-send-result')).toMatchObject({
      type: 'app-send-result',
      payload: { status: 'receiving' },
    });
    await bridgeB.runtime.handleFrame(peer.link, {
      type: 'app-send-file-chunk',
      payload: { requestId: randomUUID(), messageId: 'f1', transferId: 't-file', offset: 0, chunkIndex: 0, dataBase64: fileBytes.toString('base64') },
    });
    expect(await nextResult(peer, (f) => f.type === 'app-send-result')).toMatchObject({
      type: 'app-send-result',
      payload: { persistedOffset: 1500 },
    });
    await bridgeB.runtime.handleFrame(peer.link, {
      type: 'app-send-file-commit',
      payload: { requestId: randomUUID(), messageId: 'f1', transferId: 't-file' },
    });
    expect(await nextResult(peer, (f) => f.type === 'app-send-result')).toMatchObject({
      type: 'app-send-result',
      payload: { status: 'received' },
    });
    // 1500 (file) + 2048 (message) = 3548 > 3000 must block.
    await bridgeB.runtime.handleFrame(peer.link, {
      type: 'app-send-message',
      payload: { requestId: randomUUID(), messageId: 'm-after', subject: 's', body: BODY(2048) },
    });
    expect(await nextResult(peer, (f) => f.type === 'app-error')).toMatchObject({
      type: 'app-error',
      payload: { code: 'inbox_full' },
    });
    const committedPath = join(
      bridgeB.appRootDir,
      'app-inbox/files',
      encodeAppPathSegment('daemon-a'),
      encodeAppPathSegment('f1'),
      file.fileName,
    );
    expect((await stat(committedPath)).size).toBe(fileBytes.length);
    const verify = new DaemonAppMessagingStore({ appRootDir: bridgeB.appRootDir, maxInboxBytes: 3000 });
    expect(await verify.readInboxRecord('daemon-a', 'f1')).toMatchObject({
      kind: 'file',
      state: 'received',
    });
  });

  it('does not double count a same-id message retry against inbox capacity', async () => {
    const root = await registry.root();
    const bridgeB = await createBridge({ root, deviceId: 'device-b', daemonHostId: 'daemon-b', maxInboxBytes: 3000 });
    const peer = peerLink();
    const body = BODY(2048);
    await bridgeB.runtime.handleFrame(peer.link, {
      type: 'app-send-message',
      payload: { requestId: randomUUID(), messageId: 'retry', subject: 's', body },
    });
    expect(await nextResult(peer, (f) => f.type === 'app-send-result')).toMatchObject({
      type: 'app-send-result',
      payload: { status: 'received' },
    });
    // Same id with identical content is idempotent, so it cannot free or
    // re-occupy capacity; a third distinct message still hits the shared limit.
    await bridgeB.runtime.handleFrame(peer.link, {
      type: 'app-send-message',
      payload: { requestId: randomUUID(), messageId: 'retry', subject: 's', body },
    });
    expect(await nextResult(peer, (f) => f.type === 'app-send-result')).toMatchObject({
      type: 'app-send-result',
      payload: { status: 'received' },
    });
    await bridgeB.runtime.handleFrame(peer.link, {
      type: 'app-send-message',
      payload: { requestId: randomUUID(), messageId: 'm3', subject: 's', body: BODY(2048) },
    });
    expect(await nextResult(peer, (f) => f.type === 'app-error')).toMatchObject({
      type: 'app-error',
      payload: { code: 'inbox_full' },
    });
  });

  it('retains committed state after restart and still enforces accumulated bytes', async () => {
    const root = await registry.root();
    const appRootDir = join(root, 'app');
    const seed = new DaemonAppMessagingStore({ appRootDir, maxInboxBytes: 3000 });
    await seed.initialize();
    const record: AppInboxRecord = {
      schemaVersion: 1,
      senderDeviceId: 'device-a',
      senderDaemonHostId: 'daemon-a',
      receiverDeviceId: 'device-b',
      receiverDaemonHostId: 'daemon-b',
      messageId: 'committed',
      kind: 'message',
      subject: 's',
      body: BODY(2048),
      state: 'received',
      receivedAt: new Date().toISOString(),
    };
    await seed.writeInboxRecord(record);

    const bridgeB = await createBridge({ root, deviceId: 'device-b', daemonHostId: 'daemon-b', maxInboxBytes: 3000 });
    expect(bridgeB.runtime.getInitializationError()).toBeNull();
    const local = captureLink('local', 'device-b', 'daemon-b');
    await bridgeB.runtime.subscribeLocal(local.link);
    const replayed = local.frames.filter((frame) => frame.type === 'app-inbound-message');
    expect(replayed).toHaveLength(1);
    expect((replayed[0] as Extract<AppServerFrame, { type: 'app-inbound-message' }>).payload.messageId).toBe('committed');

    // 2048 (existing) + 2048 (new) = 4096 > 3000 must still be blocked.
    const peer = peerLink();
    await bridgeB.runtime.handleFrame(peer.link, {
      type: 'app-send-message',
      payload: { requestId: randomUUID(), messageId: 'm-new', subject: 's', body: BODY(2048) },
    });
    expect(await nextResult(peer, (f) => f.type === 'app-error')).toMatchObject({
      type: 'app-error',
      payload: { code: 'inbox_full' },
    });
    // The rejected message must not have been persisted.
    const after = captureLink('local', 'device-b', 'daemon-b');
    await bridgeB.runtime.subscribeLocal(after.link);
    expect(after.frames.filter((frame) => frame.type === 'app-inbound-message')).toHaveLength(1);
    const usage = await new DaemonAppMessagingStore({ appRootDir, maxInboxBytes: 3000 }).computeInboxUsage();
    expect(usage).toEqual({ records: 1, bytes: BODY(2048).length });
  });
});

describe('daemon /app atomic temp isolation on restart (P1-B)', () => {
  it('stays usable after crashed atomic writes and never publishes the temps', async () => {
    const root = await registry.root();
    const appRootDir = join(root, 'app');
    const seed = new DaemonAppMessagingStore({ appRootDir });
    await seed.initialize();
    const record: AppInboxRecord = {
      schemaVersion: 1,
      senderDeviceId: 'device-a',
      senderDaemonHostId: 'daemon-a',
      receiverDeviceId: 'device-b',
      receiverDaemonHostId: 'daemon-b',
      messageId: 'committed',
      kind: 'message',
      subject: 's',
      body: 'committed-body',
      state: 'received',
      receivedAt: new Date().toISOString(),
    };
    await seed.writeInboxRecord(record);

    // Crashed atomic writes: empty, partial, and complete-but-not-renamed temps.
    const recordGhostDir = join(seed.inboxRoot, 'records', encodeAppPathSegment('daemon-a'), encodeAppPathSegment('ghost'));
    await mkdir(recordGhostDir, { recursive: true });
    await writeFile(join(recordGhostDir, `.tmp-${randomUUID()}.json`), '');
    await writeFile(join(recordGhostDir, `.tmp-${randomUUID()}.json`), '{"messageId":"partial"');
    await writeFile(join(recordGhostDir, `.tmp-${randomUUID()}.json`), JSON.stringify({
      schemaVersion: 1,
      messageId: 'complete-not-renamed',
      kind: 'message',
      body: 'x',
      state: 'received',
    }));
    const stagingGhostDir = join(seed.inboxRoot, 'staging', encodeAppPathSegment('daemon-a'), encodeAppPathSegment('ghostx'));
    await mkdir(stagingGhostDir, { recursive: true });
    await writeFile(join(stagingGhostDir, `.tmp-${randomUUID()}.json`), JSON.stringify({
      schemaVersion: 1,
      transferId: 'ghostx',
      messageId: 'ghostx',
      reservedBytes: 999,
    }));

    const bridgeB = await createBridge({ root, deviceId: 'device-b', daemonHostId: 'daemon-b' });
    expect(bridgeB.runtime.getInitializationError()).toBeNull();

    const local = captureLink('local', 'device-b', 'daemon-b');
    await bridgeB.runtime.subscribeLocal(local.link);
    const inbound = local.frames.filter((frame) => frame.type === 'app-inbound-message' || frame.type === 'app-inbound-file');
    expect(inbound).toHaveLength(1);
    expect((inbound[0] as Extract<AppServerFrame, { type: 'app-inbound-message' }>).payload.messageId).toBe('committed');

    // A fresh admission still works and is not blocked by the ghost temps.
    const peer = captureLink('peer', 'device-a', 'daemon-a');
    await bridgeB.runtime.handleFrame(peer.link, {
      type: 'app-send-message',
      payload: { requestId: randomUUID(), messageId: 'fresh', subject: 's', body: 'fresh-body' },
    });
    expect(await waitForFrames(peer.frames, (f) => f.type === 'app-send-result')).toMatchObject({
      type: 'app-send-result',
      payload: { status: 'received' },
    });

    // Capacity/count truth comes only from published records.
    const verify = new DaemonAppMessagingStore({ appRootDir });
    const usage = await verify.computeInboxUsage();
    expect(usage).toEqual({
      records: 2,
      bytes: Buffer.byteLength('committed-body', 'utf8') + Buffer.byteLength('fresh-body', 'utf8'),
    });
  });
});
