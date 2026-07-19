import type { Session } from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import {
  buildSessionTransportWaitUpdates,
  buildActiveSessionRefreshPlan,
} from './session-transport-open-helpers';

interface MutableRefObject<T> {
  current: T;
}

interface RuntimeDebugFn {
  (event: string, payload?: Record<string, unknown>): void;
}

interface SessionTransportRuntimeLike {
  targetKey: string | null;
}

interface SessionTargetRuntimeLike {
  sessionIds: string[];
}

export const ACTIVE_SESSION_PENDING_OPEN_STALE_MS = 1200;
export const SESSION_TRANSPORT_KEEPALIVE_GRACE_MS = 2 * 60 * 1000;

export function resolveSessionTransportKeepaliveGrace(options: {
  sessionId: string;
  refs: {
    lastConnectedBaselineAtRef: MutableRefObject<Map<string, number>>;
    lastServerActivityAtRef: MutableRefObject<Map<string, number>>;
  };
  now?: number;
  graceMs?: number;
}) {
  const now = options.now ?? Date.now();
  const graceMs = Math.max(0, Math.floor(options.graceMs ?? SESSION_TRANSPORT_KEEPALIVE_GRACE_MS));
  const lastServerActivityAt = options.refs.lastServerActivityAtRef.current.get(options.sessionId) || 0;
  const lastConnectedBaselineAt = options.refs.lastConnectedBaselineAtRef.current.get(options.sessionId) || 0;
  const lastAliveAt = Math.max(lastServerActivityAt, lastConnectedBaselineAt);
  const ageMs = lastAliveAt > 0 ? now - lastAliveAt : Number.POSITIVE_INFINITY;
  return {
    active: lastAliveAt > 0 && ageMs >= 0 && ageMs < graceMs,
    lastAliveAt: lastAliveAt || null,
    ageMs: Number.isFinite(ageMs) ? ageMs : null,
    graceMs,
  };
}

