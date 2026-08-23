import type {
  AttachFileStartPayload,
  ClientMessage,
  PasteImageStartPayload,
  RemoteScreenshotCapture,
  RemoteScreenshotRequestPayload,
  RemoteScreenshotStatusPayload,
  Session,
} from '../lib/types';
import {
  FILE_TRANSFER_WIRE_CHUNK_BYTES,
} from '@zterm/shared/protocol';
import { sendBoundedFileUploadChunks } from '../lib/file-transfer-throughput-runtime';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type { ClientDaemonConnection } from '../lib/client-daemon-connection';
import {
  ensureSessionReadyForTransfer,
  sendInputThroughSessionTransport,
} from './session-context-input-runtime';
import type { FileTransferMessage } from '../lib/file-transfer-message-runtime';

interface MutableRefObject<T> {
  current: T;
}

interface RuntimeDebugFn {
  (event: string, payload?: Record<string, unknown>): void;
}

const TRANSFER_BINARY_CHUNK_BYTES = 16 * 1024;

function createImageUploadAckRuntime(subscribe?: (
  handler: (message: FileTransferMessage) => void,
) => () => void) {
  if (!subscribe) {
    throw new Error('image upload progress subscription is required');
  }
  let acknowledgedChunks = 0;
  let complete = false;
  let error: string | null = null;
  const waiters = new Set<{
    minimumChunks: number;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  function settleWaiter(
    waiter: { minimumChunks: number; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> },
    failure?: Error,
  ) {
    if (!waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    if (failure) waiter.reject(failure);
    else waiter.resolve();
  }

  const unsubscribe = subscribe((message) => {
    if (message.type === 'file-upload-progress') {
      acknowledgedChunks = Math.max(acknowledgedChunks, message.payload.chunkIndex);
      for (const waiter of Array.from(waiters)) {
        if (acknowledgedChunks >= waiter.minimumChunks) settleWaiter(waiter);
      }
      return;
    }
    if (message.type === 'file-upload-complete') {
      complete = true;
      for (const waiter of Array.from(waiters)) settleWaiter(waiter);
      return;
    }
    if (message.type === 'file-upload-error') {
      error = message.payload.error;
      const failure = new Error(message.payload.error);
      for (const waiter of Array.from(waiters)) settleWaiter(waiter, failure);
    }
  });

  return {
    waitForProgress(minimumChunks: number, timeoutMs: number) {
      if (error) return Promise.reject(new Error(error || 'image upload failed'));
      if (complete || acknowledgedChunks >= minimumChunks) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const waiter = {
          minimumChunks,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`image upload ACK timeout at chunk ${minimumChunks}`));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
    getAcknowledgedChunks: () => acknowledgedChunks,
    isComplete: () => complete,
    dispose: unsubscribe,
  };
}

function readFileChunkBase64(file: Blob, offset: number, length: number) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('image chunk read failed'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const commaIndex = result.indexOf(',');
      if (commaIndex < 0) {
        reject(new Error('image chunk encoder returned an invalid data URL'));
        return;
      }
      resolve(result.slice(commaIndex + 1));
    };
    reader.readAsDataURL(file.slice(offset, offset + length));
  });
}

export interface ImagePasteWaiterRuntime {
  wait: (sessionId: string, timeoutMs?: number) => Promise<void>;
  resolve: (sessionId: string) => boolean;
  reject: (sessionId: string, message: string) => boolean;
  dispose: () => void;
}

interface PendingImagePaste {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createImagePasteWaiterRuntime(): ImagePasteWaiterRuntime {
  const pendingBySession = new Map<string, PendingImagePaste>();
  const epochBySession = new Map<string, number>();

  function rejectPending(sessionId: string, message: string) {
    const pending = pendingBySession.get(sessionId);
    if (!pending) {
      return false;
    }
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
    pendingBySession.delete(sessionId);
    return true;
  }

