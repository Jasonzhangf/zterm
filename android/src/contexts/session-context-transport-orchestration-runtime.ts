import type { Host, ServerMessage, Session, SessionScheduleState, TerminalWidthMode } from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type {
  QueueSessionTransportOpenIntentOptions,
  SessionReconnectRuntime,
} from './session-context-core';
import type {
  PendingSessionTransportOpenIntent,
} from './session-sync-helpers';
import {
  bindSessionTransportSocketLifecycleOrchestrationRuntime,
  cleanupControlSocketOrchestrationRuntime,
  ensureControlTransportForSessionOpenOrchestrationRuntime,
  failPendingControlTargetIntentsOrchestrationRuntime,
  handleControlTransportMessageOrchestrationRuntime,
  primeSessionTransportSocketRuntime,
} from './session-context-transport-lifecycle-runtime';
import {
  applyTransportOpenConnectedEffectsRuntime,
  applyTransportOpenLiveFailureEffectsRuntime,
  buildConnectTransportOpenIntentOptionsRuntime,
  buildReconnectTransportOpenIntentOptionsRuntime,
  cleanupSocketRuntime,
  clearReconnectForSessionRuntime,
  clearSupersededSocketsRuntime,
  handleReconnectBeforeConnectSendRuntime,
  handleReconnectHandshakeFailureRuntime,
  openSessionTransportByIntentRuntime,
  queueSessionTransportOpenIntentRuntime,
  queueTransportOpenIntentRuntime,
} from './session-context-transport-open-runtime';
import {
  computeReconnectDelay,
  createSessionReconnectRuntime,
} from './session-context-core';
import {
  shouldAutoReconnectSession,
} from './session-sync-helpers';
import {
  scheduleReconnectRuntime,
  startReconnectAttemptRuntime,
} from './session-context-session-runtime';

interface MutableRefObject<T> {
  current: T;
}

