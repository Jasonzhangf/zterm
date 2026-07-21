import type { MutableRefObject } from 'react';
import type { Host, Session, SessionBufferState, SessionScheduleState } from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type { CreateSessionOptions } from './session-context-core';
import {
  closeSessionRuntime,
  connectSessionRuntime,
  createSessionRuntime,
  type ReconnectSessionRuntimeOptions,
  reconnectAllSessionsRuntime,
  reconnectSessionRuntime,
  renameSessionRuntime,
} from './session-context-session-runtime';
import {
  ensureActiveSessionFreshRuntime,
} from './session-context-activity-runtime';

interface RuntimeDebugFn {
  (event: string, payload?: Record<string, unknown>): void;
}

interface SessionStateRef {
  current: {
    sessions: Session[];
    activeSessionId: string | null;
  };
}

interface SessionLifecycleRuntimeOptions {
  refs: {
    stateRef: SessionStateRef;
    manualCloseRef: MutableRefObject<Set<string>>;
    pendingSessionTransportOpenIntentsRef: MutableRefObject<Map<string, unknown>>;
    pendingInputTailRefreshRef: MutableRefObject<Map<string, { requestedAt: number; localRevision: number }>>;
    pendingConnectTailRefreshRef: MutableRefObject<Set<string>>;
    pendingResumeTailRefreshRef: MutableRefObject<Set<string>>;
    lastActiveReentryAtRef: MutableRefObject<Map<string, number>>;
    lastConnectedBaselineAtRef: MutableRefObject<Map<string, number>>;
    connectedBaselineBurstGuardRef: MutableRefObject<Set<string>>;
    reconnectRuntimesRef: MutableRefObject<Map<string, { connecting: boolean; timer: number | null }>>;
    sessionVisibleRangeRef: MutableRefObject<Map<string, unknown>>;
    sessionBufferStoreRef: MutableRefObject<{
      commitBuffer: (sessionId: string, buffer: SessionBufferState) => boolean;
      setBuffer: (sessionId: string, buffer: SessionBufferState) => void;
      deleteSession: (sessionId: string) => void;
    }>;
    sessionRenderGateRef: MutableRefObject<{
      deleteSession: (sessionId: string) => void;
    }>;
    sessionHeadStoreRef: MutableRefObject<{
      setHead: (sessionId: string, head: { daemonHeadRevision: number; daemonHeadEndIndex: number }) => boolean;
      deleteSession: (sessionId: string) => void;
    }>;
    sessionDebugMetricsStoreRef: MutableRefObject<{
      clearSession: (sessionId: string) => void;
    }>;
    lastServerActivityAtRef: MutableRefObject<Map<string, number>>;
    lastHeadRequestAtRef: MutableRefObject<Map<string, number>>;
    lastPongAtRef: MutableRefObject<Map<string, number>>;
    staleTransportProbeAtRef: MutableRefObject<Map<string, number>>;
  };
  runtimeDebug: RuntimeDebugFn;
  defaultViewport: {
    cols: number;
    rows: number;
  };
  activeTransportProbeWaitMs: number;
  resolveSessionCacheLines: (rows?: number | null) => number;
  createSessionSync: (session: Session) => void;
  deleteSessionSync: (id: string) => void;
  moveSessionSync: (id: string, toIndex: number) => void;
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
  setScheduleStates: React.Dispatch<React.SetStateAction<Record<string, SessionScheduleState>>>;
  setScheduleStateForSession: (
    sessionId: string,
    nextState: SessionScheduleState | ((current: SessionScheduleState) => SessionScheduleState),
  ) => void;
  clearReconnectForSession: (sessionId: string) => void;
  cleanupSocket: (sessionId: string, shouldClose?: boolean) => void;
  cleanupControlSocket: (sessionId: string, shouldClose?: boolean) => void;
  writeSessionTransportHost: (sessionId: string, host: Host) => unknown;
  writeSessionTransportToken: (sessionId: string, token: string | null) => string | null;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionTransportResource?: (sessionId: string) => { socket?: BridgeTransportSocket | null } | null;
  readSessionTransportHost: (sessionId: string) => Host | null;
  readSessionTransportRuntime: (sessionId: string) => { targetKey: string | null } | null;
  readSessionTargetRuntime: (sessionId: string) => { sessionIds: string[] } | null;
  readSessionTargetKey: (sessionId: string) => string | null;
  clearSessionTransportRuntime: (sessionId: string) => unknown;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  queueConnectTransportOpenIntent: (sessionId: string, host: Host) => void;
  scheduleReconnect: (
    sessionId: string,
    message: string,
    retryable?: boolean,
    options?: { immediate?: boolean; resetAttempt?: boolean; force?: boolean },
  ) => void;
  readSessionBufferSnapshot: (sessionId: string) => { revision: number; startIndex: number; endIndex: number };
  requestSessionBufferHead: (sessionId: string, ws?: BridgeTransportSocket | null, options?: { force?: boolean }) => boolean;
  resolveTerminalRefreshCadence: (sessionId?: string | null) => { headTickMs: number; headStalePingMs: number; pullRequestStaleMs: number };
  isSessionTransportActive: (sessionId: string) => boolean;
  isSessionTransportActivityStale: (sessionId: string) => boolean;
  isReconnectInFlight: (sessionId: string) => boolean;
  hasPendingSessionTransportOpen: (sessionId: string) => boolean;
  isPendingSessionTransportOpenStale: (sessionId: string, staleAfterMs?: number) => boolean;
  resetSessionTransportPullBookkeeping: (sessionId: string, reason: string) => void;
}

