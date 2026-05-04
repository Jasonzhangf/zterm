import type { Host, ServerMessage, Session, SessionBufferState, SessionScheduleState, TerminalBufferPayload, TerminalCursorState } from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type { SessionBufferHeadState, SessionPullPurpose } from './session-sync-helpers';
import {
  applyIncomingBufferSyncOrchestrationRuntime,
  commitSessionBufferUpdateRuntime,
  finalizeSocketFailureBaselineOrchestrationRuntime,
  handleBufferHeadOrchestrationRuntime,
  handleSocketConnectedBaselineOrchestrationRuntime,
  handleSocketServerMessageOrchestrationRuntime,
  requestSessionBufferHeadOrchestrationRuntime,
  requestSessionBufferSyncOrchestrationRuntime,
} from './session-context-buffer-message-runtime';

interface MutableRefObject<T> {
  current: T;
}

export function createSessionMessageOrchestrationRuntime(options: {
  refs: {
    stateRef: MutableRefObject<{ sessions: Session[]; activeSessionId: string | null }>;
    scheduleStatesRef: MutableRefObject<Record<string, SessionScheduleState>>;
    lastHeadRequestAtRef: MutableRefObject<Map<string, number>>;
    lastPongAtRef: MutableRefObject<Map<string, number>>;
    sessionVisibleRangeRef: MutableRefObject<Map<string, any>>;
    sessionBufferHeadsRef: MutableRefObject<Map<string, SessionBufferHeadState>>;
    sessionPullStateRef: MutableRefObject<Map<string, any>>;
    pendingInputTailRefreshRef: MutableRefObject<Map<string, { requestedAt: number; localRevision: number }>>;
    pendingConnectTailRefreshRef: MutableRefObject<Set<string>>;
    pendingResumeTailRefreshRef: MutableRefObject<Set<string>>;
    sessionRevisionResetRef: MutableRefObject<Map<string, { revision: number; latestEndIndex: number; seenAt: number }>>;
    sessionBufferStoreRef: MutableRefObject<{ setBuffer: (sessionId: string, buffer: SessionBufferState) => boolean }>;
    sessionHeadStoreRef: MutableRefObject<{ setHead: (sessionId: string, head: { daemonHeadRevision: number; daemonHeadEndIndex: number }) => boolean }>;
    sessionDebugMetricsStoreRef: MutableRefObject<{ recordRefreshRequest: (sessionId: string) => void }>;
    pendingSessionTransportOpenIntentsRef: MutableRefObject<Map<string, unknown>>;
    manualCloseRef: MutableRefObject<Set<string>>;
  };
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionBufferSnapshot: (sessionId: string) => SessionBufferState;
  clearSessionPullState: (sessionId: string, purpose?: SessionPullPurpose) => void;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer, sendOptions?: any) => void;
  resolveTerminalRefreshCadence: () => { headTickMs: number };
  resolveSessionCacheLines: (rows?: number | null) => number;
  summarizeBufferPayload: (payload: TerminalBufferPayload) => Record<string, unknown>;
  runtimeDebug: (event: string, payload?: Record<string, unknown>) => void;
  isSessionTransportActive: (sessionId: string) => boolean;
  scheduleSessionRenderCommit: (sessionId: string) => void;
  settleSessionPullState: (sessionId: string, payload: TerminalBufferPayload) => void;
  setScheduleStateForSession: (
    sessionId: string,
    nextState: SessionScheduleState | ((current: SessionScheduleState) => SessionScheduleState),
  ) => void;
  setSessionTitleSync: (id: string, title: string) => void;
  fileTransferMessageRuntime: { dispatch: (msg: any) => unknown };
  applyTransportDiagnostics: (sessionId: string, socket: BridgeTransportSocket) => void;
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
  incrementConnectedSync: () => void;
  cleanupSocket: (sessionId: string, shouldClose?: boolean) => void;
  writeSessionTransportToken: (sessionId: string, token: string | null) => string | null;
}) {
  const commitSessionBufferUpdate = (sessionId: string, nextBuffer: SessionBufferState) => {
    return commitSessionBufferUpdateRuntime({
      sessionId,
      nextBuffer,
      sessionBufferStoreRef: options.refs.sessionBufferStoreRef,
    });
  };

  const requestSessionBufferSync = (sessionId: string, requestOptions?: {
    ws?: BridgeTransportSocket | null;
    reason?: string;
    purpose?: SessionPullPurpose;
    sessionOverride?: Session | null;
    liveHead?: SessionBufferHeadState | null;
    invalidLocalWindow?: boolean;
  }) => {
    return requestSessionBufferSyncOrchestrationRuntime({
      sessionId,
      requestOptions,
      refs: {
        stateRef: options.refs.stateRef,
        sessionVisibleRangeRef: options.refs.sessionVisibleRangeRef,
        sessionBufferHeadsRef: options.refs.sessionBufferHeadsRef,
        sessionPullStateRef: options.refs.sessionPullStateRef,
        pendingInputTailRefreshRef: options.refs.pendingInputTailRefreshRef,
        pendingConnectTailRefreshRef: options.refs.pendingConnectTailRefreshRef,
        pendingResumeTailRefreshRef: options.refs.pendingResumeTailRefreshRef,
      },
      readSessionTransportSocket: options.readSessionTransportSocket,
      readSessionBufferSnapshot: options.readSessionBufferSnapshot,
      clearSessionPullState: options.clearSessionPullState,
      sendSocketPayload: options.sendSocketPayload,
      runtimeDebug: options.runtimeDebug,
    });
  };

  const requestSessionBufferHead = (sessionId: string, ws?: BridgeTransportSocket | null, headOptions?: { force?: boolean }) => {
    return requestSessionBufferHeadOrchestrationRuntime({
      sessionId,
      ws,
      force: headOptions?.force,
      refs: {
        stateRef: options.refs.stateRef,
        lastHeadRequestAtRef: options.refs.lastHeadRequestAtRef,
        sessionDebugMetricsStoreRef: options.refs.sessionDebugMetricsStoreRef,
      },
      readSessionTransportSocket: options.readSessionTransportSocket,
      sendSocketPayload: options.sendSocketPayload,
      resolveTerminalRefreshCadence: options.resolveTerminalRefreshCadence,
    });
  };

  const handleBufferHead = (
    sessionId: string,
    latestRevision: number,
    latestEndIndex: number,
    availableStartIndex?: number,
    availableEndIndex?: number,
    cursor?: TerminalCursorState | null,
  ) => {
    handleBufferHeadOrchestrationRuntime({
      sessionId,
      latestRevision,
      latestEndIndex,
      availableStartIndex,
      availableEndIndex,
      cursor,
      refs: {
        stateRef: options.refs.stateRef,
        sessionBufferHeadsRef: options.refs.sessionBufferHeadsRef,
        lastHeadRequestAtRef: options.refs.lastHeadRequestAtRef,
        sessionRevisionResetRef: options.refs.sessionRevisionResetRef,
        sessionVisibleRangeRef: options.refs.sessionVisibleRangeRef,
        sessionBufferStoreRef: options.refs.sessionBufferStoreRef,
        sessionHeadStoreRef: options.refs.sessionHeadStoreRef,
      },
      readSessionTransportSocket: options.readSessionTransportSocket,
      readSessionBufferSnapshot: options.readSessionBufferSnapshot,
      commitSessionBufferUpdate,
      scheduleSessionRenderCommit: options.scheduleSessionRenderCommit,
      isSessionTransportActive: options.isSessionTransportActive,
      runtimeDebug: options.runtimeDebug,
      requestSessionBufferSync,
    });
  };

  const applyIncomingBufferSync = (sessionId: string, payload: TerminalBufferPayload) => {
    applyIncomingBufferSyncOrchestrationRuntime({
      sessionId,
      payload,
      refs: {
        stateRef: options.refs.stateRef,
        sessionRevisionResetRef: options.refs.sessionRevisionResetRef,
        sessionBufferHeadsRef: options.refs.sessionBufferHeadsRef,
        pendingInputTailRefreshRef: options.refs.pendingInputTailRefreshRef,
        pendingConnectTailRefreshRef: options.refs.pendingConnectTailRefreshRef,
        pendingResumeTailRefreshRef: options.refs.pendingResumeTailRefreshRef,
        sessionVisibleRangeRef: options.refs.sessionVisibleRangeRef,
      },
      readSessionBufferSnapshot: options.readSessionBufferSnapshot,
      resolveSessionCacheLines: options.resolveSessionCacheLines,
      summarizeBufferPayload: options.summarizeBufferPayload,
      runtimeDebug: options.runtimeDebug,
      commitSessionBufferUpdate,
      scheduleSessionRenderCommit: options.scheduleSessionRenderCommit,
      isSessionTransportActive: options.isSessionTransportActive,
      requestSessionBufferSync,
    });
  };

  const handleSocketServerMessage = (messageOptions: {
    sessionId: string;
    host: Host;
    ws: BridgeTransportSocket;
    debugScope: 'connect' | 'reconnect';
    onConnected: () => void;
    onFailure: (message: string, retryable: boolean) => void;
    onClosed: (reason?: string) => void;
  }, msg: ServerMessage) => {
    handleSocketServerMessageOrchestrationRuntime({
      params: messageOptions,
      msg,
      refs: {
        stateRef: options.refs.stateRef,
        scheduleStatesRef: options.refs.scheduleStatesRef,
        lastHeadRequestAtRef: options.refs.lastHeadRequestAtRef,
        lastPongAtRef: options.refs.lastPongAtRef,
      },
      settleSessionPullState: options.settleSessionPullState,
      runtimeDebug: options.runtimeDebug,
      summarizeBufferPayload: options.summarizeBufferPayload,
      applyIncomingBufferSync,
      handleBufferHead,
      setScheduleStateForSession: options.setScheduleStateForSession,
      setSessionTitleSync: options.setSessionTitleSync,
      fileTransferMessageRuntime: options.fileTransferMessageRuntime,
    });
  };

  const handleSocketConnectedBaseline = (connectedOptions: {
    sessionId: string;
    sessionName: string;
    ws: BridgeTransportSocket;
  }) => {
    handleSocketConnectedBaselineOrchestrationRuntime({
      sessionId: connectedOptions.sessionId,
      sessionName: connectedOptions.sessionName,
      ws: connectedOptions.ws,
      refs: {
        stateRef: options.refs.stateRef,
        pendingConnectTailRefreshRef: options.refs.pendingConnectTailRefreshRef,
      },
      readSessionBufferSnapshot: options.readSessionBufferSnapshot,
      applyTransportDiagnostics: options.applyTransportDiagnostics,
      updateSessionSync: options.updateSessionSync,
      setScheduleStateForSession: options.setScheduleStateForSession,
      sendSocketPayload: options.sendSocketPayload,
      isSessionTransportActive: options.isSessionTransportActive,
      requestSessionBufferHead,
      incrementConnectedSync: options.incrementConnectedSync,
    });
  };

  const finalizeSocketFailureBaseline = (baselineOptions: {
    sessionId: string;
    message: string;
    markCompleted: () => boolean;
  }) => {
    return finalizeSocketFailureBaselineOrchestrationRuntime({
      sessionId: baselineOptions.sessionId,
      message: baselineOptions.message,
      markCompleted: baselineOptions.markCompleted,
      refs: {
        pendingSessionTransportOpenIntentsRef: options.refs.pendingSessionTransportOpenIntentsRef,
        manualCloseRef: options.refs.manualCloseRef,
      },
      cleanupSocket: options.cleanupSocket,
      writeSessionTransportToken: options.writeSessionTransportToken,
      setScheduleStateForSession: options.setScheduleStateForSession,
    });
  };

  return {
    commitSessionBufferUpdate,
    requestSessionBufferSync,
    requestSessionBufferHead,
    applyIncomingBufferSync,
    handleBufferHead,
    handleSocketServerMessage,
    handleSocketConnectedBaseline,
    finalizeSocketFailureBaseline,
  };
}
