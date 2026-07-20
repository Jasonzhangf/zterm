import type { Host, Session, SessionScheduleState } from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';

export interface SessionReconnectDecisionOptions {
  hasSession: boolean;
  wsReadyState: number | null;
  reconnectInFlight: boolean;
}

export type ActiveRefreshSource = 'explicit-resume' | 'active-reentry' | 'active-tick';

export interface ActiveSessionRefreshPlanOptions {
  hasSession: boolean;
  isRefreshTarget: boolean;
  sessionState: string | null;
  wsReadyState: number | null;
  reconnectInFlight: boolean;
  pendingTransportOpen: boolean;
  pendingTransportOpenStale?: boolean;
  allowReconnectIfUnavailable?: boolean;
  keepaliveGraceActive?: boolean;
  transportStale: boolean;
  source: ActiveRefreshSource;
}

export type ActiveSessionRefreshPlan =
  | { action: 'skip'; reason: 'inactive-or-missing-session' | 'tick-blocked-by-reconnect' | 'transport-unavailable' | 'transport-open-pending' | 'closed-session-requires-explicit-open' }
  | { action: 'request-head'; resetPullBookkeeping: boolean }
  | { action: 'reconnect' };

export type SessionTransportOpenDebugScope = 'connect' | 'reconnect';
export type SessionTransportOpenFailureStage = 'handshake' | 'live';
export type SessionTransportReuseSource = 'connect' | 'reconnect' | 'open-intent';

export interface SessionTransportReusePlanOptions {
  currentTargetKey: string | null;
  requestedTargetKey: string | null;
  wsReadyState: number | null;
  pendingTransportOpen: boolean;
  pendingTransportOpenStale?: boolean;
  manualClosed?: boolean;
  source: SessionTransportReuseSource;
}

export type SessionTransportReusePlan =
  | { action: 'reuse-open'; reason: 'open-same-target' }
  | { action: 'wait-existing-open'; reason: 'connecting-same-target' | 'pending-open' }
  | { action: 'skip'; reason: 'manual-closed' }
  | { action: 'rebuild'; reason: 'missing-target' | 'target-mismatch' | 'closed' | 'missing-socket' | 'stale-pending-open' };

export interface TransportOpenConnectedEffectPlan {
  debugEvent: 'session.ws.connected' | 'session.ws.reconnect.connected';
  clearSupersededSockets: boolean;
}

export interface TransportOpenLiveFailureEffectPlan {
  clearPendingIntent: boolean;
  clearTransportToken: boolean;
  clearScheduleErrorState: boolean;
  clearSupersededSockets: boolean;
  scheduleReconnect: boolean;
}

export type ReconnectHandshakeFailurePlan =
  | { action: 'terminal-error' }
  | { action: 'retry-reconnect'; nextAttempt: number };

export function buildSessionTransportReusePlan(
  options: SessionTransportReusePlanOptions,
): SessionTransportReusePlan {
  if (options.manualClosed) {
    return { action: 'skip', reason: 'manual-closed' };
  }

  if (options.pendingTransportOpen && options.pendingTransportOpenStale) {
    return { action: 'rebuild', reason: 'stale-pending-open' };
  }

  if (!options.requestedTargetKey || !options.currentTargetKey) {
    if (options.pendingTransportOpen) {
      return { action: 'wait-existing-open', reason: 'pending-open' };
    }
    return { action: 'rebuild', reason: 'missing-target' };
  }

  if (options.currentTargetKey !== options.requestedTargetKey) {
    return { action: 'rebuild', reason: 'target-mismatch' };
  }

  if (options.pendingTransportOpen) {
    return { action: 'wait-existing-open', reason: 'pending-open' };
  }

  if (options.wsReadyState === WebSocket.OPEN) {
    return { action: 'reuse-open', reason: 'open-same-target' };
  }

  if (options.wsReadyState === WebSocket.CONNECTING) {
    return { action: 'wait-existing-open', reason: 'connecting-same-target' };
  }

  if (options.pendingTransportOpen) {
    return { action: 'wait-existing-open', reason: 'pending-open' };
  }

  if (
    options.wsReadyState === WebSocket.CLOSING
    || options.wsReadyState === WebSocket.CLOSED
  ) {
    return { action: 'rebuild', reason: 'closed' };
  }

  return { action: 'rebuild', reason: 'missing-socket' };
}

