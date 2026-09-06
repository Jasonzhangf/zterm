import { writeFileTransferChunkBatches } from './file-transfer-throughput-runtime';
import { joinLocalDisplayPath } from './file-transfer-path-runtime';

export interface FileTransferDownloadDestination {
  requestId: string;
  scopeId: string;
  fileName: string;
  downloadDir: string;
  targetPath: string;
  stagingPath: string;
}

export interface FileTransferDownloadIntent {
  scopeId: string;
  downloadDir: string;
}

export interface FileTransferNativeStorePort {
  mkdir(options: { path: string; recursive?: boolean }): Promise<void>;
  stat(options: {
    path: string;
  }): Promise<{ size: number; modified: number; uri: string; type: 'file' | 'directory' }>;
  writeFile(options: { path: string; data: string }): Promise<void>;
  writeFileChunks(options: {
    path: string;
    chunks: string[];
    append: boolean;
  }): Promise<{ bytesWritten: number }>;
  publishFile(options: {
    sourcePath: string;
    targetPath: string;
    expectedBytes: number;
  }): Promise<{ bytesPublished: number }>;
  deleteFile(options: { path: string }): Promise<void>;
}

export interface FileTransferDownloadPersistInput {
  requestId: string;
  fileName: string;
  totalBytes: number;
  chunksBase64: string[];
  destination: FileTransferDownloadDestination;
}

export interface FileTransferDownloadStore {
  createDestination(input: {
    requestId: string;
    scopeId: string;
    downloadDir: string;
    fileName: string;
  }): FileTransferDownloadDestination;
  persist(input: FileTransferDownloadPersistInput): Promise<void>;
  complete(input: {
    destination: FileTransferDownloadDestination;
    totalBytes: number;
  }): Promise<void>;
  abort(input: {
    destination: FileTransferDownloadDestination;
  }): Promise<void>;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createFileTransferDownloadStore(
  nativeStore: FileTransferNativeStorePort,
): FileTransferDownloadStore {
  const abort = async (input: {
    destination: FileTransferDownloadDestination;
  }) => {
    try {
      await nativeStore.deleteFile({
        path: input.destination.stagingPath,
      });
    } catch (error) {
      if (!/does not exist|not found|enoent/i.test(formatError(error))) {
        throw error;
      }
    }
  };

  return {
    createDestination(input) {
      const targetPath = joinLocalDisplayPath(input.downloadDir, input.fileName);
      return {
        requestId: input.requestId,
        scopeId: input.scopeId,
        fileName: input.fileName,
        downloadDir: input.downloadDir,
        targetPath,
        stagingPath: joinLocalDisplayPath(
          input.downloadDir,
          `.zterm-download-${input.requestId}.part`,
        ),
      };
    },

    async persist(input) {
      await nativeStore.mkdir({
        path: input.destination.downloadDir,
        recursive: true,
      });
      if (input.totalBytes > 0 && input.chunksBase64.length === 0) {
        throw new Error('download completed without file chunks');
      }
      if (input.chunksBase64.length === 0) {
        await nativeStore.writeFile({
          path: input.destination.stagingPath,
          data: '',
        });
        return;
      }
      await writeFileTransferChunkBatches({
        chunksBase64: input.chunksBase64,
        writeBatch: async (chunksBase64, append) => {
          await nativeStore.writeFileChunks({
            path: input.destination.stagingPath,
            chunks: chunksBase64,
            append,
          });
        },
      });
    },

    async complete(input) {
      try {
        const staged = await nativeStore.stat({
          path: input.destination.stagingPath,
        });
        if (staged.size !== input.totalBytes) {
          throw new Error(
            `download size mismatch: wrote ${staged.size} bytes, expected ${input.totalBytes}`,
          );
        }
        const published = await nativeStore.publishFile({
          sourcePath: input.destination.stagingPath,
          targetPath: input.destination.targetPath,
          expectedBytes: input.totalBytes,
        });
        if (published.bytesPublished !== input.totalBytes) {
          throw new Error(
            `download publish size mismatch: published ${published.bytesPublished} bytes, expected ${input.totalBytes}`,
          );
        }
        const finalStat = await nativeStore.stat({
          path: input.destination.targetPath,
        });
        if (finalStat.size !== input.totalBytes) {
          throw new Error(
            `download final size mismatch: wrote ${finalStat.size} bytes, expected ${input.totalBytes}`,
          );
        }
      } catch (error) {
        try {
          await abort(input);
        } catch (cleanupError) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; cleanup failed: ${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }`,
          );
        }
        throw error;
      }
    },

    abort,
  };
}