  return {
    wait(sessionId, timeoutMs = 30_000) {
      const epoch = (epochBySession.get(sessionId) || 0) + 1;
      epochBySession.set(sessionId, epoch);
      rejectPending(sessionId, 'superseded by a newer image paste');

      const pendingPromise = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const pending = pendingBySession.get(sessionId);
          if (pending?.timer !== timer) {
            return;
          }
          pendingBySession.delete(sessionId);
          reject(new Error(`image paste result timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        pendingBySession.set(sessionId, {
          resolve: () => {
            const pending = pendingBySession.get(sessionId);
            if (pending?.timer !== timer) {
              return;
            }
            clearTimeout(timer);
            pendingBySession.delete(sessionId);
            resolve();
          },
          reject: (error) => {
            const pending = pendingBySession.get(sessionId);
            if (pending?.timer !== timer) {
              return;
            }
            clearTimeout(timer);
            pendingBySession.delete(sessionId);
            reject(error);
          },
          timer,
        });
      });
      // The rejection still reaches awaiting callers; this branch only prevents
      // an abandoned in-flight paste from surfacing as an unhandled rejection
      // when the provider unmounts before the caller observes it.
      pendingPromise.catch(() => {});
      return pendingPromise;
    },
    resolve(sessionId) {
      const pending = pendingBySession.get(sessionId);
      if (!pending) {
        return false;
      }
      clearTimeout(pending.timer);
      pending.resolve();
      pendingBySession.delete(sessionId);
      return true;
    },
    reject: rejectPending,
    dispose() {
      for (const sessionId of Array.from(pendingBySession.keys())) {
        rejectPending(sessionId, 'image paste runtime disposed');
      }
      pendingBySession.clear();
      epochBySession.clear();
    },
  };
}

function sendBinaryTransferPayload(
  sessionId: string,
  ws: BridgeTransportSocket,
  fileBuffer: ArrayBuffer,
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void,
) {
  for (let offset = 0; offset < fileBuffer.byteLength; offset += TRANSFER_BINARY_CHUNK_BYTES) {
    sendSocketPayload(
      sessionId,
      ws,
      fileBuffer.slice(offset, Math.min(offset + TRANSFER_BINARY_CHUNK_BYTES, fileBuffer.byteLength)),
    );
  }
}

interface RemoteScreenshotRuntimeLike {
  request: (
    sessionId: string,
    options: {
      ws: BridgeTransportSocket;
      onProgress?: (progress: RemoteScreenshotStatusPayload) => void;
      request?: Omit<RemoteScreenshotRequestPayload, 'requestId'>;
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    },
  ) => Promise<RemoteScreenshotCapture>;
}

export function sendInputRuntime(options: {
  sessionId: string;
  data: string;
  refs: {
    stateRef: MutableRefObject<{ sessions: Session[]; activeSessionId: string | null }>;
  };
  runtimeDebug: RuntimeDebugFn;
  daemonConnection: ClientDaemonConnection;
  isReconnectInFlight: (sessionId: string) => boolean;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  markPendingInputTailRefresh: (sessionId: string, localRevision: number) => boolean;
  readSessionBufferSnapshot: (sessionId: string) => { revision: number };
  requestSessionBufferHead: (sessionId: string, ws?: BridgeTransportSocket | null, options?: { force?: boolean }) => boolean;
  hasPendingSessionTransportOpen: (sessionId: string) => boolean;
  isPendingSessionTransportOpenStale: (sessionId: string) => boolean;
  scheduleReconnect?: (
    sessionId: string,
    message: string,
    retryable?: boolean,
    options?: { immediate?: boolean; resetAttempt?: boolean; force?: boolean },
  ) => void;
}) {
  const sessionsSnapshotRef = {
    get current() {
      return options.refs.stateRef.current.sessions;
    },
  };
  return sendInputThroughSessionTransport({
    sessionId: options.sessionId,
    data: options.data,
    refs: {
      sessionsRef: sessionsSnapshotRef,
      stateRef: {
        current: { activeSessionId: options.refs.stateRef.current.activeSessionId },
      },
    },
    runtimeDebug: options.runtimeDebug,
    daemonConnection: options.daemonConnection,
    isReconnectInFlight: options.isReconnectInFlight,
    sendSocketPayload: options.sendSocketPayload,
    markPendingInputTailRefresh: options.markPendingInputTailRefresh,
    readSessionBufferSnapshot: options.readSessionBufferSnapshot,
    requestSessionBufferHead: options.requestSessionBufferHead,
    hasPendingSessionTransportOpen: options.hasPendingSessionTransportOpen,
    isPendingSessionTransportOpenStale: options.isPendingSessionTransportOpenStale,
    scheduleReconnect: options.scheduleReconnect,
  });
}

export async function ensureSessionReadyForPasteRuntime(options: {
  sessionId: string;
  timeoutMs: number;
  sessions: Session[];
  daemonConnection: ClientDaemonConnection;
  requestReconnect?: (sessionId: string, reason: string) => void;
}) {
  const sessionId = options.sessionId;
  const readSocket = () => {
    const ws = options.daemonConnection.readSessionSocket(sessionId) || null;
    if (!ws) return null;
    if (ws.readyState === WebSocket.OPEN) return ws;
    if (ws.readyState === WebSocket.CONNECTING) return ws;
    return null;
  };
  const initial = readSocket();
  if (initial) return initial;
  const session = options.sessions.find((item) => item.id === sessionId);
  if (!session) {
    throw new Error('Active session no longer exists');
  }
  if (options.requestReconnect) {
    options.requestReconnect(sessionId, 'transfer transport unavailable');
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < options.timeoutMs) {
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    const socket = readSocket();
    if (socket) return socket;
  }
  throw new Error('Transfer transport did not recover before timeout');
}

export async function sendImagePasteRuntime(options: {
  sessionId: string;
  file: File;
  pasteTarget?: PasteImageStartPayload['pasteTarget'];
  imagePasteWaiterRuntime: ImagePasteWaiterRuntime;
  imagePasteResultTimeoutMs?: number;
  ensureSessionReadyForPaste: (sessionId: string, timeoutMs?: number) => Promise<BridgeTransportSocket>;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  subscribeFileTransferMessages: (
    handler: (message: FileTransferMessage) => void,
  ) => () => void;
}) {
  const targetSessionId = options.sessionId.trim();
  if (!targetSessionId) {
    throw new Error('No target session for image paste');
  }

  const requestId = `paste-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const metadata: PasteImageStartPayload = {
    name: options.file.name || 'upload',
    mimeType: options.file.type || 'application/octet-stream',
    byteLength: options.file.size,
    ...(options.pasteTarget
      ? { pasteTarget: options.pasteTarget }
      : { pasteSequence: '\x16' }),
  };
  const totalChunks = Math.max(1, Math.ceil(options.file.size / FILE_TRANSFER_WIRE_CHUNK_BYTES));
  const acks = createImageUploadAckRuntime(options.subscribeFileTransferMessages);

  try {
    let ws = await options.ensureSessionReadyForPaste(targetSessionId);
    options.sendSocketPayload(targetSessionId, ws, JSON.stringify({
      type: 'file-upload-start',
      payload: {
        requestId,
        targetDir: 'zterm-paste-staging',
        fileName: `${requestId}.bin`,
        fileSize: options.file.size,
        chunkCount: totalChunks,
        pasteImage: metadata,
      },
    } satisfies ClientMessage));

    await sendBoundedFileUploadChunks({
      totalChunks,
      readChunk: (chunkIndex) => readFileChunkBase64(
        options.file,
        chunkIndex * FILE_TRANSFER_WIRE_CHUNK_BYTES,
        FILE_TRANSFER_WIRE_CHUNK_BYTES,
      ),
      sendChunk: async (chunkIndex, dataBase64) => {
        ws = await options.ensureSessionReadyForPaste(targetSessionId);
        options.sendSocketPayload(targetSessionId, ws, JSON.stringify({
          type: 'file-upload-chunk',
          payload: { requestId, chunkIndex, dataBase64 },
        } satisfies ClientMessage));
      },
      waitForProgress: (minimum) => acks.waitForProgress(minimum, 10_000),
      resume: {
        maxAttempts: 8,
        delayMs: 3_000,
        getResumeChunkIndex: () => acks.getAcknowledgedChunks(),
      },
    });

    ws = await options.ensureSessionReadyForPaste(targetSessionId);
    options.sendSocketPayload(targetSessionId, ws, JSON.stringify({
      type: 'file-upload-end',
      payload: { requestId },
    } satisfies ClientMessage));
    ws = await options.ensureSessionReadyForPaste(targetSessionId);
    options.sendSocketPayload(targetSessionId, ws, JSON.stringify({
      type: 'paste-image-from-upload',
      payload: { requestId },
    } satisfies ClientMessage));
    await options.imagePasteWaiterRuntime.wait(
      targetSessionId,
      options.imagePasteResultTimeoutMs,
    );
  } finally {
    acks.dispose();
  }
}

export async function sendFileAttachRuntime(options: {
  sessionId: string;
  file: File;
  ensureSessionReadyForPaste: (sessionId: string, timeoutMs?: number) => Promise<BridgeTransportSocket>;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
}) {
  const targetSessionId = options.sessionId.trim();
  if (!targetSessionId) {
    throw new Error('No target session for file attach');
  }

  const ws = await options.ensureSessionReadyForPaste(targetSessionId);
  const fileBuffer = await options.file.arrayBuffer();
  const payload: AttachFileStartPayload = {
    name: options.file.name || 'attachment',
    mimeType: options.file.type || 'application/octet-stream',
    byteLength: fileBuffer.byteLength,
  };

  options.sendSocketPayload(targetSessionId, ws, JSON.stringify({
    type: 'attach-file-start',
    payload,
  } satisfies ClientMessage));
  sendBinaryTransferPayload(targetSessionId, ws, fileBuffer, options.sendSocketPayload);
}

export async function requestRemoteScreenshotRuntime(options: {
  sessionId: string;
  onProgress?: (progress: RemoteScreenshotStatusPayload) => void;
  request?: Omit<RemoteScreenshotRequestPayload, 'requestId'>;
  ensureSessionReadyForPaste: (sessionId: string, timeoutMs?: number) => Promise<BridgeTransportSocket>;
  remoteScreenshotRuntime: RemoteScreenshotRuntimeLike;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
}) {
  const targetSessionId = options.sessionId.trim();
  if (!targetSessionId) {
    throw new Error('No target session for remote screenshot');
  }

  const ws = await options.ensureSessionReadyForPaste(targetSessionId);
  return options.remoteScreenshotRuntime.request(targetSessionId, {
    ws,
    onProgress: options.onProgress,
    request: options.request,
    sendSocketPayload: options.sendSocketPayload,
  });
}
