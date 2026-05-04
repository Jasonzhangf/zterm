import { getResolvedSessionName } from '../lib/connection-target';
import { createSessionBufferState } from '../lib/terminal-buffer';
import type { Host, Session, SessionBufferState, SessionScheduleState } from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import {
  buildSessionConnectionFields,
  buildSessionErrorUpdates,
  buildSessionIdleAfterReconnectBlockedUpdates,
  buildSessionReconnectAttemptProgressUpdates,
  buildSessionReconnectingFailureUpdates,
  buildSessionScheduleLoadingState,
  buildSessionTransportPrimeState,
  findReusableManagedSession,
  orderSessionsForReconnect,
  shouldAutoReconnectSession,
  shouldOpenManagedSessionTransport,
} from './session-sync-helpers';
import {
  deletePendingSessionTransportOpenIntent,
  hasPendingSessionTransportOpenIntent,
} from './session-context-open-intent-store';

interface MutableRefObject<T> {
  current: T;
}

interface RuntimeDebugFn {
  (event: string, payload?: Record<string, unknown>): void;
}

interface SessionLikeState {
  sessions: Session[];
  activeSessionId: string | null;
}

interface CreateSessionOptions {
  activate?: boolean;
  connect?: boolean;
  customName?: string;
  buffer?: SessionBufferState;
  createdAt?: number;
  sessionId?: string;
}

interface SessionReconnectRuntime {
  attempt: number;
  timer: number | null;
  nextDelayMs: number | null;
  connecting: boolean;
}

function clearReconnectRuntimeEntry(
  reconnectRuntimes: Map<string, SessionReconnectRuntime>,
  sessionId: string,
) {
  const reconnectRuntime = reconnectRuntimes.get(sessionId) || null;
  if (reconnectRuntime?.timer) {
    clearTimeout(reconnectRuntime.timer);
  }
  reconnectRuntimes.delete(sessionId);
}

export function connectSessionRuntime(options: {
  sessionId: string;
  host: Host;
  activate: boolean;
  refs: {
    manualCloseRef: MutableRefObject<Set<string>>;
  };
  clearReconnectForSession: (sessionId: string) => void;
  cleanupSocket: (sessionId: string, shouldClose?: boolean) => void;
  writeSessionTransportHost: (sessionId: string, host: Host) => unknown;
  writeSessionTransportToken: (sessionId: string, token: string | null) => string | null;
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
  setScheduleStateForSession: (
    sessionId: string,
    nextState: SessionScheduleState | ((current: SessionScheduleState) => SessionScheduleState),
  ) => void;
  setActiveSessionSync: (id: string) => void;
  queueConnectTransportOpenIntent: (sessionId: string, host: Host, activate: boolean) => void;
}) {
  const primeState = buildSessionTransportPrimeState(options.host, 'connect');
  options.clearReconnectForSession(options.sessionId);
  options.cleanupSocket(options.sessionId, false);
  options.refs.manualCloseRef.current.delete(options.sessionId);
  options.writeSessionTransportHost(options.sessionId, primeState.transportHost);
  options.writeSessionTransportToken(options.sessionId, null);
  options.updateSessionSync(options.sessionId, primeState.sessionUpdates);
  options.setScheduleStateForSession(
    options.sessionId,
    buildSessionScheduleLoadingState(primeState.resolvedSessionName),
  );
  if (options.activate) {
    options.setActiveSessionSync(options.sessionId);
  }
  options.queueConnectTransportOpenIntent(options.sessionId, options.host, options.activate);
}

