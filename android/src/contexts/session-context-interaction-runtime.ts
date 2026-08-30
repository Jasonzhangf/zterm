import {
  type ImagePasteWaiterRuntime,
  ensureSessionReadyForPasteRuntime,
  requestRemoteScreenshotRuntime,
  sendFileAttachRuntime,
  sendImagePasteRuntime,
  sendInputRuntime,
} from './session-context-transfer-runtime';
import {
  type RemoteWindowTargetCatalogCacheStore,
  requestRemoteWindowStreamStartRuntime,
  requestRemoteWindowTargetsRuntime,
  resizeRemoteWindowTargetRuntime,
  sendRemoteWindowInputRuntime,
  stopRemoteWindowStreamRuntime,
  updateRemoteWindowFocusRuntime,
  updateRemoteWindowStreamQualityRuntime,
} from './session-context-remote-window-runtime';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type { ClientDaemonConnection } from '../lib/client-daemon-connection';
import type { BridgeSettings } from '../lib/bridge-settings';
import type { FileTransferMessageRuntime } from '../lib/file-transfer-message-runtime';
import type {
  PasteImageStartPayload,
  RemoteScreenshotCapture,
  RemoteScreenshotRequestPayload,
  RemoteScreenshotStatusPayload,
  RemoteWindowInputEventPayload,
  RemoteWindowStreamPurpose,
  RemoteWindowStreamQualityRequestPayload,
  RemoteWindowStreamQualityResultPayload,
  RemoteWindowStreamStatusPayload,
  RemoteWindowStreamTargetsResponsePayload,
  RemoteWindowStreamTargetManifest,
  RemoteWindowVideoProfile,
  Session,
} from '../lib/types';
import type { RemoteWindowReceiverStartResult } from '../lib/remote-window-receiver-runtime';

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
      request?: Omit<RemoteScreenshotRequestPayload, 'requestId'>;
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
  requestStreamStart: (...args: any[]) => Promise<any>;
  sendStreamQuality: (...args: any[]) => Promise<RemoteWindowStreamQualityResultPayload>;
  sendStreamUpdateFocus: (...args: any[]) => void;
  sendStreamIceCandidate: (...args: any[]) => void;
  stopStream: (...args: any[]) => Promise<RemoteWindowStreamStatusPayload>;
  sendInputEvent: (...args: any[]) => void;
}

interface RemoteWindowReceiverRuntimeLike {
  startStream: (...args: any[]) => Promise<RemoteWindowReceiverStartResult>;
  stopStream: (streamId: string) => boolean;
}

