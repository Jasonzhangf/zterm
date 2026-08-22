import { describe, expect, it, vi } from 'vitest';
import {
  FILE_TRANSFER_NATIVE_WRITE_BATCH_CHUNKS,
  FILE_TRANSFER_UPLOAD_WINDOW_CHUNKS,
  sendBoundedFileUploadChunks,
  writeFileTransferChunkBatches,
} from './file-transfer-throughput-runtime';

function createProgressGate() {
  let acknowledgedChunks = 0;
  const waiters = new Set<{ minimum: number; resolve: () => void }>();

  return {
    acknowledge(nextAcknowledgedChunks: number) {
      acknowledgedChunks = Math.max(acknowledgedChunks, nextAcknowledgedChunks);
      for (const waiter of Array.from(waiters)) {
        if (acknowledgedChunks >= waiter.minimum) {
          waiters.delete(waiter);
          waiter.resolve();
        }
      }
    },
    waitForProgress(minimum: number) {
      if (acknowledgedChunks >= minimum) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waiters.add({ minimum, resolve });
      });
    },
  };
}

describe('file-transfer-throughput-runtime', () => {
  it('resumes from the requested acknowledged chunk instead of resending written chunks', async () => {
    const sentIndexes: number[] = [];

    await sendBoundedFileUploadChunks({
      totalChunks: 5,
      startChunkIndex: 2,
      readChunk: async (chunkIndex) => `chunk-${chunkIndex}`,
      sendChunk: (chunkIndex) => {
        sentIndexes.push(chunkIndex);
      },
      waitForProgress: () => Promise.resolve(),
    });

    expect(sentIndexes).toEqual([2, 3, 4]);
  });

  it('keeps upload in flight at eight chunks and opens one slot per cumulative ACK', async () => {
    const progress = createProgressGate();
    const sentIndexes: number[] = [];
    const run = sendBoundedFileUploadChunks({
      totalChunks: 10,
      readChunk: async (chunkIndex) => `chunk-${chunkIndex}`,
      sendChunk: (chunkIndex) => {
        sentIndexes.push(chunkIndex);
      },
      waitForProgress: progress.waitForProgress,
    });

    await vi.waitFor(() => expect(sentIndexes).toEqual([0, 1, 2, 3, 4, 5, 6, 7]));
    await Promise.resolve();
    expect(sentIndexes).toHaveLength(FILE_TRANSFER_UPLOAD_WINDOW_CHUNKS);

    progress.acknowledge(1);
    await vi.waitFor(() => expect(sentIndexes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]));
    progress.acknowledge(2);
    await vi.waitFor(() => expect(sentIndexes).toHaveLength(10));

    let settled = false;
    void run.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    progress.acknowledge(10);
    await expect(run).resolves.toBeUndefined();
  });

  it('does not send beyond the bounded window when progress stalls', async () => {
    const progress = createProgressGate();
    const sendChunk = vi.fn();
    void sendBoundedFileUploadChunks({
      totalChunks: 64,
      readChunk: async (chunkIndex) => `chunk-${chunkIndex}`,
      sendChunk,
      waitForProgress: progress.waitForProgress,
    });

    await vi.waitFor(() => expect(sendChunk).toHaveBeenCalledTimes(FILE_TRANSFER_UPLOAD_WINDOW_CHUNKS));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sendChunk).toHaveBeenCalledTimes(FILE_TRANSFER_UPLOAD_WINDOW_CHUNKS);
  });

  it('writes eight wire chunks per native bridge call while preserving order and append truth', async () => {
    const chunks = Array.from({ length: 18 }, (_, index) => Buffer.from(`chunk-${index}|`).toString('base64'));
    const writes: Array<{ chunksBase64: string[]; append: boolean }> = [];

    await writeFileTransferChunkBatches({
      chunksBase64: chunks,
      writeBatch: async (chunksBase64, append) => {
        writes.push({ chunksBase64, append });
      },
    });

    expect(writes).toHaveLength(3);
    expect(writes.map((item) => item.append)).toEqual([false, true, true]);
    expect(writes.flatMap((item) => item.chunksBase64).map((item) => Buffer.from(item, 'base64').toString('utf8')).join('')).toBe(
      Array.from({ length: 18 }, (_, index) => `chunk-${index}|`).join(''),
    );
    expect(FILE_TRANSFER_NATIVE_WRITE_BATCH_CHUNKS).toBe(8);
  });
});
