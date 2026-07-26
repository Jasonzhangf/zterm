import type {
  ClientMessage,
  PasteImageStartPayload,
  RemoteScreenshotCapture,
  RemoteScreenshotRequestPayload,
  RemoteScreenshotStatusPayload,
  RemoteWindowInputEventPayload,
  RemoteWindowStreamQualityRequestPayload,
  RemoteWindowStreamTargetManifest,
  RemoteWindowStreamTargetsResponsePayload,
  RemoteWindowVideoBitrateConfig,
  ScheduleJobDraft,
  Session,
  SessionBufferState,
  SessionDebugOverlayMetrics,
  SessionScheduleState,
  TerminalViewportState,
  TerminalVisibleRange,
} from '../lib/types';
import type { TerminalMuxTargetClientMessage } from '@zterm/shared/protocol';
import type { SessionBufferStore } from '../lib/session-buffer-store';
import type { SessionRenderBufferStore } from '../lib/session-render-buffer-store';
import type { SessionHeadStore } from '../lib/session-head-store';
import type { SessionTransportResource } from '../lib/session-transport-runtime';
import type { RemoteWindowReceiverStartResult } from '../lib/remote-window-receiver-runtime';
import type { RemoteWindowControlMessage } from '../lib/remote-window-message-runtime';
import {
  manageTmuxSessionsOnOpenTransportRuntime,
  type SessionTmuxTargetRequestStore,
} from './session-context-tmux-management-runtime';
import type {
  CreateSessionOptions,
  SessionContextValue,
  SessionManagerState,
} from './session-context-core';
import {
  deleteScheduleJobRuntime,
  getActiveSessionRuntime,
  getSessionDebugMetricsRuntime,
  getSessionRuntime,
  getSessionScheduleStateRuntime,
  requestScheduleListRuntime,
  runScheduleJobNowRuntime,
  sendMessageRawRuntime,
  sendMessageRuntime,
  toggleScheduleJobRuntime,
  updateSessionViewportRuntime,
  upsertScheduleJobRuntime,
} from './session-context-public-runtime';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type { SessionBufferHeadState } from './session-buffer-planner-helpers';
import type { ClientDaemonConnection } from '../lib/client-daemon-connection';

