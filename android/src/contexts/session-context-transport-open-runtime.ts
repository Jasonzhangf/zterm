import { getResolvedSessionName } from '../lib/connection-target';
import type { Host, Session, SessionScheduleState } from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type {
  QueueSessionTransportOpenIntent,
  QueueSessionTransportOpenIntentOptions,
  SessionReconnectRuntime,
} from './session-context-core';
import {
  buildReconnectHandshakeFailurePlan,
  buildSessionConnectingLabelUpdates,
  buildSessionErrorUpdates,
  buildSessionReconnectingFailureUpdates,
  buildSessionScheduleErrorState,
  buildSessionScheduleLoadingState,
  buildTransportOpenConnectedEffectPlan,
  buildTransportOpenLiveFailureEffectPlan,
  createPendingSessionTransportOpenIntent,
  type PendingSessionTransportOpenIntent,
} from './session-sync-helpers';

interface MutableRefObject<T> {
  current: T;
}

export function clearReconnectForSessionRuntime(options: {
  sessionId: string;
  reconnectRuntimesRef: MutableRefObject<Map<string, SessionReconnectRuntime>>;
}) {
  const reconnectRuntime = options.reconnectRuntimesRef.current.get(options.sessionId);
  if (!reconnectRuntime) {
    return;
  }
  if (reconnectRuntime.timer) {
    clearTimeout(reconnectRuntime.timer);
  }
  options.reconnectRuntimesRef.current.delete(options.sessionId);
}

export function clearSupersededSocketsRuntime(options: {
  sessionId: string;
  shouldClose?: boolean;
  drainSessionSupersededSockets: (sessionId: string) => BridgeTransportSocket[];
}) {
  const superseded = options.drainSessionSupersededSockets(options.sessionId);
  if (superseded.length === 0) {
    return;
  }
  if (options.shouldClose) {
    for (const ws of superseded) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (ws.readyState < WebSocket.CLOSING) {
        ws.close();
      }
    }
  }
}

export function cleanupSocketRuntime(options: {
  sessionId: string;
  shouldClose?: boolean;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  moveSessionTransportSocketAside: (sessionId: string) => BridgeTransportSocket | null;
  writeSessionTransportSocket: (sessionId: string, socket: BridgeTransportSocket | null) => unknown;
  clearSupersededSockets: (sessionId: string, shouldClose?: boolean) => void;
  clearHeartbeat: (sessionId: string) => void;
  clearSessionHandshakeTimeout: (sessionId: string) => void;
  clearTailRefreshRuntime: (sessionId: string) => void;
  clearSessionPullState: (sessionId: string) => void;
  staleTransportProbeAtRef: MutableRefObject<Map<string, number>>;
}) {
  const ws = options.readSessionTransportSocket(options.sessionId);
  if (ws) {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    if (options.shouldClose && ws.readyState < WebSocket.CLOSING) {
      ws.close();
    } else if (!options.shouldClose) {
      options.moveSessionTransportSocketAside(options.sessionId);
    }
    options.writeSessionTransportSocket(options.sessionId, null);
  }

  if (options.shouldClose) {
    options.clearSupersededSockets(options.sessionId, true);
  }

  options.clearHeartbeat(options.sessionId);
  options.clearSessionHandshakeTimeout(options.sessionId);
  options.clearTailRefreshRuntime(options.sessionId);
  options.clearSessionPullState(options.sessionId);
  options.staleTransportProbeAtRef.current.delete(options.sessionId);
}

