import { getResolvedSessionName } from '../lib/connection-target';
import { buildReconnectHostFallback } from '../lib/reconnect-host-fallback';
import type { ReconnectHostCandidate } from '../lib/reconnect-host-fallback';
import { probeHostReachable } from '../lib/reconnect-host-probe';
import { buildTransportTargetKey } from '../lib/session-transport-runtime';
import { createSessionBufferState } from '../lib/terminal-buffer';
import type { Host, Session, SessionBufferState, SessionScheduleState } from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type { ClientDaemonConnection } from '../lib/client-daemon-connection';
import type { SessionTailRefreshStore } from '../lib/session-tail-refresh-store';
import type { SessionReconnectRuntime, SessionReconnectStore } from '../lib/session-reconnect-store';
import type { BufferFrameAssemblyResourceState } from './session-buffer-frame-assembly';
// 连续自动重连失败上限：达到后停止自动重试并显式报错（避免网络黑洞下
// 无限循环耗电 + 用户无法感知），active-reentry / resume 仍可手动恢复。
const MAX_RECONNECT_ATTEMPTS = 12;
import {
  buildSessionConnectionFields,
  buildSessionErrorUpdates,
  buildSessionIdleAfterReconnectBlockedUpdates,
  buildSessionReconnectAttemptProgressUpdates,
  buildSessionReconnectingFailureUpdates,
  buildSessionScheduleLoadingState,
  buildSessionTransportPrimeState,
  buildSessionTransportReusePlan,
  buildSessionTransportWaitUpdates,
} from './session-transport-open-helpers';
import {
  findReusableManagedSession,
  orderSessionsForReconnect,
  shouldAutoReconnectSession,
  shouldOpenManagedSessionTransport,
} from './session-reconnect-helpers';
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
  connect?: boolean;
  customName?: string;
  buffer?: SessionBufferState;
  createdAt?: number;
  sessionId?: string;
}

export type ReconnectSessionRuntimeOptions = Record<string, never>;

function readEffectiveSessionTransportReadyState(options: {
  sessionId: string;
  daemonConnection: ClientDaemonConnection;
}) {
  const resource = options.daemonConnection.readSessionResource(options.sessionId) || null;
  const channelState = resource?.channel?.state || null;
  if (channelState === 'closed' || channelState === 'closing') {
    return WebSocket.CLOSED;
  }
  if (!channelState) {
    return resource?.socket?.readyState
      ?? options.daemonConnection.readSessionSocket(options.sessionId)?.readyState
      ?? null;
  }
  const physicalReadyState = resource?.terminalSocket?.readyState
    ?? resource?.socket?.readyState
    ?? options.daemonConnection.readSessionSocket(options.sessionId)?.readyState
    ?? null;
  if (channelState === 'opening') {
    if (
      physicalReadyState === WebSocket.CLOSING
      || physicalReadyState === WebSocket.CLOSED
      || physicalReadyState === null
    ) {
      return physicalReadyState;
    }
    return WebSocket.CONNECTING;
  }
  return physicalReadyState;
}