export function createSessionPublicFacadeRuntime(options: {
  stateRef: { current: SessionManagerState };
  scheduleStatesRef: { current: Record<string, SessionScheduleState> };
  sessionVisibleRangeRef: { current: Map<string, any> };
  sessionHeadStoreRef: { current: { getLiveHead: (sessionId: string) => SessionBufferHeadState | null } };
  readSessionTransportResource: (sessionId: string) => SessionTransportResource;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  daemonConnection: ClientDaemonConnection;
  tmuxTargetRequestsRef: { current: SessionTmuxTargetRequestStore };
  setScheduleStateForSession: (
    sessionId: string,
    nextState: SessionScheduleState | ((current: SessionScheduleState) => SessionScheduleState),
  ) => void;
  readSessionBufferSnapshot: (sessionId: string) => SessionBufferState;
  requestSessionBufferSync: (
    sessionId: string,
    requestOptions?: {
      headOverride?: { daemonHeadRevision: number; daemonHeadEndIndex: number } | null;
      reason?: string;
      force?: boolean;
      purpose?: 'tail-refresh' | 'reading-repair';
      ws?: BridgeTransportSocket | null;
      liveHead?: SessionBufferHeadState | null;
      invalidLocalWindow?: boolean;
      requestWindowOverride?: { requestStartIndex: number; requestEndIndex: number } | null;
      requestMissingRangesOverride?: Array<{ startIndex: number; endIndex: number }> | null;
    },
  ) => boolean;
  ensureActiveSessionFresh: (options: {
    sessionId: string;
    source: 'explicit-resume' | 'active-reentry' | 'active-tick';
    forceHead?: boolean;
    markResumeTail?: boolean;
    allowReconnectIfUnavailable?: boolean;
  }) => boolean;
  sendTerminalResize: (sessionId: string, cols?: number | null, rows?: number | null, widthMode?: 'adaptive-phone' | 'mirror-fixed') => boolean;
  setLiveSessionIdsSync: (ids: string[]) => void;
  setActiveBodySubscriptionSuppressedSync: (suppressed: boolean, reason?: string) => void;
  isSessionTransportActive: (sessionId: string) => boolean;
  sessionDebugMetricsStoreRef: {
    current: {
      getMetrics: (sessionId: string, sessionState: Session['state'] | null, active: boolean, now: number) => SessionDebugOverlayMetrics | null;
    };
  };
  runtimeDebug?: (event: string, payload?: Record<string, unknown>) => void;
}) {
  const daemonConnection = options.daemonConnection;

  const sendMessage = (sessionId: string, msg: ClientMessage) => {
    return sendMessageRuntime({
      sessionId,
      msg,
      daemonConnection,
    });
  };

  const requestScheduleList = (sessionId: string) => {
    requestScheduleListRuntime({
      sessionId,
      sessions: options.stateRef.current.sessions,
      setScheduleStateForSession: options.setScheduleStateForSession,
      sendMessage,
    });
  };

  const manageTmuxSessionsOnOpenTransport = (
    sessionId: string,
    message: TerminalMuxTargetClientMessage,
  ) => manageTmuxSessionsOnOpenTransportRuntime({
    sessionId,
    message,
    pendingRequestsRef: options.tmuxTargetRequestsRef,
    readSessionTransportResource: options.readSessionTransportResource,
    daemonConnection,
    sendSocketPayload: options.sendSocketPayload,
    runtimeDebug: options.runtimeDebug,
  });

  const upsertScheduleJob = (sessionId: string, job: ScheduleJobDraft) => {
    upsertScheduleJobRuntime({
      sessionId,
      job,
      sessions: options.stateRef.current.sessions,
      setScheduleStateForSession: options.setScheduleStateForSession,
      sendMessage,
    });
  };

  const deleteScheduleJob = (sessionId: string, jobId: string) => {
    deleteScheduleJobRuntime({
      sessionId,
      jobId,
      sessions: options.stateRef.current.sessions,
      setScheduleStateForSession: options.setScheduleStateForSession,
      sendMessage,
    });
  };

  const toggleScheduleJob = (sessionId: string, jobId: string, enabled: boolean) => {
    toggleScheduleJobRuntime({
      sessionId,
      jobId,
      enabled,
      sessions: options.stateRef.current.sessions,
      setScheduleStateForSession: options.setScheduleStateForSession,
      sendMessage,
    });
  };

  const runScheduleJobNow = (sessionId: string, jobId: string) => {
    runScheduleJobNowRuntime({
      sessionId,
      jobId,
      sessions: options.stateRef.current.sessions,
      setScheduleStateForSession: options.setScheduleStateForSession,
      sendMessage,
    });
  };

  const setLiveSessionIds = (ids: string[]) => {
    options.setLiveSessionIdsSync(ids);
  };

  const setActiveBodySubscriptionSuppressed = (suppressed: boolean) => {
    options.setActiveBodySubscriptionSuppressedSync(suppressed, 'remote-window-overlay');
  };

  const resumeActiveSessionTransport = (sessionId: string) => {
    return options.ensureActiveSessionFresh({
      sessionId,
      source: 'explicit-resume',
      forceHead: true,
      markResumeTail: true,
      allowReconnectIfUnavailable: true,
    });
  };

  const sendTerminalResize = (sessionId: string, cols?: number | null, rows?: number | null, widthMode?: 'adaptive-phone' | 'mirror-fixed') => {
    return options.sendTerminalResize(sessionId, cols, rows, widthMode);
  };

  const updateSessionViewport = (sessionId: string, visibleRange: TerminalVisibleRange | TerminalViewportState) => {
    const declaredMissingRanges = 'mode' in visibleRange && Array.isArray(visibleRange.missingRanges)
      ? visibleRange.missingRanges
      : undefined;
    const normalizedVisibleRange = 'mode' in visibleRange
      ? {
          startIndex: Math.max(0, Math.floor(visibleRange.viewportEndIndex - visibleRange.viewportRows)),
          endIndex: Math.max(0, Math.floor(visibleRange.viewportEndIndex)),
          viewportRows: Math.max(1, Math.floor(visibleRange.viewportRows)),
        }
      : visibleRange;
    updateSessionViewportRuntime({
      sessionId,
      visibleRange: normalizedVisibleRange,
      viewportMode: 'mode' in visibleRange ? visibleRange.mode : undefined,
      sessionVisibleRangeRef: options.sessionVisibleRangeRef,
      isSessionTransportActive: options.isSessionTransportActive,
      sessions: options.stateRef.current.sessions,
      sessionHeadStoreRef: options.sessionHeadStoreRef,
      readSessionBufferSnapshot: options.readSessionBufferSnapshot,
      requestSessionBufferSync: options.requestSessionBufferSync,
      triggerRepair: !('mode' in visibleRange) || visibleRange.mode !== 'follow' || Boolean(declaredMissingRanges?.length),
      requestMissingRangesOverride: declaredMissingRanges,
    });
  };

  const getActiveSession = () => {
    return getActiveSessionRuntime({
      sessions: options.stateRef.current.sessions,
      activeSessionId: options.stateRef.current.activeSessionId,
    });
  };

  const getSession = (sessionId: string) => {
    return getSessionRuntime({
      sessions: options.stateRef.current.sessions,
      sessionId,
    });
  };

  const getSessionScheduleState = (sessionId: string) => {
    return getSessionScheduleStateRuntime({
      sessionId,
      scheduleStates: options.scheduleStatesRef.current,
      sessions: options.stateRef.current.sessions,
    });
  };

  const getSessionDebugMetrics = (sessionId: string) => {
    return getSessionDebugMetricsRuntime({
      sessionId,
      sessions: options.stateRef.current.sessions,
      activeSessionId: options.stateRef.current.activeSessionId,
      readMetrics: (targetSessionId, sessionState, active, now) => (
        options.sessionDebugMetricsStoreRef.current.getMetrics(targetSessionId, sessionState, active, now)
      ),
      now: Date.now(),
    });
  };

  const sendMessageRaw = (sessionId: string, msg: unknown) => {
    sendMessageRawRuntime({
      sessionId,
      msg,
      daemonConnection,
    });
  };

  return {
    sendMessage,
    requestScheduleList,
    upsertScheduleJob,
    deleteScheduleJob,
    toggleScheduleJob,
    runScheduleJobNow,
    setLiveSessionIds,
    setActiveBodySubscriptionSuppressed,
    resumeActiveSessionTransport,
    sendTerminalResize,
    updateSessionViewport,
    getActiveSession,
    getSession,
    getSessionScheduleState,
    getSessionDebugMetrics,
    manageTmuxSessionsOnOpenTransport,
    sendMessageRaw,
  };
}