export function openSessionTransportByIntentRuntime(options: {
  intent: PendingSessionTransportOpenIntent;
  readSessionTransportToken: (sessionId: string) => string | null;
  cleanupSocket: (sessionId: string, shouldClose?: boolean) => void;
  buildTraversalSocketForHost: (host: Host, transportRole?: 'control' | 'session') => BridgeTransportSocket;
  runtimeDebug: (event: string, payload?: Record<string, unknown>) => void;
  primeSessionTransportSocket: (sessionId: string, ws: BridgeTransportSocket) => void;
  bindSessionTransportSocketLifecycle: (options: {
    sessionId: string;
    host: Host;
    resolvedSessionName: string;
    ws: BridgeTransportSocket;
    debugScope: 'connect' | 'reconnect';
    activate?: boolean;
    finalizeFailure: (message: string, retryable: boolean) => void;
    onBeforeConnectSend?: (ctx: { sessionName: string }) => void;
    onConnected: () => void;
  }) => void;
  writeSessionTransportToken: (sessionId: string, token: string | null) => string | null;
}) {
  const { sessionId, host, debugScope, activate, finalizeFailure, onBeforeConnectSend, onConnected } = options.intent;
  const sessionTransportToken = options.readSessionTransportToken(sessionId);
  if (!sessionTransportToken) {
    finalizeFailure('missing session transport token', true);
    return;
  }

  options.cleanupSocket(sessionId, false);
  const ws = options.buildTraversalSocketForHost(host, 'session');
  options.runtimeDebug(`session.ws.${debugScope}.opening`, {
    sessionId,
    host: host.bridgeHost,
    port: host.bridgePort,
    sessionName: getResolvedSessionName(host),
    activate: Boolean(activate),
  });
  options.primeSessionTransportSocket(sessionId, ws);

  options.bindSessionTransportSocketLifecycle({
    sessionId,
    host,
    resolvedSessionName: options.intent.resolvedSessionName,
    ws,
    debugScope,
    activate,
    finalizeFailure,
    onBeforeConnectSend,
    onConnected: () => {
      options.writeSessionTransportToken(sessionId, null);
      onConnected(ws);
    },
  });
}

export function queueSessionTransportOpenIntentRuntime(options: {
  intentOptions: QueueSessionTransportOpenIntentOptions;
  clearSessionHandshakeTimeout: (sessionId: string) => void;
  finalizeSocketFailureBaseline: (options: {
    sessionId: string;
    message: string;
    markCompleted: () => boolean;
  }) => { shouldContinue: boolean; manualClosed: boolean } | null | undefined;
  pendingSessionTransportOpenIntentsRef: MutableRefObject<Map<string, PendingSessionTransportOpenIntent>>;
  ensureControlTransportForSessionOpen: (intent: PendingSessionTransportOpenIntent) => void;
}) {
  const pendingIntent = createPendingSessionTransportOpenIntent({
    ...options.intentOptions,
    resolvedSessionName: getResolvedSessionName(options.intentOptions.host),
    clearHandshakeTimeout: () => options.clearSessionHandshakeTimeout(options.intentOptions.sessionId),
    finalizeSocketFailureBaseline: (baselineOptions) => (
      options.finalizeSocketFailureBaseline(baselineOptions) || null
    ),
  });

  options.pendingSessionTransportOpenIntentsRef.current.set(options.intentOptions.sessionId, pendingIntent);
  options.ensureControlTransportForSessionOpen(pendingIntent);
}

export function applyTransportOpenConnectedEffectsRuntime(options: {
  sessionId: string;
  debugScope: 'connect' | 'reconnect';
  sessionName: string;
  ws: BridgeTransportSocket;
  runtimeDebug: (event: string, payload?: Record<string, unknown>) => void;
  activeSessionId: string | null;
  clearSupersededSockets: (sessionId: string, shouldClose?: boolean) => void;
  handleSocketConnectedBaseline: (options: {
    sessionId: string;
    sessionName: string;
    ws: BridgeTransportSocket;
  }) => void;
  flushPendingInputQueue: (sessionId: string) => void;
}) {
  const connectedEffectPlan = buildTransportOpenConnectedEffectPlan(options.debugScope);
  options.runtimeDebug(connectedEffectPlan.debugEvent, {
    sessionId: options.sessionId,
    activeSessionId: options.activeSessionId,
  });
  if (connectedEffectPlan.clearSupersededSockets) {
    options.clearSupersededSockets(options.sessionId, true);
  }
  options.handleSocketConnectedBaseline({
    sessionId: options.sessionId,
    sessionName: options.sessionName,
    ws: options.ws,
  });
  if (connectedEffectPlan.flushPendingInputQueue) {
    options.flushPendingInputQueue(options.sessionId);
  }
}

