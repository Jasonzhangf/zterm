import {
  ensureSessionReadyForPasteRuntime,
  requestRemoteScreenshotRuntime,
  sendFileAttachRuntime,
  sendImagePasteRuntime,
  sendInputRuntime,
} from './session-context-transfer-runtime';
import { requestRemoteWindowTargetsRuntime } from './session-context-remote-window-runtime';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type { SessionTransportResource } from '../lib/session-transport-runtime';
import type {
  RemoteScreenshotCapture,
  RemoteScreenshotStatusPayload,
  RemoteWindowStreamTargetsResponsePayload,
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

interface RemoteWindowMessageRuntimeLike {
  requestTargets: (
    sessionId: string,
    options: {
      ws: BridgeTransportSocket;
      request?: { includeAppWindows?: boolean; includeIterm2?: boolean };
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    },
  ) => Promise<RemoteWindowStreamTargetsResponsePayload>;
}

export function createSessionInteractionRuntime(options: {
  refs: {
    stateRef: StateRefLike;
    remoteScreenshotRuntimeRef: { current: RemoteScreenshotRuntimeLike };
    remoteWindowMessageRuntimeRef: { current: RemoteWindowMessageRuntimeLike };
  };
  imagePasteReadyTimeoutMs: number;
  runtimeDebug: (event: string, payload?: Record<string, unknown>) => void;
  readSessionTransportResource: (sessionId: string) => SessionTransportResource;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  markPendingInputTailRefresh: (sessionId: string, localRevision: number) => boolean;
  readSessionBufferSnapshot: (sessionId: string) => { revision: number };
  requestSessionBufferHead: (sessionId: string, ws?: BridgeTransportSocket | null, options?: { force?: boolean }) => boolean;
  isReconnectInFlight: (sessionId: string) => boolean;
  hasPendingSessionTransportOpen: (sessionId: string) => boolean;
  isPendingSessionTransportOpenStale: (sessionId: string) => boolean;
}) {
  const sendInput = (sessionId: string, data: string) => {
    sendInputRuntime({
      sessionId,
      data,
      refs: {
        stateRef: options.refs.stateRef,
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

  const requestRemoteWindowTargets = async (sessionId: string) => {
    return requestRemoteWindowTargetsRuntime({
      sessionId,
      sessions: options.refs.stateRef.current.sessions,
      readSessionTransportSocket: options.readSessionTransportSocket,
      remoteWindowMessageRuntime: options.refs.remoteWindowMessageRuntimeRef.current,
      sendSocketPayload: options.sendSocketPayload,
    });
  };

  return {
    sendInput,
    ensureSessionReadyForPaste,
    sendImagePaste,
    sendFileAttach,
    requestRemoteScreenshot,
    requestRemoteWindowTargets,
  };
}
