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
}

export type FileTransferSessionRuntimeMessage =
  | { type: 'file-list-response'; payload: FileListResponsePayload }
  | { type: 'file-list-error'; payload: FileListErrorPayload }
  | { type: 'file-download-chunk'; payload: FileDownloadChunkPayload }
  | { type: 'file-download-complete'; payload: FileDownloadCompletePayload }
  | { type: 'file-download-error'; payload: FileDownloadErrorPayload }
  | { type: 'file-upload-progress'; payload: FileUploadProgressPayload }
  | { type: 'file-upload-complete'; payload: { requestId: string } }
  | { type: 'file-upload-error'; payload: { requestId: string; error: string } };

export interface FileTransferSessionRuntimeDeps {
  now?: () => number;
  randomId?: () => string;
  onDownloadComplete?: (payload: FileDownloadCompletePayload, orderedChunksBase64: string[]) => Promise<void> | void;
}

function createDefaultState(): FileTransferSessionRuntimeState {
  return {
    remotePath: '',
    remoteParentPath: null,
    remoteEntries: [],
    remoteLoading: false,
    transfers: [],
  };
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
  let downloadChunks = new Map<number, string>();
  const waiters = new Map<string, () => void>();
  const now = deps?.now ?? (() => Date.now());
  const randomId = deps?.randomId ?? (() => Math.random().toString(36).slice(2, 6));

  const settleWaiter = (requestId: string) => {
    waiters.get(requestId)?.();
    waiters.delete(requestId);
  };

  return {
    getState() {
      return state;
    },

    open(initialRemotePath: string) {
      activeListRequestId = null;
      activeDownloadRequestId = null;
      downloadChunks = new Map();
      waiters.clear();
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
          if (activeDownloadRequestId !== msg.payload.requestId) {
            return false;
          }
          activeDownloadRequestId = null;
          settleWaiter(msg.payload.requestId);
          await deps?.onDownloadComplete?.(
            msg.payload,
            Array.from({ length: downloadChunks.size }, (_, index) => downloadChunks.get(index) || '').filter(Boolean),
          );
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
  };
}