export interface PendingSessionTransportOpenIntent {
  sessionId: string;
  openRequestId: string;
  createdAt: number;
  host: Host;
  resolvedSessionName: string;
  debugScope: SessionTransportOpenDebugScope;
  onBeforeConnectSend?: (ctx: { sessionName: string }) => void;
  finalizeFailure: (message: string, retryable: boolean) => void;
  onConnected: (ws: BridgeTransportSocket) => void;
  onClosed?: (reason?: string) => void;
}

export interface QueueSessionTransportOpenIntentOptions {
  sessionId: string;
  openRequestId?: string;
  host: Host;
  resolvedSessionName: string;
  debugScope: SessionTransportOpenDebugScope;
  onBeforeConnectSend?: (ctx: { sessionName: string }) => void;
  onHandshakeConnected?: (ws: BridgeTransportSocket, sessionName: string) => void;
  onHandshakeFailure?: (message: string, retryable: boolean, stage: SessionTransportOpenFailureStage) => void;
  onClosed?: (reason?: string) => void;
  clearHandshakeTimeout: () => void;
  finalizeSocketFailureBaseline: (options: {
    sessionId: string;
    message: string;
    markCompleted: () => boolean;
  }) => { shouldContinue: boolean; manualClosed: boolean } | null | undefined;
}

let sessionOpenRequestSequence = 0;

export function buildSessionOpenRequestId(sessionId: string) {
  sessionOpenRequestSequence += 1;
  return `${sessionId}:open:${sessionOpenRequestSequence}`;
}

export function createPendingSessionTransportOpenIntent(
  options: QueueSessionTransportOpenIntentOptions,
): PendingSessionTransportOpenIntent {
  let handshakeSettled = false;
  let liveFailureHandled = false;

  const markHandshakeSettled = () => {
    if (handshakeSettled) {
      return false;
    }
    handshakeSettled = true;
    return true;
  };

  return {
    sessionId: options.sessionId,
    openRequestId: options.openRequestId || buildSessionOpenRequestId(options.sessionId),
    createdAt: Date.now(),
    host: options.host,
    resolvedSessionName: options.resolvedSessionName,
    debugScope: options.debugScope,
    onBeforeConnectSend: options.onBeforeConnectSend,
    onClosed: options.onClosed,
    finalizeFailure: (message: string, retryable: boolean) => {
      if (!handshakeSettled) {
        options.clearHandshakeTimeout();
        const baseline = options.finalizeSocketFailureBaseline({
          sessionId: options.sessionId,
          message,
          markCompleted: markHandshakeSettled,
        });
        if (!baseline?.shouldContinue) {
          return;
        }
        options.onHandshakeFailure?.(message, retryable, 'handshake');
        return;
      }
      if (liveFailureHandled) {
        return;
      }
      liveFailureHandled = true;
      options.onHandshakeFailure?.(message, retryable, 'live');
    },
    onConnected: (ws: BridgeTransportSocket) => {
      if (!markHandshakeSettled()) {
        return;
      }
      options.clearHandshakeTimeout();
      options.onHandshakeConnected?.(ws, options.resolvedSessionName);
    },
  };
}

export function buildTransportOpenConnectedEffectPlan(
  debugScope: SessionTransportOpenDebugScope,
): TransportOpenConnectedEffectPlan {
  if (debugScope === 'reconnect') {
    return {
      debugEvent: 'session.ws.reconnect.connected',
      clearSupersededSockets: true,
    };
  }
  return {
    debugEvent: 'session.ws.connected',
    clearSupersededSockets: false,
  };
}

export function buildTransportOpenLiveFailureEffectPlan(
  debugScope: SessionTransportOpenDebugScope,
): TransportOpenLiveFailureEffectPlan {
  return {
    clearPendingIntent: true,
    clearTransportToken: true,
    clearScheduleErrorState: true,
    clearSupersededSockets: debugScope === 'reconnect',
    scheduleReconnect: true,
  };
}

