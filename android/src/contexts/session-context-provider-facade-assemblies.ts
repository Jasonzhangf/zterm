import { useMemo } from 'react';
import { CLIENT_RUNTIME_DEBUG_FLUSH_INTERVAL_MS } from '../lib/runtime-debug-http-exporter';
import { runtimeDebug } from '../lib/runtime-debug';
import {
  createSessionLifecycleRuntime,
} from './session-context-session-orchestration-runtime';
import {
  createSessionInteractionRuntime,
} from './session-context-interaction-runtime';
import {
  useSessionContextLifecycle,
} from './session-context-lifecycle';
import {
  createSessionPublicFacadeRuntime,
} from './session-context-public-facade-runtime';
import type {
  SessionProviderAssembliesSharedOptions,
  SessionProviderCoreAssembliesResult,
} from './session-context-provider-assembly-types';

const IMAGE_PASTE_READY_TIMEOUT_MS = 6000;
function resolveActiveTransportProbeWaitMs(resolveCadence: (sessionId?: string | null) => { headTickMs: number }) {
  const cadence = resolveCadence();
  if (cadence.headTickMs >= 120) { return 500; }
  if (cadence.headTickMs >= 66) { return 900; }
  return 1200;
}
const DEFAULT_TERMINAL_SESSION_VIEWPORT = {
  cols: 80,
  rows: 24,
} as const;