export function connectSessionRuntime(options: {
  sessionId: string;
  host: Host;
  refs: {
    reconnectStore: SessionReconnectStore;
  };
  clearReconnectForSession: (sessionId: string) => void;
  cleanupSocket: (sessionId: string, shouldClose?: boolean) => void;
  writeSessionTransportHost: (sessionId: string, host: Host) => unknown;
  writeSessionTransportToken: (sessionId: string, token: string | null) => string | null;
  daemonConnection: ClientDaemonConnection;
  readSessionTargetKey: (sessionId: string) => string | null;
  hasPendingSessionTransportOpen: (sessionId: string) => boolean;
  isPendingSessionTransportOpenStale: (sessionId: string) => boolean;
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
  setScheduleStateForSession: (
    sessionId: string,
    nextState: SessionScheduleState | ((current: SessionScheduleState) => SessionScheduleState),
  ) => void;
  queueConnectTransportOpenIntent: (sessionId: string, host: Host) => void;
}) {
  const primeState = buildSessionTransportPrimeState(options.host, 'connect');
  const pendingTransportOpen = options.hasPendingSessionTransportOpen(options.sessionId);
  const reusePlan = buildSessionTransportReusePlan({
    currentTargetKey: options.readSessionTargetKey(options.sessionId),
    requestedTargetKey: buildTransportTargetKey(primeState.transportHost),
    wsReadyState: readEffectiveSessionTransportReadyState(options),
    pendingTransportOpen,
    pendingTransportOpenStale: pendingTransportOpen
      ? options.isPendingSessionTransportOpenStale(options.sessionId)
      : false,
    source: 'connect',
  });
  if (reusePlan.action === 'reuse-open') {
    options.clearReconnectForSession(options.sessionId);
    options.refs.reconnectStore.clearManualClosed(options.sessionId);
    options.writeSessionTransportHost(options.sessionId, primeState.transportHost);
    options.writeSessionTransportToken(options.sessionId, null);
    return;
  }
  if (reusePlan.action === 'wait-existing-open' || reusePlan.action === 'skip') {
    return;
  }

  options.clearReconnectForSession(options.sessionId);
  options.cleanupSocket(options.sessionId, false);
  options.refs.reconnectStore.clearManualClosed(options.sessionId);
  options.writeSessionTransportHost(options.sessionId, primeState.transportHost);
  options.writeSessionTransportToken(options.sessionId, null);
  options.updateSessionSync(options.sessionId, primeState.sessionUpdates);
  options.setScheduleStateForSession(
    options.sessionId,
    buildSessionScheduleLoadingState(primeState.resolvedSessionName),
  );
  options.queueConnectTransportOpenIntent(options.sessionId, options.host);
}