export function buildReconnectHandshakeFailurePlan(options: {
  retryable: boolean;
  currentAttempt: number;
}): ReconnectHandshakeFailurePlan {
  if (!options.retryable) {
    return { action: 'terminal-error' };
  }
  return {
    action: 'retry-reconnect',
    nextAttempt: Math.min(options.currentAttempt + 1, 6),
  };
}

export type SessionConnectionFields = Pick<
  Session,
  'hostId' | 'connectionName' | 'bridgeHost' | 'bridgePort' | 'daemonHostId' | 'sessionName' | 'authToken' | 'autoCommand'
>;

export interface SessionTransportPrimeState {
  resolvedSessionName: string;
  transportHost: Host;
  sessionUpdates: Partial<Session>;
}

export function buildSessionConnectionFields(host: Host, resolvedSessionName: string): SessionConnectionFields {
  return {
    hostId: host.id,
    connectionName: host.name,
    bridgeHost: host.bridgeHost,
    bridgePort: host.bridgePort,
    daemonHostId: host.daemonHostId || host.relayHostId,
    sessionName: resolvedSessionName,
    authToken: host.authToken,
    autoCommand: host.autoCommand,
  };
}

export function buildSessionConnectingUpdates(
  host: Host,
  resolvedSessionName: string,
): Partial<Session> {
  return {
    ...buildSessionConnectionFields(host, resolvedSessionName),
    state: 'connecting',
    reconnectAttempt: 0,
    lastError: undefined,
  };
}

export function buildSessionReconnectingUpdates(
  host: Host,
  resolvedSessionName: string,
): Partial<Session> {
  return {
    ...buildSessionConnectionFields(host, resolvedSessionName),
    state: 'reconnecting',
    reconnectAttempt: 0,
    lastError: undefined,
    ws: null,
  };
}

export function buildSessionTransportPrimeState(
  host: Host,
  mode: 'connect' | 'reconnect',
): SessionTransportPrimeState {
  const resolvedSessionName = host.sessionName.trim() || host.name.trim();
  return {
    resolvedSessionName,
    transportHost: {
      ...host,
      sessionName: resolvedSessionName,
    },
    sessionUpdates: mode === 'connect'
      ? buildSessionConnectingUpdates(host, resolvedSessionName)
      : buildSessionReconnectingUpdates(host, resolvedSessionName),
  };
}

export function buildSessionScheduleLoadingState(
  sessionName: string,
): Pick<SessionScheduleState, 'sessionName' | 'jobs' | 'loading'> {
  return {
    sessionName,
    jobs: [],
    loading: true,
  };
}

export function buildSessionScheduleErrorState(
  current: SessionScheduleState,
  message: string,
): SessionScheduleState {
  return {
    ...current,
    loading: false,
    error: message,
  };
}

export function buildSessionReconnectAttemptProgressUpdates(
  reconnectAttempt: number,
): Pick<Session, 'state' | 'reconnectAttempt' | 'lastError'> {
  return {
    state: 'reconnecting',
    reconnectAttempt,
    lastError: undefined,
  };
}

export function buildSessionTransportWaitUpdates(
  message: string,
): Pick<Session, 'state' | 'lastError'> {
  return {
    state: 'reconnecting',
    lastError: message,
  };
}

export function buildSessionConnectingLabelUpdates(
  sessionName: string,
): Pick<Session, 'state' | 'sessionName'> {
  return {
    state: 'connecting',
    sessionName,
  };
}

export function buildSessionErrorUpdates(
  message: string,
  options?: { includeWsNull?: boolean },
): Partial<Session> {
  return {
    state: 'error',
    lastError: message,
    ...(options?.includeWsNull ? { ws: null } : {}),
  };
}

export function buildSessionClosedUpdates(
  message?: string,
): Pick<Session, 'state' | 'lastError' | 'reconnectAttempt' | 'ws'> {
  return {
    state: 'disconnected',
    lastError: message || undefined,
    reconnectAttempt: 0,
    ws: null,
  };
}

export function buildSessionIdleAfterReconnectBlockedUpdates(
  message: string,
): Pick<Session, 'state' | 'lastError' | 'reconnectAttempt' | 'ws'> {
  return {
    state: 'idle',
    lastError: message,
    reconnectAttempt: 0,
    ws: null,
  };
}

