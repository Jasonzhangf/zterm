import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_MAX_PATH_IDENTITY_BYTES, computeAppChunkCount } from '@zterm/shared/app-protocol';
import { sha256, tempRootRegistry } from './daemon-app-messaging-test-harness';
import {
  AppStoreError,
  DaemonAppMessagingStore,
  type AppInboxRecord,
  type AppOutboxRecord,
  type AppStagingMetadata,
} from './daemon-app-messaging-store';

const registry = tempRootRegistry();

afterEach(async () => {
  await registry.cleanup();
});

async function createStore() {
  const root = await registry.root();
  const store = new DaemonAppMessagingStore({ appRootDir: join(root, 'app') });
  await store.initialize();
  return store;
}

function stagingMetadata(options: {
  messageId: string;
  transferId: string;
  bytes: Buffer;
  phase: 'open' | 'verified';
  absolutePath?: string;
}): AppStagingMetadata {
  return {
    schemaVersion: 1,
    senderDaemonHostId: 'daemon-a',
    senderDeviceId: 'device-a',
    receiverDeviceId: 'device-b',
    receiverDaemonHostId: 'daemon-b',
    transferId: options.transferId,
    messageId: options.messageId,
    subject: 'staging',
    fileName: 'staged.bin',
    totalBytes: options.bytes.length,
    chunkCount: computeAppChunkCount(options.bytes.length),
    sha256: sha256(options.bytes),
    reservedBytes: options.bytes.length,
    persistedOffset: options.bytes.length,
    phase: options.phase,
    ...(options.absolutePath ? { absolutePath: options.absolutePath } : {}),
  };
}

