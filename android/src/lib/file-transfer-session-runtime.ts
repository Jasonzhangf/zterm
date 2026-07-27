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

function createDefaultState(): FileTransferSessionRuntimeState {
  return {
    remotePath: '',
    remoteParentPath: null,
    remoteEntries: [],
    remoteLoading: false,
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

function decodeBase64Text(chunks: string[]) {
  const binary = atob(chunks.join(''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
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
  const waiters = new Map<string, () => void>();
  const uploadProgressWaiters = new Map<string, Set<UploadProgressWaiter>>();
  const now = deps?.now ?? (() => Date.now());
  const randomId = deps?.randomId ?? (() => Math.random().toString(36).slice(2, 6));

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
      activePreviewRequestId = null;
      downloadChunks = new Map();
      previewChunks = new Map();
      waiters.clear();
      for (const [requestId] of uploadProgressWaiters) {
        clearUploadProgressWaiters(requestId, new Error('file transfer sheet reopened'));
      }
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
          };
          return true;
        case 'file-list-error':
          activeListRequestId = null;
          state = {
            ...state,
            remoteLoading: false,
          };
          return true;
        case 'file-download-chunk':
          if (activePreviewRequestId === msg.payload.requestId) {
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
            activePreviewRequestId = null;
            const orderedChunks = Array.from({ length: previewChunks.size }, (_, index) => previewChunks.get(index) || '').filter(Boolean);
            try {
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
            previewChunks = new Map();
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
            activePreviewRequestId = null;
            previewChunks = new Map();
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
      state = {
        ...state,
        preview: createDefaultState().preview,
      };
      return state;
    },
  };
}
