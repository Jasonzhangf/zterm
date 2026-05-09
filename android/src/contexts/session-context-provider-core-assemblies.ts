import { useMemo } from 'react';
import {
  resolveTerminalRefreshCadence,
} from '../lib/mobile-config';
import { runtimeDebug } from '../lib/runtime-debug';
import type { TerminalBufferPayload } from '../lib/types';
import {
  applyIncomingBufferSyncRuntime,
  handleBufferHeadRuntime,
  requestSessionBufferHeadRuntime,
  requestSessionBufferSyncRuntime,
} from './session-context-buffer-runtime';
import {
  createSessionInfraFacadeRuntime,
} from './session-context-infra-facade-runtime';
import {
  createSessionTransportOrchestrationRuntime,
} from './session-context-transport-orchestration-runtime';
import {
  reduceSessionAction,
} from './session-context-core';
import {
  finalizeSocketFailureBaselineRuntime,
  handleSocketConnectedBaselineRuntime,
  handleSocketServerMessageRuntime,
} from './session-context-socket-message-runtime';
import type {
  SessionProviderAssembliesSharedOptions,
  SessionProviderCoreAssembliesResult,
} from './session-context-provider-assembly-types';

const SESSION_HANDSHAKE_TIMEOUT_MS = 4000;
const CLIENT_PING_INTERVAL_MS = 30000;
const ACTIVE_TRANSPORT_STALE_ACTIVITY_MS = CLIENT_PING_INTERVAL_MS + 5000;
const DEFAULT_TERMINAL_SESSION_VIEWPORT = {
  cols: 80,
  rows: 24,
} as const;

function summarizeBufferPayload(payload: TerminalBufferPayload) {
  const firstLine = payload.lines[0];
  const lastLine = payload.lines[payload.lines.length - 1];
  return {
    revision: payload.revision,
    startIndex: payload.startIndex,
    endIndex: payload.endIndex,
    cols: payload.cols,
    rows: payload.rows,
    lineCount: payload.lines.length,
    cursor: payload.cursor
      ? {
          rowIndex: payload.cursor.rowIndex,
          col: payload.cursor.col,
          visible: payload.cursor.visible,
        }
      : null,
    firstLineIndex: firstLine ? ('i' in firstLine ? firstLine.i : firstLine.index) : null,
    lastLineIndex: lastLine ? ('i' in lastLine ? lastLine.i : lastLine.index) : null,
  };
}

