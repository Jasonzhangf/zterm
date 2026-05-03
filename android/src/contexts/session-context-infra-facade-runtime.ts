import { flushRuntimeDebugLogsToSessionTransport } from '../lib/runtime-debug-flush';
import type { BridgeSettings } from '../lib/bridge-settings';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type { Host, Session, SessionBufferState, SessionRenderBufferSnapshot, SessionScheduleState, TerminalBufferPayload } from '../lib/types';
import type { RecordSessionTxOptions } from './session-context-pull-runtime';
import type { RevisionResetExpectation, SessionAction, SessionManagerState, SessionReconnectRuntime } from './session-context-core';
import type { SessionBufferHeadState, SessionPullPurpose } from './session-sync-helpers';
import {
  applySessionActionRuntime,
  applyTransportDiagnosticsRuntime,
  buildTraversalSocketForHostRuntime,
  clearHeartbeatRuntime,
  clearSessionHandshakeTimeoutInfraRuntime,
  clearSessionPullStateInfraRuntime,
  clearTailRefreshRuntimeInfra,
  createSessionSyncRuntime,
  createTransportInfraAccessorsRuntime,
  deleteSessionSyncRuntime,
  getSessionRenderBufferSnapshotRuntime,
  hasPendingSessionTransportOpenRuntime,
  incrementConnectedSyncRuntime,
  isReconnectInFlightRuntime,
  isSessionTransportActiveRuntime,
  isSessionTransportActivityStaleInfraRuntime,
  markPendingInputTailRefreshInfraRuntime,
  moveSessionSyncRuntime,
  readSessionBufferSnapshotRuntime,
  readSessionTransportTokenRuntime,
  recordSessionRenderCommitInfraRuntime,
  recordSessionRxInfraRuntime,
  recordSessionTxInfraRuntime,
  resetSessionTransportPullBookkeepingInfraRuntime,
  resolveSessionCacheLinesRuntime,
  sendSocketPayloadInfraRuntime,
  setActiveSessionSyncRuntime,
  setScheduleStateForSessionRuntime,
  setSessionHandshakeTimeoutInfraRuntime,
  setSessionTitleSyncRuntime,
  settleSessionPullStateInfraRuntime,
  startSocketHeartbeatInfraRuntime,
  updateSessionSyncRuntime,
  writeSessionTransportTokenRuntime,
} from './session-context-infra-runtime';

