import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_MAX_PATH_IDENTITY_BYTES, computeAppChunkCount, encodeAppPathSegment } from '@zterm/shared/app-protocol';
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

async function createStore(options: { maxInboxBytes?: number } = {}) {
  const root = await registry.root();
  const store = new DaemonAppMessagingStore({
    appRootDir: join(root, 'app'),
    ...(options.maxInboxBytes === undefined ? {} : { maxInboxBytes: options.maxInboxBytes }),
  });
  await store.initialize();
  return store;
}

function messageRecord(options: {
  messageId: string;
  body: string;
  senderDaemonHostId?: string;
}): AppInboxRecord {
  return {
    schemaVersion: 1,
    senderDeviceId: 'device-a',
    senderDaemonHostId: options.senderDaemonHostId ?? 'daemon-a',
    receiverDeviceId: 'device-b',
    receiverDaemonHostId: 'daemon-b',
    messageId: options.messageId,
    kind: 'message',
    subject: 'subject',
    body: options.body,
    state: 'received',
    receivedAt: new Date().toISOString(),
  };
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

  it('excludes a crashed temp json from published records, recovery and capacity', async () => {
    const store = await createStore();
    const committed = messageRecord({ messageId: 'committed', body: 'committed-body' });
    await store.writeInboxRecord(committed);
    const usageBefore = await store.computeInboxUsage();
    expect(usageBefore.records).toBe(1);

    // A crash during atomicWriteJson leaves a .tmp-<uuid>.json sibling.
    const recordDir = join(store.inboxRoot, 'records', encodeAppPathSegment('daemon-a'), encodeAppPathSegment('ghost'));
    await mkdir(recordDir, { recursive: true });
    const tempPath = join(recordDir, `.tmp-${randomUUID()}.json`);
    await writeFile(tempPath, JSON.stringify({ messageId: 'ghost', kind: 'message' }));

    const records = await store.listInboxRecords();
    expect(records.map((record) => record.messageId)).not.toContain('ghost');
    expect(records).toHaveLength(1);
    const usage = await store.computeInboxUsage();
    expect(usage.records).toBe(1);
    expect(await store.readInboxRecord('daemon-a', 'ghost')).toBeNull();
    await rm(tempPath, { force: true });
  });

  it('still raises on a corrupt published record instead of silently skipping it', async () => {
    const store = await createStore();
    await store.writeInboxRecord(messageRecord({ messageId: 'good', body: 'ok' }));
    const corruptDir = join(
      store.inboxRoot,
      'records',
      encodeAppPathSegment('daemon-a'),
      encodeAppPathSegment('broken'),
    );
    await mkdir(corruptDir, { recursive: true });
    // A truncated formal record.json is a real corruption, not a temp write, so
    // enumeration must surface the parse failure instead of dropping it.
    await writeFile(join(corruptDir, 'record.json'), '{"messageId":"broken",');
    await expect(store.listInboxRecords()).rejects.toBeInstanceOf(SyntaxError);
  });

  it('counts persisted message body bytes when enforcing the inbox limit', async () => {
    // 3000-byte limit: one 2048-byte message leaves 952 bytes, a second 2048-byte
    // message would exceed the old record-only accounting but must be blocked now.
    const store = await createStore({ maxInboxBytes: 3000 });
    const firstBody = 'a'.repeat(2048);
    const first = messageRecord({ messageId: 'm1', body: firstBody });
    await store.admitInboxRecord(first, Buffer.byteLength(firstBody, 'utf8'));
    const secondBody = 'b'.repeat(2048);
    const second = messageRecord({ messageId: 'm2', body: secondBody });
    await expect(store.admitInboxRecord(second, Buffer.byteLength(secondBody, 'utf8'))).rejects.toMatchObject({
      code: 'inbox_full',
    });
    expect(await store.readInboxRecord('daemon-a', 'm2')).toBeNull();
  });

  it('does not double count a same-id message retry against inbox capacity', async () => {
    const store = await createStore({ maxInboxBytes: 3000 });
    const body = 'a'.repeat(2048);
    const first = messageRecord({ messageId: 'retry', body });
    const ok = await store.admitInboxRecord(first, Buffer.byteLength(body, 'utf8'));
    expect(ok).toBe(true);
    // Same id with identical content is idempotent: no extra capacity.
    const retry = await store.admitInboxRecord(first, Buffer.byteLength(body, 'utf8'));
    expect(retry).toBe(false);
    const usage = await store.computeInboxUsage();
    expect(usage.records).toBe(1);
    expect(usage.bytes).toBe(Buffer.byteLength(body, 'utf8'));
  });

  it('blocks a message when an existing file plus the message exceeds the limit', async () => {
    const store = await createStore({ maxInboxBytes: 3000 });
    const bytes = Buffer.alloc(2048, 7);
    const messageId = 'file-then-msg';
    const transferId = 'file-then-msg-transfer';
    const finalPath = store.finalFilePath('daemon-a', messageId, 'staged.bin');
    await store.openStagingPart(stagingMetadata({ messageId, transferId, bytes, phase: 'open' }));
    await store.appendPart('daemon-a', transferId, 0, bytes);
    await store.writeStagingMetadata(stagingMetadata({ messageId, transferId, bytes, phase: 'verified', absolutePath: finalPath }));
    await store.renamePartToFinal('daemon-a', messageId, 'staged.bin', transferId);
    const fileRecord: AppInboxRecord = {
      ...messageRecord({ messageId, body: 'unused' }),
      kind: 'file',
      file: {
        transferId,
        fileName: 'staged.bin',
        totalBytes: bytes.length,
        chunkCount: computeAppChunkCount(bytes.length),
        sha256: sha256(bytes),
        absolutePath: finalPath,
      },
    };
    await store.writeInboxRecord(fileRecord);
    const messageBody = 'b'.repeat(2048);
    const message = messageRecord({ messageId: 'after-file', body: messageBody });
    await expect(store.admitInboxRecord(message, Buffer.byteLength(messageBody, 'utf8'))).rejects.toMatchObject({
      code: 'inbox_full',
    });
  });
});
