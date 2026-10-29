import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  APP_MAX_INBOX_BYTES,
  APP_MAX_INBOX_RECORDS,
  APP_MAX_PATH_IDENTITY_BYTES,
  encodeAppPathSegment,
  type AppRecordState,
} from '@zterm/shared/app-protocol';

export type AppInboxRecord = {
  schemaVersion: 1;
  senderDeviceId: string;
  senderDaemonHostId: string;
  receiverDeviceId: string;
  receiverDaemonHostId: string;
  messageId: string;
  kind: 'message' | 'file';
  subject: string;
  body?: string;
  file?: {
    transferId: string;
    fileName: string;
    totalBytes: number;
    chunkCount: number;
    sha256: string;
    absolutePath: string;
  };
  state: AppRecordState;
  receivedAt: string;
  deliveredAt?: string;
  consumedAt?: string;
};

export type AppOutboxState = 'pending' | 'sent' | 'received' | 'result_unknown' | 'failed';

export type AppOutboxRecord = {
  schemaVersion: 1;
  targetDeviceId: string;
  targetDaemonHostId: string;
  messageId: string;
  kind: 'message' | 'file';
  subject: string;
  body?: string;
  file?: {
    transferId: string;
    fileName: string;
    totalBytes: number;
    chunkCount: number;
    sha256: string;
  };
  state: AppOutboxState;
  lastError?: string;
  updatedAt: string;
};

export type AppStagingMetadata = {
  schemaVersion: 1;
  senderDaemonHostId: string;
  senderDeviceId: string;
  receiverDeviceId: string;
  receiverDaemonHostId: string;
  transferId: string;
  messageId: string;
  subject: string;
  fileName: string;
  totalBytes: number;
  chunkCount: number;
  sha256: string;
  reservedBytes: number;
  persistedOffset: number;
  phase: 'open' | 'verified';
  absolutePath?: string;
};

export class AppStoreError extends Error {
  readonly code: 'storage_error' | 'inbox_full' | 'chunk_conflict' | 'storage_inconsistent';

  constructor(code: AppStoreError['code'], message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'AppStoreError';
    this.code = code;
    if (options?.cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: options.cause });
    }
  }
}

function assertSegment(value: string): string {
  if (value.length === 0 || new TextEncoder().encode(value).length > APP_MAX_PATH_IDENTITY_BYTES) {
    throw new AppStoreError('storage_error', 'identity segment is empty or longer than 191 UTF-8 bytes');
  }
  return value;
}

async function fsyncDirectory(directory: string) {
  try {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is not supported on every filesystem. The atomic rename
    // and file fsync still guard record publication.
  }
}