export function createSessionInfraFacadeRuntime(options: {
  stateRef: { current: SessionManagerState };
  dispatch: React.Dispatch<SessionAction>;
  reduceSessionAction: (state: SessionManagerState, action: SessionAction) => SessionManagerState;
  sessionStore: {
    addSession: (session: Session) => void;
    updateSession: (id: string, updates: Partial<Session>) => void;
    deleteSession: (id: string) => void;
    moveSession: (id: string, toIndex: number) => void;
  };
  transportRuntimeStoreRef: { current: any };
  sessionBufferStoreRef: { current: any };
  sessionHeadStoreRef: { current: any };
  sessionDebugMetricsStoreRef: { current: any };
  scheduleStatesRef: { current: Record<string, SessionScheduleState> };
  setScheduleStates: React.Dispatch<React.SetStateAction<Record<string, SessionScheduleState>>>;
  sessionAttachTokensRef: { current: Map<string, string> };
  pendingSessionTransportOpenIntentsRef: { current: Map<string, unknown> };
  reconnectRuntimesRef: { current: Map<string, SessionReconnectRuntime> };
  pendingInputTailRefreshRef: { current: Map<string, { requestedAt: number; localRevision: number }> };
  sessionPullStateRef: { current: Map<string, unknown> };
  lastServerActivityAtRef: { current: Map<string, number> };
  staleTransportProbeAtRef: { current: Map<string, number> };
  lastPongAtRef: { current: Map<string, number> };
  pingIntervalsRef: { current: Map<string, ReturnType<typeof setInterval>> };
  handshakeTimeoutsRef: { current: Map<string, number> };
  sessionBufferHeadsRef: { current: Map<string, SessionBufferHeadState> };
  sessionRevisionResetRef: { current: Map<string, RevisionResetExpectation> };
  lastHeadRequestAtRef: { current: Map<string, number> };
  terminalCacheLines: number;
  defaultRows: number;
  bridgeSettings: BridgeSettings;
  wsUrl?: string;
  staleActivityMs: number;
  runtimeDebug: (event: string, payload?: Record<string, unknown>) => void;
}) {
  const applySessionAction = (action: SessionAction) => {
    applySessionActionRuntime({
      stateRef: options.stateRef,
      action,
      reduceSessionAction: options.reduceSessionAction,
      dispatch: options.dispatch,
    });
  };

  const readSessionBufferSnapshot = (sessionId: string): SessionBufferState => {
    return readSessionBufferSnapshotRuntime({
      sessionId,
      sessionBufferStoreRef: options.sessionBufferStoreRef,
    });
  };

  const updateSessionSync = (id: string, updates: Partial<Session>) => {
    updateSessionSyncRuntime({
      id,
      updates,
      applySessionAction,
      sessionStore: options.sessionStore,
    });
  };

  const setActiveSessionSync = (id: string) => {
    setActiveSessionSyncRuntime({
      id,
      applySessionAction,
    });
  };

  const createSessionSync = (session: Session, activate: boolean) => {
    createSessionSyncRuntime({
      session,
      activate,
      applySessionAction,
      sessionStore: options.sessionStore,
      setActiveSessionSync,
    });
  };

  const deleteSessionSync = (id: string) => {
    deleteSessionSyncRuntime({
      id,
      applySessionAction,
      sessionStore: options.sessionStore,
    });
  };

  const moveSessionSync = (id: string, toIndex: number) => {
    moveSessionSyncRuntime({
      id,
      toIndex,
      applySessionAction,
      sessionStore: options.sessionStore,
    });
  };

  const setSessionTitleSync = (id: string, title: string) => {
    setSessionTitleSyncRuntime({
      id,
      title,
      applySessionAction,
    });
  };

  const incrementConnectedSync = () => {
    incrementConnectedSyncRuntime({
      applySessionAction,
    });
  };

  const transportAccessors = createTransportInfraAccessorsRuntime(options.transportRuntimeStoreRef);

  const readSessionTransportToken = (sessionId: string) => {
    return readSessionTransportTokenRuntime({
      sessionId,
      sessionAttachTokensRef: options.sessionAttachTokensRef,
    });
  };

  const writeSessionTransportToken = (sessionId: string, token: string | null) => {
    return writeSessionTransportTokenRuntime({
      sessionId,
      token,
      sessionAttachTokensRef: options.sessionAttachTokensRef,
    });
  };

  const isSessionTransportActive = (sessionId: string) => {
    return isSessionTransportActiveRuntime({
      sessionId,
      stateRef: options.stateRef,
    });
  };

  const hasPendingSessionTransportOpen = (sessionId: string) => {
    return hasPendingSessionTransportOpenRuntime({
      sessionId,
      pendingSessionTransportOpenIntentsRef: options.pendingSessionTransportOpenIntentsRef,
    });
  };

  const isReconnectInFlight = (sessionId: string) => {
    return isReconnectInFlightRuntime({
      sessionId,
      reconnectRuntimesRef: options.reconnectRuntimesRef,
    });
  };

  const resolveSessionCacheLines = (rows?: number | null) => {
    return resolveSessionCacheLinesRuntime({
      rows,
      terminalCacheLines: options.terminalCacheLines,
      defaultRows: options.defaultRows,
    });
  };

  const getSessionRenderBufferSnapshot = (sessionId: string): SessionRenderBufferSnapshot => {
    return getSessionRenderBufferSnapshotRuntime({
      sessionId,
      sessionBufferStoreRef: options.sessionBufferStoreRef,
    });
  };

  const getSessionBufferStore = () => options.sessionBufferStoreRef.current;
  const getSessionHeadStore = () => options.sessionHeadStoreRef.current;

  const recordSessionTx = (sessionId: string, data: string | ArrayBuffer, recordOptions?: RecordSessionTxOptions) => {
    recordSessionTxInfraRuntime({
      sessionId,
      data,
      refs: {
        sessionDebugMetricsStoreRef: options.sessionDebugMetricsStoreRef,
        sessionPullStateRef: options.sessionPullStateRef,
      },
      recordOptions,
    });
  };

  const recordSessionRx = (sessionId: string, data: string | ArrayBuffer) => {
    recordSessionRxInfraRuntime({
      sessionId,
      data,
      refs: {
        sessionDebugMetricsStoreRef: options.sessionDebugMetricsStoreRef,
        lastServerActivityAtRef: options.lastServerActivityAtRef,
        staleTransportProbeAtRef: options.staleTransportProbeAtRef,
      },
    });
  };

  const recordSessionRenderCommit = (sessionId: string) => {
    recordSessionRenderCommitInfraRuntime({
      sessionId,
      sessionDebugMetricsStoreRef: options.sessionDebugMetricsStoreRef,
    });
  };

  const markPendingInputTailRefresh = (sessionId: string, localRevision: number) => {
    markPendingInputTailRefreshInfraRuntime({
      sessionId,
      localRevision,
      pendingInputTailRefreshRef: options.pendingInputTailRefreshRef,
    });
  };

  const clearSessionPullState = (sessionId: string, purpose?: SessionPullPurpose) => {
    clearSessionPullStateInfraRuntime({
      sessionId,
      sessionPullStateRef: options.sessionPullStateRef,
      purpose,
    });
  };

  const settleSessionPullState = (sessionId: string, payload: TerminalBufferPayload) => {
    settleSessionPullStateInfraRuntime({
      sessionId,
      payload,
      sessionPullStateRef: options.sessionPullStateRef,
    });
  };

  const resetSessionTransportPullBookkeeping = (sessionId: string, reason: string) => {
    resetSessionTransportPullBookkeepingInfraRuntime({
      sessionId,
      reason,
      activeSessionId: options.stateRef.current.activeSessionId,
      sessionPullStateRef: options.sessionPullStateRef,
      runtimeDebug: options.runtimeDebug,
    });
  };

  const isSessionTransportActivityStale = (sessionId: string) => {
    return isSessionTransportActivityStaleInfraRuntime({
      sessionId,
      lastServerActivityAtRef: options.lastServerActivityAtRef,
      staleActivityMs: options.staleActivityMs,
    });
  };

  const sendSocketPayload = (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer, recordOptions?: RecordSessionTxOptions) => {
    sendSocketPayloadInfraRuntime({
      sessionId,
      ws,
      data,
      recordSessionTx,
      recordOptions,
    });
  };

  const buildTraversalSocketForHost = (host: Host, transportRole: 'control' | 'session' = 'session') => {
    return buildTraversalSocketForHostRuntime({
      host,
      bridgeSettings: options.bridgeSettings,
      wsUrl: options.wsUrl,
      transportRole,
    });
  };

  const applyTransportDiagnostics = (sessionId: string, socket: BridgeTransportSocket) => {
    applyTransportDiagnosticsRuntime({
      sessionId,
      socket,
      updateSessionSync,
    });
  };

  const flushRuntimeDebugLogs = () => {
    flushRuntimeDebugLogsToSessionTransport({
      activeSessionId: options.stateRef.current.activeSessionId,
      readSessionTransportSocket: transportAccessors.readSessionTransportSocket,
      sendSocketPayload,
    });
  };

  const setScheduleStateForSession = (
    sessionId: string,
    nextState: SessionScheduleState | ((current: SessionScheduleState) => SessionScheduleState),
  ) => {
    setScheduleStateForSessionRuntime({
      sessionId,
      nextState,
      setScheduleStates: options.setScheduleStates,
      stateRef: options.stateRef,
    });
  };

  const clearHeartbeat = (sessionId: string) => {
    clearHeartbeatRuntime({
      sessionId,
      pingIntervalsRef: options.pingIntervalsRef,
      lastPongAtRef: options.lastPongAtRef,
      lastServerActivityAtRef: options.lastServerActivityAtRef,
    });
  };

  const clearSessionHandshakeTimeout = (sessionId: string) => {
    clearSessionHandshakeTimeoutInfraRuntime({
      sessionId,
      handshakeTimeoutsRef: options.handshakeTimeoutsRef,
    });
  };

  const setSessionHandshakeTimeout = (sessionId: string, callback: () => void, delayMs: number) => {
    return setSessionHandshakeTimeoutInfraRuntime({
      sessionId,
      callback,
      delayMs,
      handshakeTimeoutsRef: options.handshakeTimeoutsRef,
    });
  };

  const clearTailRefreshRuntime = (sessionId: string) => {
    clearTailRefreshRuntimeInfra({
      sessionId,
      sessionBufferHeadsRef: options.sessionBufferHeadsRef,
      sessionRevisionResetRef: options.sessionRevisionResetRef,
      lastHeadRequestAtRef: options.lastHeadRequestAtRef,
    });
  };

  const startSocketHeartbeat = (
    sessionId: string,
    ws: BridgeTransportSocket,
    finalizeFailure: (message: string, retryable: boolean) => void,
  ) => {
    startSocketHeartbeatInfraRuntime({
      sessionId,
      ws,
      finalizeFailure,
      pingIntervalsRef: options.pingIntervalsRef,
      lastPongAtRef: options.lastPongAtRef,
      clientPingIntervalMs: 30000,
      clientPongTimeoutMs: 70000,
      sendSocketPayload,
    });
  };

  return {
    applySessionAction,
    readSessionBufferSnapshot,
    updateSessionSync,
    setActiveSessionSync,
    createSessionSync,
    deleteSessionSync,
    moveSessionSync,
    setSessionTitleSync,
    incrementConnectedSync,
    ...transportAccessors,
    readSessionTransportToken,
    writeSessionTransportToken,
    isSessionTransportActive,
    hasPendingSessionTransportOpen,
    isReconnectInFlight,
    resolveSessionCacheLines,
    getSessionRenderBufferSnapshot,
    getSessionBufferStore,
    getSessionHeadStore,
    recordSessionTx,
    recordSessionRx,
    recordSessionRenderCommit,
    markPendingInputTailRefresh,
    clearSessionPullState,
    settleSessionPullState,
    resetSessionTransportPullBookkeeping,
    isSessionTransportActivityStale,
    sendSocketPayload,
    buildTraversalSocketForHost,
    applyTransportDiagnostics,
    flushRuntimeDebugLogs,
    setScheduleStateForSession,
    clearHeartbeat,
    clearSessionHandshakeTimeout,
    setSessionHandshakeTimeout,
    clearTailRefreshRuntime,
    startSocketHeartbeat,
  };
}
