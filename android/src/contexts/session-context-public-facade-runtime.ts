import type {
  ClientMessage,
  RemoteScreenshotCapture,
  RemoteScreenshotStatusPayload,
  ScheduleJobDraft,
  Session,
  SessionBufferState,
  SessionDebugOverlayMetrics,
  SessionScheduleState,
  TerminalViewportState,
  TerminalVisibleRange,
} from '../lib/types';
import type { SessionBufferStore } from '../lib/session-buffer-store';
import type { SessionRenderBufferStore } from '../lib/session-render-buffer-store';
import type { SessionHeadStore } from '../lib/session-head-store';
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
import type { SessionBufferHeadState } from './session-sync-helpers';

export function createSessionPublicFacadeRuntime(options: {
  stateRef: { current: SessionManagerState };
  scheduleStatesRef: { current: Record<string, SessionScheduleState> };
  sessionVisibleRangeRef: { current: Map<string, any> };
  sessionBufferHeadsRef: { current: Map<string, SessionBufferHeadState> };
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  setScheduleStateForSession: (
    sessionId: string,
    nextState: SessionScheduleState | ((current: SessionScheduleState) => SessionScheduleState),
  ) => void;
  readSessionBufferSnapshot: (sessionId: string) => SessionBufferState;
  requestSessionBufferSync: (
    sessionId: string,
    requestOptions?: {
      sessionOverride?: Session;
      reason?: string;
      force?: boolean;
      purpose?: 'tail-refresh' | 'reading-repair';
      ws?: BridgeTransportSocket | null;
      liveHead?: SessionBufferHeadState | null;
      invalidLocalWindow?: boolean;
    },
  ) => boolean;
  ensureActiveSessionFresh: (options: {
    sessionId: string;
    source: 'active-resume' | 'active-reentry' | 'active-tick';
    forceHead?: boolean;
    markResumeTail?: boolean;
    allowReconnectIfUnavailable?: boolean;
  }) => boolean;
  setLiveSessionIdsSync: (ids: string[]) => void;
  isSessionTransportActive: (sessionId: string) => boolean;
  sessionDebugMetricsStoreRef: {
    current: {
      getMetrics: (sessionId: string, sessionState: Session['state'] | null, active: boolean, now: number) => SessionDebugOverlayMetrics | null;
    };
  };
}) {
  const sendMessage = (sessionId: string, msg: ClientMessage) => {
    sendMessageRuntime({
      sessionId,
      msg,
      readSessionTransportSocket: options.readSessionTransportSocket,
      sendSocketPayload: options.sendSocketPayload,
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

  const upsertScheduleJob = (sessionId: string, job: ScheduleJobDraft) => {
    upsertScheduleJobRuntime({
      sessionId,
      job,
      setScheduleStateForSession: options.setScheduleStateForSession,
      sendMessage,
    });
  };

  const deleteScheduleJob = (sessionId: string, jobId: string) => {
    deleteScheduleJobRuntime({
      sessionId,
      jobId,
      setScheduleStateForSession: options.setScheduleStateForSession,
      sendMessage,
    });
  };

  const toggleScheduleJob = (sessionId: string, jobId: string, enabled: boolean) => {
    toggleScheduleJobRuntime({
      sessionId,
      jobId,
      enabled,
      setScheduleStateForSession: options.setScheduleStateForSession,
      sendMessage,
    });
  };

  const runScheduleJobNow = (sessionId: string, jobId: string) => {
    runScheduleJobNowRuntime({
      sessionId,
      jobId,
      setScheduleStateForSession: options.setScheduleStateForSession,
      sendMessage,
    });
  };

  const setLiveSessionIds = (ids: string[]) => {
    options.setLiveSessionIdsSync(ids);
  };

  const resumeActiveSessionTransport = (sessionId: string) => {
    return options.ensureActiveSessionFresh({
      sessionId,
      source: 'active-resume',
      forceHead: true,
      markResumeTail: true,
      allowReconnectIfUnavailable: true,
    });
  };

  const updateSessionViewport = (sessionId: string, visibleRange: TerminalVisibleRange | TerminalViewportState) => {
    updateSessionViewportRuntime({
      sessionId,
      visibleRange,
      sessionVisibleRangeRef: options.sessionVisibleRangeRef,
      isSessionTransportActive: options.isSessionTransportActive,
      sessions: options.stateRef.current.sessions,
      sessionBufferHeadsRef: options.sessionBufferHeadsRef,
      readSessionBufferSnapshot: options.readSessionBufferSnapshot,
      requestSessionBufferSync: options.requestSessionBufferSync,
    });
  };

  const getActiveSession = () => {
    return getActiveSessionRuntime({
      sessions: options.stateRef.current.sessions,
      activeSessionId: options.stateRef.current.activeSessionId,
      readSessionBufferSnapshot: options.readSessionBufferSnapshot,
    });
  };

  const getSession = (sessionId: string) => {
    return getSessionRuntime({
      sessions: options.stateRef.current.sessions,
      sessionId,
      readSessionBufferSnapshot: options.readSessionBufferSnapshot,
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
      readSessionTransportSocket: options.readSessionTransportSocket,
      sendSocketPayload: options.sendSocketPayload,
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
    resumeActiveSessionTransport,
    updateSessionViewport,
    getActiveSession,
    getSession,
    getSessionScheduleState,
    getSessionDebugMetrics,
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
  resumeActiveSessionTransport: (id: string) => boolean;
  sendMessage: (sessionId: string, msg: ClientMessage) => void;
  sendInput: (sessionId: string, data: string) => void;
  sendImagePaste: (sessionId: string, file: File) => Promise<void>;
  sendFileAttach: (sessionId: string, file: File) => Promise<void>;
  requestRemoteScreenshot: (
    sessionId: string,
    onProgress?: (progress: RemoteScreenshotStatusPayload) => void,
  ) => Promise<RemoteScreenshotCapture>;
  updateSessionViewport: (sessionId: string, visibleRange: TerminalVisibleRange | TerminalViewportState) => void;
  requestScheduleList: (sessionId: string) => void;
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
    resumeActiveSessionTransport: options.resumeActiveSessionTransport,
    sendMessage: options.sendMessage,
    sendInput: options.sendInput,
    sendImagePaste: options.sendImagePaste,
    sendFileAttach: options.sendFileAttach,
    requestRemoteScreenshot: options.requestRemoteScreenshot,
    updateSessionViewport: options.updateSessionViewport,
    requestScheduleList: options.requestScheduleList,
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
    sendMessageRaw: options.sendMessageRaw,
  };
}