async function atomicWriteJson(filePath: string, value: unknown) {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tmpPath = join(directory, `.tmp-${randomUUID()}.json`);
  const handle = await open(tmpPath, 'wx');
  try {
    await handle.writeFile(JSON.stringify(value), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmpPath, filePath);
  await fsyncDirectory(directory);
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export class DaemonAppMessagingStore {
  readonly inboxRoot: string;
  readonly outboxRoot: string;
  private readonly maxInboxRecords: number;
  private readonly maxInboxBytes: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: { appRootDir: string; maxInboxRecords?: number; maxInboxBytes?: number }) {
    this.inboxRoot = join(options.appRootDir, 'app-inbox');
    this.outboxRoot = join(options.appRootDir, 'app-outbox');
    this.maxInboxRecords = options.maxInboxRecords ?? APP_MAX_INBOX_RECORDS;
    this.maxInboxBytes = options.maxInboxBytes ?? APP_MAX_INBOX_BYTES;
  }

  async initialize() {
    await mkdir(this.inboxRoot, { recursive: true });
    await mkdir(this.outboxRoot, { recursive: true });
  }

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private recordDir(partition: string) {
    return join(this.inboxRoot, 'records', encodeAppPathSegment(assertSegment(partition)));
  }

  private filesDir(partition: string, messageId: string) {
    return join(this.inboxRoot, 'files', encodeAppPathSegment(assertSegment(partition)), encodeAppPathSegment(assertSegment(messageId)));
  }

  private stagingDir(partition: string) {
    return join(this.inboxRoot, 'staging', encodeAppPathSegment(assertSegment(partition)));
  }

  private outboxDir(partition: string) {
    return join(this.outboxRoot, 'records', encodeAppPathSegment(assertSegment(partition)));
  }

  inboxRecordPath(senderDaemonHostId: string, messageId: string) {
    return join(this.recordDir(senderDaemonHostId), `${encodeAppPathSegment(assertSegment(messageId))}.json`);
  }

  outboxRecordPath(targetDaemonHostId: string, messageId: string) {
    return join(this.outboxDir(targetDaemonHostId), `${encodeAppPathSegment(assertSegment(messageId))}.json`);
  }

  stagingPartPath(senderDaemonHostId: string, transferId: string) {
    return join(this.stagingDir(senderDaemonHostId), `${encodeAppPathSegment(assertSegment(transferId))}.part`);
  }

  stagingMetaPath(senderDaemonHostId: string, transferId: string) {
    return join(this.stagingDir(senderDaemonHostId), `${encodeAppPathSegment(assertSegment(transferId))}.json`);
  }

  finalFilePath(senderDaemonHostId: string, messageId: string, safeFileName: string) {
    return join(this.filesDir(senderDaemonHostId, messageId), safeFileName);
  }

  async writeInboxRecord(record: AppInboxRecord) {
    await atomicWriteJson(this.inboxRecordPath(record.senderDaemonHostId, record.messageId), record);
  }

  async readInboxRecord(senderDaemonHostId: string, messageId: string): Promise<AppInboxRecord | null> {
    return readJson<AppInboxRecord>(this.inboxRecordPath(senderDaemonHostId, messageId));
  }

  async listInboxRecords(): Promise<AppInboxRecord[]> {
    const records: AppInboxRecord[] = [];
    await this.walkJson(this.recordRoot(), (record) => {
      records.push(record as AppInboxRecord);
    });
    return records;
  }

  async writeOutboxRecord(record: AppOutboxRecord) {
    await atomicWriteJson(this.outboxRecordPath(record.targetDaemonHostId, record.messageId), record);
  }

  async readOutboxRecord(targetDaemonHostId: string, messageId: string): Promise<AppOutboxRecord | null> {
    return readJson<AppOutboxRecord>(this.outboxRecordPath(targetDaemonHostId, messageId));
  }

  async listOutboxRecords(): Promise<AppOutboxRecord[]> {
    const records: AppOutboxRecord[] = [];
    await this.walkJson(join(this.outboxRoot, 'records'), (record) => {
      records.push(record as AppOutboxRecord);
    });
    return records;
  }

  async listStagingMetadata(): Promise<AppStagingMetadata[]> {
    const metadata: AppStagingMetadata[] = [];
    const stagingRoot = join(this.inboxRoot, 'staging');
    await this.walkJson(stagingRoot, (record) => {
      if (record && (record as AppStagingMetadata).schemaVersion === 1) {
        metadata.push(record as AppStagingMetadata);
      }
    });
    return metadata;
  }

  async writeStagingMetadata(metadata: AppStagingMetadata) {
    await atomicWriteJson(this.stagingMetaPath(metadata.senderDaemonHostId, metadata.transferId), metadata);
  }

  async readStagingMetadata(senderDaemonHostId: string, transferId: string): Promise<AppStagingMetadata | null> {
    return readJson<AppStagingMetadata>(this.stagingMetaPath(senderDaemonHostId, transferId));
  }

  async openStagingPart(metadata: AppStagingMetadata) {
    await mkdir(this.stagingDir(metadata.senderDaemonHostId), { recursive: true });
    await mkdir(this.filesDir(metadata.senderDaemonHostId, metadata.messageId), { recursive: true });
    await this.writeStagingMetadata({ ...metadata, phase: 'open' });
    const partPath = this.stagingPartPath(metadata.senderDaemonHostId, metadata.transferId);
    const handle = await open(partPath, 'w');
    await handle.sync();
    await handle.close();
    await fsyncDirectory(dirname(partPath));
  }

  async appendPart(senderDaemonHostId: string, transferId: string, expectedOffset: number, data: Buffer) {
    const partPath = this.stagingPartPath(senderDaemonHostId, transferId);
    const handle = await open(partPath, 'r+');
    try {
      const currentSize = (await handle.stat()).size;
      if (currentSize !== expectedOffset) {
        throw new AppStoreError('chunk_conflict', `offset ${expectedOffset} does not match persisted part size ${currentSize}`);
      }
      await handle.write(data, 0, data.length, expectedOffset);
      await handle.sync();
      return expectedOffset + data.length;
    } finally {
      await handle.close();
    }
  }

  async statPart(senderDaemonHostId: string, transferId: string): Promise<number> {
    try {
      return (await stat(this.stagingPartPath(senderDaemonHostId, transferId))).size;
    } catch (error) {
      if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0;
      }
      throw error;
    }
  }

  async truncatePart(senderDaemonHostId: string, transferId: string, size: number) {
    const handle = await open(this.stagingPartPath(senderDaemonHostId, transferId), 'r+');
    try {
      await handle.truncate(size);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async readPartRange(senderDaemonHostId: string, transferId: string, offset: number, length: number): Promise<Buffer> {
    const handle = await open(this.stagingPartPath(senderDaemonHostId, transferId), 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async removePart(senderDaemonHostId: string, transferId: string) {
    await rm(this.stagingPartPath(senderDaemonHostId, transferId), { force: true });
  }

  async renamePartToFinal(senderDaemonHostId: string, messageId: string, safeFileName: string, transferId: string) {
    const target = this.finalFilePath(senderDaemonHostId, messageId, safeFileName);
    await mkdir(dirname(target), { recursive: true });
    await rename(this.stagingPartPath(senderDaemonHostId, transferId), target);
    await fsyncDirectory(dirname(target));
    return target;
  }

  async computeFileSha256(filePath: string): Promise<string> {
    const hash = createHash('sha256');
    const handle = await open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead <= 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
    } finally {
      await handle.close();
    }
    return hash.digest('hex');
  }

  async computeInboxUsage(excludeStaging?: { senderDaemonHostId: string; transferId: string }) {
    let records = 0;
    let bytes = 0;
    await this.walkJson(this.recordRoot(), () => {
      records += 1;
    });
    await this.walkFiles(join(this.inboxRoot, 'files'), (_filePath, size) => {
      bytes += size;
    });
    const staging = await this.listStagingMetadata();
    for (const meta of staging) {
      if (
        excludeStaging
        && meta.senderDaemonHostId === excludeStaging.senderDaemonHostId
        && meta.transferId === excludeStaging.transferId
      ) {
        continue;
      }
      records += 1;
      bytes += meta.reservedBytes;
    }
    return { records, bytes };
  }

  async admitInboxRecord(
    record: AppInboxRecord,
    reservedBytes: number,
    options?: { staging?: { senderDaemonHostId: string; transferId: string } },
  ) {
    const existing = await this.readInboxRecord(record.senderDaemonHostId, record.messageId);
    const isNew = existing === null;
    if (isNew) {
      const usage = await this.computeInboxUsage(options?.staging);
      if (usage.records + 1 > this.maxInboxRecords) {
        throw new AppStoreError('inbox_full', 'durable inbox record limit reached');
      }
      if (usage.bytes + reservedBytes > this.maxInboxBytes) {
        throw new AppStoreError('inbox_full', 'durable inbox byte limit reached');
      }
    }
    await this.writeInboxRecord(record);
    return isNew;
  }

  async removeInboxRecord(record: AppInboxRecord) {
    await rm(this.inboxRecordPath(record.senderDaemonHostId, record.messageId), { force: true });
    if (record.file) {
      await rm(dirname(record.file.absolutePath), { recursive: true, force: true });
    }
  }

  async cleanupRetention(now: number, retentionMs: number) {
    const records = await this.listInboxRecords();
    for (const record of records) {
      if (record.state !== 'delivered' && record.state !== 'consumed') continue;
      const settledAt = record.consumedAt ?? record.deliveredAt ?? record.receivedAt;
      const settled = Date.parse(settledAt);
      if (!Number.isFinite(settled) || now - settled < retentionMs) continue;
      await this.removeInboxRecord(record);
    }
  }

  async recoverStaging(): Promise<AppInboxRecord[]> {
    const recovered: AppInboxRecord[] = [];
    for (const meta of await this.listStagingMetadata()) {
      const partSize = await this.statPart(meta.senderDaemonHostId, meta.transferId);
      if (meta.phase === 'verified') {
        const absolutePath = meta.absolutePath ?? this.finalFilePath(meta.senderDaemonHostId, meta.messageId, meta.fileName);
        if (partSize === 0) {
          const finalSize = await stat(absolutePath).then((s) => s.size).catch(() => -1);
          if (finalSize !== meta.totalBytes) {
            throw new AppStoreError('storage_inconsistent', `verified transfer ${meta.transferId} has no final file and no part`);
          }
        } else if (partSize !== meta.totalBytes) {
          throw new AppStoreError('storage_inconsistent', `verified transfer ${meta.transferId} part size ${partSize} != ${meta.totalBytes}`);
        } else {
          await this.renamePartToFinal(meta.senderDaemonHostId, meta.messageId, meta.fileName, meta.transferId);
        }
        const record = await this.finishRecoveredFile(meta, absolutePath);
        if (record) recovered.push(record);
        continue;
      }

      if (partSize < meta.persistedOffset) {
        throw new AppStoreError('storage_inconsistent', `open transfer ${meta.transferId} part ${partSize} < persisted offset ${meta.persistedOffset}`);
      }
      if (partSize > meta.persistedOffset) {
        await this.truncatePart(meta.senderDaemonHostId, meta.transferId, meta.persistedOffset);
      }
    }
    return recovered;
  }

  private async finishRecoveredFile(meta: AppStagingMetadata, absolutePath: string): Promise<AppInboxRecord | null> {
    const existing = await this.readInboxRecord(meta.senderDaemonHostId, meta.messageId);
    if (existing) return null;
    const receivedAt = new Date().toISOString();
    const record: AppInboxRecord = {
      schemaVersion: 1,
      senderDaemonHostId: meta.senderDaemonHostId,
      senderDeviceId: meta.senderDeviceId,
      receiverDeviceId: meta.receiverDeviceId,
      receiverDaemonHostId: meta.receiverDaemonHostId,
      messageId: meta.messageId,
      kind: 'file',
      subject: meta.subject,
      file: {
        transferId: meta.transferId,
        fileName: meta.fileName,
        totalBytes: meta.totalBytes,
        chunkCount: meta.chunkCount,
        sha256: meta.sha256,
        absolutePath,
      },
      state: 'received',
      receivedAt,
    };
    await this.writeInboxRecord(record);
    await rm(this.stagingMetaPath(meta.senderDaemonHostId, meta.transferId), { force: true });
    return record;
  }

  private recordRoot() {
    return join(this.inboxRoot, 'records');
  }

  private async walkJson(root: string, visit: (value: unknown) => void | Promise<void>) {
    let entries: Dirent[] = [];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const next = join(root, entry.name);
      if (entry.isDirectory()) {
        await this.walkJson(next, visit);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        const value = await readJson<unknown>(next);
        if (value !== null) await visit(value);
      }
    }
  }

  private async walkFiles(root: string, visit: (filePath: string, size: number) => void | Promise<void>) {
    let entries: Dirent[] = [];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const next = join(root, entry.name);
      if (entry.isDirectory()) {
        await this.walkFiles(next, visit);
      } else if (entry.isFile()) {
        const size = (await stat(next)).size;
        await visit(next, size);
      }
    }
  }
}
