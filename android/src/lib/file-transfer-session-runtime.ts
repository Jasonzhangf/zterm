import type {
  FileDownloadChunkPayload,
  FileDownloadCompletePayload,
  FileDownloadErrorPayload,
  FileEntry,
  FileListErrorPayload,
  FileListResponsePayload,
  FileUploadChunkPayload,
  FileUploadEndPayload,
  FileUploadProgressPayload,
  FileUploadStartPayload,
  TransferProgress,
} from './types';

export interface FileTransferSessionRuntimeState {
  remotePath: string;
  remoteParentPath: string | null;
  remoteEntries: FileEntry[];
  remoteLoading: boolean;
  remoteError: string | null;
  transfers: TransferProgress[];
  preview: {
    requestId: string | null;
    fileName: string | null;
    loading: boolean;
    text: string | null;
    error: string | null;
  };
}

export type FileTransferSessionRuntimeMessage =
  | { type: 'file-list-response'; payload: FileListResponsePayload }
  | { type: 'file-list-error'; payload: FileListErrorPayload }
  | { type: 'file-download-chunk'; payload: FileDownloadChunkPayload }
  | { type: 'file-download-complete'; payload: FileDownloadCompletePayload }
  | { type: 'file-download-error'; payload: FileDownloadErrorPayload }
  | { type: 'file-upload-progress'; payload: FileUploadProgressPayload }
  | { type: 'file-upload-complete'; payload: { requestId: string; filePath?: string; bytes?: number } }
  | { type: 'file-upload-error'; payload: { requestId: string; error: string } };

export interface FileTransferSessionRuntimeDeps {
  now?: () => number;
  randomId?: () => string;
  onDownloadComplete?: (payload: FileDownloadCompletePayload, orderedChunksBase64: string[]) => Promise<void> | void;
}

interface UploadProgressWaiter {
  minTransferredChunks: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const TEXT_PREVIEW_MAX_BYTES = 512 * 1024;

function createDefaultState(): FileTransferSessionRuntimeState {
  return {
    remotePath: '',
    remoteParentPath: null,
    remoteEntries: [],
    remoteLoading: false,
    remoteError: null,
    transfers: [],
    preview: {
      requestId: null,
      fileName: null,
      loading: false,
      text: null,
      error: null,
    },
  };
}

function decodeBase64Bytes(data: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function decodeBase64Text(chunks: string[]) {
  const decoder = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  });
  let text = '';
  chunks.forEach((chunk, index) => {
    text += decoder.decode(decodeBase64Bytes(chunk), {
      stream: index < chunks.length - 1,
    });
  });
  text += decoder.decode();
  return text;
}

function buildOrderedPreviewChunks(input: {
  chunks: Map<number, string>;
  expectedChunks: number | null;
  expectedBytes: number;
}) {
  const expectedChunks =
    input.expectedChunks ?? (input.expectedBytes === 0 ? 0 : input.chunks.size);
  if (
    !Number.isInteger(expectedChunks) ||
    expectedChunks < 0 ||
    input.chunks.size !== expectedChunks
  ) {
    throw new Error(
      `incomplete text preview: received ${input.chunks.size} of ${expectedChunks} chunks`,
    );
  }
  let observedBytes = 0;
  const orderedChunks: string[] = [];
  for (let index = 0; index < expectedChunks; index += 1) {
    const chunk = input.chunks.get(index);
    if (typeof chunk !== 'string') {
      throw new Error(`incomplete text preview: missing chunk ${index}`);
    }
    observedBytes += decodeBase64Bytes(chunk).length;
    orderedChunks.push(chunk);
  }
  if (observedBytes !== input.expectedBytes) {
    throw new Error(
      `text preview size mismatch: received ${observedBytes} bytes, expected ${input.expectedBytes}`,
    );
  }
  return orderedChunks;
}

function updateTransfer(
  transfers: TransferProgress[],
  requestId: string,
  updater: (current: TransferProgress) => TransferProgress,
) {
  return transfers.map((item) => (item.id === requestId ? updater(item) : item));
}

