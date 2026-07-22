import type { Host, ServerMessage, Session, SessionScheduleState, TerminalWidthMode } from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import { getResolvedSessionName } from '../lib/connection-target';
import type {
  QueueSessionTransportOpenIntentOptions,
  SessionReconnectRuntime,
} from './session-context-core';
import type {
  PendingSessionTransportOpenIntent,
} from './session-transport-open-helpers';
import {
  buildTargetTransportHeartbeatKey,
} from './session-context-socket-runtime';
import {
  bindSessionTransportSocketLifecycleOrchestrationRuntime,
  primeSessionTransportSocketRuntime,
  sendTerminalResizeRuntime,
} from './session-context-transport-lifecycle-runtime';
import {
  bindTargetMuxTransportSocketLifecycleRuntime,
  handleTargetMuxServerFrameRuntime,
} from './session-context-transport-runtime';
import type { TerminalMuxTargetServerMessage } from '@zterm/shared/protocol';
import { createSessionControlTransportOrchestrationRuntime } from './session-context-transport-control-orchestration-runtime';
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
  openSessionMuxChannelByIntentRuntime,
  openSessionTransportByIntentRuntime,
  queueSessionTransportOpenIntentRuntime,
  queueTransportOpenIntentRuntime,
} from './session-context-transport-open-runtime';
import {
  computeReconnectDelay,
  createSessionReconnectRuntime,
} from './session-context-core';
import {
  hasSessionLocalWindow,
} from './session-buffer-planner-helpers';
import {
  shouldAutoReconnectSession,
} from './session-reconnect-helpers';
import {
  scheduleReconnectRuntime,
  startReconnectAttemptRuntime,
} from './session-context-session-runtime';
import {
  deletePendingSessionTransportOpenIntent,
  getPendingSessionTransportOpenIntent,
} from './session-context-open-intent-store';

interface MutableRefObject<T> {
  current: T;
}

export function handleTargetMuxTransportFailureRuntime(options: {
  anchorSessionId: string;
  message: string;
  readSessionTargetRuntime: (sessionId: string) => { key?: string; sessionIds: string[] } | null;
  readSessionTerminalChannel: (sessionId: string) => {
    state: 'opening' | 'open' | 'closing' | 'closed';
  } | null;
  writeSessionTerminalChannelState: (sessionId: string, state: 'closed') => unknown;
  writeSessionTargetTerminalSocket: (sessionId: string, socket: BridgeTransportSocket | null) => unknown;
  writeSessionTargetTerminalMuxReady: (sessionId: string, ready: boolean) => unknown;
  clearHeartbeat?: (sessionId: string, heartbeatOptions?: { heartbeatKey?: string }) => void;
  clearSessionHandshakeTimeout: (sessionId: string) => void;
  pendingSessionTransportOpenIntentsRef: MutableRefObject<Map<string, PendingSessionTransportOpenIntent>>;
  scheduleReconnect: (
    sessionId: string,
    message: string,
    retryable?: boolean,
    reconnectOptions?: { immediate?: boolean; resetAttempt?: boolean; force?: boolean },
  ) => void;
  runtimeDebug: (event: string, payload?: Record<string, unknown>) => void;
}) {
  const targetRuntime = options.readSessionTargetRuntime(options.anchorSessionId);
  const targetSessionIds = targetRuntime?.sessionIds?.length
    ? targetRuntime.sessionIds
    : [options.anchorSessionId];

  options.writeSessionTargetTerminalMuxReady(options.anchorSessionId, false);
  options.writeSessionTargetTerminalSocket(options.anchorSessionId, null);
  const targetKey = typeof targetRuntime?.key === 'string' ? targetRuntime.key : '';
  if (targetKey && options.clearHeartbeat) {
    options.clearHeartbeat(options.anchorSessionId, {
      heartbeatKey: buildTargetTransportHeartbeatKey(targetKey),
    });
  }

  for (const sessionId of targetSessionIds) {
    const channel = options.readSessionTerminalChannel(sessionId);
    if (channel && channel.state !== 'closed') {
      options.writeSessionTerminalChannelState(sessionId, 'closed');
    }

    const pending = getPendingSessionTransportOpenIntent(
      options.pendingSessionTransportOpenIntentsRef.current,
      sessionId,
    );
    if (pending) {
      options.clearSessionHandshakeTimeout(sessionId);
      deletePendingSessionTransportOpenIntent(options.pendingSessionTransportOpenIntentsRef.current, sessionId);
      pending.finalizeFailure(options.message, true);
      continue;
    }

    options.scheduleReconnect(sessionId, options.message, true, {
      immediate: true,
      resetAttempt: true,
    });
  }

  options.runtimeDebug('session.mux.target-transport-failed', {
    anchorSessionId: options.anchorSessionId,
    message: options.message,
    affectedSessionCount: targetSessionIds.length,
  });
}

