/**
 * SessionContext - 管理 Session 状态、重连和持久化
 */

import React, { createContext, useContext, useReducer, useRef } from 'react';
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
    sessionStore,
    scheduleStates,
    setScheduleStates,
    refs: {
      sessionDebugMetricsStoreRef,
      transportRuntimeStoreRef,
      sessionBufferStoreRef,
      sessionHeadStoreRef,
      pingIntervalsRef,
      handshakeTimeoutsRef,
      sessionVisibleRangeRef,
      lastPongAtRef,
      lastServerActivityAtRef,
      staleTransportProbeAtRef,
      viewportSizeRef,
      reconnectRuntimesRef,
      manualCloseRef,
      pendingInputQueueRef,
      lastActivatedSessionIdRef,
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
    getSessionHeadStore,
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
  } = useSessionProviderAssemblies({
    appForegroundActive,
    state,
    stateRef,
    dispatch,
    scheduleStates,
    scheduleStatesRef,
    sessionStore,
    setScheduleStates,
    bridgeSettings,
    terminalCacheLines,
    wsUrl,
    refs: {
      sessionDebugMetricsStoreRef,
      transportRuntimeStoreRef,
      sessionBufferStoreRef,
      sessionHeadStoreRef,
      pingIntervalsRef,
      handshakeTimeoutsRef,
      sessionVisibleRangeRef,
      lastPongAtRef,
      lastServerActivityAtRef,
      staleTransportProbeAtRef,
      viewportSizeRef,
      reconnectRuntimesRef,
      manualCloseRef,
      pendingInputQueueRef,
      lastActivatedSessionIdRef,
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

  const value: SessionContextValue = buildSessionContextValueRuntime({
    state,
    scheduleStates: assembledScheduleStates,
    getSessionDebugMetrics,
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
    getSessionRenderBufferSnapshot,
    getSessionBufferStore,
    getSessionHeadStore,
    onFileTransferMessage: (handler: (msg: any) => void) => {
      return fileTransferMessageRuntimeRef.current.subscribe(handler);
    },
    sendMessageRaw,
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
