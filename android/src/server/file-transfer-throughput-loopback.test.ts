import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFileTransferSessionRuntime } from '../lib/file-transfer-session-runtime';
import {
  FILE_TRANSFER_UPLOAD_WINDOW_CHUNKS,
  sendBoundedFileUploadChunks,
  writeFileTransferChunkBatches,
} from '../lib/file-transfer-throughput-runtime';
import type { ServerMessage } from '../lib/types';
import { createTerminalFileTransferBinaryRuntime } from './terminal-file-transfer-binary-runtime';
import { createTerminalFileTransferListRuntime } from './terminal-file-transfer-list-runtime';
import type { TerminalFileTransferRuntimeDeps } from './terminal-file-transfer-types';
import type { TerminalSession } from './terminal-runtime-types';

function makeSession(): TerminalSession {
  return {
    id: 'file-loopback-session',
    transportId: 'file-loopback-transport',
    transport: null,
    sessionName: 'file-loopback',
    mirrorKey: 'file-loopback',
    pendingPasteImage: null,
    pendingAttachFile: null,
  };
}

function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

function makeDeterministicBytes(size: number) {
  return Buffer.from(Array.from({ length: size }, (_, index) => (index * 31 + 17) % 256));
}

describe('file transfer bounded-throughput loopback', () => {
  let directory: string | null = null;

  afterEach(() => {
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
      directory = null;
    }
  });

  it('uploads through the real client/daemon runtimes with a bounded window and exact SHA-256', async () => {
    directory = mkdtempSync(join(tmpdir(), 'zterm-file-upload-loopback-'));
    const bytes = makeDeterministicBytes(1024 * 1024);
    const client = createFileTransferSessionRuntime({ now: () => 1, randomId: () => 'loop' });
    client.open(directory);
    const chunkBytes = 16 * 1024;
    const chunkCount = Math.ceil(bytes.length / chunkBytes);
    const upload = client.startUpload({ name: 'upload.bin', size: bytes.length }, directory, chunkCount);
    const session = makeSession();
    let sentChunks = 0;
    let acknowledgedChunks = 0;
    let maxInFlightChunks = 0;
    const deliveryPromises: Promise<unknown>[] = [];
    const deps = {
      uploadDir: directory,
      downloadsDir: directory,
      wtermHomeDir: directory,
      platform: 'darwin',
      sendMessage: (_session: TerminalSession, message: ServerMessage) => {
        deliveryPromises.push(new Promise((resolve) => {
          setTimeout(() => {
            if (message.type === 'file-upload-progress') {
              acknowledgedChunks = Math.max(acknowledgedChunks, message.payload.chunkIndex);
            }
            resolve(client.applyMessage(message as never));
          }, 3);
        }));
      },
      getSessionMirror: () => null,
      scheduleMirrorLiveSync: vi.fn(),
      enqueueBackendInput: vi.fn(async () => true),
      readTmuxPaneCurrentPath: vi.fn(() => directory!),
      runCommand: vi.fn(),
      captureRemoteScreenshot: vi.fn(async ({ outputPath }) => ({ outputPath })),
      logTimePrefix: () => '2026-07-28 00:00:00',
    } satisfies TerminalFileTransferRuntimeDeps;
    const daemon = createTerminalFileTransferBinaryRuntime(deps);

    daemon.handleFileUploadStart(session, upload.startMessage.payload);
    await sendBoundedFileUploadChunks({
      totalChunks: chunkCount,
      waitForProgress: upload.waitForProgress,
      readChunk: async (chunkIndex) => bytes.subarray(
        chunkIndex * chunkBytes,
        Math.min(bytes.length, (chunkIndex + 1) * chunkBytes),
      ).toString('base64'),
      sendChunk: (chunkIndex, dataBase64) => {
        sentChunks += 1;
        maxInFlightChunks = Math.max(maxInFlightChunks, sentChunks - acknowledgedChunks);
        setTimeout(() => {
          daemon.handleFileUploadChunk(session, upload.buildChunkMessage(chunkIndex, dataBase64).payload);
        }, 3);
      },
    });

    const done = upload.waitForDone();
    daemon.handleFileUploadEnd(session, upload.endMessage.payload);
    await done;
    await Promise.all(deliveryPromises);

    const persisted = readFileSync(join(directory, 'upload.bin'));
    expect(sha256(persisted)).toBe(sha256(bytes));
    expect(maxInFlightChunks).toBeLessThanOrEqual(FILE_TRANSFER_UPLOAD_WINDOW_CHUNKS);
    expect(acknowledgedChunks).toBe(chunkCount);
  });

  it('downloads through the real daemon/client runtimes and reduces native writes eightfold', async () => {
    directory = mkdtempSync(join(tmpdir(), 'zterm-file-download-loopback-'));
    const bytes = makeDeterministicBytes(1024 * 1024);
    const remotePath = join(directory, 'download.bin');
    writeFileSync(remotePath, bytes);
    const persistedBatches: Buffer[] = [];
    let nativeWriteCalls = 0;
    const client = createFileTransferSessionRuntime({
      now: () => 2,
      randomId: () => 'loop',
      onDownloadComplete: async (_payload, orderedChunksBase64) => {
        await writeFileTransferChunkBatches({
          chunksBase64: orderedChunksBase64,
          writeBatch: async (chunksBase64) => {
            nativeWriteCalls += 1;
            persistedBatches.push(...chunksBase64.map((chunk) => Buffer.from(chunk, 'base64')));
          },
        });
      },
    });
    client.open(directory);
    const download = client.startDownload({ name: 'download.bin', size: bytes.length }, directory);
    const session = makeSession();
    const deliveryPromises: Promise<unknown>[] = [];
    const deps = {
      uploadDir: directory,
      downloadsDir: directory,
      wtermHomeDir: directory,
      platform: 'darwin',
      sendMessage: (_session: TerminalSession, message: ServerMessage) => {
        deliveryPromises.push(client.applyMessage(message as never));
      },
      getSessionMirror: () => null,
      scheduleMirrorLiveSync: vi.fn(),
      enqueueBackendInput: vi.fn(async () => true),
      readTmuxPaneCurrentPath: vi.fn(() => directory!),
      runCommand: vi.fn(),
      captureRemoteScreenshot: vi.fn(async ({ outputPath }) => ({ outputPath })),
      logTimePrefix: () => '2026-07-28 00:00:00',
    } satisfies TerminalFileTransferRuntimeDeps;
    const daemon = createTerminalFileTransferListRuntime(deps);

    const done = download.waitForDone();
    daemon.handleFileDownloadRequest(session, download.message.payload);
    await done;
    await Promise.all(deliveryPromises);

    expect(sha256(Buffer.concat(persistedBatches))).toBe(sha256(bytes));
    expect(nativeWriteCalls).toBe(8);
  });
});
