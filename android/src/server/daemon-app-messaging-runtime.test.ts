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