export function createSessionRuntime(options: {
  host: Host;
  createOptions?: CreateSessionOptions;
  refs: {
    stateRef: MutableRefObject<SessionLikeState>;
    pendingSessionTransportOpenIntentsRef: MutableRefObject<Map<string, unknown>>;
    sessionBufferStoreRef: MutableRefObject<{
      setBuffer: (sessionId: string, buffer: SessionBufferState) => void;
    }>;
    sessionHeadStoreRef: MutableRefObject<{
      setHead: (sessionId: string, head: { daemonHeadRevision: number; daemonHeadEndIndex: number }) => boolean;
    }>;
  };
  runtimeDebug: RuntimeDebugFn;
  resolveSessionCacheLines: (rows?: number | null) => number;
  createSessionSync: (session: Session, activate: boolean) => void;
  setActiveSessionSync: (id: string) => void;
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
  readSessionTransportSocket: (sessionId: string) => { readyState: number } | null;
  connectSession: (sessionId: string, host: Host, activate: boolean) => void;
  defaultViewport: {
    cols: number;
    rows: number;
  };
}) {
  const resolvedSessionName = getResolvedSessionName(options.host);
  const existingSession = findReusableManagedSession({
    sessions: options.refs.stateRef.current.sessions,
    host: options.host,
    resolvedSessionName,
    activeSessionId: options.refs.stateRef.current.activeSessionId,
  });
  const shouldActivate = options.createOptions?.activate !== false;
  const shouldConnect = options.createOptions?.connect !== false;

  if (existingSession) {
    if (
      options.host.id !== existingSession.hostId
      || options.host.name !== existingSession.connectionName
      || options.host.bridgeHost !== existingSession.bridgeHost
      || options.host.bridgePort !== existingSession.bridgePort
      || resolvedSessionName !== existingSession.sessionName
      || options.host.authToken !== existingSession.authToken
      || options.host.autoCommand !== existingSession.autoCommand
      || (options.createOptions?.customName?.trim() && (
        options.createOptions.customName.trim() !== (existingSession.customName || '')
        || options.createOptions.customName.trim() !== existingSession.title
      ))
    ) {
      const title = options.createOptions?.customName?.trim() || existingSession.title || resolvedSessionName;
      options.updateSessionSync(existingSession.id, {
        ...buildSessionConnectionFields(options.host, resolvedSessionName),
        customName: options.createOptions?.customName?.trim() || existingSession.customName,
        title,
      });
    }

    if (shouldActivate && options.refs.stateRef.current.activeSessionId !== existingSession.id) {
      options.setActiveSessionSync(existingSession.id);
    }

    if (shouldConnect) {
      const currentTransport = options.readSessionTransportSocket(existingSession.id);
      const shouldReconnectExisting = shouldOpenManagedSessionTransport({
        readyState: currentTransport?.readyState ?? null,
        hasPendingOpenIntent: hasPendingSessionTransportOpenIntent(
          options.refs.pendingSessionTransportOpenIntentsRef.current as Parameters<typeof hasPendingSessionTransportOpenIntent>[0],
          existingSession.id,
        ),
        sessionState: existingSession.state,
      });
      if (shouldReconnectExisting) {
        options.connectSession(existingSession.id, options.host, shouldActivate);
      }
    }

    options.runtimeDebug('session.create.reuse-existing', {
      requestedSessionId: options.createOptions?.sessionId || null,
      reusedSessionId: existingSession.id,
      bridgeHost: options.host.bridgeHost,
      bridgePort: options.host.bridgePort,
      sessionName: resolvedSessionName,
      activeSessionId: options.refs.stateRef.current.activeSessionId,
    });
    return existingSession.id;
  }

  const sessionId = options.createOptions?.sessionId || `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const session: Session = {
    id: sessionId,
    hostId: options.host.id,
    connectionName: options.host.name,
    bridgeHost: options.host.bridgeHost,
    bridgePort: options.host.bridgePort,
    sessionName: resolvedSessionName,
    authToken: options.host.authToken,
    autoCommand: options.host.autoCommand,
    title: options.createOptions?.customName?.trim() || resolvedSessionName,
    ws: null,
    state: shouldConnect ? 'connecting' : 'closed',
    hasUnread: false,
    customName: options.createOptions?.customName?.trim() || undefined,
    buffer: options.createOptions?.buffer || createSessionBufferState({
      lines: [],
      cols: options.defaultViewport.cols,
      rows: options.defaultViewport.rows,
      cacheLines: options.resolveSessionCacheLines(options.defaultViewport.rows),
    }),
    daemonHeadRevision: 0,
    daemonHeadEndIndex: 0,
    reconnectAttempt: 0,
    createdAt: options.createOptions?.createdAt || Date.now(),
  };

  options.refs.sessionBufferStoreRef.current.setBuffer(sessionId, session.buffer);
  options.refs.sessionHeadStoreRef.current.setHead(sessionId, {
    daemonHeadRevision: session.daemonHeadRevision || 0,
    daemonHeadEndIndex: session.daemonHeadEndIndex || 0,
  });
  options.runtimeDebug('session.create.new', {
    sessionId,
    requestedSessionId: options.createOptions?.sessionId || null,
    bridgeHost: options.host.bridgeHost,
    bridgePort: options.host.bridgePort,
    sessionName: resolvedSessionName,
    activate: shouldActivate,
    connect: shouldConnect,
    activeSessionId: options.refs.stateRef.current.activeSessionId,
  });
  options.createSessionSync(session, shouldActivate);
  if (shouldConnect) {
    options.connectSession(sessionId, options.host, shouldActivate);
  }
  return sessionId;
}

export function closeSessionRuntime(options: {
  sessionId: string;
  refs: {
    manualCloseRef: MutableRefObject<Set<string>>;
    pendingInputQueueRef: MutableRefObject<Map<string, string[]>>;
    pendingSessionTransportOpenIntentsRef: MutableRefObject<Map<string, unknown>>;
    pendingInputTailRefreshRef: MutableRefObject<Map<string, { requestedAt: number; localRevision: number }>>;
    pendingConnectTailRefreshRef: MutableRefObject<Set<string>>;
    pendingResumeTailRefreshRef: MutableRefObject<Set<string>>;
    lastActiveReentryAtRef: MutableRefObject<Map<string, number>>;
    sessionVisibleRangeRef: MutableRefObject<Map<string, unknown>>;
    sessionBufferStoreRef: MutableRefObject<{ deleteSession: (sessionId: string) => void }>;
    sessionRenderGateRef: MutableRefObject<{ deleteSession: (sessionId: string) => void }>;
    sessionHeadStoreRef: MutableRefObject<{ deleteSession: (sessionId: string) => void }>;
    sessionDebugMetricsStoreRef: MutableRefObject<{ clearSession: (sessionId: string) => void }>;
  };
  clearReconnectForSession: (sessionId: string) => void;
  readSessionTransportRuntime: (sessionId: string) => { targetKey: string | null } | null;
  readSessionTargetRuntime: (sessionId: string) => { sessionIds: string[] } | null;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  runtimeDebug: RuntimeDebugFn;
  cleanupSocket: (sessionId: string, shouldClose?: boolean) => void;
  cleanupControlSocket: (sessionId: string, shouldClose?: boolean) => void;
  writeSessionTransportToken: (sessionId: string, token: string | null) => string | null;
  clearSessionTransportRuntime: (sessionId: string) => unknown;
  setScheduleStates: React.Dispatch<React.SetStateAction<Record<string, SessionScheduleState>>>;
  deleteSessionSync: (id: string) => void;
}) {
  options.refs.manualCloseRef.current.add(options.sessionId);
  options.refs.pendingInputQueueRef.current.delete(options.sessionId);
  deletePendingSessionTransportOpenIntent(
    options.refs.pendingSessionTransportOpenIntentsRef.current as Parameters<typeof deletePendingSessionTransportOpenIntent>[0],
    options.sessionId,
  );
  options.clearReconnectForSession(options.sessionId);
  const transportRuntime = options.readSessionTransportRuntime(options.sessionId);
  const targetRuntime = options.readSessionTargetRuntime(options.sessionId);

  const ws = options.readSessionTransportSocket(options.sessionId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    options.sendSocketPayload(options.sessionId, ws, JSON.stringify({ type: 'close' }));
  }
  options.runtimeDebug('session.close', {
    sessionId: options.sessionId,
    targetKey: transportRuntime?.targetKey || null,
    targetSessionCount: targetRuntime?.sessionIds.length || 0,
  });
  options.cleanupSocket(options.sessionId, true);
  if ((targetRuntime?.sessionIds.length || 0) <= 1) {
    options.cleanupControlSocket(options.sessionId, true);
  }
  options.writeSessionTransportToken(options.sessionId, null);
  options.clearSessionTransportRuntime(options.sessionId);
  options.refs.pendingInputTailRefreshRef.current.delete(options.sessionId);
  options.refs.pendingConnectTailRefreshRef.current.delete(options.sessionId);
  options.refs.pendingResumeTailRefreshRef.current.delete(options.sessionId);
  options.refs.lastActiveReentryAtRef.current.delete(options.sessionId);
  options.refs.sessionVisibleRangeRef.current.delete(options.sessionId);
  options.refs.sessionBufferStoreRef.current.deleteSession(options.sessionId);
  options.refs.sessionRenderGateRef.current.deleteSession(options.sessionId);
  options.refs.sessionHeadStoreRef.current.deleteSession(options.sessionId);
  options.refs.sessionDebugMetricsStoreRef.current.clearSession(options.sessionId);
  options.setScheduleStates((current) => {
    if (!(options.sessionId in current)) {
      return current;
    }
    const next = { ...current };
    delete next[options.sessionId];
    return next;
  });
  options.deleteSessionSync(options.sessionId);
}

export function renameSessionRuntime(options: {
  sessionId: string;
  name: string;
  sessions: Session[];
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
}) {
  const trimmed = options.name.trim();
  const current = options.sessions.find((session) => session.id === options.sessionId);
  if (!current) {
    return;
  }
  options.updateSessionSync(options.sessionId, {
    customName: trimmed || undefined,
    title: trimmed || current.sessionName,
  });
}

export function reconnectSessionRuntime(options: {
  sessionId: string;
  refs: {
    stateRef: MutableRefObject<SessionLikeState>;
    manualCloseRef: MutableRefObject<Set<string>>;
  };
  clearReconnectForSession: (sessionId: string) => void;
  readSessionTransportHost: (sessionId: string) => Host | null;
  readSessionTargetKey: (sessionId: string) => string | null;
  readSessionTargetRuntime: (sessionId: string) => { sessionIds: string[] } | null;
  runtimeDebug: RuntimeDebugFn;
  cleanupSocket: (sessionId: string, shouldClose?: boolean) => void;
  writeSessionTransportHost: (sessionId: string, host: Host) => unknown;
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
  setActiveSessionSync: (id: string) => void;
  scheduleReconnect: (
    sessionId: string,
    message: string,
    retryable?: boolean,
    options?: { immediate?: boolean; resetAttempt?: boolean; force?: boolean },
  ) => void;
}) {
  options.clearReconnectForSession(options.sessionId);
  const current = options.refs.stateRef.current.sessions.find((session) => session.id === options.sessionId);
  const knownHost = options.readSessionTransportHost(options.sessionId);
  const targetKey = options.readSessionTargetKey(options.sessionId);
  const targetRuntime = options.readSessionTargetRuntime(options.sessionId);
  if (!current && !knownHost) {
    return;
  }

  const host: Host = knownHost || {
    id: current!.hostId,
    createdAt: current!.createdAt,
    name: current!.connectionName,
    bridgeHost: current!.bridgeHost,
    bridgePort: current!.bridgePort,
    sessionName: current!.sessionName,
    authToken: current!.authToken,
    authType: 'password',
    tags: [],
    pinned: false,
    autoCommand: current!.autoCommand,
  };

  options.runtimeDebug('session.reconnect.one', {
    sessionId: options.sessionId,
    bridgeHost: host.bridgeHost,
    bridgePort: host.bridgePort,
    sessionName: host.sessionName,
    activeSessionId: options.refs.stateRef.current.activeSessionId,
    targetKey,
    targetSessionCount: targetRuntime?.sessionIds.length || 0,
  });

  const primeState = buildSessionTransportPrimeState(host, 'reconnect');
  options.cleanupSocket(options.sessionId, false);
  options.refs.manualCloseRef.current.delete(options.sessionId);
  options.writeSessionTransportHost(options.sessionId, primeState.transportHost);
  options.updateSessionSync(options.sessionId, primeState.sessionUpdates);
  options.scheduleReconnect(options.sessionId, 'manual reconnect', true, {
    immediate: true,
    resetAttempt: true,
    force: true,
  });
}

export function reconnectAllSessionsRuntime(options: {
  sessions: Session[];
  activeSessionId: string | null;
  runtimeDebug: RuntimeDebugFn;
  readSessionBufferSnapshot: (sessionId: string) => { revision: number };
  reconnectSession: (sessionId: string) => void;
}) {
  options.runtimeDebug('session.reconnect.all', {
    activeSessionId: options.activeSessionId,
    sessions: options.sessions.map((session) => ({
      id: session.id,
      state: session.state,
      revision: options.readSessionBufferSnapshot(session.id).revision,
    })),
  });
  const orderedSessions = orderSessionsForReconnect(
    options.sessions,
    options.activeSessionId,
  );
  for (const session of orderedSessions) {
    options.reconnectSession(session.id);
  }
}

export function scheduleReconnectRuntime(options: {
  sessionId: string;
  message: string;
  retryable?: boolean;
  reconnectOptions?: { immediate?: boolean; resetAttempt?: boolean; force?: boolean };
  refs: {
    manualCloseRef: MutableRefObject<Set<string>>;
    reconnectRuntimesRef: MutableRefObject<Map<string, SessionReconnectRuntime>>;
    stateRef: MutableRefObject<SessionLikeState>;
  };
  readSessionTransportHost: (sessionId: string) => Host | null;
  shouldAutoReconnectSessionFn: typeof shouldAutoReconnectSession;
  createSessionReconnectRuntime: () => SessionReconnectRuntime;
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
  emitSessionStatus: (sessionId: string, type: 'closed' | 'error', message?: string) => void;
  startReconnectAttempt: (sessionId: string) => void;
}) {
  if (options.refs.manualCloseRef.current.has(options.sessionId)) {
    clearReconnectRuntimeEntry(options.refs.reconnectRuntimesRef.current, options.sessionId);
    return;
  }
  if (!options.readSessionTransportHost(options.sessionId)) {
    clearReconnectRuntimeEntry(options.refs.reconnectRuntimesRef.current, options.sessionId);
    return;
  }

  if (!options.retryable) {
    clearReconnectRuntimeEntry(options.refs.reconnectRuntimesRef.current, options.sessionId);
    options.updateSessionSync(options.sessionId, buildSessionErrorUpdates(options.message, { includeWsNull: true }));
    options.emitSessionStatus(options.sessionId, 'error', options.message);
    return;
  }

  if (!options.shouldAutoReconnectSessionFn({
    sessionId: options.sessionId,
    activeSessionId: options.refs.stateRef.current.activeSessionId,
    force: options.reconnectOptions?.force,
  })) {
    clearReconnectRuntimeEntry(options.refs.reconnectRuntimesRef.current, options.sessionId);
    options.updateSessionSync(options.sessionId, buildSessionIdleAfterReconnectBlockedUpdates(options.message));
    options.emitSessionStatus(options.sessionId, 'error', options.message);
    return;
  }

  const reconnectRuntime = options.refs.reconnectRuntimesRef.current.get(options.sessionId)
    || options.createSessionReconnectRuntime();
  if (options.reconnectOptions?.resetAttempt) {
    reconnectRuntime.attempt = 0;
  }
  if (options.reconnectOptions?.immediate) {
    reconnectRuntime.nextDelayMs = 0;
  }
  options.refs.reconnectRuntimesRef.current.set(options.sessionId, reconnectRuntime);

  options.updateSessionSync(
    options.sessionId,
    buildSessionReconnectingFailureUpdates(options.message, reconnectRuntime.attempt),
  );
  options.emitSessionStatus(options.sessionId, 'error', options.message);
  options.startReconnectAttempt(options.sessionId);
}

export function startReconnectAttemptRuntime(options: {
  sessionId: string;
  refs: {
    manualCloseRef: MutableRefObject<Set<string>>;
    reconnectRuntimesRef: MutableRefObject<Map<string, SessionReconnectRuntime>>;
  };
  readSessionTransportHost: (sessionId: string) => Host | null;
  computeReconnectDelay: (attempt: number) => number;
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
  writeSessionTransportToken: (sessionId: string, token: string | null) => string | null;
  queueReconnectTransportOpenIntent: (sessionId: string, host: Host) => void;
}) {
  if (options.refs.manualCloseRef.current.has(options.sessionId)) {
    options.refs.reconnectRuntimesRef.current.delete(options.sessionId);
    return;
  }
  const reconnectRuntime = options.refs.reconnectRuntimesRef.current.get(options.sessionId);
  const targetHost = options.readSessionTransportHost(options.sessionId);
  if (!reconnectRuntime || !targetHost) {
    options.refs.reconnectRuntimesRef.current.delete(options.sessionId);
    return;
  }
  if (reconnectRuntime.timer || reconnectRuntime.connecting) {
    return;
  }

  const delay = reconnectRuntime.nextDelayMs ?? options.computeReconnectDelay(reconnectRuntime.attempt);
  reconnectRuntime.nextDelayMs = null;
  reconnectRuntime.timer = window.setTimeout(() => {
    if (options.refs.manualCloseRef.current.has(options.sessionId)) {
      options.refs.reconnectRuntimesRef.current.delete(options.sessionId);
      return;
    }
    const liveRuntime = options.refs.reconnectRuntimesRef.current.get(options.sessionId);
    if (!liveRuntime) {
      return;
    }
    liveRuntime.timer = null;
    liveRuntime.connecting = true;

    const liveHost = options.readSessionTransportHost(options.sessionId);
    if (!liveHost) {
      liveRuntime.connecting = false;
      options.refs.reconnectRuntimesRef.current.delete(options.sessionId);
      return;
    }

    options.updateSessionSync(
      options.sessionId,
      buildSessionReconnectAttemptProgressUpdates(liveRuntime.attempt + 1),
    );
    options.writeSessionTransportToken(options.sessionId, null);
    options.queueReconnectTransportOpenIntent(options.sessionId, liveHost);
  }, delay);
}