export function buildSessionContextValueRuntime(options: {
  state: SessionManagerState;
  scheduleStates: Record<string, SessionScheduleState>;
  getSessionDebugMetrics: (sessionId: string) => SessionDebugOverlayMetrics | null;
  createSession: (host: Session['hostId'] extends string ? any : never, options?: CreateSessionOptions) => string;
  closeSession: (id: string) => void;
  switchSession: (id: string) => void;
  moveSession: (id: string, toIndex: number) => void;
  renameSession: (id: string, name: string) => void;
  reconnectSession: (id: string) => void;
  reconnectAllSessions: () => void;
  setLiveSessionIds: (ids: string[]) => void;
  setActiveBodySubscriptionSuppressed: (suppressed: boolean) => void;
  resumeActiveSessionTransport: (id: string) => boolean;
  sendTerminalResize: (sessionId: string, cols?: number | null, rows?: number | null, widthMode?: 'adaptive-phone' | 'mirror-fixed') => boolean;
  sendMessage: (sessionId: string, msg: ClientMessage) => void;
  sendInput: (sessionId: string, data: string) => void;
  sendImagePaste: (
    sessionId: string,
    file: File,
    options?: { pasteTarget?: PasteImageStartPayload['pasteTarget'] },
  ) => Promise<void>;
  sendFileAttach: (sessionId: string, file: File) => Promise<void>;
  requestRemoteScreenshot: (
    sessionId: string,
    onProgress?: (progress: RemoteScreenshotStatusPayload) => void,
    request?: Omit<RemoteScreenshotRequestPayload, 'requestId'>,
  ) => Promise<RemoteScreenshotCapture>;
  requestRemoteWindowTargets: (
    sessionId: string,
    options?: { forceRefresh?: boolean },
  ) => Promise<RemoteWindowStreamTargetsResponsePayload>;
  requestRemoteWindowStreamStart: (
    sessionId: string,
    target: RemoteWindowStreamTargetManifest,
    streamId: string,
    options?: { videoBitrate?: RemoteWindowVideoBitrateConfig },
  ) => Promise<RemoteWindowReceiverStartResult>;
  updateRemoteWindowStreamQuality: (
    sessionId: string,
    payload: Omit<RemoteWindowStreamQualityRequestPayload, 'requestId'>,
  ) => void;
  stopRemoteWindowStream: (sessionId: string, streamId: string) => boolean;
  sendRemoteWindowInput: (
    sessionId: string,
    payload: Omit<RemoteWindowInputEventPayload, 'requestId'>,
  ) => void;
  resizeRemoteWindowTarget: (
    sessionId: string,
    payload: Omit<RemoteWindowInputEventPayload, 'requestId'>,
  ) => void;
  updateSessionViewport: (sessionId: string, visibleRange: TerminalVisibleRange | TerminalViewportState) => void;
  requestScheduleList: (sessionId: string) => void;
  manageTmuxSessionsOnOpenTransport: (
    sessionId: string,
    message: TerminalMuxTargetClientMessage,
  ) => Promise<string[] | null>;
  upsertScheduleJob: (sessionId: string, job: ScheduleJobDraft) => void;
  deleteScheduleJob: (sessionId: string, jobId: string) => void;
  toggleScheduleJob: (sessionId: string, jobId: string, enabled: boolean) => void;
  runScheduleJobNow: (sessionId: string, jobId: string) => void;
  getSessionScheduleState: (sessionId: string) => SessionScheduleState;
  getActiveSession: () => Session | null;
  getSession: (id: string) => Session | null;
  getSessionRenderBufferSnapshot: (sessionId: string) => any;
  getSessionBufferStore: () => SessionBufferStore;
  getSessionRenderBufferStore: () => SessionRenderBufferStore;
  getSessionHeadStore: () => SessionHeadStore;
  onFileTransferMessage: (handler: (msg: any) => void) => () => void;
  onRemoteWindowMessage: (handler: (msg: RemoteWindowControlMessage) => void) => () => void;
  sendMessageRaw: (sessionId: string, msg: unknown) => void;
}): SessionContextValue {
  return {
    state: options.state,
    scheduleStates: options.scheduleStates,
    getSessionDebugMetrics: options.getSessionDebugMetrics,
    createSession: options.createSession,
    closeSession: options.closeSession,
    switchSession: options.switchSession,
    moveSession: options.moveSession,
    renameSession: options.renameSession,
    reconnectSession: options.reconnectSession,
    reconnectAllSessions: options.reconnectAllSessions,
    setLiveSessionIds: options.setLiveSessionIds,
    setActiveBodySubscriptionSuppressed: options.setActiveBodySubscriptionSuppressed,
    resumeActiveSessionTransport: options.resumeActiveSessionTransport,
    sendTerminalResize: options.sendTerminalResize,
    sendMessage: options.sendMessage,
    sendInput: options.sendInput,
    sendImagePaste: options.sendImagePaste,
    sendFileAttach: options.sendFileAttach,
    requestRemoteScreenshot: options.requestRemoteScreenshot,
    requestRemoteWindowTargets: options.requestRemoteWindowTargets,
    requestRemoteWindowStreamStart: options.requestRemoteWindowStreamStart,
    updateRemoteWindowStreamQuality: options.updateRemoteWindowStreamQuality,
    stopRemoteWindowStream: options.stopRemoteWindowStream,
    sendRemoteWindowInput: options.sendRemoteWindowInput,
    resizeRemoteWindowTarget: options.resizeRemoteWindowTarget,
    updateSessionViewport: options.updateSessionViewport,
    requestScheduleList: options.requestScheduleList,
    manageTmuxSessionsOnOpenTransport: options.manageTmuxSessionsOnOpenTransport,
    upsertScheduleJob: options.upsertScheduleJob,
    deleteScheduleJob: options.deleteScheduleJob,
    toggleScheduleJob: options.toggleScheduleJob,
    runScheduleJobNow: options.runScheduleJobNow,
    getSessionScheduleState: options.getSessionScheduleState,
    getActiveSession: options.getActiveSession,
    getSession: options.getSession,
    getSessionRenderBufferSnapshot: options.getSessionRenderBufferSnapshot,
    getSessionBufferStore: options.getSessionBufferStore,
    getSessionRenderBufferStore: options.getSessionRenderBufferStore,
    getSessionHeadStore: options.getSessionHeadStore,
    onFileTransferMessage: options.onFileTransferMessage,
    onRemoteWindowMessage: options.onRemoteWindowMessage,
    sendMessageRaw: options.sendMessageRaw,
  };
}