export function createFileTransferSessionRuntime(deps?: FileTransferSessionRuntimeDeps) {
  let state = createDefaultState();
  let activeListRequestId: string | null = null;
  let activeDownloadRequestId: string | null = null;
  let activePreviewRequestId: string | null = null;
  let downloadChunks = new Map<number, string>();
  let previewChunks = new Map<number, string>();
  let previewChunkByteLengths = new Map<number, number>();
  let previewReceivedBytes = 0;
  let previewExpectedChunks: number | null = null;
  const waiters = new Map<string, () => void>();
  const uploadProgressWaiters = new Map<string, Set<UploadProgressWaiter>>();
  const uploadChunkCounts = new Map<string, number>();
  const now = deps?.now ?? (() => Date.now());
  const randomId = deps?.randomId ?? (() => Math.random().toString(36).slice(2, 6));

  const clearPreviewAssembly = () => {
    activePreviewRequestId = null;
    previewChunks = new Map();
    previewChunkByteLengths = new Map();
    previewReceivedBytes = 0;
    previewExpectedChunks = null;
  };

  const settleWaiter = (requestId: string) => {
    waiters.get(requestId)?.();
    waiters.delete(requestId);
  };

  const findTransfer = (requestId: string) => state.transfers.find((item) => item.id === requestId);

  const clearUploadProgressWaiters = (requestId: string, error?: Error) => {
    const pending = uploadProgressWaiters.get(requestId);
    if (!pending) {
      return;
    }
    uploadProgressWaiters.delete(requestId);
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      if (error) {
        waiter.reject(error);
      } else {
        waiter.resolve();
      }
    }
  };

  const resolveSatisfiedUploadProgressWaiters = (requestId: string) => {
    const pending = uploadProgressWaiters.get(requestId);
    if (!pending) {
      return;
    }
    const transfer = findTransfer(requestId);
    if (!transfer) {
      return;
    }
    if (transfer.status === 'error') {
      clearUploadProgressWaiters(requestId, new Error(transfer.error || 'upload failed'));
      return;
    }
    if (transfer.status === 'done') {
      clearUploadProgressWaiters(requestId);
      return;
    }
    for (const waiter of Array.from(pending)) {
      if (transfer.transferredBytes >= waiter.minTransferredChunks) {
        pending.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    }
    if (pending.size === 0) {
      uploadProgressWaiters.delete(requestId);
    }
  };

  const waitForUploadProgress = (
    requestId: string,
    minTransferredChunks: number,
    timeoutMs: number,
  ) => {
    const transfer = findTransfer(requestId);
    if (transfer?.status === 'error') {
      return Promise.reject(new Error(transfer.error || 'upload failed'));
    }
    if (transfer?.status === 'done' || (transfer?.transferredBytes ?? -1) >= minTransferredChunks) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: UploadProgressWaiter = {
        minTransferredChunks,
        resolve,
        reject,
        timer: setTimeout(() => {
          const pending = uploadProgressWaiters.get(requestId);
          pending?.delete(waiter);
          if (pending?.size === 0) {
            uploadProgressWaiters.delete(requestId);
          }
          reject(new Error(`upload progress timeout at chunk ${minTransferredChunks}`));
        }, timeoutMs),
      };
      const pending = uploadProgressWaiters.get(requestId) ?? new Set<UploadProgressWaiter>();
      pending.add(waiter);
      uploadProgressWaiters.set(requestId, pending);
    });
  };

  return {
    getState() {
      return state;
    },

    open(initialRemotePath: string) {
      activeListRequestId = null;
      activeDownloadRequestId = null;
      downloadChunks = new Map();
      clearPreviewAssembly();
      waiters.clear();
      for (const [requestId] of uploadProgressWaiters) {
        clearUploadProgressWaiters(requestId, new Error('file transfer sheet reopened'));
      }
      uploadChunkCounts.clear();
      state = {
        ...createDefaultState(),
        remotePath: initialRemotePath.trim(),
      };
      return state;
    },

    requestRemoteList(path: string, showHidden: boolean) {
      const requestId = `flist-${now()}-${randomId()}`;
      activeListRequestId = requestId;
      state = {
        ...state,
        remoteLoading: true,
        remoteError: null,
      };
      return {
        requestId,
        message: {
          type: 'file-list-request' as const,
          payload: { requestId, path, showHidden },
        },
      };
    },

    startDownload(entry: Pick<FileEntry, 'name' | 'size'>, remotePath: string) {
      const requestId = `fdl-${now()}-${randomId()}`;
      activeDownloadRequestId = requestId;
      downloadChunks = new Map();
      state = {
        ...state,
        transfers: [
          ...state.transfers,
          {
            id: requestId,
            fileName: entry.name,
            direction: 'download',
            totalBytes: entry.size,
            transferredBytes: 0,
            status: 'transferring',
          },
        ],
      };
      return {
        requestId,
        message: {
          type: 'file-download-request' as const,
          payload: {
            requestId,
            remotePath: remotePath === '/' ? `/${entry.name}` : `${remotePath}/${entry.name}`,
            fileName: entry.name,
            totalBytes: entry.size,
          },
        },
        waitForDone: () => new Promise<void>((resolve) => {
          waiters.set(requestId, resolve);
        }),
      };
    },

    startPreview(entry: Pick<FileEntry, 'name' | 'size'>, remotePath: string) {
      const requestId = `fpv-${now()}-${randomId()}`;
      activePreviewRequestId = requestId;
      previewChunks = new Map();
      previewChunkByteLengths = new Map();
      previewReceivedBytes = 0;
      previewExpectedChunks = null;
      state = {
        ...state,
        preview: {
          requestId,
          fileName: entry.name,
          loading: true,
          text: null,
          error: null,
        },
      };
      return {
        requestId,
        message: {
          type: 'file-download-request' as const,
          payload: {
            requestId,
            remotePath: remotePath === '/' ? `/${entry.name}` : `${remotePath}/${entry.name}`,
            fileName: entry.name,
            totalBytes: entry.size,
          },
        },
      };
    },

    startUpload(entry: { name: string; size: number }, targetDir: string, chunkCount: number) {
      const requestId = `ful-${now()}-${randomId()}`;
      uploadChunkCounts.set(requestId, chunkCount);
      state = {
        ...state,
        transfers: [
          ...state.transfers,
          {
            id: requestId,
            fileName: entry.name,
            direction: 'upload',
            totalBytes: entry.size,
            transferredBytes: 0,
            status: 'transferring',
          },
        ],
      };
      return {
        requestId,
        startMessage: {
          type: 'file-upload-start' as const,
          payload: {
            requestId,
            targetDir,
            fileName: entry.name,
            fileSize: entry.size,
            chunkCount,
          } satisfies FileUploadStartPayload,
        },
        buildChunkMessage: (chunkIndex: number, dataBase64: string) => ({
          type: 'file-upload-chunk' as const,
          payload: {
            requestId,
            chunkIndex,
            dataBase64,
          } satisfies FileUploadChunkPayload,
        }),
        endMessage: {
          type: 'file-upload-end' as const,
          payload: { requestId } satisfies FileUploadEndPayload,
        },
        waitForProgress: (minTransferredChunks: number, timeoutMs = 15000) => (
          waitForUploadProgress(requestId, minTransferredChunks, timeoutMs)
        ),
        waitForDone: (timeoutMs = 60000) => new Promise<void>((resolve, reject) => {
          const transfer = findTransfer(requestId);
          if (transfer?.status === 'done') {
            resolve();
            return;
          }
          if (transfer?.status === 'error') {
            reject(new Error(transfer.error || 'upload failed'));
            return;
          }
          const timer = setTimeout(() => {
            waiters.delete(requestId);
            reject(new Error('upload complete timeout'));
          }, timeoutMs);
          waiters.set(requestId, () => {
            clearTimeout(timer);
            const settled = findTransfer(requestId);
            if (settled?.status === 'error') {
              reject(new Error(settled.error || 'upload failed'));
              return;
            }
            resolve();
          });
        }),
      };
    },

    async applyMessage(msg: FileTransferSessionRuntimeMessage) {
      switch (msg.type) {
        case 'file-list-response':
          if (activeListRequestId !== msg.payload.requestId) {
            return false;
          }
          activeListRequestId = null;
          state = {
            ...state,
            remotePath: msg.payload.path,
            remoteParentPath: msg.payload.parentPath,
            remoteEntries: msg.payload.entries,
            remoteLoading: false,
            remoteError: null,
          };
          return true;
        case 'file-list-error':
          if (activeListRequestId !== msg.payload.requestId) {
            return false;
          }
          activeListRequestId = null;
          state = {
            ...state,
            remoteLoading: false,
            remoteError: msg.payload.error,
          };
          return true;
        case 'file-download-chunk':
          if (activePreviewRequestId === msg.payload.requestId) {
            if (
              !Number.isInteger(msg.payload.chunkIndex) ||
              msg.payload.chunkIndex < 0 ||
              !Number.isInteger(msg.payload.totalChunks) ||
              msg.payload.totalChunks < 0 ||
              msg.payload.chunkIndex >= msg.payload.totalChunks
            ) {
              clearPreviewAssembly();
              state = {
                ...state,
                preview: {
                  requestId: msg.payload.requestId,
                  fileName: msg.payload.fileName,
                  loading: false,
                  text: null,
                  error: `invalid text preview chunk ${msg.payload.chunkIndex}`,
                },
              };
              return true;
            }
            if (
              previewExpectedChunks !== null &&
              previewExpectedChunks !== msg.payload.totalChunks
            ) {
              clearPreviewAssembly();
              state = {
                ...state,
                preview: {
                  requestId: msg.payload.requestId,
                  fileName: msg.payload.fileName,
                  loading: false,
                  text: null,
                  error: 'conflicting text preview chunk count',
                },
              };
              return true;
            }
            previewExpectedChunks = msg.payload.totalChunks;
            let chunkBytes: Uint8Array;
            try {
              chunkBytes = decodeBase64Bytes(msg.payload.dataBase64);
            } catch (error) {
              clearPreviewAssembly();
              state = {
                ...state,
                preview: {
                  requestId: msg.payload.requestId,
                  fileName: msg.payload.fileName,
                  loading: false,
                  text: null,
                  error: `invalid text preview chunk ${msg.payload.chunkIndex}: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                },
              };
              return true;
            }
            const previousChunkBytes = previewChunkByteLengths.get(msg.payload.chunkIndex) ?? 0;
            previewReceivedBytes += chunkBytes.length - previousChunkBytes;
            if (previewReceivedBytes > TEXT_PREVIEW_MAX_BYTES) {
              clearPreviewAssembly();
              state = {
                ...state,
                preview: {
                  requestId: msg.payload.requestId,
                  fileName: msg.payload.fileName,
                  loading: false,
                  text: null,
                  error: 'text preview exceeds 512 KiB limit',
                },
              };
              return true;
            }
            previewChunkByteLengths.set(msg.payload.chunkIndex, chunkBytes.length);
            previewChunks.set(msg.payload.chunkIndex, msg.payload.dataBase64);
            return true;
          }
          if (activeDownloadRequestId !== msg.payload.requestId) {
            return false;
          }
          downloadChunks.set(msg.payload.chunkIndex, msg.payload.dataBase64);
          state = {
            ...state,
            transfers: updateTransfer(state.transfers, msg.payload.requestId, (current) => ({
              ...current,
              transferredBytes: current.transferredBytes + 1,
              status: 'transferring',
            })),
          };
          return true;
        case 'file-download-complete':
          if (activePreviewRequestId === msg.payload.requestId) {
            try {
              const orderedChunks = buildOrderedPreviewChunks({
                chunks: previewChunks,
                expectedChunks: previewExpectedChunks,
                expectedBytes: msg.payload.totalBytes,
              });
              state = {
                ...state,
                preview: {
                  requestId: msg.payload.requestId,
                  fileName: msg.payload.fileName,
                  loading: false,
                  text: decodeBase64Text(orderedChunks),
                  error: null,
                },
              };
            } catch (error) {
              state = {
                ...state,
                preview: {
                  requestId: msg.payload.requestId,
                  fileName: msg.payload.fileName,
                  loading: false,
                  text: null,
                  error: error instanceof Error ? error.message : String(error),
                },
              };
            }
            clearPreviewAssembly();
            return true;
          }
          if (activeDownloadRequestId !== msg.payload.requestId) {
            return false;
          }
          activeDownloadRequestId = null;
          try {
            await deps?.onDownloadComplete?.(
              msg.payload,
              Array.from({ length: downloadChunks.size }, (_, index) => downloadChunks.get(index) || '').filter(Boolean),
            );
          } catch (error) {
            downloadChunks = new Map();
            state = {
              ...state,
              transfers: updateTransfer(state.transfers, msg.payload.requestId, (current) => ({
                ...current,
                status: 'error',
                error: error instanceof Error ? error.message : String(error),
              })),
            };
            settleWaiter(msg.payload.requestId);
            return true;
          }
          settleWaiter(msg.payload.requestId);
          downloadChunks = new Map();
          state = {
            ...state,
            transfers: updateTransfer(state.transfers, msg.payload.requestId, (current) => ({
              ...current,
              status: 'done',
              transferredBytes: current.totalBytes,
            })),
          };
          return true;
        case 'file-download-error':
          if (activePreviewRequestId === msg.payload.requestId) {
            clearPreviewAssembly();
            state = {
              ...state,
              preview: {
                requestId: msg.payload.requestId,
                fileName: state.preview.fileName,
                loading: false,
                text: null,
                error: msg.payload.error,
              },
            };
            return true;
          }
          activeDownloadRequestId = null;
          settleWaiter(msg.payload.requestId);
          state = {
            ...state,
            transfers: updateTransfer(state.transfers, msg.payload.requestId, (current) => ({
              ...current,
              status: 'error',
              error: msg.payload.error,
            })),
          };
          return true;
        case 'file-upload-progress':
          state = {
            ...state,
            transfers: updateTransfer(state.transfers, msg.payload.requestId, (current) => ({
              ...current,
              transferredBytes: msg.payload.chunkIndex,
              status: 'transferring',
            })),
          };
          resolveSatisfiedUploadProgressWaiters(msg.payload.requestId);
          return true;
        case 'file-upload-complete':
          settleWaiter(msg.payload.requestId);
          state = {
            ...state,
            transfers: updateTransfer(state.transfers, msg.payload.requestId, (current) => ({
              ...current,
              status: 'done',
              transferredBytes: current.totalBytes,
            })),
          };
          clearUploadProgressWaiters(msg.payload.requestId);
          return true;
        case 'file-upload-error':
          settleWaiter(msg.payload.requestId);
          state = {
            ...state,
            transfers: updateTransfer(state.transfers, msg.payload.requestId, (current) => ({
              ...current,
              status: 'error',
              error: msg.payload.error,
            })),
          };
          clearUploadProgressWaiters(
            msg.payload.requestId,
            new Error(msg.payload.error || 'upload failed'),
          );
          return true;
      }
    },

    markDownloadWriteError(requestId: string, error: string) {
      state = {
        ...state,
        transfers: updateTransfer(state.transfers, requestId, (current) => ({
          ...current,
          status: 'error',
          error,
        })),
      };
      return state;
    },

    appendTransferError(transfer: TransferProgress) {
      state = {
        ...state,
        transfers: [...state.transfers, transfer],
      };
      return state;
    },

    getUploadResumeChunk(requestId: string): number | null {
      const totalChunks = uploadChunkCounts.get(requestId);
      if (totalChunks === undefined) {
        return null;
      }
      const transfer = findTransfer(requestId);
      if (transfer?.status === 'done') {
        return totalChunks;
      }
      if (!transfer || transfer.status === 'error') {
        return null;
      }
      const acknowledgedChunks = Number.isInteger(transfer.transferredBytes)
        ? transfer.transferredBytes
        : 0;
      return Math.min(Math.max(acknowledgedChunks, 0), totalChunks);
    },

    markTransferError(requestId: string, error: string) {
      state = {
        ...state,
        transfers: updateTransfer(state.transfers, requestId, (current) => ({
          ...current,
          status: 'error',
          error,
        })),
      };
      settleWaiter(requestId);
      return state;
    },

    setPreviewText(fileName: string, text: string) {
      clearPreviewAssembly();
      state = {
        ...state,
        preview: {
          requestId: null,
          fileName,
          loading: false,
          text,
          error: null,
        },
      };
      return state;
    },

    setPreviewError(fileName: string, error: string) {
      clearPreviewAssembly();
      state = {
        ...state,
        preview: {
          requestId: null,
          fileName,
          loading: false,
          text: null,
          error,
        },
      };
      return state;
    },

    clearPreview() {
      clearPreviewAssembly();
      state = {
        ...state,
        preview: createDefaultState().preview,
      };
      return state;
    },
  };
}
