import type {
  AttachFileStartPayload,
  ClientMessage,
  PasteImageStartPayload,
  RemoteScreenshotCapture,
  RemoteScreenshotStatusPayload,
  Session,
} from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type { SessionTransportResource } from '../lib/session-transport-runtime';
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
  readSessionTransportResource: (sessionId: string) => SessionTransportResource;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  isReconnectInFlight: (sessionId: string) => boolean;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  markPendingInputTailRefresh: (sessionId: string, localRevision: number) => boolean;
  readSessionBufferSnapshot: (sessionId: string) => { revision: number };
  requestSessionBufferHead: (sessionId: string, ws?: BridgeTransportSocket | null, options?: { force?: boolean }) => boolean;
  hasPendingSessionTransportOpen: (sessionId: string) => boolean;
  isPendingSessionTransportOpenStale: (sessionId: string) => boolean;
}) {
  const sessionsSnapshotRef = {
    current: options.refs.stateRef.current.sessions,
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
    readSessionTransportResource: options.readSessionTransportResource,
    readSessionTransportSocket: options.readSessionTransportSocket,
    isReconnectInFlight: options.isReconnectInFlight,
    sendSocketPayload: options.sendSocketPayload,
    markPendingInputTailRefresh: options.markPendingInputTailRefresh,
    readSessionBufferSnapshot: options.readSessionBufferSnapshot,
    requestSessionBufferHead: options.requestSessionBufferHead,
    hasPendingSessionTransportOpen: options.hasPendingSessionTransportOpen,
    isPendingSessionTransportOpenStale: options.isPendingSessionTransportOpenStale,
  });
}

export async function ensureSessionReadyForPasteRuntime(options: {
  sessionId: string;
  timeoutMs: number;
  sessions: Session[];
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
}) {
  return ensureSessionReadyForTransfer({
    sessionId: options.sessionId,
    timeoutMs: options.timeoutMs,
    sessionsRef: {
      current: options.sessions,
    },
    readSessionTransportSocket: options.readSessionTransportSocket,
  });
}

export async function sendImagePasteRuntime(options: {
  sessionId: string;
  file: File;
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
    pasteSequence: '\x16',
  };

  options.sendSocketPayload(targetSessionId, ws, JSON.stringify({
    type: 'paste-image-start',
    payload,
  } satisfies ClientMessage));
  sendBinaryTransferPayload(targetSessionId, ws, fileBuffer, options.sendSocketPayload);
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
    sendSocketPayload: options.sendSocketPayload,
  });
}