export function useSessionProviderFacadeAssemblies(
  options: SessionProviderAssembliesSharedOptions,
  core: SessionProviderCoreAssembliesResult,
) {
  const {
    sessionDebugMetricsStoreRef,
    transportRuntimeStoreRef,
    sessionVisibleRangeRef,
    remoteScreenshotRuntimeRef,
    remoteWindowMessageRuntimeRef,
    remoteWindowReceiverRuntimeRef,
    foregroundActiveRef,
    sessionPullStateRef,
    lastActivatedSessionIdRef,
    lastActiveReentryAtRef,
    lastConnectedBaselineAtRef,
    lastBackgroundEnteredAtRef,
    connectedBaselineBurstGuardRef,
    sessionHeartbeatStoreRef,
    handshakeTimeoutsRef,
    sessionReconnectStoreRef,
    tmuxTargetRequestsRef,
  } = options.refs;

  const sessionLifecycleRuntime = useMemo(() => createSessionLifecycleRuntime({
    refs: {
      stateRef: options.stateRef,
      reconnectStore: sessionReconnectStoreRef.current,
      pendingSessionTransportOpenIntentsRef: options.refs.pendingSessionTransportOpenIntentsRef,
      tailRefreshStore: options.refs.sessionTailRefreshStoreRef.current,
      lastActiveReentryAtRef,
      lastConnectedBaselineAtRef,
      connectedBaselineBurstGuardRef,
      lastBackgroundEnteredAtRef,
      sessionVisibleRangeRef,
      sessionRevisionResetRef: options.refs.sessionRevisionResetRef,
      bufferFrameAssemblyRef: options.refs.bufferFrameAssemblyRef,
      sessionBufferStoreRef: options.refs.sessionBufferStoreRef,
      sessionRenderGateRef: options.refs.sessionRenderGateRef,
      sessionHeadStoreRef: options.refs.sessionHeadStoreRef,
      sessionDebugMetricsStoreRef,
      heartbeatStore: sessionHeartbeatStoreRef.current,
      lastHeadRequestAtRef: options.refs.lastHeadRequestAtRef,
    },
    runtimeDebug,
    defaultViewport: DEFAULT_TERMINAL_SESSION_VIEWPORT,
    activeTransportProbeWaitMs: resolveActiveTransportProbeWaitMs(core.resolveTerminalRefreshCadence),
    resolveSessionCacheLines: core.resolveSessionCacheLines,
    createSessionSync: core.createSessionSync,
    deleteSessionSync: core.deleteSessionSync,
    moveSessionSync: core.moveSessionSync,
    updateSessionSync: core.updateSessionSync,
    setScheduleStates: options.setScheduleStates,
    setScheduleStateForSession: core.setScheduleStateForSession,
    clearReconnectForSession: core.clearReconnectForSession,
    cleanupSocket: core.cleanupSocket,
    cleanupControlSocket: core.cleanupControlSocket,
    writeSessionTransportHost: core.writeSessionTransportHost,
    writeSessionTerminalChannelName: core.writeSessionTerminalChannelName,
    writeSessionTransportToken: core.writeSessionTransportToken,
    reconcilePhysicalBodySubscriptions: core.reconcilePhysicalBodySubscriptions,
    daemonConnection: core.daemonConnection,
    readSessionTransportHost: core.readSessionTransportHost,
    readSessionTransportRuntime: core.readSessionTransportRuntime,
    readSessionTargetRuntime: core.readSessionTargetRuntime,
    readSessionTerminalChannel: core.readSessionTerminalChannel,
    readSessionTargetKey: core.readSessionTargetKey,
    clearSessionTransportRuntime: core.clearSessionTransportRuntime,
    sendSocketPayload: core.sendSocketPayload,
    queueConnectTransportOpenIntent: core.queueConnectTransportOpenIntent,
    scheduleReconnect: core.scheduleReconnect,
    readSessionBufferSnapshot: core.readSessionBufferSnapshot,
    requestSessionBufferHead: core.requestSessionBufferHead,
    resolveTerminalRefreshCadence: core.resolveTerminalRefreshCadence,
    isSessionTransportActive: core.isSessionTransportActive,
    isSessionTransportActivityStale: core.isSessionTransportActivityStale,
    isReconnectInFlight: core.isReconnectInFlight,
    hasPendingSessionTransportOpen: core.hasPendingSessionTransportOpen,
    isPendingSessionTransportOpenStale: core.isPendingSessionTransportOpenStale,
    resetSessionTransportPullBookkeeping: core.resetSessionTransportPullBookkeeping,
  }), [
    core,
    sessionReconnectStoreRef,
    sessionHeartbeatStoreRef,
    options.refs.sessionTailRefreshStoreRef,
    options.refs.pendingSessionTransportOpenIntentsRef,
    options.refs.sessionAttachTokensRef,
    options.refs.sessionBufferStoreRef,
    options.refs.sessionHeadStoreRef,
    options.refs.transportRuntimeStoreRef,
    options.setScheduleStates,
    options.stateRef,
    sessionDebugMetricsStoreRef,
    sessionVisibleRangeRef,
  ]);

  const {
    createSession,
    closeSession,
    moveSession,
    renameSession,
    renameRemoteSession,
    reconnectSession,
    reconnectAllSessions,
    ensureActiveSessionFresh,
  } = sessionLifecycleRuntime;
  const switchSession = (id: string, switchOptions?: { refreshSource?: 'explicit-resume' | 'active-reentry' }) => {
    const refreshSource = switchOptions?.refreshSource || 'active-reentry';
    const prev = options.stateRef.current.activeSessionId;
    const targetSession = options.stateRef.current.sessions.find((session) => session.id === id) || null;
    if (prev && prev !== id) {
      core.resetSessionTransportPullBookkeeping(prev, 'tab-switch-out');
      lastActiveReentryAtRef.current.delete(prev);
    }
    lastActivatedSessionIdRef.current = id;
    core.setActiveSessionSync(id);
    if (targetSession?.state !== 'connected') {
      core.resetSessionTransportPullBookkeeping(id, 'tab-switch-in');
    }
    ensureActiveSessionFresh({
      sessionId: id,
      source: refreshSource,
      forceHead: true,
      markResumeTail: true,
      allowReconnectIfUnavailable: true,
    });
  };

  const sessionPublicFacadeRuntime = useMemo(() => createSessionPublicFacadeRuntime({
    stateRef: options.stateRef,
    scheduleStatesRef: options.scheduleStatesRef,
    sessionVisibleRangeRef,
    sessionHeadStoreRef: options.refs.sessionHeadStoreRef,
    readSessionTransportResource: core.readSessionTransportResource,
    readSessionTransportSocket: core.readSessionTransportSocket,
    readTargetTransportRuntimes: core.readTargetTransportRuntimes,
    daemonConnection: core.daemonConnection,
    sendSocketPayload: core.sendSocketPayload,
    tmuxTargetRequestsRef,
    setScheduleStateForSession: core.setScheduleStateForSession,
    readSessionBufferSnapshot: core.readSessionBufferSnapshot,
    requestSessionBufferSync: core.requestSessionBufferSync,
    ensureActiveSessionFresh,
    notifyTargetNetworkSignal: core.notifyTargetNetworkSignal,
    reportTargetNetworkProbeError: core.reportTargetNetworkProbeError,
    sendTerminalResize: core.sendTerminalResize,
    setLiveSessionIdsSync: core.setLiveSessionIdsSync,
    setActiveBodySubscriptionSuppressedSync: core.setActiveBodySubscriptionSuppressedSync,
    isSessionTransportActive: core.isSessionTransportActive,
    sessionDebugMetricsStoreRef,
    runtimeDebug,
  }), [
    core,
    ensureActiveSessionFresh,
    options.scheduleStatesRef,
    options.stateRef,
    options.refs.sessionHeadStoreRef,
    sessionDebugMetricsStoreRef,
    sessionVisibleRangeRef,
    tmuxTargetRequestsRef,
  ]);

  const {
    sendMessage,
    requestScheduleList,
    upsertScheduleJob,
    deleteScheduleJob,
    toggleScheduleJob,
    runScheduleJobNow,
    setLiveSessionIds,
    setActiveBodySubscriptionSuppressed,
    resumeActiveSessionTransport,
    notifyTargetNetworkSignal,
    reportTargetNetworkProbeError,
    sendTerminalResize,
    updateSessionViewport,
    getActiveSession,
    getSession,
    getSessionScheduleState,
    getSessionDebugMetrics,
    manageTmuxSessionsOnOpenTransport,
    queryTerminalSessionCatalogOnOpenTransport,
    sendMessageRaw,
    sendTargetHeartbeat,
  } = sessionPublicFacadeRuntime;

  const sessionInteractionRuntime = useMemo(() => createSessionInteractionRuntime({
    refs: {
      stateRef: options.stateRef,
      imagePasteWaiterRuntimeRef: options.refs.imagePasteWaiterRuntimeRef,
      fileTransferMessageRuntimeRef: options.refs.fileTransferMessageRuntimeRef,
      remoteScreenshotRuntimeRef,
      remoteWindowMessageRuntimeRef,
      remoteWindowReceiverRuntimeRef,
    },
    imagePasteReadyTimeoutMs: IMAGE_PASTE_READY_TIMEOUT_MS,
    bridgeSettings: options.bridgeSettings,
    runtimeDebug,
    daemonConnection: core.daemonConnection,
    sendSocketPayload: core.sendSocketPayload,
    markPendingInputTailRefresh: core.markPendingInputTailRefresh,
    readSessionBufferSnapshot: core.readSessionBufferSnapshot,
    requestSessionBufferHead: core.requestSessionBufferHead,
    isReconnectInFlight: core.isReconnectInFlight,
    hasPendingSessionTransportOpen: core.hasPendingSessionTransportOpen,
    isPendingSessionTransportOpenStale: core.isPendingSessionTransportOpenStale,
    scheduleReconnect: core.scheduleReconnect,
  }), [
    core,
    core.daemonConnection,
    options.bridgeSettings,
    options.refs.imagePasteWaiterRuntimeRef,
    options.refs.fileTransferMessageRuntimeRef,
    options.stateRef,
    remoteScreenshotRuntimeRef,
    remoteWindowMessageRuntimeRef,
    remoteWindowReceiverRuntimeRef,
  ]);

  const {
    sendInput,
    sendImagePaste,
    sendFileAttach,
    requestRemoteScreenshot,
    requestRemoteWindowTargets,
    requestRemoteWindowStreamStart,
    updateRemoteWindowStreamQuality,
    updateRemoteWindowFocus,
    setRemoteWindowBrowserUserAgent,
    stopRemoteWindowStream,
    sendRemoteWindowInput,
    resizeRemoteWindowTarget,
  } = sessionInteractionRuntime;

  useSessionContextLifecycle({
    appForegroundActive: options.appForegroundActive,
    foregroundResumeEpoch: options.foregroundResumeEpoch,
    state: options.state,
    scheduleStates: options.scheduleStates,
    refs: {
      foregroundActiveRef,
      stateRef: options.stateRef,
      scheduleStatesRef: options.scheduleStatesRef,
      sessionDebugMetricsStoreRef,
      transportRuntimeStoreRef,
      sessionPullStateRef,
      lastActivatedSessionIdRef,
      lastActiveReentryAtRef,
      lastConnectedBaselineAtRef,
      heartbeatStore: sessionHeartbeatStoreRef.current,
      remoteScreenshotRuntimeRef,
      remoteWindowMessageRuntimeRef,
      remoteWindowReceiverRuntimeRef,
      handshakeTimeoutsRef,
      reconnectStore: sessionReconnectStoreRef.current,
    },
    flushRuntimeDebugLogs: core.flushRuntimeDebugLogs,
    clientRuntimeDebugFlushIntervalMs: CLIENT_RUNTIME_DEBUG_FLUSH_INTERVAL_MS,
    ensureActiveSessionFresh,
    resolveActiveHeadRefreshTickMs: (sessionId?: string | null) => core.resolveTerminalRefreshCadence(sessionId).headTickMs,
    resolveHeadStalePingMs: (sessionId?: string | null) => core.resolveTerminalRefreshCadence(sessionId).headStalePingMs,
    clearSessionHandshakeTimeout: core.clearSessionHandshakeTimeout,
    cleanupSocket: core.cleanupSocket,
    cleanupControlSocket: core.cleanupControlSocket,
  });

  return useMemo(() => ({
    scheduleStates: options.scheduleStates,
    createSession,
    closeSession,
    switchSession,
    moveSession,
    renameSession,
    renameRemoteSession,
    reconnectSession,
    reconnectAllSessions,
    setLiveSessionIds,
    setActiveBodySubscriptionSuppressed,
    resumeActiveSessionTransport,
    notifyTargetNetworkSignal,
    reportTargetNetworkProbeError,
    sendTerminalResize,
    sendMessage,
    sendInput,
    sendImagePaste,
    sendFileAttach,
    requestRemoteScreenshot,
    requestRemoteWindowTargets,
    requestRemoteWindowStreamStart,
    updateRemoteWindowStreamQuality,
    setRemoteWindowBrowserUserAgent,
    updateRemoteWindowFocus,
    stopRemoteWindowStream,
    sendRemoteWindowInput,
    resizeRemoteWindowTarget,
    updateSessionViewport,
    requestScheduleList,
    upsertScheduleJob,
    deleteScheduleJob,
    toggleScheduleJob,
    runScheduleJobNow,
    getSessionScheduleState,
    getActiveSession,
    getSession,
    getSessionDebugMetrics,
    manageTmuxSessionsOnOpenTransport,
    queryTerminalSessionCatalogOnOpenTransport,
    sendMessageRaw,
    sendTargetHeartbeat,
  }), [
    closeSession,
    createSession,
    deleteScheduleJob,
    getActiveSession,
    getSession,
    getSessionDebugMetrics,
    getSessionScheduleState,
    manageTmuxSessionsOnOpenTransport,
    queryTerminalSessionCatalogOnOpenTransport,
    moveSession,
    options.scheduleStates,
    reconnectAllSessions,
    reconnectSession,
    renameSession,
    renameRemoteSession,
    requestRemoteScreenshot,
    requestRemoteWindowTargets,
    requestRemoteWindowStreamStart,
    updateRemoteWindowStreamQuality,
    requestScheduleList,
    setRemoteWindowBrowserUserAgent,
    resumeActiveSessionTransport,
    notifyTargetNetworkSignal,
    runScheduleJobNow,
    sendFileAttach,
    sendImagePaste,
    sendInput,
    sendRemoteWindowInput,
    resizeRemoteWindowTarget,
    sendMessage,
    sendMessageRaw,
    sendTargetHeartbeat,
    setLiveSessionIds,
    setActiveBodySubscriptionSuppressed,
    stopRemoteWindowStream,
    switchSession,
    toggleScheduleJob,
    updateSessionViewport,
    upsertScheduleJob,
  ]);
}
