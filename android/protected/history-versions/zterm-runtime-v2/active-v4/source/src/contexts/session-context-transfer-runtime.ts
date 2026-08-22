import type {
  AttachFileStartPayload,
  ClientMessage,
  PasteImageStartPayload,
  RemoteScreenshotCapture,
  RemoteScreenshotRequestPayload,
  RemoteScreenshotStatusPayload,
  Session,
} from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type { ClientDaemonConnection } from '../lib/client-daemon-connection';
import {
  ensureSessionReadyForTransfer,
  sendInputThroughSessionTransport,
} from './session-context-input-runtime';

interface MutableRefObject<T> {
  current: T;
}

interface RuntimeDebugFn {
  (event: string, payload?: Record<string, unknown>): void;
}

const TRANSFER_BINARY_CHUNK_BYTES = 16 * 1024;

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
}) {
  return ensureSessionReadyForTransfer({
    sessionId: options.sessionId,
    timeoutMs: options.timeoutMs,
    sessionsRef: {
      current: options.sessions,
    },
    daemonConnection: options.daemonConnection,
  });
}

export async function sendImagePasteRuntime(options: {
  sessionId: string;
  file: File;
  pasteTarget?: PasteImageStartPayload['pasteTarget'];
  imagePasteWaiterRuntime: ImagePasteWaiterRuntime;
  imagePasteResultTimeoutMs?: number;
  ensureSessionReadyForPaste: (sessionId: string, timeoutMs?: number) => Promise<BridgeTransportSocket>;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
}) {
  const targetSessionId = options.sessionId.trim();
  if (!targetSessionId) {
    throw new Error('No target session for image paste');
  }

  const ws = await options.ensureSessionReadyForPaste(targetSessionId);
  const fileBuffer = await options.file.arrayBuffer();
  const payload: PasteImageStartPayload = {
    name: options.file.name || 'upload',
    mimeType: options.file.type || 'application/octet-stream',
    byteLength: fileBuffer.byteLength,
    ...(options.pasteTarget
      ? { pasteTarget: options.pasteTarget }
      : { pasteSequence: '\x16' }),
  };

  options.sendSocketPayload(targetSessionId, ws, JSON.stringify({
    type: 'paste-image-start',
    payload,
  } satisfies ClientMessage));
  sendBinaryTransferPayload(targetSessionId, ws, fileBuffer, options.sendSocketPayload);
  await options.imagePasteWaiterRuntime.wait(
    targetSessionId,
    options.imagePasteResultTimeoutMs,
  );
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
