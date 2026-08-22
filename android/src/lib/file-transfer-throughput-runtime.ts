import throughputContract from '../../contracts/file-transfer-throughput.json';

export const FILE_TRANSFER_UPLOAD_WINDOW_CHUNKS =
  throughputContract.upload_window_chunks;
export const FILE_TRANSFER_NATIVE_WRITE_BATCH_CHUNKS =
  throughputContract.native_write_batch_chunks;
export const FILE_TRANSFER_UPLOAD_RESUME_RETRY_LIMIT = 8;
export const FILE_TRANSFER_UPLOAD_RESUME_RETRY_DELAY_MS = 3000;

export interface UploadResumePolicy {
  maxAttempts: number;
  delayMs: number;
  getResumeChunkIndex: () => number | null;
}

interface SendBoundedFileUploadChunksOptions<TChunk> {
  totalChunks: number;
  startChunkIndex?: number;
  readChunk: (chunkIndex: number) => Promise<TChunk>;
  sendChunk: (chunkIndex: number, chunk: TChunk) => void;
  waitForProgress: (minimumAcknowledgedChunks: number) => Promise<void>;
  resume?: UploadResumePolicy;
}

export async function sendBoundedFileUploadChunks<TChunk>(
  options: SendBoundedFileUploadChunksOptions<TChunk>,
) {
  if (!Number.isInteger(options.totalChunks) || options.totalChunks < 1) {
    throw new Error(`invalid upload chunk count: ${options.totalChunks}`);
  }

  let startChunkIndex = options.startChunkIndex ?? 0;
  let resumeAttempts = 0;
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
      const resume = options.resume;
      if (!resume) {
        throw error;
      }
      resumeAttempts += 1;
      if (resumeAttempts > resume.maxAttempts) {
        throw new Error("upload resume window expired");
      }
      await new Promise((resolve) => setTimeout(resolve, resume.delayMs));
      const resumeChunkIndex = resume.getResumeChunkIndex();
      if (resumeChunkIndex === null) {
        throw new Error("upload can no longer be resumed");
      }
      startChunkIndex = resumeChunkIndex;
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
