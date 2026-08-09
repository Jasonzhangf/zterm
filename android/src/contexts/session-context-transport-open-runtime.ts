import { getResolvedSessionName } from '../lib/connection-target';
import type { ClientDaemonConnection } from '../lib/client-daemon-connection';
import type { SessionReconnectStore } from '../lib/session-reconnect-store';
import type { SessionTerminalChannelRuntime, SessionTerminalChannelState } from '../lib/session-transport-runtime';
import type { Host, Session, SessionScheduleState } from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import { sendSessionMuxChannelOpenRuntime } from './session-context-transport-runtime';
import type {
  QueueSessionTransportOpenIntent,
  QueueSessionTransportOpenIntentOptions,
} from './session-context-core';
import {
  buildReconnectHandshakeFailurePlan,
  buildSessionClosedUpdates,
  buildSessionConnectingLabelUpdates,
  buildSessionErrorUpdates,
  buildSessionIdleAfterReconnectBlockedUpdates,
  buildSessionReconnectingFailureUpdates,
  buildSessionScheduleErrorState,
  buildSessionScheduleLoadingState,
  buildTransportOpenConnectedEffectPlan,
  buildTransportOpenLiveFailureEffectPlan,
  createPendingSessionTransportOpenIntent,
  type PendingSessionTransportOpenIntent,
} from './session-transport-open-helpers';
import {
  deletePendingSessionTransportOpenIntent,
  setPendingSessionTransportOpenIntent,
} from './session-context-open-intent-store';

interface MutableRefObject<T> {
  current: T;
}

export function clearReconnectForSessionRuntime(options: {
  sessionId: string;
  reconnectStore: SessionReconnectStore;
}) {
  options.reconnectStore.deleteRuntime(options.sessionId);
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
  reconnectStore: SessionReconnectStore;
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
  options.reconnectStore.clearStaleTransportProbe(options.sessionId);
}

