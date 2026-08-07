import { useCallback, useEffect, useMemo, useRef } from "react";
import { runtimeDebug } from "../lib/runtime-debug";
import { resolveTerminalRefreshCadence } from "../lib/mobile-config";
import { resolveSessionRuntimeTransportCadenceInput } from "../lib/session-runtime-cadence";
import { getSessionTransportResource } from "../lib/session-transport-runtime";
import {
  createSessionInfraFacadeRuntime,
} from "./session-context-infra-facade-runtime";
import {
  createSessionTransportOrchestrationRuntime,
} from "./session-context-transport-orchestration-runtime";
import {
  reduceSessionAction,
} from "./session-context-core";
import {
  createSessionMessageAssemblies,
  type SessionMessageAssembliesResult,
} from "./session-context-message-assemblies";
import {
  settleSessionTmuxTargetRequestRuntime,
} from './session-context-tmux-management-runtime';
import type {
  SessionProviderAssembliesSharedOptions,
  SessionProviderCoreAssembliesResult,
} from "./session-context-provider-assembly-types";
import type { AttachmentAssetDataPayload, AttachmentHistoryPayload, PendingAttachmentsPayload, SessionActivity } from '@zterm/shared/protocol';
import { createSessionActivityNotifier } from '../lib/session-activity-notify';



const SESSION_HANDSHAKE_TIMEOUT_MS = 4000;
const SESSION_TERMINAL_READY_TIMEOUT_MS = 10000;
const ACTIVE_TRANSPORT_STALE_ACTIVITY_MS = 2500;
const DEFAULT_TERMINAL_SESSION_VIEWPORT = {
  cols: 80,
  rows: 24,
} as const;

