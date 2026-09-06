import { describe, expect, it, vi } from 'vitest';
import {
  createFileTransferDownloadStore,
  type FileTransferNativeStorePort,
} from './file-transfer-native-store-port';

function createNativeStore(
  overrides: Partial<FileTransferNativeStorePort> = {},
): FileTransferNativeStorePort {
  return {
    mkdir: vi.fn(async () => undefined),
    stat: vi.fn(async ({ path }) => ({
      size: path.includes('.part') ? 5 : 5,
      modified: 1,
      uri: `file://${path}`,
      type: 'file' as const,
    })),
    writeFile: vi.fn(async () => undefined),
    writeFileChunks: vi.fn(async ({ chunks }) => ({
      bytesWritten: chunks.join('').length,
    })),
    publishFile: vi.fn(async ({ expectedBytes }) => ({
      bytesPublished: expectedBytes,
    })),
    deleteFile: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('file-transfer-native-store-port', () => {
  it('creates request-unique staging paths while keeping the target deterministic', () => {
    const store = createFileTransferDownloadStore(createNativeStore());

    const first = store.createDestination({
      requestId: 'fdl-one',
      scopeId: 'scope-a',
      downloadDir: '/storage/emulated/0/Download/zterm',
      fileName: 'same.bin',
    });
    const second = store.createDestination({
      requestId: 'fdl-two',
      scopeId: 'scope-a',
      downloadDir: '/storage/emulated/0/Download/zterm',
      fileName: 'same.bin',
    });

    expect(first.targetPath).toBe(
      '/storage/emulated/0/Download/zterm/same.bin',
    );
    expect(first.stagingPath).not.toBe(second.stagingPath);
    expect(first.stagingPath).toContain('.zterm-download-fdl-one.part');
  });

  it('persists ordered chunks through bounded native batches', async () => {
    const nativeStore = createNativeStore();
    const store = createFileTransferDownloadStore(nativeStore);
    const destination = store.createDestination({
      requestId: 'fdl-batch',
      scopeId: 'scope-a',
      downloadDir: '/storage/emulated/0/Download/zterm',
      fileName: 'batch.bin',
    });
    const chunksBase64 = Array.from({ length: 18 }, (_, index) =>
      Buffer.from(`chunk-${index}|`).toString('base64'),
    );

    await store.persist({
      requestId: destination.requestId,
      fileName: destination.fileName,
      totalBytes: 0,
      chunksBase64,
      destination,
    });

    expect(nativeStore.mkdir).toHaveBeenCalledWith({
      path: destination.downloadDir,
      recursive: true,
    });
    expect(nativeStore.writeFileChunks).toHaveBeenCalledTimes(3);
    expect(
      vi.mocked(nativeStore.writeFileChunks).mock.calls.map(
        ([input]) => input.append,
      ),
    ).toEqual([false, true, true]);
    expect(
      vi.mocked(nativeStore.writeFileChunks).mock.calls.flatMap(
        ([input]) => input.chunks,
      ),
    ).toEqual(chunksBase64);
  });

  it('stats staging, atomically publishes, then stats the final target', async () => {
    const nativeStore = createNativeStore();
    const store = createFileTransferDownloadStore(nativeStore);
    const destination = store.createDestination({
      requestId: 'fdl-complete',
      scopeId: 'scope-a',
      downloadDir: '/storage/emulated/0/Download/zterm',
      fileName: 'complete.bin',
    });

    await store.complete({ destination, totalBytes: 5 });

    expect(nativeStore.publishFile).toHaveBeenCalledWith({
      sourcePath: destination.stagingPath,
      targetPath: destination.targetPath,
      expectedBytes: 5,
    });
    expect(vi.mocked(nativeStore.stat).mock.calls.map(([input]) => input.path)).toEqual([
      destination.stagingPath,
      destination.targetPath,
    ]);
  });

  it('rejects staging size mismatch, skips publish, and cleans staging', async () => {
    const nativeStore = createNativeStore({
      stat: vi.fn(async ({ path }) => ({
        size: path.includes('.part') ? 4 : 5,
        modified: 1,
        uri: `file://${path}`,
        type: 'file' as const,
      })),
    });
    const store = createFileTransferDownloadStore(nativeStore);
    const destination = store.createDestination({
      requestId: 'fdl-mismatch',
      scopeId: 'scope-a',
      downloadDir: '/storage/emulated/0/Download/zterm',
      fileName: 'mismatch.bin',
    });

    await expect(store.complete({ destination, totalBytes: 5 })).rejects.toThrow(
      'download size mismatch',
    );
    expect(nativeStore.publishFile).not.toHaveBeenCalled();
    expect(nativeStore.deleteFile).toHaveBeenCalledWith({
      path: destination.stagingPath,
    });
  });

  it('does not report completion when final stat fails and still cleans staging', async () => {
    const nativeStore = createNativeStore({
      stat: vi
        .fn()
        .mockResolvedValueOnce({
          size: 5,
          modified: 1,
          uri: 'file:///staging',
          type: 'file',
        })
        .mockRejectedValueOnce(new Error('final stat failed')),
    });
    const store = createFileTransferDownloadStore(nativeStore);
    const destination = store.createDestination({
      requestId: 'fdl-final-stat',
      scopeId: 'scope-a',
      downloadDir: '/storage/emulated/0/Download/zterm',
      fileName: 'final-stat.bin',
    });

    await expect(store.complete({ destination, totalBytes: 5 })).rejects.toThrow(
      'final stat failed',
    );
    expect(nativeStore.publishFile).toHaveBeenCalledTimes(1);
    expect(nativeStore.deleteFile).toHaveBeenCalledWith({
      path: destination.stagingPath,
    });
  });

  it('preserves the original completion error when cleanup also fails', async () => {
    const nativeStore = createNativeStore({
      stat: vi.fn().mockRejectedValue(new Error('final stat failed')),
      deleteFile: vi.fn().mockRejectedValue(new Error('cleanup failed')),
    });
    const store = createFileTransferDownloadStore(nativeStore);
    const destination = store.createDestination({
      requestId: 'fdl-error-chain',
      scopeId: 'scope-a',
      downloadDir: '/storage/emulated/0/Download/zterm',
      fileName: 'error-chain.bin',
    });

    await expect(store.complete({ destination, totalBytes: 5 })).rejects.toThrow(
      'final stat failed; cleanup failed: cleanup failed',
    );
  });
});