export function createSessionInteractionRuntime(options: {
  refs: {
    stateRef: StateRefLike;
    imagePasteWaiterRuntimeRef: { current: ImagePasteWaiterRuntime };
    fileTransferMessageRuntimeRef: { current: Pick<FileTransferMessageRuntime, 'subscribe'> };
    remoteScreenshotRuntimeRef: { current: RemoteScreenshotRuntimeLike };
    remoteWindowTargetCatalogCacheRef?: { current: RemoteWindowTargetCatalogCacheStore };
    remoteWindowMessageRuntimeRef: { current: RemoteWindowMessageRuntimeLike };
    remoteWindowReceiverRuntimeRef: { current: RemoteWindowReceiverRuntimeLike };
  };
  imagePasteReadyTimeoutMs: number;
  bridgeSettings: BridgeSettings;
  runtimeDebug: (event: string, payload?: Record<string, unknown>) => void;
  daemonConnection: ClientDaemonConnection;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  markPendingInputTailRefresh: (sessionId: string, localRevision: number) => boolean;
  readSessionBufferSnapshot: (sessionId: string) => { revision: number };
  requestSessionBufferHead: (sessionId: string, ws?: BridgeTransportSocket | null, options?: { force?: boolean }) => boolean;
  isReconnectInFlight: (sessionId: string) => boolean;
  hasPendingSessionTransportOpen: (sessionId: string) => boolean;
  isPendingSessionTransportOpenStale: (sessionId: string) => boolean;
  scheduleReconnect?: (
    sessionId: string,
    message: string,
    retryable?: boolean,
    options?: { immediate?: boolean; resetAttempt?: boolean; force?: boolean },
  ) => void;
}) {
  const daemonConnection = options.daemonConnection;
  const imagePasteWaiterRuntime = options.refs.imagePasteWaiterRuntimeRef.current;

  const sendInput = (sessionId: string, data: string) => {
    sendInputRuntime({
      sessionId,
      data,
      refs: {
        stateRef: options.refs.stateRef,
      },
      runtimeDebug: options.runtimeDebug,
      daemonConnection,
      isReconnectInFlight: options.isReconnectInFlight,
      sendSocketPayload: options.sendSocketPayload,
      markPendingInputTailRefresh: options.markPendingInputTailRefresh,
      readSessionBufferSnapshot: options.readSessionBufferSnapshot,
      requestSessionBufferHead: options.requestSessionBufferHead,
      hasPendingSessionTransportOpen: options.hasPendingSessionTransportOpen,
      isPendingSessionTransportOpenStale: options.isPendingSessionTransportOpenStale,
      scheduleReconnect: options.scheduleReconnect,
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
      daemonConnection,
      requestReconnect: options.scheduleReconnect
        ? (sessionId, reason) => options.scheduleReconnect?.(sessionId, reason, true, {
          immediate: true,
          resetAttempt: false,
          force: true,
        })
        : undefined,
    });
  };

  const sendImagePaste = async (
    sessionId: string,
    file: File,
    pasteOptions?: { pasteTarget?: PasteImageStartPayload['pasteTarget'] },
  ) => {
    return sendImagePasteRuntime({
      sessionId,
      file,
      pasteTarget: pasteOptions?.pasteTarget,
      imagePasteWaiterRuntime,
      imagePasteResultTimeoutMs: 30_000,
      ensureSessionReadyForPaste,
      subscribeFileTransferMessages: options.refs.fileTransferMessageRuntimeRef.current.subscribe,
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
    request?: Omit<RemoteScreenshotRequestPayload, 'requestId'>,
  ) => {
    return requestRemoteScreenshotRuntime({
      sessionId,
      onProgress,
      request,
      ensureSessionReadyForPaste,
      remoteScreenshotRuntime: options.refs.remoteScreenshotRuntimeRef.current,
      sendSocketPayload: options.sendSocketPayload,
    });
  };

  const requestRemoteWindowTargets = async (
    sessionId: string,
    requestOptions?: { forceRefresh?: boolean },
  ) => {
    return requestRemoteWindowTargetsRuntime({
      sessionId,
      sessions: options.refs.stateRef.current.sessions,
      daemonConnection,
      remoteWindowMessageRuntime: options.refs.remoteWindowMessageRuntimeRef.current,
      sendSocketPayload: options.sendSocketPayload,
      targetCatalogCache: options.refs.remoteWindowTargetCatalogCacheRef?.current,
      forceRefresh: requestOptions?.forceRefresh === true,
    });
  };

  const requestRemoteWindowStreamStart = async (
    sessionId: string,
    target: RemoteWindowStreamTargetManifest,
    streamId: string,
    startOptions: { videoProfile: RemoteWindowVideoProfile; purpose?: RemoteWindowStreamPurpose },
  ) => {
    return requestRemoteWindowStreamStartRuntime({
      sessionId,
      streamId,
      purpose: startOptions.purpose,
      target,
      videoProfile: startOptions.videoProfile,
      bridgeSettings: options.bridgeSettings,
      sessions: options.refs.stateRef.current.sessions,
      daemonConnection,
      remoteWindowMessageRuntime: options.refs.remoteWindowMessageRuntimeRef.current,
      remoteWindowReceiverRuntime: options.refs.remoteWindowReceiverRuntimeRef.current,
      sendSocketPayload: options.sendSocketPayload,
    });
  };

  const updateRemoteWindowStreamQuality = (
    sessionId: string,
    payload: Omit<RemoteWindowStreamQualityRequestPayload, 'requestId'>,
  ) => {
    return updateRemoteWindowStreamQualityRuntime({
      sessionId,
      payload,
      sessions: options.refs.stateRef.current.sessions,
      daemonConnection,
      remoteWindowMessageRuntime: options.refs.remoteWindowMessageRuntimeRef.current,
      sendSocketPayload: options.sendSocketPayload,
    });
  };

  const updateRemoteWindowFocus = (
    sessionId: string,
    streamId: string,
    target: RemoteWindowStreamTargetManifest,
    revision?: number,
  ) => {
    return updateRemoteWindowFocusRuntime({
      sessionId,
      streamId,
      revision,
      target,
      sessions: options.refs.stateRef.current.sessions,
      daemonConnection,
      remoteWindowMessageRuntime: options.refs.remoteWindowMessageRuntimeRef.current,
      sendSocketPayload: options.sendSocketPayload,
    });
  };

  const stopRemoteWindowStream = (sessionId: string, streamId: string) => {
    return stopRemoteWindowStreamRuntime({
      sessionId,
      streamId,
      sessions: options.refs.stateRef.current.sessions,
      daemonConnection,
      remoteWindowMessageRuntime: options.refs.remoteWindowMessageRuntimeRef.current,
      remoteWindowReceiverRuntime: options.refs.remoteWindowReceiverRuntimeRef.current,
      sendSocketPayload: options.sendSocketPayload,
    });
  };

  const sendRemoteWindowInput = (
    sessionId: string,
    payload: Omit<RemoteWindowInputEventPayload, 'requestId'>,
  ) => {
    return sendRemoteWindowInputRuntime({
      sessionId,
      payload,
      sessions: options.refs.stateRef.current.sessions,
      daemonConnection,
      remoteWindowMessageRuntime: options.refs.remoteWindowMessageRuntimeRef.current,
      sendSocketPayload: options.sendSocketPayload,
    });
  };

  const resizeRemoteWindowTarget = (
    sessionId: string,
    payload: Omit<RemoteWindowInputEventPayload, 'requestId'>,
  ) => {
    return resizeRemoteWindowTargetRuntime({
      sessionId,
      payload,
      sessions: options.refs.stateRef.current.sessions,
      daemonConnection,
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
    requestRemoteWindowStreamStart,
    updateRemoteWindowFocus,
    updateRemoteWindowStreamQuality,
    stopRemoteWindowStream,
    sendRemoteWindowInput,
    resizeRemoteWindowTarget,
  };
}