export function createSessionLifecycleRuntime(options: SessionLifecycleRuntimeOptions) {
  const connectSession = (sessionId: string, host: Host) => {
    connectSessionRuntime({
      sessionId,
      host,
      refs: {
        manualCloseRef: options.refs.manualCloseRef,
      },
      clearReconnectForSession: options.clearReconnectForSession,
      cleanupSocket: options.cleanupSocket,
      writeSessionTransportHost: options.writeSessionTransportHost,
      writeSessionTransportToken: options.writeSessionTransportToken,
      readSessionTransportSocket: options.readSessionTransportSocket,
      readSessionTargetKey: options.readSessionTargetKey,
      hasPendingSessionTransportOpen: options.hasPendingSessionTransportOpen,
      isPendingSessionTransportOpenStale: options.isPendingSessionTransportOpenStale,
      updateSessionSync: options.updateSessionSync,
      setScheduleStateForSession: options.setScheduleStateForSession,
      queueConnectTransportOpenIntent: options.queueConnectTransportOpenIntent,
    });
  };

  const createSession = (host: Host, createOptions?: CreateSessionOptions): string => {
    return createSessionRuntime({
      host,
      createOptions,
      refs: {
        stateRef: options.refs.stateRef,
        pendingSessionTransportOpenIntentsRef: options.refs.pendingSessionTransportOpenIntentsRef,
        sessionBufferStoreRef: options.refs.sessionBufferStoreRef,
        sessionHeadStoreRef: options.refs.sessionHeadStoreRef,
      },
      runtimeDebug: options.runtimeDebug,
      resolveSessionCacheLines: options.resolveSessionCacheLines,
      createSessionSync: options.createSessionSync,
      updateSessionSync: options.updateSessionSync,
      writeSessionTransportHost: options.writeSessionTransportHost,
      readSessionTransportSocket: options.readSessionTransportSocket,
      connectSession,
      defaultViewport: options.defaultViewport,
    });
  };

  const closeSession = (sessionId: string) => {
    closeSessionRuntime({
      sessionId,
      refs: {
        manualCloseRef: options.refs.manualCloseRef,
        pendingSessionTransportOpenIntentsRef: options.refs.pendingSessionTransportOpenIntentsRef,
        pendingInputTailRefreshRef: options.refs.pendingInputTailRefreshRef,
        pendingConnectTailRefreshRef: options.refs.pendingConnectTailRefreshRef,
        pendingResumeTailRefreshRef: options.refs.pendingResumeTailRefreshRef,
        lastActiveReentryAtRef: options.refs.lastActiveReentryAtRef,
        lastConnectedBaselineAtRef: options.refs.lastConnectedBaselineAtRef,
        sessionVisibleRangeRef: options.refs.sessionVisibleRangeRef,
        sessionBufferStoreRef: options.refs.sessionBufferStoreRef,
        sessionRenderGateRef: options.refs.sessionRenderGateRef,
        sessionHeadStoreRef: options.refs.sessionHeadStoreRef,
        sessionDebugMetricsStoreRef: options.refs.sessionDebugMetricsStoreRef,
      },
      clearReconnectForSession: options.clearReconnectForSession,
      readSessionTransportRuntime: options.readSessionTransportRuntime,
      readSessionTargetRuntime: options.readSessionTargetRuntime,
      readSessionTransportSocket: options.readSessionTransportSocket,
      sendSocketPayload: options.sendSocketPayload,
      runtimeDebug: options.runtimeDebug,
      cleanupSocket: options.cleanupSocket,
      cleanupControlSocket: options.cleanupControlSocket,
      writeSessionTransportToken: options.writeSessionTransportToken,
      clearSessionTransportRuntime: options.clearSessionTransportRuntime,
      setScheduleStates: options.setScheduleStates,
      deleteSessionSync: options.deleteSessionSync,
    });
  };

  const moveSession = (sessionId: string, toIndex: number) => {
    options.moveSessionSync(sessionId, toIndex);
  };

  const renameSession = (sessionId: string, name: string) => {
    renameSessionRuntime({
      sessionId,
      name,
      sessions: options.refs.stateRef.current.sessions,
      updateSessionSync: options.updateSessionSync,
    });
  };

  const reconnectSession = (sessionId: string, reconnectOptions?: ReconnectSessionRuntimeOptions) => {
    reconnectSessionRuntime({
      sessionId,
      reconnectOptions,
      refs: {
        stateRef: options.refs.stateRef,
        manualCloseRef: options.refs.manualCloseRef,
        pendingSessionTransportOpenIntentsRef: options.refs.pendingSessionTransportOpenIntentsRef,
      },
      clearReconnectForSession: options.clearReconnectForSession,
      readSessionTransportHost: options.readSessionTransportHost,
      readSessionTargetKey: options.readSessionTargetKey,
      readSessionTargetRuntime: options.readSessionTargetRuntime,
      readSessionTransportSocket: options.readSessionTransportSocket,
      hasPendingSessionTransportOpen: options.hasPendingSessionTransportOpen,
      isPendingSessionTransportOpenStale: options.isPendingSessionTransportOpenStale,
      runtimeDebug: options.runtimeDebug,
      cleanupSocket: options.cleanupSocket,
      cleanupControlSocket: options.cleanupControlSocket,
      writeSessionTransportHost: options.writeSessionTransportHost,
      updateSessionSync: options.updateSessionSync,
      scheduleReconnect: options.scheduleReconnect,
    });
  };

  const reconnectAllSessions = () => {
    reconnectAllSessionsRuntime({
      sessions: options.refs.stateRef.current.sessions,
      activeSessionId: options.refs.stateRef.current.activeSessionId,
      runtimeDebug: options.runtimeDebug,
      readSessionBufferSnapshot: options.readSessionBufferSnapshot,
      reconnectSession,
    });
  };

  const ensureActiveSessionFresh = (refreshOptions: {
    sessionId: string;
    source: 'explicit-resume' | 'active-reentry' | 'active-tick';
    forceHead?: boolean;
    markResumeTail?: boolean;
    allowReconnectIfUnavailable?: boolean;
  }) => {
    return ensureActiveSessionFreshRuntime({
      refreshOptions,
      refs: {
        stateRef: options.refs.stateRef,
        pendingResumeTailRefreshRef: options.refs.pendingResumeTailRefreshRef,
        lastActiveReentryAtRef: options.refs.lastActiveReentryAtRef,
        lastConnectedBaselineAtRef: options.refs.lastConnectedBaselineAtRef,
        connectedBaselineBurstGuardRef: options.refs.connectedBaselineBurstGuardRef,
        lastServerActivityAtRef: options.refs.lastServerActivityAtRef,
        lastHeadRequestAtRef: options.refs.lastHeadRequestAtRef,
        staleTransportProbeAtRef: options.refs.staleTransportProbeAtRef,
        reconnectRuntimesRef: options.refs.reconnectRuntimesRef,
      },
      readSessionTransportRuntime: options.readSessionTransportRuntime,
      readSessionTargetRuntime: options.readSessionTargetRuntime,
      readSessionTransportSocket: options.readSessionTransportSocket,
      readSessionTransportResource: options.readSessionTransportResource,
      isReconnectInFlight: options.isReconnectInFlight,
      hasPendingSessionTransportOpen: options.hasPendingSessionTransportOpen,
      isPendingSessionTransportOpenStale: options.isPendingSessionTransportOpenStale,
      isSessionTransportActivityStale: options.isSessionTransportActivityStale,
      runtimeDebug: options.runtimeDebug,
      updateSessionSync: options.updateSessionSync,
      readSessionBufferSnapshot: options.readSessionBufferSnapshot,
      resetSessionTransportPullBookkeeping: options.resetSessionTransportPullBookkeeping,
      requestSessionBufferHead: options.requestSessionBufferHead,
      resolveTerminalRefreshCadence: options.resolveTerminalRefreshCadence,
      reconnectSession,
    });
  };

  return {
    connectSession,
    createSession,
    closeSession,
    moveSession,
    renameSession,
    reconnectSession,
    reconnectAllSessions,
    ensureActiveSessionFresh,
  };
}
