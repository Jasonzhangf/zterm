import { useMemo } from 'react';
import { CLIENT_RUNTIME_DEBUG_FLUSH_INTERVAL_MS } from '../lib/runtime-debug-flush';
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
import {
  shouldReconnectQueuedActiveInput,
} from './session-transport-open-helpers';
import type {
  SessionProviderAssembliesSharedOptions,
  SessionProviderCoreAssembliesResult,
} from './session-context-provider-assembly-types';

const IMAGE_PASTE_READY_TIMEOUT_MS = 6000;
function resolveActiveTransportProbeWaitMs(resolveCadence: (sessionId?: string | null) => { headTickMs: number }) {
  const cadence = resolveCadence();
  if (cadence.headTickMs >= 120) { return 500; }
  if (cadence.headTickMs >= 66) { return 900; }
  return 1500;
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
    sessionVisibleRangeRef,
    sessionBufferHeadsRef,
    remoteScreenshotRuntimeRef,
    foregroundActiveRef,
    sessionPullStateRef,
    lastActivatedSessionIdRef,
    lastActiveReentryAtRef,
    lastConnectedBaselineAtRef,
    connectedBaselineBurstGuardRef,
    pingIntervalsRef,
    handshakeTimeoutsRef,
    reconnectRuntimesRef,
    manualCloseRef,
  } = options.refs;

  const sessionLifecycleRuntime = useMemo(() => createSessionLifecycleRuntime({
    refs: {
      stateRef: options.stateRef,
      manualCloseRef,
        pendingSessionTransportOpenIntentsRef: options.refs.pendingSessionTransportOpenIntentsRef,
        pendingInputTailRefreshRef: options.refs.pendingInputTailRefreshRef,
      pendingConnectTailRefreshRef: options.refs.pendingConnectTailRefreshRef,
      pendingResumeTailRefreshRef: options.refs.pendingResumeTailRefreshRef,
      lastActiveReentryAtRef,
      lastConnectedBaselineAtRef,
      connectedBaselineBurstGuardRef,
      reconnectRuntimesRef,
      sessionVisibleRangeRef,
      sessionBufferStoreRef: options.refs.sessionBufferStoreRef,
      sessionRenderGateRef: options.refs.sessionRenderGateRef,
      sessionHeadStoreRef: options.refs.sessionHeadStoreRef,
      sessionDebugMetricsStoreRef,
      lastServerActivityAtRef: options.refs.lastServerActivityAtRef,
      lastHeadRequestAtRef: options.refs.lastHeadRequestAtRef,
      staleTransportProbeAtRef: options.refs.staleTransportProbeAtRef,
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
    writeSessionTransportToken: core.writeSessionTransportToken,
    readSessionTransportSocket: core.readSessionTransportSocket,
    readSessionTransportHost: core.readSessionTransportHost,
    readSessionTransportRuntime: core.readSessionTransportRuntime,
    readSessionTargetRuntime: core.readSessionTargetRuntime,
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
    manualCloseRef,
    options.refs.lastServerActivityAtRef,
    options.refs.pendingConnectTailRefreshRef,
    options.refs.pendingInputTailRefreshRef,
    options.refs.pendingResumeTailRefreshRef,
    options.refs.pendingSessionTransportOpenIntentsRef,
    options.refs.sessionAttachTokensRef,
    options.refs.sessionBufferStoreRef,
    options.refs.sessionHeadStoreRef,
    options.refs.staleTransportProbeAtRef,
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
    reconnectSession,
    reconnectAllSessions,
    probeOrReconnectStaleSessionTransport,
    ensureActiveSessionFresh,
  } = sessionLifecycleRuntime;
  const switchSession = (id: string) => {
    const prev = options.stateRef.current.activeSessionId;
    if (prev && prev !== id) {
      core.resetSessionTransportPullBookkeeping(prev, 'tab-switch-out');
    }
    lastActivatedSessionIdRef.current = id;
    core.setActiveSessionSync(id);
    core.resetSessionTransportPullBookkeeping(id, 'tab-switch-in');
    ensureActiveSessionFresh({
      sessionId: id,
      source: 'active-reentry',
      forceHead: true,
      markResumeTail: true,
      allowReconnectIfUnavailable: true,
    });
  };

  const sessionPublicFacadeRuntime = useMemo(() => createSessionPublicFacadeRuntime({
    stateRef: options.stateRef,
    scheduleStatesRef: options.scheduleStatesRef,
    sessionVisibleRangeRef,
    sessionBufferHeadsRef,
    readSessionTransportSocket: core.readSessionTransportSocket,
    sendSocketPayload: core.sendSocketPayload,
    setScheduleStateForSession: core.setScheduleStateForSession,
    readSessionBufferSnapshot: core.readSessionBufferSnapshot,
    requestSessionBufferSync: core.requestSessionBufferSync,
    ensureActiveSessionFresh,
    sendTerminalResize: core.sendTerminalResize,
    setLiveSessionIdsSync: core.setLiveSessionIdsSync,
    isSessionTransportActive: core.isSessionTransportActive,
    sessionDebugMetricsStoreRef,
  }), [
    core,
    ensureActiveSessionFresh,
    options.scheduleStatesRef,
    options.stateRef,
    sessionBufferHeadsRef,
    sessionDebugMetricsStoreRef,
    sessionVisibleRangeRef,
  ]);

  const {
    sendMessage,
    requestScheduleList,
    upsertScheduleJob,
    deleteScheduleJob,
    toggleScheduleJob,
    runScheduleJobNow,
    setLiveSessionIds,
    resumeActiveSessionTransport,
    sendTerminalResize,
    updateSessionViewport,
    getActiveSession,
    getSession,
    getSessionScheduleState,
    getSessionDebugMetrics,
    sendMessageRaw,
  } = sessionPublicFacadeRuntime;

  const sessionInteractionRuntime = useMemo(() => createSessionInteractionRuntime({
    refs: {
      stateRef: options.stateRef,
      remoteScreenshotRuntimeRef,
    },
    imagePasteReadyTimeoutMs: IMAGE_PASTE_READY_TIMEOUT_MS,
    runtimeDebug,
    readSessionTransportSocket: core.readSessionTransportSocket,
    sendSocketPayload: core.sendSocketPayload,
    markPendingInputTailRefresh: core.markPendingInputTailRefresh,
    readSessionBufferSnapshot: core.readSessionBufferSnapshot,
    requestSessionBufferHead: core.requestSessionBufferHead,
    isSessionTransportActivityStale: core.isSessionTransportActivityStale,
    isReconnectInFlight: core.isReconnectInFlight,
    probeOrReconnectStaleSessionTransport,
    hasPendingSessionTransportOpen: core.hasPendingSessionTransportOpen,
    isPendingSessionTransportOpenStale: core.isPendingSessionTransportOpenStale,
    shouldReconnectQueuedActiveInput,
    reconnectSession,
  }), [
    core,
    options.stateRef,
    probeOrReconnectStaleSessionTransport,
    reconnectSession,
    remoteScreenshotRuntimeRef,
  ]);

  const {
    sendInput,
    sendImagePaste,
    sendFileAttach,
    requestRemoteScreenshot,
  } = sessionInteractionRuntime;

  useSessionContextLifecycle({
    appForegroundActive: options.appForegroundActive,
    state: options.state,
    scheduleStates: options.scheduleStates,
    refs: {
      foregroundActiveRef,
      stateRef: options.stateRef,
      scheduleStatesRef: options.scheduleStatesRef,
      sessionDebugMetricsStoreRef,
      sessionPullStateRef,
      lastActivatedSessionIdRef,
      lastActiveReentryAtRef,
      lastConnectedBaselineAtRef,
      lastServerActivityAtRef: options.refs.lastServerActivityAtRef,
      remoteScreenshotRuntimeRef,
      pingIntervalsRef,
      handshakeTimeoutsRef,
      reconnectRuntimesRef,
      manualCloseRef,
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
    reconnectSession,
    reconnectAllSessions,
    setLiveSessionIds,
    resumeActiveSessionTransport,
    sendTerminalResize,
    sendMessage,
    sendInput,
    sendImagePaste,
    sendFileAttach,
    requestRemoteScreenshot,
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
    sendMessageRaw,
  }), [
    closeSession,
    createSession,
    deleteScheduleJob,
    getActiveSession,
    getSession,
    getSessionDebugMetrics,
    getSessionScheduleState,
    moveSession,
    options.scheduleStates,
    reconnectAllSessions,
    reconnectSession,
    renameSession,
    requestRemoteScreenshot,
    requestScheduleList,
    resumeActiveSessionTransport,
    runScheduleJobNow,
    sendFileAttach,
    sendImagePaste,
    sendInput,
    sendMessage,
    sendMessageRaw,
    setLiveSessionIds,
    switchSession,
    toggleScheduleJob,
    updateSessionViewport,
    upsertScheduleJob,
  ]);
}
