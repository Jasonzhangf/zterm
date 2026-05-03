import { useMemo } from 'react';
import {
  ACTIVE_HEAD_REFRESH_TICK_MS,
} from '../lib/mobile-config';
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
} from './session-sync-helpers';
import type {
  SessionProviderAssembliesSharedOptions,
  SessionProviderCoreAssembliesResult,
} from './session-context-provider-assembly-types';

const IMAGE_PASTE_READY_TIMEOUT_MS = 6000;
const ACTIVE_TRANSPORT_PROBE_WAIT_MS = 1500;
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
    viewportSizeRef,
    pendingInputQueueRef,
    remoteScreenshotRuntimeRef,
    foregroundActiveRef,
    sessionPullStateRef,
    lastActivatedSessionIdRef,
    pingIntervalsRef,
    handshakeTimeoutsRef,
    reconnectRuntimesRef,
    manualCloseRef,
  } = options.refs;

  const sessionLifecycleRuntime = useMemo(() => createSessionLifecycleRuntime({
    refs: {
      stateRef: options.stateRef,
      manualCloseRef,
      pendingInputQueueRef,
      pendingSessionTransportOpenIntentsRef: options.refs.pendingSessionTransportOpenIntentsRef,
      viewportSizeRef,
      pendingInputTailRefreshRef: options.refs.pendingInputTailRefreshRef,
      pendingConnectTailRefreshRef: options.refs.pendingConnectTailRefreshRef,
      pendingResumeTailRefreshRef: options.refs.pendingResumeTailRefreshRef,
      sessionVisibleRangeRef,
      sessionBufferStoreRef: options.refs.sessionBufferStoreRef,
      sessionHeadStoreRef: options.refs.sessionHeadStoreRef,
      sessionDebugMetricsStoreRef,
      lastServerActivityAtRef: options.refs.lastServerActivityAtRef,
      staleTransportProbeAtRef: options.refs.staleTransportProbeAtRef,
    },
    runtimeDebug,
    defaultViewport: DEFAULT_TERMINAL_SESSION_VIEWPORT,
    activeTransportProbeWaitMs: ACTIVE_TRANSPORT_PROBE_WAIT_MS,
    resolveSessionCacheLines: core.resolveSessionCacheLines,
    createSessionSync: core.createSessionSync,
    setActiveSessionSync: core.setActiveSessionSync,
    deleteSessionSync: core.deleteSessionSync,
    moveSessionSync: core.moveSessionSync,
    updateSessionSync: core.updateSessionSync,
    setScheduleStates: options.setScheduleStates,
    setScheduleStateForSession: core.setScheduleStateForSession,
    clearReconnectForSession: core.clearReconnectForSession,
    cleanupSocket: core.cleanupSocket,
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
    isSessionTransportActive: core.isSessionTransportActive,
    isSessionTransportActivityStale: core.isSessionTransportActivityStale,
    isReconnectInFlight: core.isReconnectInFlight,
    hasPendingSessionTransportOpen: core.hasPendingSessionTransportOpen,
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
    pendingInputQueueRef,
    sessionDebugMetricsStoreRef,
    sessionVisibleRangeRef,
    viewportSizeRef,
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
    switchSession,
  } = sessionLifecycleRuntime;

  const sessionPublicFacadeRuntime = useMemo(() => createSessionPublicFacadeRuntime({
    stateRef: options.stateRef,
    scheduleStatesRef: options.scheduleStatesRef,
    sessionVisibleRangeRef,
    sessionBufferHeadsRef,
    viewportSizeRef,
    readSessionTransportSocket: core.readSessionTransportSocket,
    sendSocketPayload: core.sendSocketPayload,
    setScheduleStateForSession: core.setScheduleStateForSession,
    readSessionBufferSnapshot: core.readSessionBufferSnapshot,
    requestSessionBufferSync: core.requestSessionBufferSync,
    ensureActiveSessionFresh,
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
    viewportSizeRef,
  ]);

  const {
    sendMessage,
    requestScheduleList,
    upsertScheduleJob,
    deleteScheduleJob,
    toggleScheduleJob,
    runScheduleJobNow,
    resumeActiveSessionTransport,
    updateSessionViewport,
    resizeTerminal,
    setTerminalWidthMode,
    getActiveSession,
    getSession,
    getSessionScheduleState,
    getSessionDebugMetrics,
    sendMessageRaw,
  } = sessionPublicFacadeRuntime;

  const sessionInteractionRuntime = useMemo(() => createSessionInteractionRuntime({
    refs: {
      stateRef: options.stateRef,
      pendingInputQueueRef,
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
    shouldReconnectQueuedActiveInput,
    reconnectSession,
  }), [
    core,
    options.stateRef,
    pendingInputQueueRef,
    probeOrReconnectStaleSessionTransport,
    reconnectSession,
    remoteScreenshotRuntimeRef,
  ]);

  const {
    flushPendingInputQueue,
    sendInput,
    sendImagePaste,
    sendFileAttach,
    requestRemoteScreenshot,
  } = sessionInteractionRuntime;
  options.refs.flushPendingInputQueueRef.current = flushPendingInputQueue;

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
      remoteScreenshotRuntimeRef,
      pingIntervalsRef,
      handshakeTimeoutsRef,
      reconnectRuntimesRef,
      manualCloseRef,
    },
    flushRuntimeDebugLogs: core.flushRuntimeDebugLogs,
    clientRuntimeDebugFlushIntervalMs: CLIENT_RUNTIME_DEBUG_FLUSH_INTERVAL_MS,
    ensureActiveSessionFresh,
    activeHeadRefreshTickMs: ACTIVE_HEAD_REFRESH_TICK_MS,
    clearSessionHandshakeTimeout: core.clearSessionHandshakeTimeout,
    cleanupSocket: core.cleanupSocket,
    cleanupControlSocket: core.cleanupControlSocket,
  });

  return {
    scheduleStates: options.scheduleStates,
    createSession,
    closeSession,
    switchSession,
    moveSession,
    renameSession,
    reconnectSession,
    reconnectAllSessions,
    resumeActiveSessionTransport,
    sendMessage,
    sendInput,
    sendImagePaste,
    sendFileAttach,
    requestRemoteScreenshot,
    resizeTerminal,
    setTerminalWidthMode,
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
  };
}