export function ensureActiveSessionFreshRuntime(options: {
  refreshOptions: {
    sessionId: string;
    source: 'explicit-resume' | 'active-reentry' | 'active-tick';
    forceHead?: boolean;
    markResumeTail?: boolean;
    allowReconnectIfUnavailable?: boolean;
  };
  refs: {
    stateRef: MutableRefObject<{ sessions: Session[]; activeSessionId: string | null; liveSessionIds?: string[] }>;
    pendingResumeTailRefreshRef: MutableRefObject<Set<string>>;
    lastActiveReentryAtRef: MutableRefObject<Map<string, number>>;
    lastConnectedBaselineAtRef: MutableRefObject<Map<string, number>>;
    connectedBaselineBurstGuardRef: MutableRefObject<Set<string>>;
    lastServerActivityAtRef: MutableRefObject<Map<string, number>>;
    lastHeadRequestAtRef: MutableRefObject<Map<string, number>>;
    staleTransportProbeAtRef: MutableRefObject<Map<string, number>>;
    reconnectRuntimesRef: MutableRefObject<Map<string, { connecting: boolean; timer: number | null }>>;
  };
  readSessionTransportRuntime: (sessionId: string) => SessionTransportRuntimeLike | null;
  readSessionTargetRuntime: (sessionId: string) => SessionTargetRuntimeLike | null;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  isReconnectInFlight: (sessionId: string) => boolean;
  hasPendingSessionTransportOpen: (sessionId: string) => boolean;
  isPendingSessionTransportOpenStale: (sessionId: string, staleAfterMs?: number) => boolean;
  isSessionTransportActivityStale: (sessionId: string) => boolean;
  runtimeDebug: RuntimeDebugFn;
  updateSessionSync?: (id: string, updates: Partial<Session>) => void;
  readSessionBufferSnapshot: (sessionId: string) => { revision: number; startIndex: number; endIndex: number };
  resetSessionTransportPullBookkeeping: (sessionId: string, reason: string) => void;
  requestSessionBufferHead: (sessionId: string, ws?: BridgeTransportSocket | null, options?: { force?: boolean }) => boolean;
  resolveTerminalRefreshCadence: (sessionId?: string | null) => { headTickMs: number; headStalePingMs: number; pullRequestStaleMs: number };
  reconnectSession: (sessionId: string) => void;
}) {
  const session = options.refs.stateRef.current.sessions.find((item) => item.id === options.refreshOptions.sessionId) || null;
  const transportRuntime = options.readSessionTransportRuntime(options.refreshOptions.sessionId);
  const targetRuntime = options.readSessionTargetRuntime(options.refreshOptions.sessionId);
  const ws = options.readSessionTransportSocket(options.refreshOptions.sessionId) || null;
  const isActive = options.refs.stateRef.current.activeSessionId === options.refreshOptions.sessionId;
  const isLive = Array.isArray(options.refs.stateRef.current.liveSessionIds)
    && options.refs.stateRef.current.liveSessionIds.includes(options.refreshOptions.sessionId);
  const isExplicitResumeTarget = options.refreshOptions.source === 'explicit-resume';
  const isActiveReentryTarget = options.refreshOptions.source === 'active-reentry';
  const isRefreshTarget = isExplicitResumeTarget || isActiveReentryTarget || isActive || isLive;
  const sessionState = session?.state ?? null;
  const reconnectInFlight = options.isReconnectInFlight(options.refreshOptions.sessionId);
  const pendingTransportOpen = options.hasPendingSessionTransportOpen(options.refreshOptions.sessionId);
  const activePendingOpenStaleAfterMs = (
    options.refreshOptions.source === 'active-reentry'
    || options.refreshOptions.source === 'explicit-resume'
  )
    ? ACTIVE_SESSION_PENDING_OPEN_STALE_MS
    : undefined;
  const pendingTransportOpenStale = pendingTransportOpen
    ? options.isPendingSessionTransportOpenStale(
        options.refreshOptions.sessionId,
        activePendingOpenStaleAfterMs,
      )
    : false;
  const transportStale = session ? options.isSessionTransportActivityStale(options.refreshOptions.sessionId) : false;
  const now = Date.now();
  const keepaliveGrace = resolveSessionTransportKeepaliveGrace({
    sessionId: options.refreshOptions.sessionId,
    refs: {
      lastConnectedBaselineAtRef: options.refs.lastConnectedBaselineAtRef,
      lastServerActivityAtRef: options.refs.lastServerActivityAtRef,
    },
    now,
  });
  const keepaliveGraceActiveForLifecycle = (
    keepaliveGrace.active
    && (
      options.refreshOptions.source === 'explicit-resume'
      || options.refreshOptions.source === 'active-reentry'
    )
  );
  const refreshPlan = buildActiveSessionRefreshPlan({
    hasSession: Boolean(session),
    isRefreshTarget,
    sessionState,
    wsReadyState: ws?.readyState ?? null,
    reconnectInFlight,
    pendingTransportOpen,
    pendingTransportOpenStale,
    allowReconnectIfUnavailable: options.refreshOptions.allowReconnectIfUnavailable,
    keepaliveGraceActive: keepaliveGraceActiveForLifecycle,
    transportStale,
    source: options.refreshOptions.source,
  });

  if (refreshPlan.action === 'skip') {
    if (
      refreshPlan.reason === 'transport-open-pending'
      && (sessionState === 'reconnecting' || reconnectInFlight)
    ) {
      options.updateSessionSync?.(
        options.refreshOptions.sessionId,
        buildSessionTransportWaitUpdates('Waiting for existing websocket open'),
      );
    }
    options.runtimeDebug(`session.transport.${options.refreshOptions.source}.skip`, {
      sessionId: options.refreshOptions.sessionId,
      activeSessionId: options.refs.stateRef.current.activeSessionId,
      hasSession: Boolean(session),
      isActive,
      isLive,
      isExplicitResumeTarget,
      isActiveReentryTarget,
      isRefreshTarget,
      sessionState,
      wsReadyState: ws?.readyState ?? null,
      targetKey: transportRuntime?.targetKey || null,
      targetSessionCount: targetRuntime?.sessionIds.length || 0,
      pendingTransportOpenStale,
      activePendingOpenStaleAfterMs: activePendingOpenStaleAfterMs ?? null,
      keepaliveGraceActive: keepaliveGraceActiveForLifecycle,
      keepaliveGraceLastAliveAt: keepaliveGrace.lastAliveAt,
      keepaliveGraceAgeMs: keepaliveGrace.ageMs,
      keepaliveGraceMs: keepaliveGrace.graceMs,
      reason: refreshPlan.reason,
    });
    return false;
  }

  const localBuffer = options.readSessionBufferSnapshot(options.refreshOptions.sessionId);
  const cadence = options.resolveTerminalRefreshCadence(options.refreshOptions.sessionId);
  const pendingProbeStartedAt = options.refs.staleTransportProbeAtRef.current.get(options.refreshOptions.sessionId) || 0;
  const pendingProbeAgeMs = pendingProbeStartedAt > 0 ? now - pendingProbeStartedAt : 0;
  const staleProbeTimedOut = Boolean(
    ws?.readyState === WebSocket.OPEN
    && pendingProbeStartedAt > 0
    && pendingProbeAgeMs >= Math.max(1, Math.floor(cadence.pullRequestStaleMs || cadence.headStalePingMs || cadence.headTickMs || 1000))
  );
  options.runtimeDebug(`session.transport.${options.refreshOptions.source}`, {
    sessionId: options.refreshOptions.sessionId,
    activeSessionId: options.refs.stateRef.current.activeSessionId,
    isActive,
    isLive,
    isExplicitResumeTarget,
    isActiveReentryTarget,
    isRefreshTarget,
    localRevision: localBuffer.revision ?? null,
    localStartIndex: localBuffer.startIndex ?? null,
    localEndIndex: localBuffer.endIndex ?? null,
    transportStale,
    pendingTransportOpen,
    pendingTransportOpenStale,
    activePendingOpenStaleAfterMs: activePendingOpenStaleAfterMs ?? null,
    keepaliveGraceActive: keepaliveGraceActiveForLifecycle,
    keepaliveGraceLastAliveAt: keepaliveGrace.lastAliveAt,
    keepaliveGraceAgeMs: keepaliveGrace.ageMs,
    keepaliveGraceMs: keepaliveGrace.graceMs,
    pendingProbeStartedAt: pendingProbeStartedAt || null,
    pendingProbeAgeMs,
    staleProbeTimedOut,
    targetKey: transportRuntime?.targetKey || null,
    targetSessionCount: targetRuntime?.sessionIds.length || 0,
    plan: refreshPlan.action,
  });

  if (staleProbeTimedOut) {
    options.runtimeDebug('session.transport.head-probe.timeout', {
      sessionId: options.refreshOptions.sessionId,
      activeSessionId: options.refs.stateRef.current.activeSessionId,
      source: options.refreshOptions.source,
      pendingProbeStartedAt,
      pendingProbeAgeMs,
      wsReadyState: ws?.readyState ?? null,
    });
    options.refs.staleTransportProbeAtRef.current.delete(options.refreshOptions.sessionId);
  }

  if (refreshPlan.action === 'request-head') {
    if (refreshPlan.resetPullBookkeeping) {
      options.resetSessionTransportPullBookkeeping(
        options.refreshOptions.sessionId,
        options.refreshOptions.source,
      );
    }

    const lastActiveReentryAt = options.refs.lastActiveReentryAtRef.current.get(options.refreshOptions.sessionId) || 0;
    const shouldForceHeadRequest = Boolean(options.refreshOptions.forceHead);
    const shouldSkipImmediateForcedResumeHead = (
      options.refreshOptions.source === 'active-reentry'
      && shouldForceHeadRequest
      && ws?.readyState === WebSocket.OPEN
      && (
        (lastActiveReentryAt > 0 && now - lastActiveReentryAt < cadence.headTickMs)
        || options.refs.connectedBaselineBurstGuardRef.current.has(options.refreshOptions.sessionId)
      )
    );

    if (options.refreshOptions.markResumeTail) {
      options.refs.pendingResumeTailRefreshRef.current.add(options.refreshOptions.sessionId);
    }

    if (
      options.refreshOptions.source === 'active-tick'
      && ws?.readyState === WebSocket.OPEN
      && pendingProbeStartedAt > 0
      && !staleProbeTimedOut
    ) {
      options.runtimeDebug('session.transport.active-tick.head-probe.pending', {
        sessionId: options.refreshOptions.sessionId,
        activeSessionId: options.refs.stateRef.current.activeSessionId,
        pendingProbeStartedAt,
        pendingProbeAgeMs,
      });
      return false;
    }

    if (shouldSkipImmediateForcedResumeHead) {
      options.refs.connectedBaselineBurstGuardRef.current.delete(options.refreshOptions.sessionId);
      return true;
    }

    const requested = options.requestSessionBufferHead(
      options.refreshOptions.sessionId,
      ws,
      { force: options.refreshOptions.forceHead },
    );
    if (requested && !options.refs.staleTransportProbeAtRef.current.has(options.refreshOptions.sessionId)) {
      options.refs.staleTransportProbeAtRef.current.set(options.refreshOptions.sessionId, now);
    }
    if (requested && options.refreshOptions.source === 'active-reentry') {
      options.refs.lastActiveReentryAtRef.current.set(options.refreshOptions.sessionId, now);
    }
    return requested;
  }

  if (refreshPlan.action === 'reconnect') {
    options.reconnectSession(options.refreshOptions.sessionId);
    return true;
  }

  return false;
}
