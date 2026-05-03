import {
  enqueuePendingInput as enqueuePendingInputBaseRuntime,
  flushPendingInputQueue as flushPendingInputQueueBaseRuntime,
} from './session-context-input-runtime';
import {
  ensureSessionReadyForPasteRuntime,
  requestRemoteScreenshotRuntime,
  sendFileAttachRuntime,
  sendImagePasteRuntime,
  sendInputRuntime,
} from './session-context-transfer-runtime';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type {
  RemoteScreenshotCapture,
  RemoteScreenshotStatusPayload,
  Session,
} from '../lib/types';

interface StateRefLike {
  current: {
    sessions: Session[];
    activeSessionId: string | null;
  };
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

export function createSessionInteractionRuntime(options: {
  refs: {
    stateRef: StateRefLike;
    pendingInputQueueRef: { current: Map<string, string[]> };
    remoteScreenshotRuntimeRef: { current: RemoteScreenshotRuntimeLike };
  };
  imagePasteReadyTimeoutMs: number;
  runtimeDebug: (event: string, payload?: Record<string, unknown>) => void;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  markPendingInputTailRefresh: (sessionId: string, localRevision: number) => void;
  readSessionBufferSnapshot: (sessionId: string) => { revision: number };
  requestSessionBufferHead: (sessionId: string, ws: BridgeTransportSocket, options?: { force?: boolean }) => void;
  isSessionTransportActivityStale: (sessionId: string) => boolean;
  isReconnectInFlight: (sessionId: string) => boolean;
  probeOrReconnectStaleSessionTransport: (
    sessionId: string,
    ws: BridgeTransportSocket,
    reason: 'input' | 'active-tick' | 'active-reentry',
  ) => void;
  hasPendingSessionTransportOpen: (sessionId: string) => boolean;
  shouldReconnectQueuedActiveInput: (options: {
    isActiveTarget: boolean;
    wsReadyState: number | null;
    reconnectInFlight: boolean;
  }) => boolean;
  reconnectSession: (sessionId: string) => void;
}) {
  const flushPendingInputQueue = (sessionId: string) => {
    const sessionsSnapshotRef = {
      current: options.refs.stateRef.current.sessions,
    };
    flushPendingInputQueueBaseRuntime({
      sessionId,
      refs: {
        pendingInputQueueRef: options.refs.pendingInputQueueRef,
        sessionsRef: sessionsSnapshotRef,
      },
      readSessionTransportSocket: options.readSessionTransportSocket,
      sendSocketPayload: options.sendSocketPayload,
      markPendingInputTailRefresh: options.markPendingInputTailRefresh,
      readSessionBufferSnapshot: options.readSessionBufferSnapshot,
      requestSessionBufferHead: options.requestSessionBufferHead,
    });
  };

  const enqueuePendingInput = (sessionId: string, payload: string) => {
    enqueuePendingInputBaseRuntime({
      sessionId,
      payload,
      pendingInputQueueRef: options.refs.pendingInputQueueRef,
    });
  };

  const sendInput = (sessionId: string, data: string) => {
    sendInputRuntime({
      sessionId,
      data,
      refs: {
        stateRef: options.refs.stateRef,
      },
      runtimeDebug: options.runtimeDebug,
      readSessionTransportSocket: options.readSessionTransportSocket,
      isSessionTransportActivityStale: options.isSessionTransportActivityStale,
      isReconnectInFlight: options.isReconnectInFlight,
      sendSocketPayload: options.sendSocketPayload,
      markPendingInputTailRefresh: options.markPendingInputTailRefresh,
      readSessionBufferSnapshot: options.readSessionBufferSnapshot,
      requestSessionBufferHead: options.requestSessionBufferHead,
      probeOrReconnectStaleSessionTransport: options.probeOrReconnectStaleSessionTransport,
      enqueuePendingInput,
      hasPendingSessionTransportOpen: options.hasPendingSessionTransportOpen,
      shouldReconnectQueuedActiveInput: options.shouldReconnectQueuedActiveInput,
      reconnectSession: options.reconnectSession,
    });
  };

  const ensureSessionReadyForPaste = async (
    sessionId: string,
    timeoutMs = options.imagePasteReadyTimeoutMs,
  ) => {
    return ensureSessionReadyForPasteRuntime({
      sessionId,
      timeoutMs,
      sessions: options.refs.stateRef.current.sessions,
      readSessionTransportSocket: options.readSessionTransportSocket,
    });
  };

  const sendImagePaste = async (sessionId: string, file: File) => {
    return sendImagePasteRuntime({
      sessionId,
      file,
      ensureSessionReadyForPaste,
      sendSocketPayload: options.sendSocketPayload,
    });
  };

  const sendFileAttach = async (sessionId: string, file: File) => {
    return sendFileAttachRuntime({
      sessionId,
      file,
      ensureSessionReadyForPaste,
      sendSocketPayload: options.sendSocketPayload,
    });
  };

  const requestRemoteScreenshot = async (
    sessionId: string,
    onProgress?: (progress: RemoteScreenshotStatusPayload) => void,
  ) => {
    return requestRemoteScreenshotRuntime({
      sessionId,
      onProgress,
      ensureSessionReadyForPaste,
      remoteScreenshotRuntime: options.refs.remoteScreenshotRuntimeRef.current,
      sendSocketPayload: options.sendSocketPayload,
    });
  };

  return {
    flushPendingInputQueue,
    enqueuePendingInput,
    sendInput,
    ensureSessionReadyForPaste,
    sendImagePaste,
    sendFileAttach,
    requestRemoteScreenshot,
  };
}