export function createSessionRuntime(options: {
  host: Host;
  createOptions?: CreateSessionOptions;
  refs: {
    stateRef: MutableRefObject<SessionLikeState>;
    pendingSessionTransportOpenIntentsRef: MutableRefObject<Map<string, unknown>>;
    sessionBufferStoreRef: MutableRefObject<{
      commitBuffer: (sessionId: string, buffer: SessionBufferState) => boolean;
      setBuffer: (sessionId: string, buffer: SessionBufferState) => void;
    }>;
    sessionHeadStoreRef: MutableRefObject<{
      setHead: (sessionId: string, head: { daemonHeadRevision: number; daemonHeadEndIndex: number }) => boolean;
    }>;
  };
  runtimeDebug: RuntimeDebugFn;
  resolveSessionCacheLines: (rows?: number | null) => number;
  scheduleSessionRenderCommit?: (sessionId: string) => void;
  createSessionSync: (session: Session) => void;
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
  writeSessionTransportHost?: (sessionId: string, host: Host) => unknown;
  daemonConnection: ClientDaemonConnection;
  connectSession: (sessionId: string, host: Host) => void;
  defaultViewport: {
    cols: number;
    rows: number;
  };
}) {
  const resolvedSessionName = getResolvedSessionName(options.host);
  // sessionId is the only authority for reusing an existing managed session. Two
  // tmux sessions that happen to share host+sessionName (e.g. rcc and rcc2 after
  // a rename) must NEVER collapse into one client-owned session.
  const reuseSessionId = options.createOptions?.sessionId?.trim() || '';
  const existingSession = reuseSessionId
    ? findReusableManagedSession({
        sessionId: reuseSessionId,
        sessions: options.refs.stateRef.current.sessions,
        activeSessionId: options.refs.stateRef.current.activeSessionId,
      })
    : null;
  const shouldConnect = options.createOptions?.connect !== false;

  if (existingSession) {
    options.writeSessionTransportHost?.(existingSession.id, {
      ...options.host,
      sessionName: resolvedSessionName,
    });

    if (
      options.host.id !== existingSession.hostId
      || options.host.name !== existingSession.connectionName
      || options.host.bridgeHost !== existingSession.bridgeHost
      || options.host.bridgePort !== existingSession.bridgePort
      || (options.host.daemonHostId || options.host.relayHostId || undefined) !== existingSession.daemonHostId
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

    if (shouldConnect) {
      const currentTransportReadyState = readEffectiveSessionTransportReadyState({
        sessionId: existingSession.id,
        daemonConnection: options.daemonConnection,
      });
      const shouldReconnectExisting = shouldOpenManagedSessionTransport({
        readyState: currentTransportReadyState,
        hasPendingOpenIntent: hasPendingSessionTransportOpenIntent(
          options.refs.pendingSessionTransportOpenIntentsRef.current as Parameters<typeof hasPendingSessionTransportOpenIntent>[0],
          existingSession.id,
        ),
        sessionState: existingSession.state,
      });
      if (shouldReconnectExisting) {
        options.connectSession(existingSession.id, options.host);
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
    daemonHostId: options.host.daemonHostId || options.host.relayHostId,
    sessionName: resolvedSessionName,
    authToken: options.host.authToken,
    autoCommand: options.host.autoCommand,
    title: options.createOptions?.customName?.trim() || resolvedSessionName,
    ws: null,
    state: shouldConnect ? 'connecting' : 'closed',
    hasUnread: false,
    customName: options.createOptions?.customName?.trim() || undefined,
    reconnectAttempt: 0,
    createdAt: options.createOptions?.createdAt || Date.now(),
  };

  const initialBuffer = options.createOptions?.buffer || createSessionBufferState({
    lines: [],
    cols: options.defaultViewport.cols,
    rows: options.defaultViewport.rows,
    cacheLines: options.resolveSessionCacheLines(options.defaultViewport.rows),
  });
  options.refs.sessionBufferStoreRef.current.commitBuffer(sessionId, initialBuffer);
  if (initialBuffer.lines.length > 0) {
    options.scheduleSessionRenderCommit?.(sessionId);
  }
  options.refs.sessionHeadStoreRef.current.setHead(sessionId, {
    daemonHeadRevision: 0,
    daemonHeadEndIndex: 0,
  });
  options.runtimeDebug('session.create.new', {
    sessionId,
    requestedSessionId: options.createOptions?.sessionId || null,
    bridgeHost: options.host.bridgeHost,
    bridgePort: options.host.bridgePort,
    sessionName: resolvedSessionName,
      connect: shouldConnect,
      activeSessionId: options.refs.stateRef.current.activeSessionId,
    });
  options.createSessionSync(session);
  options.writeSessionTransportHost?.(sessionId, {
    ...options.host,
    sessionName: resolvedSessionName,
  });
  if (shouldConnect) {
    options.connectSession(sessionId, options.host);
  }
  return sessionId;
}

export function closeSessionRuntime(options: {
  sessionId: string;
  refs: {
    reconnectStore: SessionReconnectStore;
    pendingSessionTransportOpenIntentsRef: MutableRefObject<Map<string, unknown>>;
    tailRefreshStore: SessionTailRefreshStore;
    lastActiveReentryAtRef: MutableRefObject<Map<string, number>>;
    lastConnectedBaselineAtRef: MutableRefObject<Map<string, number>>;
    sessionVisibleRangeRef: MutableRefObject<Map<string, unknown>>;
    sessionRevisionResetRef: MutableRefObject<Map<string, {
      revision: number;
      latestEndIndex: number;
      seenAt: number;
    }>>;
    bufferFrameAssemblyRef: MutableRefObject<Map<string, BufferFrameAssemblyResourceState>>;
    sessionBufferStoreRef: MutableRefObject<{ deleteSession: (sessionId: string) => void }>;
    sessionRenderGateRef: MutableRefObject<{ deleteSession: (sessionId: string) => void }>;
    sessionHeadStoreRef: MutableRefObject<{ deleteSession: (sessionId: string) => void }>;
    sessionDebugMetricsStoreRef: MutableRefObject<{ clearSession: (sessionId: string) => void }>;
  };
  clearReconnectForSession: (sessionId: string) => void;
  readSessionTransportRuntime: (sessionId: string) => { targetKey: string | null } | null;
  readSessionTargetRuntime: (sessionId: string) => { sessionIds: string[] } | null;
  daemonConnection: ClientDaemonConnection;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  runtimeDebug: RuntimeDebugFn;
  cleanupSocket: (sessionId: string, shouldClose?: boolean) => void;
  cleanupControlSocket: (sessionId: string, shouldClose?: boolean) => void;
  writeSessionTransportToken: (sessionId: string, token: string | null) => string | null;
  clearSessionTransportRuntime: (sessionId: string) => unknown;
  setScheduleStates: React.Dispatch<React.SetStateAction<Record<string, SessionScheduleState>>>;
  deleteSessionSync: (id: string) => void;
}) {
  options.refs.reconnectStore.markManualClosed(options.sessionId);
  deletePendingSessionTransportOpenIntent(
    options.refs.pendingSessionTransportOpenIntentsRef.current as Parameters<typeof deletePendingSessionTransportOpenIntent>[0],
    options.sessionId,
  );
  options.clearReconnectForSession(options.sessionId);
  const transportRuntime = options.readSessionTransportRuntime(options.sessionId);
  const targetRuntime = options.readSessionTargetRuntime(options.sessionId);

  const ws = options.daemonConnection.readSessionSocket(options.sessionId);
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
  options.refs.tailRefreshStore.deleteSession(options.sessionId);
  options.refs.lastActiveReentryAtRef.current.delete(options.sessionId);
  options.refs.lastConnectedBaselineAtRef.current.delete(options.sessionId);
  options.refs.sessionVisibleRangeRef.current.delete(options.sessionId);
  options.refs.sessionRevisionResetRef.current.delete(options.sessionId);
  options.refs.bufferFrameAssemblyRef.current.delete(options.sessionId);
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
  reconnectOptions?: ReconnectSessionRuntimeOptions;
  refs: {
    stateRef: MutableRefObject<SessionLikeState>;
    reconnectStore: SessionReconnectStore;
    pendingSessionTransportOpenIntentsRef?: MutableRefObject<Map<string, unknown>>;
  };
  clearReconnectForSession: (sessionId: string) => void;
  readSessionTransportHost: (sessionId: string) => Host | null;
  readSessionTargetKey: (sessionId: string) => string | null;
  readSessionTargetRuntime: (sessionId: string) => { sessionIds: string[] } | null;
  daemonConnection: ClientDaemonConnection;
  hasPendingSessionTransportOpen: (sessionId: string) => boolean;
  isPendingSessionTransportOpenStale: (sessionId: string) => boolean;
  runtimeDebug: RuntimeDebugFn;
  cleanupSocket: (sessionId: string, shouldClose?: boolean) => void;
  cleanupControlSocket?: (sessionId: string, shouldClose?: boolean) => void;
  writeSessionTransportHost: (sessionId: string, host: Host) => unknown;
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
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
  const pendingTransportOpen = options.hasPendingSessionTransportOpen(options.sessionId);
  const pendingTransportOpenStale = pendingTransportOpen
    ? options.isPendingSessionTransportOpenStale(options.sessionId)
    : false;
  const reusePlan = buildSessionTransportReusePlan({
    currentTargetKey: targetKey,
    requestedTargetKey: buildTransportTargetKey(primeState.transportHost),
    wsReadyState: readEffectiveSessionTransportReadyState(options),
    pendingTransportOpen,
    pendingTransportOpenStale,
    source: 'reconnect',
  });
  options.runtimeDebug('session.reconnect.reuse-plan', {
    sessionId: options.sessionId,
    action: reusePlan.action,
    reason: reusePlan.reason,
    targetKey,
  });
  if (reusePlan.action === 'reuse-open') {
    options.clearReconnectForSession(options.sessionId);
    options.refs.reconnectStore.clearManualClosed(options.sessionId);
    options.writeSessionTransportHost(options.sessionId, primeState.transportHost);
    return;
  }
  if (reusePlan.action === 'wait-existing-open' || reusePlan.action === 'skip') {
    if (reusePlan.action === 'wait-existing-open') {
      options.updateSessionSync(
        options.sessionId,
        buildSessionTransportWaitUpdates(
          reusePlan.reason === 'pending-open'
            ? 'Waiting for existing websocket open'
            : 'Waiting for existing websocket handshake',
        ),
      );
    }
    return;
  }

  if (pendingTransportOpenStale && options.refs.pendingSessionTransportOpenIntentsRef) {
    deletePendingSessionTransportOpenIntent(
      options.refs.pendingSessionTransportOpenIntentsRef.current as Parameters<typeof deletePendingSessionTransportOpenIntent>[0],
      options.sessionId,
    );
    options.cleanupControlSocket?.(options.sessionId, true);
  }
  options.cleanupSocket(options.sessionId, false);
  options.refs.reconnectStore.clearManualClosed(options.sessionId);
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
  reconnectSession: (sessionId: string, options?: ReconnectSessionRuntimeOptions) => void;
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
    reconnectStore: SessionReconnectStore;
    stateRef: MutableRefObject<SessionLikeState & { liveSessionIds?: string[] }>;
  };
  readSessionTransportHost: (sessionId: string) => Host | null;
  shouldAutoReconnectSessionFn: typeof shouldAutoReconnectSession;
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
  emitSessionStatus: (sessionId: string, type: 'closed' | 'error', message?: string) => void;
  startReconnectAttempt: (sessionId: string) => void;
}) {
  if (options.refs.reconnectStore.isManualClosed(options.sessionId)) {
    options.refs.reconnectStore.deleteRuntime(options.sessionId);
    return;
  }
  if (!options.readSessionTransportHost(options.sessionId)) {
    options.refs.reconnectStore.deleteRuntime(options.sessionId);
    return;
  }

  if (!options.retryable) {
    options.refs.reconnectStore.deleteRuntime(options.sessionId);
    options.updateSessionSync(options.sessionId, buildSessionErrorUpdates(options.message, { includeWsNull: true }));
    options.emitSessionStatus(options.sessionId, 'error', options.message);
    return;
  }

  if (!options.shouldAutoReconnectSessionFn({
    sessionId: options.sessionId,
    activeSessionId: options.refs.stateRef.current.activeSessionId,
    liveSessionIds: options.refs.stateRef.current.liveSessionIds,
    force: options.reconnectOptions?.force,
  })) {
    options.refs.reconnectStore.deleteRuntime(options.sessionId);
    options.updateSessionSync(options.sessionId, buildSessionIdleAfterReconnectBlockedUpdates(options.message));
    return;
  }

  const existingReconnectRuntime = options.refs.reconnectStore.read(options.sessionId)
    || options.refs.reconnectStore.createRuntime();
  options.refs.reconnectStore.clearTimer(options.sessionId);
  const reconnectRuntime: SessionReconnectRuntime = {
    phase: 'idle',
    attempt: options.reconnectOptions?.resetAttempt ? 0 : existingReconnectRuntime.attempt,
    nextDelayMs: options.reconnectOptions?.immediate ? 0 : existingReconnectRuntime.nextDelayMs,
  };
  options.refs.reconnectStore.write(options.sessionId, reconnectRuntime);

  options.updateSessionSync(
    options.sessionId,
    buildSessionReconnectingFailureUpdates(options.message, reconnectRuntime.attempt),
  );
  // 连续失败上限：attempt 已在 startReconnectAttempt 后递增写回，达到上限
  // 停止自动重试并显式报错（网络黑洞下不再无限循环耗电），active-reentry /
  // resume / 手动重连仍会重新尝试。
  if (reconnectRuntime.attempt >= MAX_RECONNECT_ATTEMPTS) {
    options.refs.reconnectStore.deleteRuntime(options.sessionId);
    options.updateSessionSync(
      options.sessionId,
      buildSessionErrorUpdates('reconnect: max attempts reached', { includeWsNull: true }),
    );
    options.emitSessionStatus(
      options.sessionId,
      'error',
      '自动重连失败次数过多，请手动重连',
    );
    return;
  }
  options.startReconnectAttempt(options.sessionId);
}

export function startReconnectAttemptRuntime(options: {
  sessionId: string;
  refs: {
    reconnectStore: SessionReconnectStore;
  };
  readSessionTransportHost: (sessionId: string) => Host | null;
  computeReconnectDelay: (attempt: number) => number;
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
  writeSessionTransportToken: (sessionId: string, token: string | null) => string | null;
  writeSessionTransportHost?: (sessionId: string, host: Host) => void;
  queueReconnectTransportOpenIntent: (sessionId: string, host: Host) => void;
  probeReconnectHost?: (bridgeHost: string, bridgePort: number) => Promise<boolean>;
}) {
  if (options.refs.reconnectStore.isManualClosed(options.sessionId)) {
    options.refs.reconnectStore.deleteRuntime(options.sessionId);
    return;
  }
  const reconnectRuntime = options.refs.reconnectStore.read(options.sessionId);
  const targetHost = options.readSessionTransportHost(options.sessionId);
  if (!reconnectRuntime || !targetHost) {
    options.refs.reconnectStore.deleteRuntime(options.sessionId);
    return;
  }
  if (reconnectRuntime.phase === 'scheduled' || reconnectRuntime.phase === 'connecting') {
    return;
  }

  const delay = reconnectRuntime.nextDelayMs ?? options.computeReconnectDelay(reconnectRuntime.attempt);
  const timer = globalThis.setTimeout(() => {
    if (options.refs.reconnectStore.isManualClosed(options.sessionId)) {
      options.refs.reconnectStore.deleteRuntime(options.sessionId);
      return;
    }
    const liveRuntime = options.refs.reconnectStore.read(options.sessionId);
    if (!liveRuntime) {
      return;
    }
    options.refs.reconnectStore.markConnecting(options.sessionId);

    const liveHost = options.readSessionTransportHost(options.sessionId);
    if (!liveHost) {
      options.refs.reconnectStore.deleteRuntime(options.sessionId);
      return;
    }

    options.updateSessionSync(
      options.sessionId,
      buildSessionReconnectAttemptProgressUpdates(liveRuntime.attempt + 1),
    );
    options.writeSessionTransportToken(options.sessionId, null);
    // Probe the current host before opening the reconnect intent. If the
    // cached bridgeHost is unreachable (e.g. switched networks, daemon moved
    // IP) we fall through to the next candidate endpoint in priority order
    // before queueing the open intent. This prevents a tight reconnect loop
    // against a stale host.
    void runReconnectHostProbeAndFallback({
      sessionId: options.sessionId,
      host: liveHost,
      attempt: liveRuntime.attempt + 1,
      probe: options.probeReconnectHost,
      writeHost: options.writeSessionTransportHost,
      updateSessionSync: options.updateSessionSync,
      queueReconnectTransportOpenIntent: options.queueReconnectTransportOpenIntent,
      refreshStore: options.refs.reconnectStore,
      isManualClosed: () => options.refs.reconnectStore.isManualClosed(options.sessionId),
      deleteRuntime: () => options.refs.reconnectStore.deleteRuntime(options.sessionId),
    });
  }, delay) as unknown as number;
  options.refs.reconnectStore.schedule(options.sessionId, {
    // 递增 attempt：每次失败后写回，让 backoff（computeReconnectDelay）真正
    // 生效（300→600→1200→…cap）。此前 attempt 从不递增，失败循环每次都
    // 从 0 开始 300ms 高频重试——网络黑洞下无限快速循环（耗电 + 永远连不上）。
    attempt: reconnectRuntime.attempt + 1,
    nextDelayMs: null,
    timer,
  });
}

type ReconnectHostProbeAndFallbackOptions = {
  sessionId: string;
  host: Host;
  attempt: number;
  probe?: (bridgeHost: string, bridgePort: number) => Promise<boolean>;
  writeHost?: (sessionId: string, host: Host) => void;
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
  queueReconnectTransportOpenIntent: (sessionId: string, host: Host) => void;
  refreshStore: SessionReconnectStore;
  isManualClosed: () => boolean;
  deleteRuntime: () => void;
};

export async function runReconnectHostProbeAndFallback(options: ReconnectHostProbeAndFallbackOptions) {
  const fallback = buildReconnectHostFallback(options.host);
  const candidates = fallback.candidates;
  if (candidates.length === 0) {
    options.queueReconnectTransportOpenIntent(options.sessionId, options.host);
    return;
  }

  if (options.isManualClosed()) {
    options.deleteRuntime();
    return;
  }

  // Default probe implementation - keep tiny (1.5s) so a dead host does not
  // delay the user-visible reconnect.
  const probe = options.probe ?? (async (bridgeHost: string, bridgePort: number) => {
    const result = await probeHostReachable(bridgeHost, bridgePort, { protocol: 'http', timeoutMs: 1500 });
    return result.reachable;
  });

  // First attempt: connect directly to the current host without probing so a
  // healthy endpoint recovers immediately (fast path).
  if (options.attempt === 0) {
    options.queueReconnectTransportOpenIntent(options.sessionId, options.host);
    return;
  }

  // Retry: the cached bridgeHost already failed, so probe every candidate
  // endpoint in parallel and queue the first reachable one. This prevents a
  // tight reconnect loop against a stale host while keeping the fallback
  // latency at one probe timeout instead of N serial timeouts.
  const probeResults = await Promise.all(
    candidates.map(async (candidate): Promise<{ candidate: ReconnectHostCandidate; reachable: boolean }> => {
      if (options.isManualClosed()) {
        return { candidate, reachable: false };
      }
      try {
        return { candidate, reachable: await probe(candidate.bridgeHost, candidate.bridgePort) };
      } catch {
        return { candidate, reachable: false };
      }
    }),
  );

  if (options.isManualClosed()) {
    options.deleteRuntime();
    return;
  }

  const reachableEntry = probeResults.find((entry) => entry.reachable);
  if (reachableEntry) {
    const { candidate } = reachableEntry;
    let nextHost: Host = options.host;
    if (
      candidate.bridgeHost.trim().toLowerCase() !== options.host.bridgeHost.trim().toLowerCase()
      || candidate.bridgePort !== options.host.bridgePort
    ) {
      nextHost = {
        ...options.host,
        bridgeHost: candidate.bridgeHost,
        bridgePort: candidate.bridgePort,
      };
      options.writeHost?.(options.sessionId, nextHost);
      options.updateSessionSync(options.sessionId, {
        bridgeHost: candidate.bridgeHost,
        bridgePort: candidate.bridgePort,
        lastError: `reconnect via ${candidate.label}`,
      });
    }
    options.queueReconnectTransportOpenIntent(options.sessionId, nextHost);
    return;
  }

  // No candidate answers the probe. Keep the reconnect intent alive against
  // the current host anyway - TraversalSocket will race all of its candidate
  // paths - so a manual reconnect (or a host the probe cannot see) is never
  // silently dropped. This preserves the original "index 0 always queued"
  // contract while still preferring a reachable fallback endpoint.
  options.updateSessionSync(options.sessionId, {
    lastError: 'reconnect: all host candidates unreachable, retrying current host',
  });
  options.queueReconnectTransportOpenIntent(options.sessionId, options.host);
}
