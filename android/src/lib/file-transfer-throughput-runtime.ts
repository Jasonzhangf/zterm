import throughputContract from '../../contracts/file-transfer-throughput.json';

export const FILE_TRANSFER_UPLOAD_WINDOW_CHUNKS =
  throughputContract.upload_window_chunks;
export const FILE_TRANSFER_NATIVE_WRITE_BATCH_CHUNKS =
  throughputContract.native_write_batch_chunks;

interface SendBoundedFileUploadChunksOptions<TChunk> {
  totalChunks: number;
  startChunkIndex?: number;
  readChunk: (chunkIndex: number) => Promise<TChunk>;
  sendChunk: (chunkIndex: number, chunk: TChunk) => void;
  waitForProgress: (minimumAcknowledgedChunks: number) => Promise<void>;
  waitForResume?: (error: unknown) => Promise<void>;
  getResumeChunkIndex?: () => number;
}

export async function sendBoundedFileUploadChunks<TChunk>(
  options: SendBoundedFileUploadChunksOptions<TChunk>,
) {
  if (!Number.isInteger(options.totalChunks) || options.totalChunks < 1) {
    throw new Error(`invalid upload chunk count: ${options.totalChunks}`);
  }

  let startChunkIndex = options.startChunkIndex ?? 0;
  for (;;) {
    if (
      !Number.isInteger(startChunkIndex) ||
      startChunkIndex < 0 ||
      startChunkIndex > options.totalChunks
    ) {
      throw new Error(`invalid upload resume index: ${startChunkIndex}`);
    }

    try {
      for (let chunkIndex = startChunkIndex; chunkIndex < options.totalChunks; chunkIndex += 1) {
        if (chunkIndex >= FILE_TRANSFER_UPLOAD_WINDOW_CHUNKS) {
          await options.waitForProgress(
            chunkIndex - FILE_TRANSFER_UPLOAD_WINDOW_CHUNKS + 1,
          );
        }
        const chunk = await options.readChunk(chunkIndex);
        options.sendChunk(chunkIndex, chunk);
      }

      await options.waitForProgress(options.totalChunks);
      return;
    } catch (error) {
      if (!options.waitForResume || !options.getResumeChunkIndex) {
        throw error;
      }
      await options.waitForResume(error);
      startChunkIndex = options.getResumeChunkIndex();
      if (startChunkIndex === options.totalChunks) {
        await options.waitForProgress(options.totalChunks);
        return;
      }
    }
  }
}

interface WriteFileTransferChunkBatchesOptions {
  chunksBase64: string[];
  writeBatch: (chunksBase64: string[], append: boolean) => Promise<void>;
}

export async function writeFileTransferChunkBatches(
  options: WriteFileTransferChunkBatchesOptions,
) {
  for (
    let start = 0;
    start < options.chunksBase64.length;
    start += FILE_TRANSFER_NATIVE_WRITE_BATCH_CHUNKS
  ) {
    const chunksBase64 = options.chunksBase64.slice(
      start,
      start + FILE_TRANSFER_NATIVE_WRITE_BATCH_CHUNKS,
    );
    await options.writeBatch(chunksBase64, start > 0);
  }
}