export function createSessionTransportOrchestrationRuntime(options: {
  stateRef: MutableRefObject<{ activeSessionId: string | null }>;
  terminalWidthMode: TerminalWidthMode;
  runtimeDebug: (event: string, payload?: Record<string, unknown>) => void;
  sessionHandshakeTimeoutMs: number;
  refs: {
    pendingSessionTransportOpenIntentsRef: MutableRefObject<Map<string, PendingSessionTransportOpenIntent>>;
    reconnectRuntimesRef: MutableRefObject<Map<string, SessionReconnectRuntime>>;
    manualCloseRef: MutableRefObject<Set<string>>;
    lastPongAtRef: MutableRefObject<Map<string, number>>;
    staleTransportProbeAtRef: MutableRefObject<Map<string, number>>;
    sessionDebugMetricsStoreRef: MutableRefObject<{
      recordRxBytes: (sessionId: string, data: string | ArrayBuffer) => void;
    }>;
    flushPendingInputQueueRef: MutableRefObject<((sessionId: string) => void) | null>;
    handleSocketServerMessageRef: MutableRefObject<((params: {
      sessionId: string;
      host: Host;
      ws: BridgeTransportSocket;
      debugScope: 'connect' | 'reconnect';
      onConnected: () => void;
      onFailure: (message: string, retryable: boolean) => void;
    }, msg: ServerMessage) => void) | null>;
    handleSocketConnectedBaselineRef: MutableRefObject<((options: {
      sessionId: string;
      sessionName: string;
      ws: BridgeTransportSocket;
    }) => void) | null>;
    finalizeSocketFailureBaselineRef: MutableRefObject<((options: {
      sessionId: string;
      message: string;
      markCompleted: () => boolean;
    }) => { shouldContinue: boolean; manualClosed: boolean }) | null>;
  };
  readSessionTargetControlSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionTargetRuntime: (sessionId: string) => { sessionIds: string[] } | null;
  readSessionTargetKey: (sessionId: string) => string | null;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionTransportToken: (sessionId: string) => string | null;
  readSessionTransportHost: (sessionId: string) => Host | null;
  writeSessionTransportToken: (sessionId: string, token: string | null) => string | null;
  writeSessionTargetControlSocket: (sessionId: string, socket: BridgeTransportSocket | null) => unknown;
  writeSessionTransportSocket: (sessionId: string, socket: BridgeTransportSocket | null) => unknown;
  moveSessionTransportSocketAside: (sessionId: string) => BridgeTransportSocket | null;
  drainSessionSupersededSockets: (sessionId: string) => BridgeTransportSocket[];
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
  clearHeartbeat: (sessionId: string) => void;
  clearSessionHandshakeTimeout: (sessionId: string) => void;
  setSessionHandshakeTimeout: (sessionId: string, callback: () => void, delayMs: number) => number;
  clearTailRefreshRuntime: (sessionId: string) => void;
  clearSessionPullState: (sessionId: string) => void;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  buildTraversalSocketForHost: (host: Host, transportRole?: 'control' | 'session') => BridgeTransportSocket;
  applyTransportDiagnostics: (sessionId: string, socket: BridgeTransportSocket) => void;
  recordSessionRx: (sessionId: string, data: string | ArrayBuffer) => void;
  flushRuntimeDebugLogs: () => void;
  startSocketHeartbeat: (
    sessionId: string,
    ws: BridgeTransportSocket,
    finalizeFailure: (message: string, retryable: boolean) => void,
  ) => void;
  setScheduleStateForSession: (
    sessionId: string,
    nextState: SessionScheduleState | ((current: SessionScheduleState) => SessionScheduleState),
  ) => void;
}) {
  const cleanupControlSocket = (sessionId: string, shouldClose = false) => {
    cleanupControlSocketOrchestrationRuntime({
      sessionId,
      shouldClose,
      readSessionTargetControlSocket: options.readSessionTargetControlSocket,
      writeSessionTargetControlSocket: options.writeSessionTargetControlSocket,
    });
  };

  const handleControlTransportMessage = (transportOptions: {
    sessionId: string;
    host: Host;
    ws: BridgeTransportSocket;
  }, msg: ServerMessage) => {
    handleControlTransportMessageOrchestrationRuntime({
      sessionId: transportOptions.sessionId,
      openSessionTransportByIntent,
      pendingSessionTransportOpenIntentsRef: options.refs.pendingSessionTransportOpenIntentsRef,
      clearSessionHandshakeTimeout: options.clearSessionHandshakeTimeout,
      writeSessionTransportToken: options.writeSessionTransportToken,
      msg,
    });
  };

  const failPendingControlTargetIntents = (sessionId: string, message: string, retryable: boolean) => {
    failPendingControlTargetIntentsOrchestrationRuntime({
      sessionId,
      message,
      retryable,
      readSessionTargetRuntime: options.readSessionTargetRuntime,
      pendingSessionTransportOpenIntentsRef: options.refs.pendingSessionTransportOpenIntentsRef,
      clearSessionHandshakeTimeout: options.clearSessionHandshakeTimeout,
      writeSessionTransportToken: options.writeSessionTransportToken,
    });
  };

  const ensureControlTransportForSessionOpen = (intent: PendingSessionTransportOpenIntent) => {
    ensureControlTransportForSessionOpenOrchestrationRuntime({
      intent,
      terminalWidthMode: options.terminalWidthMode,
      readSessionTargetControlSocket: options.readSessionTargetControlSocket,
      readSessionTargetRuntime: options.readSessionTargetRuntime,
      readSessionTargetKey: options.readSessionTargetKey,
      pendingSessionTransportOpenIntentsRef: options.refs.pendingSessionTransportOpenIntentsRef,
      sendSocketPayload: options.sendSocketPayload,
      clearSessionHandshakeTimeout: options.clearSessionHandshakeTimeout,
      setSessionHandshakeTimeout: options.setSessionHandshakeTimeout,
      failPendingControlTargetIntents,
      buildTraversalSocketForHost: options.buildTraversalSocketForHost,
      writeSessionTargetControlSocket: options.writeSessionTargetControlSocket,
      applyTransportDiagnostics: options.applyTransportDiagnostics,
      runtimeDebug: options.runtimeDebug,
      recordSessionRx: options.recordSessionRx,
      handleControlTransportMessage: ({ sessionId }, nextMsg) => {
        handleControlTransportMessage({
          sessionId,
          host: intent.host,
          ws: options.readSessionTargetControlSocket(sessionId)
            || options.buildTraversalSocketForHost(intent.host, 'control'),
        }, nextMsg);
      },
      cleanupControlSocket,
      sessionHandshakeTimeoutMs: options.sessionHandshakeTimeoutMs,
    });
  };

  const primeSessionTransportSocket = (sessionId: string, ws: BridgeTransportSocket) => {
    primeSessionTransportSocketRuntime({
      sessionId,
      ws,
      writeSessionTransportSocket: options.writeSessionTransportSocket,
      updateSessionSync: options.updateSessionSync,
      lastPongAtRef: options.refs.lastPongAtRef,
    });
  };

  const clearReconnectForSession = (sessionId: string) => {
    clearReconnectForSessionRuntime({
      sessionId,
      reconnectRuntimesRef: options.refs.reconnectRuntimesRef,
    });
  };

  const clearSupersededSockets = (sessionId: string, shouldClose = true) => {
    clearSupersededSocketsRuntime({
      sessionId,
      shouldClose,
      drainSessionSupersededSockets: options.drainSessionSupersededSockets,
    });
  };

  const cleanupSocket = (sessionId: string, shouldClose = false) => {
    cleanupSocketRuntime({
      sessionId,
      shouldClose,
      readSessionTransportSocket: options.readSessionTransportSocket,
      moveSessionTransportSocketAside: options.moveSessionTransportSocketAside,
      writeSessionTransportSocket: options.writeSessionTransportSocket,
      clearSupersededSockets,
      clearHeartbeat: options.clearHeartbeat,
      clearSessionHandshakeTimeout: options.clearSessionHandshakeTimeout,
      clearTailRefreshRuntime: options.clearTailRefreshRuntime,
      clearSessionPullState: options.clearSessionPullState,
      staleTransportProbeAtRef: options.refs.staleTransportProbeAtRef,
    });
  };

  const bindSessionTransportSocketLifecycle = (bindOptions: {
    sessionId: string;
    host: Host;
    ws: BridgeTransportSocket;
    debugScope: 'connect' | 'reconnect';
    activate?: boolean;
    finalizeFailure: (message: string, retryable: boolean) => void;
    onBeforeConnectSend?: (ctx: { sessionName: string }) => void;
    onConnected: () => void;
  }) => {
    bindSessionTransportSocketLifecycleOrchestrationRuntime({
      sessionId: bindOptions.sessionId,
      host: bindOptions.host,
      ws: bindOptions.ws,
      debugScope: bindOptions.debugScope,
      activate: bindOptions.activate,
      terminalWidthMode: options.terminalWidthMode,
      readActiveSessionId: () => options.stateRef.current.activeSessionId,
      readSessionTransportToken: options.readSessionTransportToken,
      sendSocketPayload: options.sendSocketPayload,
      runtimeDebug: options.runtimeDebug,
      flushRuntimeDebugLogs: options.flushRuntimeDebugLogs,
      startSocketHeartbeat: options.startSocketHeartbeat,
      applyTransportDiagnostics: options.applyTransportDiagnostics,
      clearSessionHandshakeTimeout: options.clearSessionHandshakeTimeout,
      setSessionHandshakeTimeout: options.setSessionHandshakeTimeout,
      recordSessionRx: (sessionId: string, data: string | ArrayBuffer) => {
        if (typeof data === 'string') {
          try {
            const parsed = JSON.parse(data) as ServerMessage;
            if (parsed.type === 'pong') {
              options.refs.sessionDebugMetricsStoreRef.current.recordRxBytes(sessionId, data);
              return;
            }
          } catch {
            // fall through to normal rx accounting
          }
        }
        options.recordSessionRx(sessionId, data);
      },
      handleSocketServerMessage: (params, msg) => {
        options.refs.handleSocketServerMessageRef.current?.(params, msg);
      },
      finalizeFailure: bindOptions.finalizeFailure,
      onBeforeConnectSend: bindOptions.onBeforeConnectSend,
      onConnected: bindOptions.onConnected,
      sessionHandshakeTimeoutMs: options.sessionHandshakeTimeoutMs,
    });
  };

  function openSessionTransportByIntent(intent: PendingSessionTransportOpenIntent) {
    openSessionTransportByIntentRuntime({
      intent,
      readSessionTransportToken: options.readSessionTransportToken,
      cleanupSocket,
      buildTraversalSocketForHost: options.buildTraversalSocketForHost,
      runtimeDebug: options.runtimeDebug,
      primeSessionTransportSocket,
      bindSessionTransportSocketLifecycle,
      writeSessionTransportToken: options.writeSessionTransportToken,
    });
  }

  const startReconnectAttempt = (sessionId: string) => {
    startReconnectAttemptRuntime({
      sessionId,
      refs: {
        manualCloseRef: options.refs.manualCloseRef,
        reconnectRuntimesRef: options.refs.reconnectRuntimesRef,
      },
      readSessionTransportHost: options.readSessionTransportHost,
      computeReconnectDelay,
      updateSessionSync: options.updateSessionSync,
      writeSessionTransportToken: options.writeSessionTransportToken,
      queueReconnectTransportOpenIntent,
    });
  };

  const scheduleReconnect = (
    sessionId: string,
    message: string,
    retryable = true,
    reconnectOptions?: { immediate?: boolean; resetAttempt?: boolean; force?: boolean },
  ) => {
    scheduleReconnectRuntime({
      sessionId,
      message,
      retryable,
      reconnectOptions,
      refs: {
        manualCloseRef: options.refs.manualCloseRef,
        reconnectRuntimesRef: options.refs.reconnectRuntimesRef,
        stateRef: options.stateRef as MutableRefObject<{ sessions: Session[]; activeSessionId: string | null }>,
      },
      readSessionTransportHost: options.readSessionTransportHost,
      shouldAutoReconnectSessionFn: shouldAutoReconnectSession,
      createSessionReconnectRuntime,
      updateSessionSync: options.updateSessionSync,
      emitSessionStatus,
      startReconnectAttempt,
    });
  };

  const queueSessionTransportOpenIntent = (intentOptions: QueueSessionTransportOpenIntentOptions) => {
    queueSessionTransportOpenIntentRuntime({
      intentOptions,
      clearSessionHandshakeTimeout: options.clearSessionHandshakeTimeout,
      finalizeSocketFailureBaseline: (baselineOptions) => {
        const result = options.refs.finalizeSocketFailureBaselineRef.current?.(baselineOptions);
        if (!result) {
          throw new Error('finalizeSocketFailureBaseline handler unavailable');
        }
        return result;
      },
      pendingSessionTransportOpenIntentsRef: options.refs.pendingSessionTransportOpenIntentsRef,
      ensureControlTransportForSessionOpen,
    });
  };

  const applyTransportOpenConnectedEffects = (connectedOptions: {
    sessionId: string;
    debugScope: 'connect' | 'reconnect';
    sessionName: string;
    ws: BridgeTransportSocket;
  }) => {
    applyTransportOpenConnectedEffectsRuntime({
      ...connectedOptions,
      runtimeDebug: options.runtimeDebug,
      activeSessionId: options.stateRef.current.activeSessionId,
      clearSupersededSockets,
      handleSocketConnectedBaseline: (connectedOptions) => {
        options.refs.handleSocketConnectedBaselineRef.current?.(connectedOptions);
      },
      flushPendingInputQueue: (sessionId) => {
        options.refs.flushPendingInputQueueRef.current?.(sessionId);
      },
    });
  };

  const applyTransportOpenLiveFailureEffects = (failureOptions: {
    sessionId: string;
    debugScope: 'connect' | 'reconnect';
    message: string;
    retryable: boolean;
  }) => {
    applyTransportOpenLiveFailureEffectsRuntime({
      ...failureOptions,
      cleanupSocket,
      pendingSessionTransportOpenIntentsRef: options.refs.pendingSessionTransportOpenIntentsRef,
      writeSessionTransportToken: options.writeSessionTransportToken,
      clearSupersededSockets,
      setScheduleStateForSession: options.setScheduleStateForSession,
      scheduleReconnect,
    });
  };

  const handleReconnectBeforeConnectSend = (sessionId: string, sessionName: string) => {
    handleReconnectBeforeConnectSendRuntime({
      sessionId,
      sessionName,
      updateSessionSync: options.updateSessionSync,
      setScheduleStateForSession: options.setScheduleStateForSession,
    });
  };

  const handleReconnectHandshakeFailure = (failureOptions: {
    sessionId: string;
    message: string;
    retryable: boolean;
  }) => {
    handleReconnectHandshakeFailureRuntime({
      ...failureOptions,
      reconnectRuntimesRef: options.refs.reconnectRuntimesRef,
      clearSupersededSockets,
      updateSessionSync: options.updateSessionSync,
      emitSessionStatus,
      createSessionReconnectRuntime,
      startReconnectAttempt,
    });
  };

  const buildReconnectTransportOpenIntentOptions = (
    sessionId: string,
    host: Host,
  ): QueueSessionTransportOpenIntentOptions => {
    return buildReconnectTransportOpenIntentOptionsRuntime({
      sessionId,
      host,
      handleReconnectBeforeConnectSend,
      handleReconnectHandshakeFailure,
      applyTransportOpenLiveFailureEffects,
      reconnectRuntimesRef: options.refs.reconnectRuntimesRef,
      applyTransportOpenConnectedEffects,
    });
  };

  const buildConnectTransportOpenIntentOptions = (
    sessionId: string,
    host: Host,
    activate: boolean,
  ): QueueSessionTransportOpenIntentOptions => {
    return buildConnectTransportOpenIntentOptionsRuntime({
      sessionId,
      host,
      activate,
      applyTransportOpenLiveFailureEffects,
      scheduleReconnect,
      applyTransportOpenConnectedEffects,
    });
  };

  function queueReconnectTransportOpenIntent(sessionId: string, host: Host) {
    queueTransportOpenIntentRuntime({
      sessionId,
      host,
      mode: 'reconnect',
      queueSessionTransportOpenIntent,
      buildReconnectTransportOpenIntentOptions,
      buildConnectTransportOpenIntentOptions,
    });
  }

  const queueConnectTransportOpenIntent = (sessionId: string, host: Host, activate: boolean) => {
    queueTransportOpenIntentRuntime({
      sessionId,
      host,
      activate,
      mode: 'connect',
      queueSessionTransportOpenIntent,
      buildReconnectTransportOpenIntentOptions,
      buildConnectTransportOpenIntentOptions,
    });
  };

  return {
    cleanupControlSocket,
    primeSessionTransportSocket,
    clearReconnectForSession,
    clearSupersededSockets,
    cleanupSocket,
    scheduleReconnect,
    queueConnectTransportOpenIntent,
  };
}

function emitSessionStatus(sessionId: string, type: 'closed' | 'error', message?: string) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('zterm:session-status', { detail: { sessionId, type, message } }));
}
