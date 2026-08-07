/**
 * SessionContext - 管理 Session 状态、重连和持久化
 */

import React, { createContext, useContext, useMemo, useReducer, useRef } from 'react';
import type {
  SessionScheduleState,
} from '../lib/types';
import type { RemoteWindowControlMessage } from '../lib/remote-window-message-runtime';
import type { SessionTargetNetworkSignal } from './session-context-target-network-probe-runtime';
import { DEFAULT_BRIDGE_SETTINGS } from '../lib/bridge-settings';
import {
  DEFAULT_TERMINAL_CACHE_LINES,
} from '../lib/mobile-config';
import {
  buildSessionContextValueRuntime,
} from './session-context-public-facade-runtime';
import {
  useSessionProviderRuntime,
} from './session-context-provider-runtime';
import {
  useSessionProviderAssemblies,
} from './session-context-provider-assemblies';
import {
  initialSessionManagerState,
  type SessionContextValue,
  type SessionProviderProps,
  sessionReducer,
} from './session-context-core';
export { shouldReconnectActivatedSession } from './session-transport-open-helpers';

const SESSION_STATUS_EVENT = 'zterm:session-status';

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({
  children,
  wsUrl,
  terminalCacheLines = DEFAULT_TERMINAL_CACHE_LINES,
  bridgeSettings = DEFAULT_BRIDGE_SETTINGS,
  appForegroundActive,
  foregroundResumeEpoch,
}: SessionProviderProps) {
  const [state, dispatch] = useReducer(sessionReducer, initialSessionManagerState);
  const stateRef = useRef(state);
  const scheduleStatesRef = useRef<Record<string, SessionScheduleState>>({});
  const {
    scheduleStates,
    setScheduleStates,
    refs: {
      sessionDebugMetricsStoreRef,
      transportRuntimeStoreRef,
      sessionBufferStoreRef,
      sessionRenderGateRef,
      sessionHeadStoreRef,
      sessionHeartbeatStoreRef,
      sessionReconnectStoreRef,
      targetNetworkProbeRuntimeRef,
      handshakeTimeoutsRef,
      sessionVisibleRangeRef,
      lastActivatedSessionIdRef,
      lastActiveReentryAtRef,
      lastConnectedBaselineAtRef,
      connectedBaselineBurstGuardRef,
      lastBackgroundEnteredAtRef,
      sessionRevisionResetRef,
      sessionTailRefreshStoreRef,
      lastHeadRequestAtRef,
      bufferFrameAssemblyRef,
      sessionPullStateRef,
      sessionAttachTokensRef,
      pendingSessionTransportOpenIntentsRef,
      tmuxTargetRequestsRef,
      activeBodySubscriptionSuppressedRef,
      remoteScreenshotRuntimeRef,
      remoteWindowTargetCatalogCacheRef,
      remoteWindowMessageRuntimeRef,
      remoteWindowReceiverRuntimeRef,
      fileTransferMessageRuntimeRef,
      foregroundActiveRef,
      handleSocketConnectedBaselineRef,
      finalizeSocketFailureBaselineRef,
      handleSocketServerMessageRef,
      attachmentStoreRef,
      attachmentFetchRuntimeRef,
    },
 } = useSessionProviderRuntime({
   appForegroundActive,
    bridgeSettings,
    wsUrl,
  });
  const {
    scheduleStates: assembledScheduleStates,
    getSessionRenderBufferSnapshot,
    getSessionBufferStore,
    getSessionRenderBufferStore,
    getSessionHeadStore,
    createSession,
    closeSession,
    switchSession,
    moveSession,
    renameSession,
    reconnectSession,
    reconnectAllSessions,
    setLiveSessionIds,
    setActiveBodySubscriptionSuppressed,
    resumeActiveSessionTransport,
    notifyTargetNetworkSignal,
    sendTerminalResize,
    sendMessage,
    sendInput,
    sendImagePaste,
    sendFileAttach,
    requestRemoteScreenshot,
    requestRemoteWindowTargets,
    requestRemoteWindowStreamStart,
    updateRemoteWindowStreamQuality,
    stopRemoteWindowStream,
    sendRemoteWindowInput,
    resizeRemoteWindowTarget,
    updateSessionViewport,
    requestScheduleList,
    manageTmuxSessionsOnOpenTransport,
    upsertScheduleJob,
    deleteScheduleJob,
    toggleScheduleJob,
    runScheduleJobNow,
    getSessionScheduleState,
    getActiveSession,
    getSession,
    getSessionDebugMetrics,
    sendMessageRaw,
  } = useSessionProviderAssemblies({
    appForegroundActive,
    foregroundResumeEpoch,
    state,
    stateRef,
    dispatch,
    scheduleStates,
    scheduleStatesRef,
    setScheduleStates,
    bridgeSettings,
    terminalCacheLines,
    wsUrl,
    refs: {
      sessionDebugMetricsStoreRef,
      transportRuntimeStoreRef,
      sessionBufferStoreRef,
      sessionRenderGateRef,
      sessionHeadStoreRef,
      sessionHeartbeatStoreRef,
      sessionReconnectStoreRef,
      targetNetworkProbeRuntimeRef,
      handshakeTimeoutsRef,
      sessionVisibleRangeRef,
      lastActivatedSessionIdRef,
      lastActiveReentryAtRef,
      lastConnectedBaselineAtRef,
      connectedBaselineBurstGuardRef,
      lastBackgroundEnteredAtRef,
      sessionRevisionResetRef,
      sessionTailRefreshStoreRef,
      lastHeadRequestAtRef,
      bufferFrameAssemblyRef,
      sessionPullStateRef,
      sessionAttachTokensRef,
      pendingSessionTransportOpenIntentsRef,
      tmuxTargetRequestsRef,
      activeBodySubscriptionSuppressedRef,
      remoteScreenshotRuntimeRef,
      remoteWindowTargetCatalogCacheRef,
      remoteWindowMessageRuntimeRef,
      remoteWindowReceiverRuntimeRef,
      fileTransferMessageRuntimeRef,
      foregroundActiveRef,
      handleSocketConnectedBaselineRef,
      finalizeSocketFailureBaselineRef,
      handleSocketServerMessageRef,
      attachmentStoreRef,
      attachmentFetchRuntimeRef,
    },
  });

  const contextRuntimeRef = useRef({
    getSessionDebugMetrics,
    createSession,
    closeSession,
    switchSession,
    moveSession,
    renameSession,
    reconnectSession,
    reconnectAllSessions,
    setLiveSessionIds,
    setActiveBodySubscriptionSuppressed,
    resumeActiveSessionTransport,
    notifyTargetNetworkSignal,
    sendTerminalResize,
    sendMessage,
    sendInput,
    sendImagePaste,
    sendFileAttach,
    requestRemoteScreenshot,
    requestRemoteWindowTargets,
    requestRemoteWindowStreamStart,
    updateRemoteWindowStreamQuality,
    stopRemoteWindowStream,
    sendRemoteWindowInput,
    resizeRemoteWindowTarget,
    updateSessionViewport,
    requestScheduleList,
    manageTmuxSessionsOnOpenTransport,
    upsertScheduleJob,
    deleteScheduleJob,
    toggleScheduleJob,
    runScheduleJobNow,
    getSessionScheduleState,
    getActiveSession,
    getSession,
    getSessionRenderBufferSnapshot,
    getSessionBufferStore,
    getSessionRenderBufferStore,
    getSessionHeadStore,
    onRemoteWindowMessage: (handler: (msg: RemoteWindowControlMessage) => void) => (
      remoteWindowMessageRuntimeRef.current.subscribe(handler)
    ),
    sendMessageRaw,
    getPendingAttachmentCount: () => attachmentStoreRef.current.getPendingCount(),
    getPendingAttachments: () => attachmentStoreRef.current.getAll(),
  });

  contextRuntimeRef.current = {
    getSessionDebugMetrics,
    createSession,
    closeSession,
    switchSession,
    moveSession,
    renameSession,
    reconnectSession,
    reconnectAllSessions,
    setLiveSessionIds,
    setActiveBodySubscriptionSuppressed,
    resumeActiveSessionTransport,
    notifyTargetNetworkSignal,
    sendTerminalResize,
    sendMessage,
    sendInput,
    sendImagePaste,
    sendFileAttach,
    requestRemoteScreenshot,
    requestRemoteWindowTargets,
    requestRemoteWindowStreamStart,
    updateRemoteWindowStreamQuality,
    stopRemoteWindowStream,
    sendRemoteWindowInput,
    resizeRemoteWindowTarget,
    updateSessionViewport,
    requestScheduleList,
    manageTmuxSessionsOnOpenTransport,
    upsertScheduleJob,
    deleteScheduleJob,
    toggleScheduleJob,
    runScheduleJobNow,
    getSessionScheduleState,
    getActiveSession,
    getSession,
    getSessionRenderBufferSnapshot,
    getSessionBufferStore,
    getSessionRenderBufferStore,
    getSessionHeadStore,
    onRemoteWindowMessage: (handler: (msg: RemoteWindowControlMessage) => void) => (
      remoteWindowMessageRuntimeRef.current.subscribe(handler)
    ),
    sendMessageRaw,
    getPendingAttachmentCount: () => attachmentStoreRef.current.getPendingCount(),
    getPendingAttachments: () => attachmentStoreRef.current.getAll(),
  };

  const stableFacade = useMemo(() => ({
    getSessionDebugMetrics: (sessionId: string) => contextRuntimeRef.current.getSessionDebugMetrics(sessionId),
    createSession: (...args: Parameters<typeof createSession>) => contextRuntimeRef.current.createSession(...args),
    closeSession: (id: string) => contextRuntimeRef.current.closeSession(id),
    switchSession: (id: string, options?: { refreshSource?: 'explicit-resume' | 'active-reentry' }) => (
      contextRuntimeRef.current.switchSession(id, options)
    ),
    moveSession: (id: string, toIndex: number) => contextRuntimeRef.current.moveSession(id, toIndex),
    renameSession: (id: string, name: string) => contextRuntimeRef.current.renameSession(id, name),
    reconnectSession: (id: string) => contextRuntimeRef.current.reconnectSession(id),
    reconnectAllSessions: () => contextRuntimeRef.current.reconnectAllSessions(),
    recordBackgroundEnteredAt: (sessionIds: string[], at: number) => {
      const now = at > 0 ? at : Date.now();
      for (const sessionId of sessionIds) {
        lastBackgroundEnteredAtRef.current.set(sessionId, now);
      }
    },
    setLiveSessionIds: (ids: string[]) => contextRuntimeRef.current.setLiveSessionIds(ids),
    setActiveBodySubscriptionSuppressed: (suppressed: boolean) => (
      contextRuntimeRef.current.setActiveBodySubscriptionSuppressed(suppressed)
    ),
    resumeActiveSessionTransport: (id: string) => contextRuntimeRef.current.resumeActiveSessionTransport(id),
    notifyTargetNetworkSignal: (
      signal: SessionTargetNetworkSignal,
    ) => contextRuntimeRef.current.notifyTargetNetworkSignal(signal),
    sendTerminalResize: (sessionId: string, cols?: number | null, rows?: number | null, widthMode?: 'adaptive-phone' | 'mirror-fixed') => (
      contextRuntimeRef.current.sendTerminalResize(sessionId, cols, rows, widthMode)
    ),
    sendMessage: (sessionId: string, msg: Parameters<typeof sendMessage>[1]) => (
      contextRuntimeRef.current.sendMessage(sessionId, msg)
    ),
    sendInput: (sessionId: string, data: string) => contextRuntimeRef.current.sendInput(sessionId, data),
    sendImagePaste: (sessionId: string, file: File) => contextRuntimeRef.current.sendImagePaste(sessionId, file),
    sendFileAttach: (sessionId: string, file: File) => contextRuntimeRef.current.sendFileAttach(sessionId, file),
    requestRemoteScreenshot: (
      sessionId: string,
      onProgress?: Parameters<typeof requestRemoteScreenshot>[1],
      request?: Parameters<typeof requestRemoteScreenshot>[2],
    ) => contextRuntimeRef.current.requestRemoteScreenshot(sessionId, onProgress, request),
    requestRemoteWindowTargets: (
      sessionId: string,
      options?: { forceRefresh?: boolean },
    ) => (
      contextRuntimeRef.current.requestRemoteWindowTargets(sessionId, options)
    ),
    requestRemoteWindowStreamStart: (...args: Parameters<typeof requestRemoteWindowStreamStart>) => (
      contextRuntimeRef.current.requestRemoteWindowStreamStart(...args)
    ),
    updateRemoteWindowStreamQuality: (...args: Parameters<typeof updateRemoteWindowStreamQuality>) => (
      contextRuntimeRef.current.updateRemoteWindowStreamQuality(...args)
    ),
    stopRemoteWindowStream: (sessionId: string, streamId: string) => (
      contextRuntimeRef.current.stopRemoteWindowStream(sessionId, streamId)
    ),
    sendRemoteWindowInput: (...args: Parameters<typeof sendRemoteWindowInput>) => (
      contextRuntimeRef.current.sendRemoteWindowInput(...args)
    ),
    resizeRemoteWindowTarget: (...args: Parameters<typeof resizeRemoteWindowTarget>) => (
      contextRuntimeRef.current.resizeRemoteWindowTarget(...args)
    ),
    updateSessionViewport: (
      sessionId: string,
      visibleRange: Parameters<typeof updateSessionViewport>[1],
    ) => contextRuntimeRef.current.updateSessionViewport(sessionId, visibleRange),
    requestScheduleList: (sessionId: string) => contextRuntimeRef.current.requestScheduleList(sessionId),
    manageTmuxSessionsOnOpenTransport: (
      sessionId: string,
      message: Parameters<typeof manageTmuxSessionsOnOpenTransport>[1],
    ) => contextRuntimeRef.current.manageTmuxSessionsOnOpenTransport(sessionId, message),
    upsertScheduleJob: (sessionId: string, job: Parameters<typeof upsertScheduleJob>[1]) => (
      contextRuntimeRef.current.upsertScheduleJob(sessionId, job)
    ),
    deleteScheduleJob: (sessionId: string, jobId: string) => contextRuntimeRef.current.deleteScheduleJob(sessionId, jobId),
    toggleScheduleJob: (sessionId: string, jobId: string, enabled: boolean) => (
      contextRuntimeRef.current.toggleScheduleJob(sessionId, jobId, enabled)
    ),
    runScheduleJobNow: (sessionId: string, jobId: string) => contextRuntimeRef.current.runScheduleJobNow(sessionId, jobId),
    getSessionScheduleState: (sessionId: string) => contextRuntimeRef.current.getSessionScheduleState(sessionId),
    getActiveSession: () => contextRuntimeRef.current.getActiveSession(),
    getSession: (id: string) => contextRuntimeRef.current.getSession(id),
    getSessionRenderBufferSnapshot: (sessionId: string) => contextRuntimeRef.current.getSessionRenderBufferSnapshot(sessionId),
    getSessionBufferStore: () => contextRuntimeRef.current.getSessionBufferStore(),
    getSessionRenderBufferStore: () => contextRuntimeRef.current.getSessionRenderBufferStore(),
    getSessionHeadStore: () => contextRuntimeRef.current.getSessionHeadStore(),
    onFileTransferMessage: (handler: (msg: any) => void) => {
      return fileTransferMessageRuntimeRef.current.subscribe(handler);
    },
    getPendingAttachmentCount: () => attachmentStoreRef.current.getPendingCount(),
    getPendingAttachments: () => attachmentStoreRef.current.getAll(),
    onRemoteWindowMessage: (handler: (msg: RemoteWindowControlMessage) => void) => {
      return remoteWindowMessageRuntimeRef.current.subscribe(handler);
    },
    sendMessageRaw: (sessionId: string, msg: unknown) => contextRuntimeRef.current.sendMessageRaw(sessionId, msg),
  }), [fileTransferMessageRuntimeRef, remoteWindowMessageRuntimeRef]);

  const value: SessionContextValue = buildSessionContextValueRuntime({
    state,
    scheduleStates: assembledScheduleStates,
    ...stableFacade,
  });

  return React.createElement(SessionContext.Provider, { value }, children);
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSession must be used within SessionProvider');
  }
  return context;
}

export { SESSION_STATUS_EVENT };