export function openSessionMuxChannelByIntentRuntime(options: {
  intent: PendingSessionTransportOpenIntent;
  daemonConnection: ClientDaemonConnection;
  readSessionTargetTerminalSocket: (sessionId: string) => BridgeTransportSocket | null;
  isSessionTargetMuxReady: (sessionId: string) => boolean;
  ensureSessionTerminalChannel: (
    sessionId: string,
    options?: { channelId?: string; now?: number; bodySubscribed?: boolean },
  ) => SessionTerminalChannelRuntime | null;
  isSessionBodySubscribed?: (sessionId: string) => boolean;
  updateSessionTerminalChannelState: (
    sessionId: string,
    state: SessionTerminalChannelState,
  ) => SessionTerminalChannelRuntime | null;
  readRequestedTerminalGeometry: (
    sessionId: string,
  ) => { cols?: number | null; rows?: number | null; widthMode?: 'adaptive-phone' | 'mirror-fixed' } | null;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  startHandshakeTimeout?: () => void;
  runtimeDebug: (event: string, payload?: Record<string, unknown>) => void;
}) {
  const { sessionId, host, debugScope, finalizeFailure } = options.intent;
  const channel = options.ensureSessionTerminalChannel(sessionId, {
    bodySubscribed: options.isSessionBodySubscribed
      ? options.isSessionBodySubscribed(sessionId)
      : true,
  });
  if (!channel) {
    finalizeFailure('terminal mux channel could not be created', true);
    return;
  }

  const markChannelOpening = () => {
    options.updateSessionTerminalChannelState(sessionId, 'opening');
  };

  const sendChannelOpen = (ws: BridgeTransportSocket) => {
    sendSessionMuxChannelOpenRuntime({
      sessionId,
      ws,
      channel,
      sessionName: options.intent.resolvedSessionName,
      host,
      geometry: options.readRequestedTerminalGeometry(sessionId),
      sendSocketPayload: options.sendSocketPayload,
    });
    options.runtimeDebug(`session.mux.${debugScope}.channel-open-sent`, {
      sessionId,
      channelId: channel.channelId,
      sessionName: options.intent.resolvedSessionName,
    });
  };

  const currentTargetSocket = options.daemonConnection.readSessionTargetSocket?.(sessionId)
    || options.readSessionTargetTerminalSocket(sessionId);
  if (currentTargetSocket?.readyState === WebSocket.OPEN) {
    // Socket is already open: the transport onopen (mux-hello) path may have
    // already started the handshake timeout, but starting (or resetting) it
    // here guarantees the mux negotiation window is bounded for this intent
    // even when this intent was queued against a pre-existing socket.
    options.startHandshakeTimeout?.();
    if (options.isSessionTargetMuxReady(sessionId)) {
      if (channel.state === 'open') {
        options.runtimeDebug(`session.mux.${debugScope}.channel-reuse`, {
          sessionId,
          channelId: channel.channelId,
        });
        options.intent.onConnected(currentTargetSocket);
        return;
      }
      markChannelOpening();
      sendChannelOpen(currentTargetSocket);
      return;
    }
    markChannelOpening();
    options.runtimeDebug(`session.mux.${debugScope}.wait-ready`, {
      sessionId,
      channelId: channel.channelId,
    });
    return;
  }
  if (currentTargetSocket?.readyState === WebSocket.CONNECTING) {
    markChannelOpening();
    options.runtimeDebug(`session.mux.${debugScope}.wait-connecting`, {
      sessionId,
      channelId: channel.channelId,
    });
    return;
  }

  markChannelOpening();
  if (!options.daemonConnection.openSessionTargetTransport) {
    finalizeFailure('client.daemon_connection target transport opener unavailable', true);
    return;
  }
  const ws = options.daemonConnection.openSessionTargetTransport({
    sessionId,
    host,
    debugScope,
    finalizeFailure,
  });
  options.runtimeDebug(`session.mux.${debugScope}.opening`, {
    sessionId,
    channelId: channel.channelId,
    host: host.bridgeHost,
    port: host.bridgePort,
    sessionName: getResolvedSessionName(host),
    readyState: ws.readyState,
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
  openSessionMuxChannelByIntent?: (intent: PendingSessionTransportOpenIntent) => void;
}) {
  options.clearSessionHandshakeTimeout(options.intentOptions.sessionId);
  const pendingIntent = createPendingSessionTransportOpenIntent({
    ...options.intentOptions,
    resolvedSessionName: getResolvedSessionName(options.intentOptions.host),
    clearHandshakeTimeout: () => options.clearSessionHandshakeTimeout(options.intentOptions.sessionId),
    finalizeSocketFailureBaseline: (baselineOptions) => (
      options.finalizeSocketFailureBaseline(baselineOptions) || null
    ),
  });

  setPendingSessionTransportOpenIntent(options.pendingSessionTransportOpenIntentsRef.current, pendingIntent);
  if (!options.openSessionMuxChannelByIntent) {
    deletePendingSessionTransportOpenIntent(
      options.pendingSessionTransportOpenIntentsRef.current,
      pendingIntent.sessionId,
    );
    pendingIntent.finalizeFailure('client.daemon_connection mux opener unavailable', true);
    return;
  }
  options.openSessionMuxChannelByIntent(pendingIntent);
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
    deletePendingSessionTransportOpenIntent(options.pendingSessionTransportOpenIntentsRef.current, options.sessionId);
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
  reconnectStore: SessionReconnectStore;
  clearSupersededSockets: (sessionId: string, shouldClose?: boolean) => void;
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
  emitSessionStatus: (sessionId: string, type: 'closed' | 'error', message?: string) => void;
  shouldContinueRetryableReconnect?: (sessionId: string) => boolean;
  startReconnectAttempt: (sessionId: string) => void;
}) {
  const currentReconnectRuntime = options.reconnectStore.read(options.sessionId);
  options.reconnectStore.clearTimer(options.sessionId);
  options.clearSupersededSockets(options.sessionId, true);
  const reconnectHandshakeFailurePlan = buildReconnectHandshakeFailurePlan({
    retryable: options.retryable,
    currentAttempt: currentReconnectRuntime?.attempt || 0,
  });
  if (reconnectHandshakeFailurePlan.action === 'terminal-error') {
    options.reconnectStore.deleteRuntime(options.sessionId);
    options.updateSessionSync(options.sessionId, buildSessionErrorUpdates(options.message));
    options.emitSessionStatus(options.sessionId, 'error', options.message);
    return;
  }
  if (options.shouldContinueRetryableReconnect && !options.shouldContinueRetryableReconnect(options.sessionId)) {
    options.reconnectStore.deleteRuntime(options.sessionId);
    options.updateSessionSync(options.sessionId, buildSessionIdleAfterReconnectBlockedUpdates(options.message));
    return;
  }
  const idleRuntime = {
    ...options.reconnectStore.createRuntime(),
    attempt: reconnectHandshakeFailurePlan.nextAttempt,
    phase: 'idle' as const,
    nextDelayMs: null,
  };
  options.updateSessionSync(
    options.sessionId,
    buildSessionReconnectingFailureUpdates(options.message, idleRuntime.attempt),
  );
  options.reconnectStore.write(options.sessionId, idleRuntime);
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
  reconnectStore: SessionReconnectStore;
  applyTransportOpenConnectedEffects: (options: {
    sessionId: string;
    debugScope: 'connect' | 'reconnect';
    sessionName: string;
    ws: BridgeTransportSocket;
  }) => void;
  emitSessionStatus: (sessionId: string, type: 'closed' | 'error', message?: string) => void;
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
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
      options.reconnectStore.deleteRuntime(options.sessionId);
      options.applyTransportOpenConnectedEffects({
        sessionId: options.sessionId,
        debugScope: 'reconnect',
        sessionName: connectedSessionName,
        ws,
      });
    },
    onClosed: (reason) => {
      options.reconnectStore.deleteRuntime(options.sessionId);
      options.updateSessionSync(options.sessionId, buildSessionClosedUpdates(reason));
      options.emitSessionStatus(options.sessionId, 'closed', reason);
    },
  };
}

export function buildConnectTransportOpenIntentOptionsRuntime(options: {
  sessionId: string;
  host: Host;
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
  emitSessionStatus: (sessionId: string, type: 'closed' | 'error', message?: string) => void;
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
}): QueueSessionTransportOpenIntentOptions {
  return {
    sessionId: options.sessionId,
    host: options.host,
    debugScope: 'connect',
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
    onClosed: (reason) => {
      options.updateSessionSync(options.sessionId, buildSessionClosedUpdates(reason));
      options.emitSessionStatus(options.sessionId, 'closed', reason);
    },
  };
}

export function queueTransportOpenIntentRuntime(options: {
  sessionId: string;
  host: Host;
  mode: 'connect' | 'reconnect';
  queueSessionTransportOpenIntent: QueueSessionTransportOpenIntent;
  buildReconnectTransportOpenIntentOptions: (sessionId: string, host: Host) => QueueSessionTransportOpenIntentOptions;
  buildConnectTransportOpenIntentOptions: (sessionId: string, host: Host) => QueueSessionTransportOpenIntentOptions;
}) {
  const intentOptions = options.mode === 'reconnect'
    ? options.buildReconnectTransportOpenIntentOptions(options.sessionId, options.host)
    : options.buildConnectTransportOpenIntentOptions(options.sessionId, options.host);
  options.queueSessionTransportOpenIntent(intentOptions);
}