describe('daemon /app durable store', () => {
  it('keeps every persistence basename inside NAME_MAX for 191-byte identities', async () => {
    const store = await createStore();
    const identity = 'x'.repeat(APP_MAX_PATH_IDENTITY_BYTES);
    const paths = [
      store.inboxRecordPath(identity, identity),
      store.outboxRecordPath(identity, identity),
      store.stagingMetaPath(identity, identity),
      store.stagingPartPath(identity, identity),
      store.finalFilePath(identity, identity, 'y'.repeat(255)),
    ];
    for (const path of paths) {
      for (const segment of path.split('/')) {
        expect(new TextEncoder().encode(segment).length).toBeLessThanOrEqual(255);
      }
    }

    const inboxRecord: AppInboxRecord = {
      schemaVersion: 1,
      senderDeviceId: 'device-a',
      senderDaemonHostId: identity,
      receiverDeviceId: 'device-b',
      receiverDaemonHostId: 'daemon-b',
      messageId: identity,
      kind: 'message',
      subject: 'long',
      body: 'long identity',
      state: 'received',
      receivedAt: new Date().toISOString(),
    };
    await store.writeInboxRecord(inboxRecord);
    expect(await store.readInboxRecord(identity, identity)).toEqual(inboxRecord);

    const outboxRecord: AppOutboxRecord = {
      schemaVersion: 1,
      targetDeviceId: 'device-b',
      targetDaemonHostId: identity,
      messageId: identity,
      kind: 'message',
      subject: 'long',
      body: 'long identity',
      state: 'pending',
      updatedAt: new Date().toISOString(),
    };
    await store.writeOutboxRecord(outboxRecord);
    expect(await store.readOutboxRecord(identity, identity)).toEqual(outboxRecord);

    const metadata = {
      ...stagingMetadata({ messageId: identity, transferId: identity, bytes: Buffer.alloc(0), phase: 'open' }),
      senderDaemonHostId: identity,
    };
    await store.writeStagingMetadata(metadata);
    expect(await store.readStagingMetadata(identity, identity)).toEqual(metadata);
    expect((await store.listStagingMetadata()).map((entry) => entry.transferId)).toContain(identity);
  });

  it('rejects identities above the declared 191-byte protocol limit', async () => {
    const store = await createStore();
    const overLimit = 'x'.repeat(APP_MAX_PATH_IDENTITY_BYTES + 1);
    expect(() => store.inboxRecordPath(overLimit, 'message')).toThrow(AppStoreError);
    expect(() => store.outboxRecordPath('daemon-b', overLimit)).toThrow(AppStoreError);
    expect(() => store.stagingMetaPath('daemon-a', overLimit)).toThrow(AppStoreError);
    expect(() => store.stagingPartPath('daemon-a', overLimit)).toThrow(AppStoreError);
  });

  it('recovers a verified zero-byte staged part instead of treating it as missing', async () => {
    const store = await createStore();
    const bytes = Buffer.alloc(0);
    const messageId = 'empty-recovery';
    const transferId = 'empty-recovery-transfer';
    const finalPath = store.finalFilePath('daemon-a', messageId, 'staged.bin');
    await store.openStagingPart(stagingMetadata({ messageId, transferId, bytes, phase: 'open' }));
    await store.writeStagingMetadata(stagingMetadata({ messageId, transferId, bytes, phase: 'verified', absolutePath: finalPath }));

    const recovered = await store.recoverStaging();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ messageId, state: 'received', file: { transferId, totalBytes: 0 } });
    expect(await store.readStagingMetadata('daemon-a', transferId)).toBeNull();
    expect((await stat(finalPath)).size).toBe(0);
    expect(await store.readInboxRecord('daemon-a', messageId)).toMatchObject({ messageId, state: 'received' });
    expect(await store.listStagingMetadata()).toHaveLength(0);
  });

  it('releases verified staging metadata that a matching inbox record already covers', async () => {
    const store = await createStore();
    const bytes = Buffer.alloc(512, 4);
    const messageId = 'record-won';
    const transferId = 'record-won-transfer';
    const finalPath = store.finalFilePath('daemon-a', messageId, 'staged.bin');
    await store.openStagingPart(stagingMetadata({ messageId, transferId, bytes, phase: 'open' }));
    await store.appendPart('daemon-a', transferId, 0, bytes);
    await store.writeStagingMetadata(stagingMetadata({ messageId, transferId, bytes, phase: 'verified', absolutePath: finalPath }));
    await store.renamePartToFinal('daemon-a', messageId, 'staged.bin', transferId);
    const record: AppInboxRecord = {
      schemaVersion: 1,
      senderDeviceId: 'device-a',
      senderDaemonHostId: 'daemon-a',
      receiverDeviceId: 'device-b',
      receiverDaemonHostId: 'daemon-b',
      messageId,
      kind: 'file',
      subject: 'staging',
      file: {
        transferId,
        fileName: 'staged.bin',
        totalBytes: bytes.length,
        chunkCount: computeAppChunkCount(bytes.length),
        sha256: sha256(bytes),
        absolutePath: finalPath,
      },
      state: 'delivered',
      receivedAt: new Date().toISOString(),
      deliveredAt: new Date().toISOString(),
    };
    await store.writeInboxRecord(record);

    expect(await store.recoverStaging()).toHaveLength(0);
    expect(await store.listStagingMetadata()).toHaveLength(0);
    expect(await store.readInboxRecord('daemon-a', messageId)).toEqual(record);
    expect((await stat(finalPath)).size).toBe(bytes.length);
  });

  it('reports a conflict when the repair state contradicts the inbox record', async () => {
    const store = await createStore();
    const bytes = Buffer.alloc(300, 2);
    const messageId = 'record-conflict';
    const transferId = 'record-conflict-transfer';
    const finalPath = store.finalFilePath('daemon-a', messageId, 'staged.bin');
    await store.openStagingPart(stagingMetadata({ messageId, transferId, bytes, phase: 'open' }));
    await store.appendPart('daemon-a', transferId, 0, bytes);
    await store.writeStagingMetadata(stagingMetadata({ messageId, transferId, bytes, phase: 'verified', absolutePath: finalPath }));
    await store.renamePartToFinal('daemon-a', messageId, 'staged.bin', transferId);
    await store.writeInboxRecord({
      schemaVersion: 1,
      senderDeviceId: 'device-a',
      senderDaemonHostId: 'daemon-a',
      receiverDeviceId: 'device-b',
      receiverDaemonHostId: 'daemon-b',
      messageId,
      kind: 'file',
      subject: 'staging',
      file: {
        transferId: 'some-other-transfer',
        fileName: 'staged.bin',
        totalBytes: bytes.length,
        chunkCount: computeAppChunkCount(bytes.length),
        sha256: sha256(bytes),
        absolutePath: finalPath,
      },
      state: 'received',
      receivedAt: new Date().toISOString(),
    });

    await expect(store.recoverStaging()).rejects.toMatchObject({ code: 'storage_inconsistent' });
  });
});