export function useSessionProviderCoreAssemblies(
  options: SessionProviderAssembliesSharedOptions,
): SessionProviderCoreAssembliesResult {
  const {
    sessionDebugMetricsStoreRef,
    transportRuntimeStoreRef,
    sessionBufferStoreRef,
    sessionRenderGateRef,
    sessionHeadStoreRef,
    sessionHeartbeatStoreRef,
    targetNetworkProbeRuntimeRef,
    sessionReconnectStoreRef,
    handshakeTimeoutsRef,
    sessionVisibleRangeRef,
    sessionRevisionResetRef,
    sessionTailRefreshStoreRef,
    lastConnectedBaselineAtRef,
    connectedBaselineBurstGuardRef,
    lastHeadRequestAtRef,
    bufferFrameAssemblyRef,
    sessionPullStateRef,
    sessionAttachTokensRef,
    pendingSessionTransportOpenIntentsRef,
    tmuxTargetRequestsRef,
    activeBodySubscriptionSuppressedRef,
    fileTransferMessageRuntimeRef,
    remoteWindowMessageRuntimeRef,
    handleSocketConnectedBaselineRef,
    finalizeSocketFailureBaselineRef,
    handleSocketServerMessageRef,
    attachmentStoreRef,
    attachmentFetchRuntimeRef,
  } = options.refs;

  const sessionActivityNotifierRef = useRef(createSessionActivityNotifier());
  useEffect(() => () => {
    sessionActivityNotifierRef.current.dispose();
  }, []);

  const resolveSessionTerminalRefreshCadence = useCallback((sessionId?: string | null) => resolveTerminalRefreshCadence({
    runtimeTransport: sessionId
      ? resolveSessionRuntimeTransportCadenceInput({
          socket: getSessionTransportResource(transportRuntimeStoreRef.current, sessionId).socket,
          metrics: sessionDebugMetricsStoreRef.current.getMetrics(sessionId, null, false),
        })
      : null,
  }), [sessionDebugMetricsStoreRef, transportRuntimeStoreRef]);

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
    activeBodySubscriptionSuppressedRef,
    reconnectStore: sessionReconnectStoreRef.current,
    tailRefreshStore: sessionTailRefreshStoreRef.current,
    bufferFrameAssemblyRef,
    sessionPullStateRef,
    heartbeatStore: sessionHeartbeatStoreRef.current,
    handshakeTimeoutsRef,
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
    readTargetTransportRuntimes,
    readTargetTransportRuntime,
    readTargetTerminalSocket,
    readSessionBufferSnapshot,
    updateSessionSync,
    setActiveSessionSync,
    setLiveSessionIdsSync,
    setActiveBodySubscriptionSuppressedSync,
    createSessionSync,
    deleteSessionSync,
    moveSessionSync,
    setSessionTitleSync,
    incrementConnectedSync,
    readSessionTransportResource,
    readSessionTransportSocket,
    readSessionTransportHost,
    readSessionTransportRuntime,
    readSessionTargetRuntime,
    readSessionTargetKey,
    readSessionTargetControlSocket,
    readSessionTargetTerminalSocket,
    readSessionTargetTerminalMuxReady,
    readSessionTerminalChannel,
    readSessionIdForTerminalChannel,
    readTargetSessionIdForTerminalChannel,
    readOpeningSessionTerminalChannelsForTarget,
    readOpeningTerminalChannelsForTarget,
    readSessionRequestedTerminalGeometry,
    writeSessionTransportHost,
    writeSessionTransportSocket,
    writeSessionTargetControlSocket,
    writeSessionTargetTerminalSocket,
    writeSessionTargetTerminalMuxReady,
    writeTargetTerminalSocket,
    writeTargetTerminalMuxReady,
    ensureSessionTerminalChannel,
    writeSessionTerminalChannelState,
    writeSessionRequestedTerminalGeometry,
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
    openDaemonTargetTransportSocket,
    applyTransportDiagnostics,
    flushRuntimeDebugLogs,
    setScheduleStateForSession,
    clearHeartbeat,
    clearSessionHandshakeTimeout,
    setSessionHandshakeTimeout,
    clearTailRefreshRuntime,
    startSocketHeartbeat,
    daemonConnection,
  } = sessionInfraRuntime;

  // Start attachment fetch runtime when mux becomes ready.
  // The startup can be missed when the provider mounts before an active session
  // exists or before the mux channel is ready, so retry on a short interval until
  // the fetch runtime is actually started (and only start it once).
  const attachmentFetchStartedRef = useRef(false);
  useEffect(() => {
    if (attachmentFetchStartedRef.current) return;
    if (!attachmentFetchRuntimeRef.current) return;

    const tryStartFetchRuntime = () => {
      if (attachmentFetchStartedRef.current) return true;
      const activeSessionId = options.stateRef.current.activeSessionId;
      if (!activeSessionId) return false;
      if (!readSessionTargetTerminalMuxReady(activeSessionId)) return false;
      const targetSocket = readSessionTargetTerminalSocket(activeSessionId);
      if (!targetSocket) return false;

      // Start the fetch runtime with proper send/read capabilities
      attachmentFetchRuntimeRef.current!.start({
        sendMuxTargetMessage: (msg) => {
          const currentActiveId = options.stateRef.current.activeSessionId;
          if (!currentActiveId) return false;
          const currentSocket = readSessionTargetTerminalSocket(currentActiveId);
          if (!currentSocket || currentSocket.readyState !== WebSocket.OPEN) return false;
          try {
            currentSocket.send(JSON.stringify(msg));
            return true;
          } catch {
            return false;
          }
        },
        readMuxReady: () => {
          const currentActiveId = options.stateRef.current.activeSessionId;
          if (!currentActiveId) return false;
          return readSessionTargetTerminalMuxReady(currentActiveId);
        },
      });
      attachmentFetchStartedRef.current = true;
      return true;
    };

    if (tryStartFetchRuntime()) return undefined;
    const retryTimer = setInterval(() => {
      if (tryStartFetchRuntime()) {
        clearInterval(retryTimer);
      }
    }, 2000);
    return () => clearInterval(retryTimer);
  }, [options.stateRef, readSessionTargetTerminalMuxReady, readSessionTargetTerminalSocket]);


  const {
    cleanupControlSocket,
    clearReconnectForSession,
    cleanupSocket,
    scheduleReconnect,
    queueConnectTransportOpenIntent,
    notifyTargetNetworkSignal,
    sendTerminalResize,
  } = useMemo(() => createSessionTransportOrchestrationRuntime({
    stateRef: options.stateRef,
    readSessionBufferSnapshot,
    readTargetTransportRuntimes,
    readTargetTransportRuntime,
    readTargetTerminalSocket,
    runtimeDebug,
    clientDeviceId: options.bridgeSettings.traversalRelay?.deviceId?.trim() || undefined,
    sessionHandshakeTimeoutMs: SESSION_HANDSHAKE_TIMEOUT_MS,
    sessionTerminalReadyTimeoutMs: SESSION_TERMINAL_READY_TIMEOUT_MS,
    refs: {
      pendingSessionTransportOpenIntentsRef,
      tmuxTargetRequestsRef,
      reconnectStore: sessionReconnectStoreRef.current,
      heartbeatStore: sessionHeartbeatStoreRef.current,
      targetNetworkProbeRuntime: targetNetworkProbeRuntimeRef.current,
      sessionDebugMetricsStoreRef,
      handleSocketServerMessageRef,
      handleSocketConnectedBaselineRef,
      finalizeSocketFailureBaselineRef,
    },
    readSessionTargetControlSocket,
    readSessionTargetTerminalSocket,
    readSessionTargetTerminalMuxReady,
    readSessionTargetRuntime,
    readSessionTargetKey,
    readSessionTerminalChannel,
    readSessionIdForTerminalChannel,
    readTargetSessionIdForTerminalChannel,
    readOpeningSessionTerminalChannelsForTarget,
    readOpeningTerminalChannelsForTarget,
    readSessionTransportSocket,
    readSessionTransportResource,
    readSessionTransportToken,
    readSessionTransportHost,
    writeSessionTransportToken,
    writeSessionTargetControlSocket,
    writeSessionTargetTerminalSocket,
    writeSessionTargetTerminalMuxReady,
    writeTargetTerminalSocket,
    writeTargetTerminalMuxReady,
    writeSessionTransportSocket,
    writeSessionTransportHost,
    ensureSessionTerminalChannel,
    writeSessionTerminalChannelState,
    moveSessionTransportSocketAside,
    drainSessionSupersededSockets,
    updateSessionSync,
    clearHeartbeat,
    clearSessionHandshakeTimeout,
    setSessionHandshakeTimeout,
    clearTailRefreshRuntime,
    clearSessionPullState,
    sendSocketPayload,
    openDaemonTargetTransportSocket,
    applyTransportDiagnostics,
    recordSessionRx,
    recordControlTransportRxBytes: recordSessionRxBytesOnly,
    flushRuntimeDebugLogs,
    startSocketHeartbeat,
    setScheduleStateForSession,
    writeSessionRequestedTerminalGeometry,
    handleTargetMuxMessage: (payload) => {
      // Handle attachment-asset-data messages from daemon
      if (payload.message.type === 'attachment-asset-data') {
        const dataPayload = payload.message.payload as AttachmentAssetDataPayload;
        // Decode base64 data and store
        const binaryStr = atob(dataPayload.dataBase64);
        const binaryLen = binaryStr.length;
        const bytes = new Uint8Array(binaryLen);
        for (let i = 0; i < binaryLen; i++) bytes[i] = binaryStr.charCodeAt(i);
        const blob = new Blob([bytes], { type: dataPayload.mimeType });

        if (dataPayload.asset === 'preview') {
          attachmentStoreRef.current.markPreviewReady(dataPayload.attachmentId, blob);
        } else {
          attachmentStoreRef.current.markOriginalReady(dataPayload.attachmentId, blob);
        }
        // Ack the received asset over the mux channel so the daemon can
        // resolve the delivery instead of leaving it pending forever.
        attachmentFetchRuntimeRef.current.onAssetDataReceived(
          dataPayload.attachmentId,
          dataPayload.asset,
          dataPayload.sha256,
        );
        return true;
      }
      // Daemon-published tmux session liveness facts (idle/stopped detection).
      if (payload.message.type === 'session-activity') {
        const activities = (payload.message.payload as { activities: SessionActivity[] }).activities || [];
        for (const activity of activities) {
          sessionActivityNotifierRef.current.handleActivity(activity);
        }
        return true;
      }      // Handle attachment history response from daemon
      if (payload.message.type === 'attachment-history') {
        attachmentFetchRuntimeRef.current.processAttachmentHistoryPayload(payload.message.payload as AttachmentHistoryPayload);
        return true;
      }
      // Handle pending-attachments response from daemon
      if (payload.message.type === 'pending-attachments') {
        const pendingPayload = payload.message.payload as PendingAttachmentsPayload;
        attachmentFetchRuntimeRef.current.processPendingAttachmentsResponse(pendingPayload);
        return true;
      }
      
      // Handle tmux target requests
      return settleSessionTmuxTargetRequestRuntime({
        pendingRequestsRef: tmuxTargetRequestsRef,
        requestId: payload.requestId,
        message: payload.message,
        runtimeDebug,
      }) ?? false;
    },
    readRequestedTerminalGeometry: (sessionId: string) => {
      const requestedGeometry = readSessionRequestedTerminalGeometry(sessionId);
      if (
        options.bridgeSettings.terminalWidthMode === 'adaptive-phone'
        && requestedGeometry?.widthMode === 'adaptive-phone'
        && Number.isFinite(requestedGeometry.cols)
      ) {
        return requestedGeometry;
      }
      return { widthMode: 'mirror-fixed' };
    },
  }), [
    applyTransportDiagnostics,
    openDaemonTargetTransportSocket,
    clearHeartbeat,
    clearSessionHandshakeTimeout,
    clearSessionPullState,
    clearTailRefreshRuntime,
    drainSessionSupersededSockets,
    flushRuntimeDebugLogs,
    moveSessionTransportSocketAside,
    options.bridgeSettings.terminalWidthMode,
    options.stateRef,
    readTargetTransportRuntime,
    readTargetTransportRuntimes,
    readTargetTerminalSocket,
    readSessionTargetControlSocket,
    readSessionTargetTerminalSocket,
    readSessionTargetTerminalMuxReady,
    readSessionIdForTerminalChannel,
    readTargetSessionIdForTerminalChannel,
    readSessionTerminalChannel,
    readOpeningSessionTerminalChannelsForTarget,
    readOpeningTerminalChannelsForTarget,
    readSessionTargetKey,
    readSessionRequestedTerminalGeometry,
    readSessionTargetRuntime,
    readSessionTransportHost,
    readSessionTransportResource,
    readSessionTransportSocket,
    readSessionTransportToken,
    recordSessionRxBytesOnly,
    sendSocketPayload,
    setScheduleStateForSession,
    setSessionHandshakeTimeout,
    startSocketHeartbeat,
    updateSessionSync,
    ensureSessionTerminalChannel,
    writeSessionTargetControlSocket,
    writeSessionTargetTerminalSocket,
    writeSessionTargetTerminalMuxReady,
    writeTargetTerminalMuxReady,
    writeTargetTerminalSocket,
    writeSessionTerminalChannelState,
    writeSessionRequestedTerminalGeometry,
    writeSessionTransportSocket,
    writeSessionTransportHost,
    writeSessionTransportToken,
  ]);

  const sessionMessageRuntime: SessionMessageAssembliesResult = useMemo(() => createSessionMessageAssemblies({
    stateRef: options.stateRef,
    scheduleStatesRef: options.scheduleStatesRef,
    sessionVisibleRangeRef,
    sessionPullStateRef,
    sessionRevisionResetRef,
    sessionBufferStoreRef,
    sessionHeadStoreRef,
    sessionDebugMetricsStoreRef,
    tailRefreshStore: sessionTailRefreshStoreRef.current,
    lastHeadRequestAtRef,
    reconnectStore: sessionReconnectStoreRef.current,
    heartbeatStore: sessionHeartbeatStoreRef.current,
    lastConnectedBaselineAtRef,
    connectedBaselineBurstGuardRef,
    bufferFrameAssemblyRef,
    pendingSessionTransportOpenIntentsRef,
    fileTransferMessageRuntimeRef,
    remoteWindowMessageRuntimeRef,
    readSessionTransportSocket,
    readSessionTransportResource,
    daemonConnection,
    readSessionBufferSnapshot,
    sendSocketPayload,
    clearSessionPullState,
    settleSessionPullState,
    scheduleSessionRenderCommit,
    isSessionTransportActive,
    shouldAcceptSessionLiveBuffer,
    resolveSessionCacheLines,
    resolveTerminalRefreshCadence: resolveSessionTerminalRefreshCadence,
    setScheduleStateForSession,
    setSessionTitleSync,
    updateSessionSync,
    writeSessionTransportToken,
    cleanupSocket,
    applyTransportDiagnostics,
    incrementConnectedSync,
  }), [
    applyTransportDiagnostics,
    cleanupSocket,
    clearSessionPullState,
    connectedBaselineBurstGuardRef,
    daemonConnection,
    fileTransferMessageRuntimeRef,
    remoteWindowMessageRuntimeRef,
    incrementConnectedSync,
    isSessionTransportActive,
    lastConnectedBaselineAtRef,
    lastHeadRequestAtRef,
    sessionReconnectStoreRef,
    sessionHeartbeatStoreRef,
    bufferFrameAssemblyRef,
    options.scheduleStatesRef,
    options.stateRef,
    sessionTailRefreshStoreRef,
    pendingSessionTransportOpenIntentsRef,
    readSessionBufferSnapshot,
    readSessionTransportResource,
    readSessionTransportSocket,
    resolveSessionCacheLines,
    resolveSessionTerminalRefreshCadence,
    scheduleSessionRenderCommit,
    sendSocketPayload,
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
  // Reference attachment refs to prevent unused warnings
  // They are exposed via the ref objects and used by attachment UI components
  void attachmentStoreRef;
  void attachmentFetchRuntimeRef;

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
    setActiveBodySubscriptionSuppressedSync,
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
    notifyTargetNetworkSignal,
    sendTerminalResize,
    readTargetTransportRuntimes,
    readSessionTransportResource,
    readSessionTransportSocket,
    readSessionTransportHost,
    readSessionTransportRuntime,
    readSessionTargetRuntime,
    readSessionTerminalChannel,
    readSessionTargetKey,
    readSessionRequestedTerminalGeometry,
    writeSessionRequestedTerminalGeometry,
    clearSessionTransportRuntime,
    requestSessionBufferSync,
    requestSessionBufferHead,
    resolveTerminalRefreshCadence: resolveSessionTerminalRefreshCadence,
    daemonConnection,
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
    notifyTargetNetworkSignal,
    sendTerminalResize,
    readSessionBufferSnapshot,
    readTargetTransportRuntimes,
    readSessionTargetKey,
    readSessionTargetRuntime,
    readSessionTerminalChannel,
    readSessionTransportHost,
    readSessionTransportResource,
    readSessionTransportRuntime,
    readSessionTransportSocket,
    requestSessionBufferHead,
    requestSessionBufferSync,
    resetSessionTransportPullBookkeeping,
    resolveSessionCacheLines,
    resolveSessionTerminalRefreshCadence,
    scheduleReconnect,
    scheduleSessionRenderCommit,
    sendSocketPayload,
    setActiveSessionSync,
    setScheduleStateForSession,
    setSessionTitleSync,
    updateSessionSync,
    writeSessionTransportHost,
    writeSessionTransportToken,
    daemonConnection,
  ]);
}