export function useSessionProviderCoreAssemblies(
  options: SessionProviderAssembliesSharedOptions,
): SessionProviderCoreAssembliesResult {
  const {
    sessionDebugMetricsStoreRef,
    transportRuntimeStoreRef,
    sessionBufferStoreRef,
    sessionRenderGateRef,
    sessionHeadStoreRef,
    pingIntervalsRef,
    handshakeTimeoutsRef,
    sessionVisibleRangeRef,
    lastPongAtRef,
    lastServerActivityAtRef,
    staleTransportProbeAtRef,
    reconnectRuntimesRef,
    manualCloseRef,
    sessionBufferHeadsRef,
    sessionRevisionResetRef,
    pendingInputTailRefreshRef,
    pendingConnectTailRefreshRef,
    pendingResumeTailRefreshRef,
    lastConnectedBaselineAtRef,
    connectedBaselineBurstGuardRef,
    lastHeadRequestAtRef,
    lastSyncRequestAtRef,
    sessionPullStateRef,
    sessionAttachTokensRef,
    pendingSessionTransportOpenIntentsRef,
    fileTransferMessageRuntimeRef,
    handleSocketConnectedBaselineRef,
    finalizeSocketFailureBaselineRef,
    handleSocketServerMessageRef,
  } = options.refs;

  const sessionInfraRuntime = useMemo(() => createSessionInfraFacadeRuntime({
    stateRef: options.stateRef,
    dispatch: options.dispatch,
    reduceSessionAction,
    transportRuntimeStoreRef,
    sessionBufferStoreRef,
    sessionRenderGateRef,
    sessionHeadStoreRef,
    sessionDebugMetricsStoreRef,
    scheduleStatesRef: options.scheduleStatesRef,
    setScheduleStates: options.setScheduleStates,
    sessionAttachTokensRef,
    pendingSessionTransportOpenIntentsRef,
    reconnectRuntimesRef,
      pendingInputTailRefreshRef,
      pendingConnectTailRefreshRef,
    pendingResumeTailRefreshRef,
    sessionPullStateRef,
    lastServerActivityAtRef,
    staleTransportProbeAtRef,
    lastPongAtRef,
    pingIntervalsRef,
    handshakeTimeoutsRef,
    sessionBufferHeadsRef,
    sessionRevisionResetRef,
    lastHeadRequestAtRef,
    terminalCacheLines: options.terminalCacheLines,
    defaultRows: DEFAULT_TERMINAL_SESSION_VIEWPORT.rows,
    bridgeSettings: options.bridgeSettings,
    wsUrl: options.wsUrl,
    staleActivityMs: ACTIVE_TRANSPORT_STALE_ACTIVITY_MS,
    runtimeDebug,
  }), [options.bridgeSettings, options.dispatch, options.scheduleStatesRef, options.setScheduleStates, options.stateRef, options.terminalCacheLines, options.wsUrl]);

  const {
    readSessionBufferSnapshot,
    updateSessionSync,
    setActiveSessionSync,
    setLiveSessionIdsSync,
    createSessionSync,
    deleteSessionSync,
    moveSessionSync,
    setSessionTitleSync,
    incrementConnectedSync,
    readSessionTransportSocket,
    readSessionTransportHost,
    readSessionTransportRuntime,
    readSessionTargetRuntime,
    readSessionTargetKey,
    readSessionTargetControlSocket,
    writeSessionTransportHost,
    writeSessionTransportSocket,
    writeSessionTargetControlSocket,
    moveSessionTransportSocketAside,
    clearSessionTransportRuntime,
    drainSessionSupersededSockets,
    readSessionTransportToken,
    writeSessionTransportToken,
    isSessionTransportActive,
    shouldAcceptSessionLiveBuffer,
    hasPendingSessionTransportOpen,
    isPendingSessionTransportOpenStale,
    isReconnectInFlight,
    resolveSessionCacheLines,
    getSessionRenderBufferSnapshot,
    getSessionBufferStore,
    getSessionRenderBufferStore,
    getSessionHeadStore,
    recordSessionRx,
    recordSessionRxBytesOnly,
    scheduleSessionRenderCommit,
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
  } = sessionInfraRuntime;

  const {
    cleanupControlSocket,
    clearReconnectForSession,
    cleanupSocket,
    scheduleReconnect,
    queueConnectTransportOpenIntent,
    sendTerminalResize,
  } = useMemo(() => createSessionTransportOrchestrationRuntime({
    stateRef: options.stateRef,
    readSessionBufferSnapshot,
    runtimeDebug,
    sessionHandshakeTimeoutMs: SESSION_HANDSHAKE_TIMEOUT_MS,
    refs: {
      pendingSessionTransportOpenIntentsRef,
      reconnectRuntimesRef,
      manualCloseRef,
      lastPongAtRef,
      staleTransportProbeAtRef,
      sessionDebugMetricsStoreRef,
      handleSocketServerMessageRef,
      handleSocketConnectedBaselineRef,
      finalizeSocketFailureBaselineRef,
    },
    readSessionTargetControlSocket,
    readSessionTargetRuntime,
    readSessionTargetKey,
    readSessionTransportSocket,
    readSessionTransportToken,
    readSessionTransportHost,
    writeSessionTransportToken,
    writeSessionTargetControlSocket,
    writeSessionTransportSocket,
    moveSessionTransportSocketAside,
    drainSessionSupersededSockets,
    updateSessionSync,
    clearHeartbeat,
    clearSessionHandshakeTimeout,
    setSessionHandshakeTimeout,
    clearTailRefreshRuntime,
    clearSessionPullState,
    sendSocketPayload,
    buildTraversalSocketForHost,
    applyTransportDiagnostics,
    recordSessionRx,
    recordControlTransportRxBytes: recordSessionRxBytesOnly,
    flushRuntimeDebugLogs,
    startSocketHeartbeat,
    setScheduleStateForSession,
    readRequestedTerminalGeometry: () => ({
      widthMode: options.bridgeSettings.terminalWidthMode,
    }),
  }), [
    applyTransportDiagnostics,
    buildTraversalSocketForHost,
    clearHeartbeat,
    clearSessionHandshakeTimeout,
    clearSessionPullState,
    clearTailRefreshRuntime,
    drainSessionSupersededSockets,
    flushRuntimeDebugLogs,
    moveSessionTransportSocketAside,
    options.bridgeSettings.terminalWidthMode,
    options.stateRef,
    readSessionTargetControlSocket,
    readSessionTargetKey,
    readSessionTargetRuntime,
    readSessionTransportHost,
    readSessionTransportSocket,
    readSessionTransportToken,
    recordSessionRxBytesOnly,
    sendSocketPayload,
    setScheduleStateForSession,
    setSessionHandshakeTimeout,
    startSocketHeartbeat,
    updateSessionSync,
    writeSessionTargetControlSocket,
    writeSessionTransportSocket,
    writeSessionTransportToken,
  ]);

  const sessionMessageRuntime = useMemo(() => {
    const commitSessionBufferUpdate = (sessionId: string, nextBuffer: any) => {
      return sessionBufferStoreRef.current.commitBuffer(sessionId, nextBuffer);
    };

    const requestSessionBufferSync = (sessionId: string, requestOptions?: {
      ws?: any;
      reason?: string;
      purpose?: any;
      sessionOverride?: any;
      liveHead?: any;
      invalidLocalWindow?: boolean;
      requestWindowOverride?: { requestStartIndex: number; requestEndIndex: number } | null;
    }) => requestSessionBufferSyncRuntime({
      sessionId,
      requestOptions,
      refs: {
        stateRef: options.stateRef,
        sessionVisibleRangeRef,
        sessionBufferHeadsRef,
        sessionPullStateRef,
        lastSyncRequestAtRef,
        pendingInputTailRefreshRef,
        pendingConnectTailRefreshRef,
        pendingResumeTailRefreshRef,
      },
      readSessionTransportSocket,
      readSessionBufferSnapshot,
      clearSessionPullState,
      sendSocketPayload,
      runtimeDebug,
      resolveTerminalRefreshCadence,
    });

    const requestSessionBufferHead = (
      sessionId: string,
      ws?: any,
      headOptions?: { force?: boolean },
    ) => requestSessionBufferHeadRuntime({
      sessionId,
      ws,
      force: headOptions?.force,
      refs: {
        stateRef: options.stateRef,
        lastHeadRequestAtRef,
        sessionDebugMetricsStoreRef,
      },
      readSessionTransportSocket,
      sendSocketPayload,
      resolveTerminalRefreshCadence,
    });

    const handleBufferHead = (
      sessionId: string,
      latestRevision: number,
      latestEndIndex: number,
      availableStartIndex?: number,
      availableEndIndex?: number,
      cursor?: any,
      cursorKeysApp?: boolean,
    ) => {
      handleBufferHeadRuntime({
        sessionId,
        latestRevision,
        latestEndIndex,
        availableStartIndex,
        availableEndIndex,
        cursor,
        cursorKeysApp,
        refs: {
          stateRef: options.stateRef,
          sessionBufferHeadsRef,
          lastHeadRequestAtRef,
          sessionRevisionResetRef,
          sessionVisibleRangeRef,
          sessionBufferStoreRef,
          sessionHeadStoreRef,
        },
        readSessionTransportSocket,
        readSessionBufferSnapshot,
        commitSessionBufferUpdate,
        scheduleSessionRenderCommit,
        isSessionTransportActive,
        shouldAcceptSessionLiveBuffer,
        runtimeDebug,
        requestSessionBufferSync,
      });
    };

    const applyIncomingBufferSync = (sessionId: string, payload: TerminalBufferPayload) => {
      applyIncomingBufferSyncRuntime({
        sessionId,
        payload,
        refs: {
          stateRef: options.stateRef,
          sessionRevisionResetRef,
          sessionBufferHeadsRef,
          pendingInputTailRefreshRef,
          pendingConnectTailRefreshRef,
          pendingResumeTailRefreshRef,
          sessionVisibleRangeRef,
        },
        readSessionBufferSnapshot,
        resolveSessionCacheLines,
        summarizeBufferPayload,
        runtimeDebug,
        commitSessionBufferUpdate,
        scheduleSessionRenderCommit,
        isSessionTransportActive,
        shouldAcceptSessionLiveBuffer,
        requestSessionBufferSync,
      });
    };

    const handleSocketServerMessage = (messageOptions: {
      sessionId: string;
      host: any;
      ws: any;
      debugScope: 'connect' | 'reconnect';
      onConnected: () => void;
      onFailure: (message: string, retryable: boolean) => void;
      onClosed: (reason?: string) => void;
    }, msg: any) => {
      handleSocketServerMessageRuntime({
        params: messageOptions,
        msg,
        refs: {
          stateRef: options.stateRef,
          scheduleStatesRef: options.scheduleStatesRef,
          lastHeadRequestAtRef,
          lastPongAtRef,
        },
        settleSessionPullState,
        runtimeDebug,
        isSessionTransportActive,
        shouldAcceptSessionLiveBuffer,
        summarizeBufferPayload,
        applyIncomingBufferSync,
        handleBufferHead,
        setScheduleStateForSession,
        setSessionTitleSync,
        fileTransferMessageRuntime: fileTransferMessageRuntimeRef.current,
        updateSessionSync,
      });
    };

    const handleSocketConnectedBaseline = (connectedOptions: {
      sessionId: string;
      sessionName: string;
      ws: any;
    }) => {
      handleSocketConnectedBaselineRuntime({
        sessionId: connectedOptions.sessionId,
        sessionName: connectedOptions.sessionName,
        ws: connectedOptions.ws,
        refs: {
          stateRef: options.stateRef,
          pendingConnectTailRefreshRef,
          lastConnectedBaselineAtRef,
          connectedBaselineBurstGuardRef,
        },
        readSessionBufferSnapshot,
        applyTransportDiagnostics,
        updateSessionSync,
        setScheduleStateForSession,
        sendSocketPayload,
        isSessionTransportActive,
        requestSessionBufferHead,
        incrementConnectedSync,
      });
    };

    const finalizeSocketFailureBaseline = (baselineOptions: {
      sessionId: string;
      message: string;
      markCompleted: () => boolean;
    }) => {
      return finalizeSocketFailureBaselineRuntime({
        sessionId: baselineOptions.sessionId,
        message: baselineOptions.message,
        markCompleted: baselineOptions.markCompleted,
        refs: {
          pendingSessionTransportOpenIntentsRef,
          manualCloseRef,
        },
        cleanupSocket,
        writeSessionTransportToken,
        setScheduleStateForSession,
      });
    };

    return {
      requestSessionBufferSync,
      requestSessionBufferHead,
      handleSocketServerMessage,
      handleSocketConnectedBaseline,
      finalizeSocketFailureBaseline,
    };
  }, [
    applyTransportDiagnostics,
    cleanupSocket,
    clearSessionPullState,
    connectedBaselineBurstGuardRef,
    incrementConnectedSync,
    isSessionTransportActive,
    lastConnectedBaselineAtRef,
    lastHeadRequestAtRef,
    lastPongAtRef,
    manualCloseRef,
    options.scheduleStatesRef,
    options.stateRef,
    pendingConnectTailRefreshRef,
    pendingInputTailRefreshRef,
    pendingResumeTailRefreshRef,
    pendingSessionTransportOpenIntentsRef,
    readSessionBufferSnapshot,
    readSessionTransportSocket,
    resolveSessionCacheLines,
    scheduleSessionRenderCommit,
    sendSocketPayload,
    sessionBufferHeadsRef,
    sessionBufferStoreRef,
    sessionDebugMetricsStoreRef,
    sessionHeadStoreRef,
    sessionPullStateRef,
    sessionRevisionResetRef,
    sessionVisibleRangeRef,
    setScheduleStateForSession,
    settleSessionPullState,
    setSessionTitleSync,
    updateSessionSync,
    writeSessionTransportToken,
  ]);

  const {
    requestSessionBufferSync,
    requestSessionBufferHead,
    handleSocketServerMessage,
    handleSocketConnectedBaseline,
    finalizeSocketFailureBaseline,
  } = sessionMessageRuntime;
  handleSocketServerMessageRef.current = handleSocketServerMessage;
  handleSocketConnectedBaselineRef.current = handleSocketConnectedBaseline;
  finalizeSocketFailureBaselineRef.current = finalizeSocketFailureBaseline;

  return useMemo(() => ({
    getSessionRenderBufferSnapshot,
    getSessionBufferStore,
    getSessionRenderBufferStore,
    getSessionHeadStore,
    flushRuntimeDebugLogs,
    clearReconnectForSession,
    writeSessionTransportHost,
    writeSessionTransportToken,
    scheduleReconnect,
    readSessionBufferSnapshot,
    setActiveSessionSync,
    setLiveSessionIdsSync,
    createSessionSync,
    deleteSessionSync,
    moveSessionSync,
    updateSessionSync,
    setSessionTitleSync,
    isSessionTransportActive,
    shouldAcceptSessionLiveBuffer,
    hasPendingSessionTransportOpen,
    isPendingSessionTransportOpenStale,
    isReconnectInFlight,
    resolveSessionCacheLines,
    scheduleSessionRenderCommit,
    markPendingInputTailRefresh,
    resetSessionTransportPullBookkeeping,
    isSessionTransportActivityStale,
    sendSocketPayload,
    setScheduleStateForSession,
    clearSessionHandshakeTimeout,
    cleanupControlSocket,
    cleanupSocket,
    queueConnectTransportOpenIntent,
    sendTerminalResize,
    readSessionTransportSocket,
    readSessionTransportHost,
    readSessionTransportRuntime,
    readSessionTargetRuntime,
    readSessionTargetKey,
    clearSessionTransportRuntime,
    requestSessionBufferSync,
    requestSessionBufferHead,
    resolveTerminalRefreshCadence,
  }), [
    clearReconnectForSession,
    clearSessionHandshakeTimeout,
    cleanupControlSocket,
    cleanupSocket,
    createSessionSync,
    deleteSessionSync,
    flushRuntimeDebugLogs,
    getSessionBufferStore,
    getSessionHeadStore,
    getSessionRenderBufferSnapshot,
    getSessionRenderBufferStore,
    hasPendingSessionTransportOpen,
    isPendingSessionTransportOpenStale,
    isReconnectInFlight,
    isSessionTransportActive,
    shouldAcceptSessionLiveBuffer,
    isSessionTransportActivityStale,
    markPendingInputTailRefresh,
    moveSessionSync,
    queueConnectTransportOpenIntent,
    sendTerminalResize,
    readSessionBufferSnapshot,
    readSessionTargetKey,
    readSessionTargetRuntime,
    readSessionTransportHost,
    readSessionTransportRuntime,
    readSessionTransportSocket,
    requestSessionBufferHead,
    requestSessionBufferSync,
    resetSessionTransportPullBookkeeping,
    resolveSessionCacheLines,
    resolveTerminalRefreshCadence,
    scheduleReconnect,
    scheduleSessionRenderCommit,
    sendSocketPayload,
    setActiveSessionSync,
    setScheduleStateForSession,
    setSessionTitleSync,
    updateSessionSync,
    writeSessionTransportHost,
    writeSessionTransportToken,
  ]);
}