export function createSessionTransportOrchestrationRuntime(options: {
  stateRef: MutableRefObject<{ sessions: Session[]; activeSessionId: string | null; liveSessionIds?: string[] }>;
  readSessionBufferSnapshot: (sessionId: string) => Session['buffer'];
  runtimeDebug: (event: string, payload?: Record<string, unknown>) => void;
  sessionHandshakeTimeoutMs: number;
  sessionTerminalReadyTimeoutMs?: number;
  refs: {
    pendingSessionTransportOpenIntentsRef: MutableRefObject<Map<string, PendingSessionTransportOpenIntent>>;
    reconnectRuntimesRef: MutableRefObject<Map<string, SessionReconnectRuntime>>;
    manualCloseRef: MutableRefObject<Set<string>>;
    lastPongAtRef: MutableRefObject<Map<string, number>>;
    lastServerActivityAtRef: MutableRefObject<Map<string, number>>;
    staleTransportProbeAtRef: MutableRefObject<Map<string, number>>;
    sessionDebugMetricsStoreRef: MutableRefObject<{
      recordRxBytes: (sessionId: string, data: string | ArrayBuffer) => void;
    }>;
    handleSocketServerMessageRef: MutableRefObject<((params: {
      sessionId: string;
      host: Host;
      ws: BridgeTransportSocket;
      debugScope: 'connect' | 'reconnect';
      rawFrameBytes?: number;
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
  readSessionTargetTerminalSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionTargetTerminalMuxReady: (sessionId: string) => boolean;
  readSessionTargetRuntime: (sessionId: string) => { key?: string; sessionIds: string[] } | null;
  readSessionTargetKey: (sessionId: string) => string | null;
  readSessionTerminalChannel: (sessionId: string) => {
    channelId: string;
    sessionId: string;
    sessionName: string;
    targetKey: string;
    state: 'opening' | 'open' | 'closing' | 'closed';
    bodySubscribed: boolean;
    openedAt: number;
    closedAt: number | null;
  } | null;
  readSessionIdForTerminalChannel: (anchorSessionId: string, channelId: string) => string | null;
  readOpeningSessionTerminalChannelsForTarget: (anchorSessionId: string) => Array<{
    channelId: string;
    sessionId: string;
    sessionName: string;
    targetKey: string;
    state: 'opening' | 'open' | 'closing' | 'closed';
    bodySubscribed: boolean;
    openedAt: number;
    closedAt: number | null;
  }>;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionTransportResource: (sessionId: string) => { socket: BridgeTransportSocket | null };
  readSessionTransportToken: (sessionId: string) => string | null;
  readSessionTransportHost: (sessionId: string) => Host | null;
  writeSessionTransportToken: (sessionId: string, token: string | null) => string | null;
  writeSessionTargetControlSocket: (sessionId: string, socket: BridgeTransportSocket | null) => unknown;
  writeSessionTargetTerminalSocket: (sessionId: string, socket: BridgeTransportSocket | null) => unknown;
  writeSessionTargetTerminalMuxReady: (sessionId: string, ready: boolean) => unknown;
  writeSessionTransportSocket: (sessionId: string, socket: BridgeTransportSocket | null) => unknown;
  ensureSessionTerminalChannel: (sessionId: string, options?: { channelId?: string; now?: number; bodySubscribed?: boolean }) => {
    channelId: string;
    sessionId: string;
    sessionName: string;
    targetKey: string;
    state: 'opening' | 'open' | 'closing' | 'closed';
    bodySubscribed: boolean;
    openedAt: number;
    closedAt: number | null;
  } | null;
  writeSessionTerminalChannelState: (sessionId: string, state: 'opening' | 'open' | 'closing' | 'closed') => {
    channelId: string;
    sessionId: string;
    sessionName: string;
    targetKey: string;
    state: 'opening' | 'open' | 'closing' | 'closed';
    bodySubscribed: boolean;
    openedAt: number;
    closedAt: number | null;
  } | null;
  moveSessionTransportSocketAside: (sessionId: string) => BridgeTransportSocket | null;
  drainSessionSupersededSockets: (sessionId: string) => BridgeTransportSocket[];
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
  clearHeartbeat: (sessionId: string, heartbeatOptions?: { heartbeatKey?: string }) => void;
  clearSessionHandshakeTimeout: (sessionId: string) => void;
  setSessionHandshakeTimeout: (sessionId: string, callback: () => void, delayMs: number) => number;
  clearTailRefreshRuntime: (sessionId: string) => void;
  clearSessionPullState: (sessionId: string) => void;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  buildTraversalSocketForHost: (host: Host, transportRole?: 'control' | 'session') => BridgeTransportSocket;
  applyTransportDiagnostics: (sessionId: string, socket: BridgeTransportSocket) => void;
  recordControlTransportRxBytes: (sessionId: string, data: string | ArrayBuffer) => void;
  recordSessionRx: (sessionId: string, data: string | ArrayBuffer) => void;
  flushRuntimeDebugLogs: () => void;
  startSocketHeartbeat: (
    sessionId: string,
    ws: BridgeTransportSocket,
    finalizeFailure: (message: string, retryable: boolean) => void,
    heartbeatOptions?: { heartbeatKey?: string },
  ) => void;
  setScheduleStateForSession: (
    sessionId: string,
    nextState: SessionScheduleState | ((current: SessionScheduleState) => SessionScheduleState),
  ) => void;
  readRequestedTerminalGeometry: (sessionId: string) => { cols?: number | null; rows?: number | null; widthMode?: TerminalWidthMode } | null;
  writeSessionRequestedTerminalGeometry: (sessionId: string, geometry: { cols?: number | null; rows?: number | null; widthMode?: TerminalWidthMode } | null) => unknown;
  handleTargetMuxMessage?: (payload: { requestId?: string; message: TerminalMuxTargetServerMessage }) => boolean;
}) {
  let openSessionTransportByIntentRef: ((intent: PendingSessionTransportOpenIntent) => void) | null = null;
  const controlTransportRuntime = createSessionControlTransportOrchestrationRuntime({
    refs: {
      pendingSessionTransportOpenIntentsRef: options.refs.pendingSessionTransportOpenIntentsRef,
    },
    readSessionTargetControlSocket: options.readSessionTargetControlSocket,
    readSessionTargetRuntime: options.readSessionTargetRuntime,
    readSessionTargetKey: options.readSessionTargetKey,
    writeSessionTransportToken: options.writeSessionTransportToken,
    writeSessionTargetControlSocket: options.writeSessionTargetControlSocket,
    clearSessionHandshakeTimeout: options.clearSessionHandshakeTimeout,
    setSessionHandshakeTimeout: options.setSessionHandshakeTimeout,
    sendSocketPayload: options.sendSocketPayload,
    buildTraversalSocketForHost: options.buildTraversalSocketForHost,
    applyTransportDiagnostics: options.applyTransportDiagnostics,
    runtimeDebug: options.runtimeDebug,
    recordControlTransportRxBytes: options.recordControlTransportRxBytes,
    openSessionTransportByIntent: (intent) => openSessionTransportByIntentRef?.(intent) || null,
    sessionHandshakeTimeoutMs: options.sessionHandshakeTimeoutMs,
  });
  const { cleanupControlSocket, ensureControlTransportForSessionOpen } = controlTransportRuntime;

  const primeSessionTransportSocket = (sessionId: string, ws: BridgeTransportSocket) => {
    primeSessionTransportSocketRuntime({
      sessionId,
      ws,
      writeSessionTransportSocket: options.writeSessionTransportSocket,
      updateSessionSync: options.updateSessionSync,
      lastPongAtRef: options.refs.lastPongAtRef,
    });
  };

  const primeTargetTerminalTransportSocket = (sessionId: string, ws: BridgeTransportSocket) => {
    options.writeSessionTargetTerminalSocket(sessionId, ws);
    options.writeSessionTargetTerminalMuxReady(sessionId, false);
    options.updateSessionSync(sessionId, { ws: null });
    const targetKey = options.readSessionTargetKey(sessionId);
    if (targetKey) {
      options.refs.lastPongAtRef.current.set(
        buildTargetTransportHeartbeatKey(targetKey),
        Date.now(),
      );
    }
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
    openRequestId: string;
    host: Host;
    ws: BridgeTransportSocket;
    debugScope: 'connect' | 'reconnect';
    finalizeFailure: (message: string, retryable: boolean) => void;
    onBeforeConnectSend?: (ctx: { sessionName: string }) => void;
    onConnected: () => void;
    onClosed?: (reason?: string) => void;
  }) => {
    bindSessionTransportSocketLifecycleOrchestrationRuntime({
      sessionId: bindOptions.sessionId,
      openRequestId: bindOptions.openRequestId,
      host: bindOptions.host,
      resolvedSessionName: getResolvedSessionName(bindOptions.host),
      ws: bindOptions.ws,
      debugScope: bindOptions.debugScope,
      readActiveSessionId: () => options.stateRef.current.activeSessionId,
      readSessionTransportSocket: options.readSessionTransportSocket,
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
      isSessionTransportActive: (sessionId: string) => (
        options.stateRef.current.activeSessionId === sessionId
        || Boolean(options.stateRef.current.liveSessionIds?.includes(sessionId))
      ),
      shouldAcceptSessionLiveBuffer: (sessionId: string) => {
        if (
          options.stateRef.current.activeSessionId === sessionId
          || Boolean(options.stateRef.current.liveSessionIds?.includes(sessionId))
        ) {
          return true;
        }
        const session = options.stateRef.current.sessions.find((candidate) => candidate.id === sessionId) || null;
        if (!session) {
          return false;
        }
        return !hasSessionLocalWindow(session, options.readSessionBufferSnapshot(sessionId));
      },
      handleSocketServerMessage: (params, msg) => {
        options.refs.handleSocketServerMessageRef.current?.(params, msg);
      },
      finalizeFailure: bindOptions.finalizeFailure,
      onBeforeConnectSend: bindOptions.onBeforeConnectSend,
      onConnected: bindOptions.onConnected,
      onClosed: bindOptions.onClosed,
      sessionHandshakeTimeoutMs: options.sessionHandshakeTimeoutMs,
      readRequestedTerminalGeometry: options.readRequestedTerminalGeometry,
    });
  };

  const buildMuxChannelCallbacks = (sessionId: string, ws: BridgeTransportSocket) => {
    const pending = getPendingSessionTransportOpenIntent(
      options.refs.pendingSessionTransportOpenIntentsRef.current,
      sessionId,
    );
    return {
      onChannelAllocated: () => {
        pending?.onChannelAllocated?.();
      },
      onConnected: () => {
        if (pending) {
          deletePendingSessionTransportOpenIntent(options.refs.pendingSessionTransportOpenIntentsRef.current, sessionId);
          pending.onConnected(ws);
          return;
        }
        const host = options.readSessionTransportHost(sessionId);
        options.refs.handleSocketConnectedBaselineRef.current?.({
          sessionId,
          sessionName: host ? getResolvedSessionName(host) : sessionId,
          ws,
        });
      },
      onFailure: (message: string, retryable: boolean) => {
        if (pending) {
          pending.finalizeFailure(message, retryable);
          return;
        }
        scheduleReconnect(sessionId, message, retryable);
      },
      onClosed: (reason?: string) => {
        if (pending) {
          deletePendingSessionTransportOpenIntent(options.refs.pendingSessionTransportOpenIntentsRef.current, sessionId);
          pending.onClosed?.(reason);
          return;
        }
        if (reason) {
          scheduleReconnect(sessionId, reason, true);
        }
      },
    };
  };

  const bindTargetMuxTransportSocketLifecycle = (bindOptions: {
    sessionId: string;
    host: Host;
    ws: BridgeTransportSocket;
    debugScope: 'connect' | 'reconnect';
    finalizeFailure: (message: string, retryable: boolean) => void;
  }) => {
    const targetKey = options.readSessionTargetKey(bindOptions.sessionId) || '';
    const targetHeartbeatKey = targetKey ? buildTargetTransportHeartbeatKey(targetKey) : '';
    bindTargetMuxTransportSocketLifecycleRuntime({
      sessionId: bindOptions.sessionId,
      targetHeartbeatKey,
      host: bindOptions.host,
      ws: bindOptions.ws,
      debugScope: bindOptions.debugScope,
      readSessionTargetTerminalSocket: options.readSessionTargetTerminalSocket,
      readRequestedTerminalGeometry: options.readRequestedTerminalGeometry,
      getOpeningSessionTerminalChannelsForTarget: options.readOpeningSessionTerminalChannelsForTarget,
      setSessionTargetMuxReady: options.writeSessionTargetTerminalMuxReady,
      sendSocketPayload: options.sendSocketPayload,
      applyTransportDiagnostics: options.applyTransportDiagnostics,
      startSocketHeartbeat: options.startSocketHeartbeat,
      recordTargetServerActivity: (heartbeatKey) => {
        options.refs.lastServerActivityAtRef.current.set(heartbeatKey, Date.now());
      },
      recordTargetPong: (heartbeatKey) => {
        options.refs.lastPongAtRef.current.set(heartbeatKey, Date.now());
      },
      runtimeDebug: options.runtimeDebug,
      finalizeFailure: (message) => {
        handleTargetMuxTransportFailureRuntime({
          anchorSessionId: bindOptions.sessionId,
          message,
          readSessionTargetRuntime: options.readSessionTargetRuntime,
          readSessionTerminalChannel: options.readSessionTerminalChannel,
          writeSessionTerminalChannelState: options.writeSessionTerminalChannelState,
          writeSessionTargetTerminalSocket: options.writeSessionTargetTerminalSocket,
          writeSessionTargetTerminalMuxReady: options.writeSessionTargetTerminalMuxReady,
          clearHeartbeat: options.clearHeartbeat,
          clearSessionHandshakeTimeout: options.clearSessionHandshakeTimeout,
          pendingSessionTransportOpenIntentsRef: options.refs.pendingSessionTransportOpenIntentsRef,
          scheduleReconnect,
          runtimeDebug: options.runtimeDebug,
        });
      },
      handleTargetMuxServerFrame: (frame, rawFrameBytes, rawFrameData) => {
        handleTargetMuxServerFrameRuntime({
          anchorSessionId: bindOptions.sessionId,
          host: bindOptions.host,
          ws: bindOptions.ws,
          debugScope: bindOptions.debugScope,
          rawFrameBytes,
          rawFrameData,
          frame,
          resolveSessionIdForChannel: (channelId) => options.readSessionIdForTerminalChannel(bindOptions.sessionId, channelId),
          readSessionTerminalChannelBodySubscribed: (sessionId) => (
            options.readSessionTerminalChannel(sessionId)?.bodySubscribed ?? null
          ),
          updateSessionTerminalChannelState: options.writeSessionTerminalChannelState,
          sendSocketPayload: options.sendSocketPayload,
          handleSocketServerMessage: (params, msg) => {
            options.refs.handleSocketServerMessageRef.current?.(params, msg);
          },
          buildChannelCallbacks: (sessionId) => buildMuxChannelCallbacks(sessionId, bindOptions.ws),
          handleTargetMuxMessage: options.handleTargetMuxMessage,
          recordSessionRx: options.recordSessionRx,
          runtimeDebug: options.runtimeDebug,
        });
      },
    });
  };

  function openSessionTransportByIntent(intent: PendingSessionTransportOpenIntent) {
    openSessionTransportByIntentRuntime({
      intent,
      readSessionTransportToken: options.readSessionTransportToken,
      readSessionTransportSocket: options.readSessionTransportSocket,
      readSessionTargetKey: options.readSessionTargetKey,
      cleanupSocket,
      buildTraversalSocketForHost: options.buildTraversalSocketForHost,
      runtimeDebug: options.runtimeDebug,
      primeSessionTransportSocket,
      bindSessionTransportSocketLifecycle,
      writeSessionTransportToken: options.writeSessionTransportToken,
    });
  }
  openSessionTransportByIntentRef = openSessionTransportByIntent;

  function openSessionMuxChannelByIntent(intent: PendingSessionTransportOpenIntent) {
    options.clearSessionHandshakeTimeout(intent.sessionId);
    options.setSessionHandshakeTimeout(intent.sessionId, () => {
      intent.finalizeFailure('terminal mux channel open timeout', true);
    }, options.sessionHandshakeTimeoutMs);
    openSessionMuxChannelByIntentRuntime({
      intent,
      readSessionTargetTerminalSocket: options.readSessionTargetTerminalSocket,
      isSessionTargetMuxReady: options.readSessionTargetTerminalMuxReady,
      ensureSessionTerminalChannel: options.ensureSessionTerminalChannel,
      isSessionBodySubscribed: (sessionId) => {
        const liveSessionIds = new Set(options.stateRef.current.liveSessionIds || []);
        return options.stateRef.current.activeSessionId === sessionId || liveSessionIds.has(sessionId);
      },
      updateSessionTerminalChannelState: options.writeSessionTerminalChannelState,
      readRequestedTerminalGeometry: options.readRequestedTerminalGeometry,
      sendSocketPayload: options.sendSocketPayload,
      buildTraversalSocketForHost: options.buildTraversalSocketForHost,
      primeTargetTerminalTransportSocket,
      bindTargetMuxTransportSocketLifecycle,
      runtimeDebug: options.runtimeDebug,
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
        stateRef: options.stateRef as MutableRefObject<{ sessions: Session[]; activeSessionId: string | null; liveSessionIds?: string[] }>,
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
    const terminalReadyTimeoutMs = options.sessionTerminalReadyTimeoutMs ?? options.sessionHandshakeTimeoutMs;
    queueSessionTransportOpenIntentRuntime({
      intentOptions: {
        ...intentOptions,
        onChannelAllocated: () => {
          intentOptions.onChannelAllocated?.();
          options.setSessionHandshakeTimeout(intentOptions.sessionId, () => {
            const pending = getPendingSessionTransportOpenIntent(
              options.refs.pendingSessionTransportOpenIntentsRef.current,
              intentOptions.sessionId,
            );
            pending?.finalizeFailure('terminal mux channel ready timeout', true);
          }, terminalReadyTimeoutMs);
        },
      },
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
      openSessionMuxChannelByIntent,
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
      shouldContinueRetryableReconnect: (sessionId) => shouldAutoReconnectSession({
        sessionId,
        activeSessionId: options.stateRef.current.activeSessionId,
        liveSessionIds: options.stateRef.current.liveSessionIds,
      }),
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
      emitSessionStatus,
      updateSessionSync: (_id, updates) => {
        options.updateSessionSync(_id, updates);
      },
    });
  };

  const buildConnectTransportOpenIntentOptions = (
    sessionId: string,
    host: Host,
  ): QueueSessionTransportOpenIntentOptions => {
    return buildConnectTransportOpenIntentOptionsRuntime({
      sessionId,
      host,
      applyTransportOpenLiveFailureEffects,
      scheduleReconnect,
      applyTransportOpenConnectedEffects,
      emitSessionStatus,
      updateSessionSync: (_id, updates) => {
        options.updateSessionSync(_id, updates);
      },
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

  const queueConnectTransportOpenIntent = (sessionId: string, host: Host) => {
    queueTransportOpenIntentRuntime({
      sessionId,
      host,
      
      mode: 'connect',
      queueSessionTransportOpenIntent,
      buildReconnectTransportOpenIntentOptions,
      buildConnectTransportOpenIntentOptions,
    });
  };

  const sendTerminalResize = (sessionId: string, cols?: number | null, rows?: number | null, widthMode?: TerminalWidthMode) => {
    return sendTerminalResizeRuntime({
      sessionId,
      ws: options.readSessionTransportResource(sessionId).socket || options.readSessionTransportSocket(sessionId),
      sendSocketPayload: options.sendSocketPayload,
      writeRequestedTerminalGeometry: options.writeSessionRequestedTerminalGeometry,
      cols,
      rows,
      widthMode,
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
    sendTerminalResize,
  };
}

function emitSessionStatus(sessionId: string, type: 'closed' | 'error', message?: string) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('zterm:session-status', { detail: { sessionId, type, message } }));
}