export function buildSessionReconnectingFailureUpdates(
  message: string,
  reconnectAttempt: number,
): Pick<Session, 'state' | 'lastError' | 'reconnectAttempt' | 'ws'> {
  return {
    state: 'reconnecting',
    lastError: message,
    reconnectAttempt,
    ws: null,
  };
}

export function buildSessionConnectedUpdates(
  options?: { daemonHostId?: string | null; reliableInputSupported?: boolean },
): Pick<Session, 'state' | 'reconnectAttempt' | 'lastError' | 'daemonHostId' | 'reliableInputSupported'> {
  const normalizedDaemonHostId = options?.daemonHostId?.trim() || '';
  return {
    state: 'connected',
    reconnectAttempt: 0,
    lastError: undefined,
    ...(normalizedDaemonHostId ? { daemonHostId: normalizedDaemonHostId } : {}),
    ...(options?.reliableInputSupported ? { reliableInputSupported: true } : {}),
  };
}

export function buildSessionScheduleListLoadingState(
  current: SessionScheduleState,
  sessionName: string,
): SessionScheduleState {
  return {
    ...current,
    sessionName,
    loading: true,
    error: undefined,
  };
}

export function buildConnectedHeadRefreshPlan(options: {
  shouldLiveRefresh: boolean;
  hadLocalWindowBeforeConnected: boolean;
}) {
  return {
    shouldRequestHead: options.shouldLiveRefresh,
    shouldMarkPendingConnectTailRefresh: (
      options.shouldLiveRefresh
      && options.hadLocalWindowBeforeConnected
    ),
  };
}

export function shouldReconnectActivatedSession(options: SessionReconnectDecisionOptions) {
  const transportClosed = (
    options.wsReadyState === null
    || options.wsReadyState === WebSocket.CLOSING
    || options.wsReadyState === WebSocket.CLOSED
  );
  return options.hasSession && transportClosed && !options.reconnectInFlight;
}

export function buildActiveSessionRefreshPlan(options: ActiveSessionRefreshPlanOptions): ActiveSessionRefreshPlan {
  const hasBlockingPendingTransportOpen = options.pendingTransportOpen && !options.pendingTransportOpenStale;
  if (!options.hasSession || !options.isRefreshTarget) {
    return { action: 'skip', reason: 'inactive-or-missing-session' };
  }

  if (
    options.source === 'active-tick'
    && (
      options.reconnectInFlight
      || hasBlockingPendingTransportOpen
      || (
        options.sessionState === 'reconnecting'
        && options.wsReadyState !== WebSocket.OPEN
      )
    )
  ) {
    return { action: 'skip', reason: 'tick-blocked-by-reconnect' };
  }

  const transportOpen = options.wsReadyState === WebSocket.OPEN;
  const unavailableState = options.sessionState === 'closed'
    || options.sessionState === 'disconnected'
    || options.sessionState === 'error';

  if (unavailableState) {
    if (options.source !== 'explicit-resume') {
      return { action: 'skip', reason: 'closed-session-requires-explicit-open' };
    }
  }

  if (transportOpen && !unavailableState) {
    if (options.source === 'active-tick') {
      return {
        action: 'request-head',
        resetPullBookkeeping: false,
      };
    }
    return {
      action: 'request-head',
      resetPullBookkeeping: true,
    };
  }

  if (!options.allowReconnectIfUnavailable) {
    return { action: 'skip', reason: 'transport-unavailable' };
  }

  if (hasBlockingPendingTransportOpen) {
    return { action: 'skip', reason: 'transport-open-pending' };
  }

  if (options.wsReadyState === WebSocket.CONNECTING && options.source !== 'active-tick') {
    return { action: 'skip', reason: 'transport-open-pending' };
  }

  if (shouldReconnectActivatedSession({
    hasSession: true,
    wsReadyState: options.wsReadyState,
    reconnectInFlight: options.reconnectInFlight,
  })) {
    return { action: 'reconnect' };
  }

  return { action: 'skip', reason: 'transport-unavailable' };
}