export function applyTransportOpenLiveFailureEffectsRuntime(options: {
  sessionId: string;
  debugScope: 'connect' | 'reconnect';
  message: string;
  retryable: boolean;
  cleanupSocket: (sessionId: string, shouldClose?: boolean) => void;
  pendingSessionTransportOpenIntentsRef: MutableRefObject<Map<string, PendingSessionTransportOpenIntent>>;
  writeSessionTransportToken: (sessionId: string, token: string | null) => string | null;
  clearSupersededSockets: (sessionId: string, shouldClose?: boolean) => void;
  setScheduleStateForSession: (
    sessionId: string,
    nextState: SessionScheduleState | ((current: SessionScheduleState) => SessionScheduleState),
  ) => void;
  scheduleReconnect: (sessionId: string, message: string, retryable?: boolean) => void;
}) {
  const liveFailureEffectPlan = buildTransportOpenLiveFailureEffectPlan(options.debugScope);
  options.cleanupSocket(options.sessionId);
  if (liveFailureEffectPlan.clearPendingIntent) {
    options.pendingSessionTransportOpenIntentsRef.current.delete(options.sessionId);
  }
  if (liveFailureEffectPlan.clearTransportToken) {
    options.writeSessionTransportToken(options.sessionId, null);
  }
  if (liveFailureEffectPlan.clearSupersededSockets) {
    options.clearSupersededSockets(options.sessionId, true);
  }
  if (liveFailureEffectPlan.clearScheduleErrorState) {
    options.setScheduleStateForSession(
      options.sessionId,
      (current) => buildSessionScheduleErrorState(current, options.message),
    );
  }
  if (liveFailureEffectPlan.scheduleReconnect) {
    options.scheduleReconnect(options.sessionId, options.message, options.retryable);
  }
}

export function handleReconnectBeforeConnectSendRuntime(options: {
  sessionId: string;
  sessionName: string;
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
  setScheduleStateForSession: (
    sessionId: string,
    nextState: SessionScheduleState | ((current: SessionScheduleState) => SessionScheduleState),
  ) => void;
}) {
  options.updateSessionSync(options.sessionId, buildSessionConnectingLabelUpdates(options.sessionName));
  options.setScheduleStateForSession(options.sessionId, buildSessionScheduleLoadingState(options.sessionName));
}

export function handleReconnectHandshakeFailureRuntime(options: {
  sessionId: string;
  message: string;
  retryable: boolean;
  reconnectRuntimesRef: MutableRefObject<Map<string, SessionReconnectRuntime>>;
  clearSupersededSockets: (sessionId: string, shouldClose?: boolean) => void;
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
  emitSessionStatus: (sessionId: string, type: 'closed' | 'error', message?: string) => void;
  createSessionReconnectRuntime: () => SessionReconnectRuntime;
  startReconnectAttempt: (sessionId: string) => void;
}) {
  const currentReconnectRuntime = options.reconnectRuntimesRef.current.get(options.sessionId) || null;
  if (currentReconnectRuntime) {
    currentReconnectRuntime.connecting = false;
  }
  options.clearSupersededSockets(options.sessionId, true);
  const reconnectHandshakeFailurePlan = buildReconnectHandshakeFailurePlan({
    retryable: options.retryable,
    currentAttempt: currentReconnectRuntime?.attempt || 0,
  });
  if (reconnectHandshakeFailurePlan.action === 'terminal-error') {
    options.reconnectRuntimesRef.current.delete(options.sessionId);
    options.updateSessionSync(options.sessionId, buildSessionErrorUpdates(options.message));
    options.emitSessionStatus(options.sessionId, 'error', options.message);
    return;
  }
  const nextReconnectRuntime = options.reconnectRuntimesRef.current.get(options.sessionId) || options.createSessionReconnectRuntime();
  nextReconnectRuntime.attempt = reconnectHandshakeFailurePlan.nextAttempt;
  nextReconnectRuntime.connecting = false;
  options.reconnectRuntimesRef.current.set(options.sessionId, nextReconnectRuntime);
  options.updateSessionSync(
    options.sessionId,
    buildSessionReconnectingFailureUpdates(options.message, nextReconnectRuntime.attempt),
  );
  options.emitSessionStatus(options.sessionId, 'error', options.message);
  options.startReconnectAttempt(options.sessionId);
}

