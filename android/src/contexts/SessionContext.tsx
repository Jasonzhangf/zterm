/**
 * SessionContext - 管理 Session 状态、重连和持久化
 */

import React, { createContext, useContext, useMemo, useReducer, useRef } from 'react';
import type {
  SessionScheduleState,
} from '../lib/types';
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
export { shouldReconnectActivatedSession, shouldReconnectQueuedActiveInput } from './session-sync-helpers';

const SESSION_STATUS_EVENT = 'zterm:session-status';

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({
  children,
  wsUrl,
  terminalCacheLines = DEFAULT_TERMINAL_CACHE_LINES,
  bridgeSettings = DEFAULT_BRIDGE_SETTINGS,
  appForegroundActive,
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
      pingIntervalsRef,
      handshakeTimeoutsRef,
      sessionVisibleRangeRef,
      lastPongAtRef,
      lastServerActivityAtRef,
      staleTransportProbeAtRef,
      reconnectRuntimesRef,
      manualCloseRef,
      pendingInputQueueRef,
      lastActivatedSessionIdRef,
      lastActiveReentryAtRef,
      sessionBufferHeadsRef,
      sessionRevisionResetRef,
      pendingInputTailRefreshRef,
      pendingConnectTailRefreshRef,
      pendingResumeTailRefreshRef,
      lastHeadRequestAtRef,
      sessionPullStateRef,
      sessionAttachTokensRef,
      pendingSessionTransportOpenIntentsRef,
      remoteScreenshotRuntimeRef,
      fileTransferMessageRuntimeRef,
      foregroundActiveRef,
      handleSocketConnectedBaselineRef,
      finalizeSocketFailureBaselineRef,
      flushPendingInputQueueRef,
      handleSocketServerMessageRef,
    },
  } = useSessionProviderRuntime({
    appForegroundActive,
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
    resumeActiveSessionTransport,
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
  } = useSessionProviderAssemblies({
    appForegroundActive,
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
      pingIntervalsRef,
      handshakeTimeoutsRef,
      sessionVisibleRangeRef,
      lastPongAtRef,
      lastServerActivityAtRef,
      staleTransportProbeAtRef,
      reconnectRuntimesRef,
      manualCloseRef,
      pendingInputQueueRef,
      lastActivatedSessionIdRef,
      lastActiveReentryAtRef,
      sessionBufferHeadsRef,
      sessionRevisionResetRef,
      pendingInputTailRefreshRef,
      pendingConnectTailRefreshRef,
      pendingResumeTailRefreshRef,
      lastHeadRequestAtRef,
      sessionPullStateRef,
      sessionAttachTokensRef,
      pendingSessionTransportOpenIntentsRef,
      remoteScreenshotRuntimeRef,
      fileTransferMessageRuntimeRef,
      foregroundActiveRef,
      handleSocketConnectedBaselineRef,
      finalizeSocketFailureBaselineRef,
      flushPendingInputQueueRef,
      handleSocketServerMessageRef,
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
    resumeActiveSessionTransport,
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
    getSessionRenderBufferSnapshot,
    getSessionBufferStore,
    getSessionRenderBufferStore,
    getSessionHeadStore,
    sendMessageRaw,
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
    resumeActiveSessionTransport,
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
    getSessionRenderBufferSnapshot,
    getSessionBufferStore,
    getSessionRenderBufferStore,
    getSessionHeadStore,
    sendMessageRaw,
  };

  const stableFacade = useMemo(() => ({
    getSessionDebugMetrics: (sessionId: string) => contextRuntimeRef.current.getSessionDebugMetrics(sessionId),
    createSession: (...args: Parameters<typeof createSession>) => contextRuntimeRef.current.createSession(...args),
    closeSession: (id: string) => contextRuntimeRef.current.closeSession(id),
    switchSession: (id: string) => contextRuntimeRef.current.switchSession(id),
    moveSession: (id: string, toIndex: number) => contextRuntimeRef.current.moveSession(id, toIndex),
    renameSession: (id: string, name: string) => contextRuntimeRef.current.renameSession(id, name),
    reconnectSession: (id: string) => contextRuntimeRef.current.reconnectSession(id),
    reconnectAllSessions: () => contextRuntimeRef.current.reconnectAllSessions(),
    setLiveSessionIds: (ids: string[]) => contextRuntimeRef.current.setLiveSessionIds(ids),
    resumeActiveSessionTransport: (id: string) => contextRuntimeRef.current.resumeActiveSessionTransport(id),
    sendMessage: (sessionId: string, msg: Parameters<typeof sendMessage>[1]) => (
      contextRuntimeRef.current.sendMessage(sessionId, msg)
    ),
    sendInput: (sessionId: string, data: string) => contextRuntimeRef.current.sendInput(sessionId, data),
    sendImagePaste: (sessionId: string, file: File) => contextRuntimeRef.current.sendImagePaste(sessionId, file),
    sendFileAttach: (sessionId: string, file: File) => contextRuntimeRef.current.sendFileAttach(sessionId, file),
    requestRemoteScreenshot: (
      sessionId: string,
      onProgress?: Parameters<typeof requestRemoteScreenshot>[1],
    ) => contextRuntimeRef.current.requestRemoteScreenshot(sessionId, onProgress),
    updateSessionViewport: (
      sessionId: string,
      visibleRange: Parameters<typeof updateSessionViewport>[1],
    ) => contextRuntimeRef.current.updateSessionViewport(sessionId, visibleRange),
    requestScheduleList: (sessionId: string) => contextRuntimeRef.current.requestScheduleList(sessionId),
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
    sendMessageRaw: (sessionId: string, msg: unknown) => contextRuntimeRef.current.sendMessageRaw(sessionId, msg),
  }), [fileTransferMessageRuntimeRef]);

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
