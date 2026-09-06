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
import type {
  FileTransferDownloadDestination,
  FileTransferDownloadIntent,
  FileTransferDownloadStore,
} from './file-transfer-native-store-port';
import {
  FILE_TRANSFER_UPLOAD_RESUME_RETRY_DELAY_MS,
  FILE_TRANSFER_UPLOAD_RESUME_RETRY_LIMIT,
  type UploadResumePolicy,
} from './file-transfer-throughput-runtime';

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

export interface FileTransferDownloadProbe {
  generation: number;
}

export interface FileTransferSessionRuntimeDeps {
  now?: () => number;
  randomId?: () => string;
  downloadStore?: FileTransferDownloadStore;
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
  let sessionGeneration = 0;
  let sessionScopeId = '';
  let requestSequence = 0;
  let disposed = false;
  let activePreviewRequestId: string | null = null;
  let previewChunks = new Map<number, string>();
  let previewChunkByteLengths = new Map<number, number>();
  let previewReceivedBytes = 0;
  let previewExpectedChunks: number | null = null;
  const stateListeners = new Set<() => void>();
  const downloadWaiters = new Map<string, {
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  const uploadWaiters = new Map<string, {
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  const uploadProgressWaiters = new Map<string, Set<UploadProgressWaiter>>();
  const uploadChunkCounts = new Map<string, number>();
  const now = deps?.now ?? (() => Date.now());
  const randomId = deps?.randomId ?? (() => Math.random().toString(36).slice(2, 6));
  const sessionDownloads = new Map<string, {
    generation: number;
    scopeId: string;
    destination?: FileTransferDownloadDestination;
    fileName: string;
    totalBytes: number;
    chunks: Map<number, string>;
    expectedChunks: number | null;
    receivedBytes: number;
    completionStarted: boolean;
    status: 'receiving' | 'persisting' | 'done' | 'error';
    error?: string;
  }>();
  let openDownloadGeneration = 0;

  const clearPreviewAssembly = () => {
    activePreviewRequestId = null;
    previewChunks = new Map();
    previewChunkByteLengths = new Map();
    previewReceivedBytes = 0;
    previewExpectedChunks = null;
  };

  const settleDownloadWaiter = (requestId: string, error?: Error) => {
    const waiter = downloadWaiters.get(requestId);
    if (!waiter) {
      return;
    }
    downloadWaiters.delete(requestId);
    if (error) {
      waiter.reject(error);
    } else {
      waiter.resolve();
    }
  };

  const settleUploadWaiter = (requestId: string, error?: Error) => {
    const waiter = uploadWaiters.get(requestId);
    if (!waiter) {
      return;
    }
    uploadWaiters.delete(requestId);
    if (error) {
      waiter.reject(error);
    } else {
      waiter.resolve();
    }
  };

  const clearDownloadAssembly = (
    requestId: string,
    download: {
      chunks: Map<number, string>;
      expectedChunks: number | null;
      receivedBytes: number;
      completionStarted: boolean;
      destination?: FileTransferDownloadDestination;
    },
  ) => {
    download.chunks.clear();
    download.expectedChunks = null;
    download.receivedBytes = 0;
    download.completionStarted = false;
    download.destination = undefined;
    sessionDownloads.delete(requestId);
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

  const readUploadResumeChunk = (requestId: string): number | null => {
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
  };

  const createUploadResumePolicy = (requestId: string): UploadResumePolicy => ({
    maxAttempts: FILE_TRANSFER_UPLOAD_RESUME_RETRY_LIMIT,
    delayMs: FILE_TRANSFER_UPLOAD_RESUME_RETRY_DELAY_MS,
    getResumeChunkIndex: () => readUploadResumeChunk(requestId),
  });

  const emitStateChange = () => {
    for (const listener of Array.from(stateListeners)) {
      listener();
    }
  };

  return {
    getState() {
      return state;
    },

    subscribe(listener: () => void) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },

    emitStateChange() {
      emitStateChange();
    },

    getCurrentDownloadGeneration() {
      return sessionGeneration;
    },

    open(initialRemotePath: string, scopeId = '') {
      if (disposed) {
        throw new Error('file transfer session runtime is disposed');
      }
      sessionGeneration += 1;
      for (const requestId of uploadWaiters.keys()) {
        settleUploadWaiter(requestId, new Error('file transfer sheet reopened'));
      }
      activeListRequestId = null;
      clearPreviewAssembly();
      for (const [requestId] of uploadProgressWaiters) {
        clearUploadProgressWaiters(requestId, new Error('file transfer sheet reopened'));
      }
      uploadChunkCounts.clear();
      state = {
        ...createDefaultState(),
        remotePath: initialRemotePath.trim(),
      };
      sessionScopeId = scopeId;
      openDownloadGeneration = sessionGeneration;
      emitStateChange();
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

    startDownload(
      entry: Pick<FileEntry, 'name' | 'size'>,
      remotePath: string,
      intent: FileTransferDownloadIntent,
      probe?: FileTransferDownloadProbe,
    ) {
      if (disposed) {
        throw new Error('file transfer session runtime is disposed');
      }
      const requestId = `fdl-${now()}-${randomId()}-${++requestSequence}`;
      const sessionGenerationAtStart = sessionGeneration;
      if (probe && (
        probe.generation !== openDownloadGeneration
      )) {
        throw new Error('download generation changed');
      }
      if (intent.scopeId !== sessionScopeId) {
        throw new Error('download scope changed');
      }
      const resolvedDestination = deps?.downloadStore?.createDestination({
        requestId,
        scopeId: intent.scopeId,
        downloadDir: intent.downloadDir,
        fileName: entry.name,
      });
      sessionDownloads.set(requestId, {
        generation: sessionGeneration,
        scopeId: resolvedDestination?.scopeId ?? intent.scopeId,
        destination: resolvedDestination,
        fileName: entry.name,
        totalBytes: entry.size,
        chunks: new Map(),
        expectedChunks: entry.size === 0 ? 0 : null,
        receivedBytes: 0,
        completionStarted: false,
        status: 'receiving',
      });
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
        waitForDone: () => new Promise<void>((resolve, reject) => {
          const transfer = findTransfer(requestId);
          if (transfer?.status === 'done') {
            resolve();
            return;
          }
          if (transfer?.status === 'error') {
            reject(new Error(transfer.error || 'download failed'));
            return;
          }
          downloadWaiters.set(requestId, { resolve, reject });
        }),
        isCurrentSession: () => (
          sessionGeneration === sessionGenerationAtStart
          && sessionScopeId === intent.scopeId
        ),
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
      uploadProgressWaiters.set(requestId, new Set());
      const resumePolicy = createUploadResumePolicy(requestId);
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
        resumePolicy,
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
            uploadWaiters.delete(requestId);
            reject(new Error('upload complete timeout'));
          }, timeoutMs);
          uploadWaiters.set(requestId, {
            resolve: () => {
              clearTimeout(timer);
              resolve();
            },
            reject: (error) => {
              clearTimeout(timer);
              reject(error);
            },
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
          const chunkDownload = sessionDownloads.get(msg.payload.requestId);
          if (!chunkDownload || chunkDownload.status !== 'receiving') {
            return false;
          }
          if (
            !Number.isInteger(msg.payload.chunkIndex)
            || msg.payload.chunkIndex < 0
            || !Number.isInteger(msg.payload.totalChunks)
            || msg.payload.totalChunks < 1
            || msg.payload.chunkIndex >= msg.payload.totalChunks
          ) {
            return false;
          }
          if (
            chunkDownload.expectedChunks !== null
            && chunkDownload.expectedChunks !== msg.payload.totalChunks
          ) {
            return false;
          }
          chunkDownload.expectedChunks = msg.payload.totalChunks;
          const existingChunk = chunkDownload.chunks.get(msg.payload.chunkIndex);
          if (existingChunk !== undefined) {
            return existingChunk === msg.payload.dataBase64;
          }
          let chunkBytes: Uint8Array;
          try {
            chunkBytes = decodeBase64Bytes(msg.payload.dataBase64);
          } catch {
            return false;
          }
          chunkDownload.chunks.set(msg.payload.chunkIndex, msg.payload.dataBase64);
          chunkDownload.receivedBytes += chunkBytes.length;
          state = {
            ...state,
            transfers: updateTransfer(state.transfers, msg.payload.requestId, (current) => ({
              ...current,
              transferredBytes: chunkDownload.receivedBytes,
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
          const completeDownload = sessionDownloads.get(msg.payload.requestId);
          if (!completeDownload || completeDownload.status !== 'receiving') {
            return false;
          }
          if (completeDownload.completionStarted) {
            return false;
          }
          completeDownload.completionStarted = true;
          completeDownload.status = 'persisting';
          const requestScopeId = completeDownload.scopeId;
          const requestDestination = completeDownload.destination;
          const expectedChunks = completeDownload.expectedChunks;
          const orderedChunks =
            expectedChunks === 0
              ? []
              : expectedChunks === null
                ? []
                : Array.from({ length: expectedChunks }, (_, index) => completeDownload.chunks.get(index));
          const requestPayload = msg.payload;
          let validationError: string | null = null;
          if (
            expectedChunks === null
            || (expectedChunks > 0 && orderedChunks.some((chunk) => typeof chunk !== 'string'))
            || (expectedChunks === 0 && requestPayload.totalBytes !== 0)
          ) {
            validationError = 'download completed before every chunk was received';
          } else if (completeDownload.totalBytes !== requestPayload.totalBytes) {
            validationError = `download source size changed: received ${requestPayload.totalBytes} bytes`;
          } else if (completeDownload.receivedBytes !== requestPayload.totalBytes) {
            validationError = `download payload size mismatch: received ${completeDownload.receivedBytes} bytes, expected ${requestPayload.totalBytes}`;
          }
          let failure: Error | null = null;
          let completionOwnedCleanup = false;
          try {
            if (validationError) {
              throw new Error(validationError);
            }
            if (!deps?.downloadStore) {
              throw new Error('download persistence capability unavailable');
            }
            if (!requestDestination) {
              throw new Error(`download destination missing for ${requestPayload.requestId}`);
            }
            if (requestDestination.scopeId !== requestScopeId) {
              throw new Error(`download scope changed for ${requestPayload.requestId}`);
            }
            await deps.downloadStore.persist({
              requestId: requestPayload.requestId,
              fileName: requestPayload.fileName,
              totalBytes: requestPayload.totalBytes,
              chunksBase64: orderedChunks as string[],
              destination: requestDestination,
            });
            completionOwnedCleanup = true;
            await deps.downloadStore.complete({
              destination: requestDestination,
              totalBytes: requestPayload.totalBytes,
            });
          } catch (error) {
            failure = error instanceof Error ? error : new Error(String(error));
          }
          if (failure && !completionOwnedCleanup && requestDestination && deps?.downloadStore) {
            try {
              await deps.downloadStore.abort({ destination: requestDestination });
            } catch (cleanupError) {
              failure = new Error(
                `${failure.message}; cleanup failed: ${
                  cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
                }`,
              );
            }
          }
          if (failure) {
            completeDownload.status = 'error';
            completeDownload.error = failure.message;
            state = {
              ...state,
              transfers: updateTransfer(state.transfers, requestPayload.requestId, (current) => ({
                ...current,
                status: 'error',
                error: failure?.message,
              })),
            };
            settleDownloadWaiter(requestPayload.requestId, failure);
            clearDownloadAssembly(requestPayload.requestId, completeDownload);
          } else {
            completeDownload.status = 'done';
            state = {
              ...state,
              transfers: updateTransfer(state.transfers, requestPayload.requestId, (current) => ({
                ...current,
                status: 'done',
                transferredBytes: current.totalBytes,
              })),
            };
            settleDownloadWaiter(requestPayload.requestId);
            clearDownloadAssembly(requestPayload.requestId, completeDownload);
          }
          emitStateChange();
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
          const failedDownload = sessionDownloads.get(msg.payload.requestId);
          if (!failedDownload || failedDownload.status !== 'receiving') {
            return false;
          }
          const failedDownloadDestination = failedDownload.destination;
          const originalError = new Error(msg.payload.error);
          failedDownload.status = 'error';
          failedDownload.error = originalError.message;
          if (failedDownloadDestination && deps?.downloadStore) {
            try {
              await deps.downloadStore.abort({ destination: failedDownloadDestination });
            } catch (cleanupError) {
              const error = new Error(
                `${originalError.message}; cleanup failed: ${
                  cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
                }`,
              );
              state = {
                ...state,
                transfers: updateTransfer(state.transfers, msg.payload.requestId, (current) => ({
                  ...current,
                  status: 'error',
                  error: error.message,
                })),
              };
              settleDownloadWaiter(msg.payload.requestId, error);
              clearDownloadAssembly(msg.payload.requestId, failedDownload);
              return true;
            }
          }
          settleDownloadWaiter(msg.payload.requestId, originalError);
          state = {
            ...state,
            transfers: updateTransfer(state.transfers, msg.payload.requestId, (current) => ({
              ...current,
              status: 'error',
              error: msg.payload.error,
            })),
          };
          clearDownloadAssembly(msg.payload.requestId, failedDownload);
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
          settleUploadWaiter(msg.payload.requestId);
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
          settleUploadWaiter(msg.payload.requestId, new Error(msg.payload.error || 'upload failed'));
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
      return readUploadResumeChunk(requestId);
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
      settleUploadWaiter(requestId, new Error(error));
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

    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      const disposeError = new Error('file transfer session closed');
      for (const [requestId, download] of sessionDownloads) {
        if (download.status !== 'receiving') {
          continue;
        }
        download.status = 'error';
        download.error = disposeError.message;
        if (download.destination && deps?.downloadStore) {
          try {
            await deps.downloadStore.abort({ destination: download.destination });
          } catch (cleanupError) {
            download.error = `${disposeError.message}; cleanup failed: ${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }`;
          }
        }
        settleDownloadWaiter(requestId, new Error(download.error));
        clearDownloadAssembly(requestId, download);
      }
      stateListeners.clear();
    },
  };
}

export type FileTransferSessionRuntime = ReturnType<typeof createFileTransferSessionRuntime>;