export function buildReconnectTransportOpenIntentOptionsRuntime(options: {
  sessionId: string;
  host: Host;
  handleReconnectBeforeConnectSend: (sessionId: string, sessionName: string) => void;
  handleReconnectHandshakeFailure: (options: {
    sessionId: string;
    message: string;
    retryable: boolean;
  }) => void;
  applyTransportOpenLiveFailureEffects: (options: {
    sessionId: string;
    debugScope: 'connect' | 'reconnect';
    message: string;
    retryable: boolean;
  }) => void;
  reconnectRuntimesRef: MutableRefObject<Map<string, SessionReconnectRuntime>>;
  applyTransportOpenConnectedEffects: (options: {
    sessionId: string;
    debugScope: 'connect' | 'reconnect';
    sessionName: string;
    ws: BridgeTransportSocket;
  }) => void;
}): QueueSessionTransportOpenIntentOptions {
  return {
    sessionId: options.sessionId,
    host: options.host,
    debugScope: 'reconnect',
    onBeforeConnectSend: ({ sessionName }) => {
      options.handleReconnectBeforeConnectSend(options.sessionId, sessionName);
    },
    onHandshakeFailure: (message, retryable, stage) => {
      if (stage === 'handshake') {
        options.handleReconnectHandshakeFailure({
          sessionId: options.sessionId,
          message,
          retryable,
        });
        return;
      }
      options.applyTransportOpenLiveFailureEffects({
        sessionId: options.sessionId,
        debugScope: 'reconnect',
        message,
        retryable,
      });
    },
    onHandshakeConnected: (ws, connectedSessionName) => {
      options.reconnectRuntimesRef.current.delete(options.sessionId);
      options.applyTransportOpenConnectedEffects({
        sessionId: options.sessionId,
        debugScope: 'reconnect',
        sessionName: connectedSessionName,
        ws,
      });
    },
  };
}

export function buildConnectTransportOpenIntentOptionsRuntime(options: {
  sessionId: string;
  host: Host;
  activate: boolean;
  applyTransportOpenLiveFailureEffects: (options: {
    sessionId: string;
    debugScope: 'connect' | 'reconnect';
    message: string;
    retryable: boolean;
  }) => void;
  scheduleReconnect: (sessionId: string, message: string, retryable?: boolean) => void;
  applyTransportOpenConnectedEffects: (options: {
    sessionId: string;
    debugScope: 'connect' | 'reconnect';
    sessionName: string;
    ws: BridgeTransportSocket;
  }) => void;
}): QueueSessionTransportOpenIntentOptions {
  return {
    sessionId: options.sessionId,
    host: options.host,
    debugScope: 'connect',
    activate: options.activate,
    onHandshakeFailure: (message, retryable, stage) => {
      if (stage === 'live') {
        options.applyTransportOpenLiveFailureEffects({
          sessionId: options.sessionId,
          debugScope: 'connect',
          message,
          retryable,
        });
        return;
      }
      options.scheduleReconnect(options.sessionId, message, retryable);
    },
    onHandshakeConnected: (ws, connectedSessionName) => {
      options.applyTransportOpenConnectedEffects({
        sessionId: options.sessionId,
        debugScope: 'connect',
        sessionName: connectedSessionName,
        ws,
      });
    },
  };
}

export function queueTransportOpenIntentRuntime(options: {
  sessionId: string;
  host: Host;
  activate?: boolean;
  mode: 'connect' | 'reconnect';
  queueSessionTransportOpenIntent: QueueSessionTransportOpenIntent;
  buildReconnectTransportOpenIntentOptions: (sessionId: string, host: Host) => QueueSessionTransportOpenIntentOptions;
  buildConnectTransportOpenIntentOptions: (
    sessionId: string,
    host: Host,
    activate: boolean,
  ) => QueueSessionTransportOpenIntentOptions;
}) {
  const intentOptions = options.mode === 'reconnect'
    ? options.buildReconnectTransportOpenIntentOptions(options.sessionId, options.host)
    : options.buildConnectTransportOpenIntentOptions(options.sessionId, options.host, Boolean(options.activate));
  options.queueSessionTransportOpenIntent(intentOptions);
}
