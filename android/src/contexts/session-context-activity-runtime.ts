import type { Session } from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import {
  buildActiveSessionRefreshPlan,
} from './session-sync-helpers';

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

export function probeOrReconnectStaleSessionTransportRuntime(options: {
  sessionId: string;
  ws: BridgeTransportSocket;
  reason: 'active-reentry' | 'active-tick' | 'input';
  refs: {
    lastServerActivityAtRef: MutableRefObject<Map<string, number>>;
    staleTransportProbeAtRef: MutableRefObject<Map<string, number>>;
    stateRef: MutableRefObject<{ activeSessionId: string | null }>;
  };
  runtimeDebug: RuntimeDebugFn;
  resetSessionTransportPullBookkeeping: (sessionId: string, reason: string) => void;
  requestSessionBufferHead: (sessionId: string, ws?: BridgeTransportSocket | null, options?: { force?: boolean }) => boolean;
  reconnectSession: (sessionId: string) => void;
  activeTransportProbeWaitMs: number;
}) {
  const lastActivityAt = options.refs.lastServerActivityAtRef.current.get(options.sessionId) || 0;
  const lastProbeAt = options.refs.staleTransportProbeAtRef.current.get(options.sessionId) || 0;
  if (lastProbeAt <= 0 || lastProbeAt <= lastActivityAt) {
    options.runtimeDebug(`session.transport.${options.reason}.probe`, {
      sessionId: options.sessionId,
      activeSessionId: options.refs.stateRef.current.activeSessionId,
      lastServerActivityAt: lastActivityAt,
    });
    options.resetSessionTransportPullBookkeeping(options.sessionId, `${options.reason}-probe`);
    options.refs.staleTransportProbeAtRef.current.set(options.sessionId, Date.now());
    options.requestSessionBufferHead(options.sessionId, options.ws, { force: true });
    return 'probed' as const;
  }

  const probeAgeMs = Math.max(0, Date.now() - lastProbeAt);
  if (probeAgeMs < options.activeTransportProbeWaitMs) {
    options.runtimeDebug(`session.transport.${options.reason}.probe-wait`, {
      sessionId: options.sessionId,
      activeSessionId: options.refs.stateRef.current.activeSessionId,
      lastServerActivityAt: lastActivityAt,
      lastProbeAt,
      probeAgeMs,
    });
    return 'waiting' as const;
  }

  options.runtimeDebug(`session.transport.${options.reason}.reconnect-after-probe`, {
    sessionId: options.sessionId,
    activeSessionId: options.refs.stateRef.current.activeSessionId,
    lastServerActivityAt: lastActivityAt,
    lastProbeAt,
    probeAgeMs,
  });
  options.reconnectSession(options.sessionId);
  return 'reconnecting' as const;
}

export function ensureActiveSessionFreshRuntime(options: {
  refreshOptions: {
    sessionId: string;
    source: 'active-resume' | 'active-reentry' | 'active-tick';
    forceHead?: boolean;
    markResumeTail?: boolean;
    allowReconnectIfUnavailable?: boolean;
  };
  refs: {
    stateRef: MutableRefObject<{ sessions: Session[]; activeSessionId: string | null; liveSessionIds?: string[] }>;
    pendingResumeTailRefreshRef: MutableRefObject<Set<string>>;
    lastActiveReentryAtRef: MutableRefObject<Map<string, number>>;
  };
  readSessionTransportRuntime: (sessionId: string) => SessionTransportRuntimeLike | null;
  readSessionTargetRuntime: (sessionId: string) => SessionTargetRuntimeLike | null;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  isReconnectInFlight: (sessionId: string) => boolean;
  hasPendingSessionTransportOpen: (sessionId: string) => boolean;
  isSessionTransportActivityStale: (sessionId: string) => boolean;
  runtimeDebug: RuntimeDebugFn;
  readSessionBufferSnapshot: (sessionId: string) => { revision: number; startIndex: number; endIndex: number };
  probeOrReconnectStaleSessionTransport: (
    sessionId: string,
    ws: BridgeTransportSocket,
    reason: 'active-reentry' | 'active-tick' | 'input',
  ) => 'probed' | 'waiting' | 'reconnecting';
  resetSessionTransportPullBookkeeping: (sessionId: string, reason: string) => void;
  requestSessionBufferHead: (sessionId: string, ws?: BridgeTransportSocket | null, options?: { force?: boolean }) => boolean;
  resolveTerminalRefreshCadence: () => { headTickMs: number };
  reconnectSession: (sessionId: string) => void;
}) {
  const session = options.refs.stateRef.current.sessions.find((item) => item.id === options.refreshOptions.sessionId) || null;
  const transportRuntime = options.readSessionTransportRuntime(options.refreshOptions.sessionId);
  const targetRuntime = options.readSessionTargetRuntime(options.refreshOptions.sessionId);
  const ws = options.readSessionTransportSocket(options.refreshOptions.sessionId) || null;
  const isActive = options.refs.stateRef.current.activeSessionId === options.refreshOptions.sessionId;
  const isLive = Array.isArray(options.refs.stateRef.current.liveSessionIds)
    && options.refs.stateRef.current.liveSessionIds.includes(options.refreshOptions.sessionId);
  const isRefreshTarget = isActive || isLive;
  const sessionState = session?.state ?? null;
  const reconnectInFlight = options.isReconnectInFlight(options.refreshOptions.sessionId);
  const pendingTransportOpen = options.hasPendingSessionTransportOpen(options.refreshOptions.sessionId);

  const transportStale = session ? options.isSessionTransportActivityStale(options.refreshOptions.sessionId) : false;
  const refreshPlan = buildActiveSessionRefreshPlan({
    hasSession: Boolean(session),
    isRefreshTarget,
    sessionState,
    wsReadyState: ws?.readyState ?? null,
    reconnectInFlight,
    pendingTransportOpen,
    allowReconnectIfUnavailable: options.refreshOptions.allowReconnectIfUnavailable,
    transportStale,
    source: options.refreshOptions.source,
  });

  if (refreshPlan.action === 'skip') {
    options.runtimeDebug(`session.transport.${options.refreshOptions.source}.skip`, {
      sessionId: options.refreshOptions.sessionId,
      activeSessionId: options.refs.stateRef.current.activeSessionId,
      hasSession: Boolean(session),
      isActive,
      isLive,
      isRefreshTarget,
      sessionState,
      wsReadyState: ws?.readyState ?? null,
      targetKey: transportRuntime?.targetKey || null,
      targetSessionCount: targetRuntime?.sessionIds.length || 0,
      reason: refreshPlan.reason,
    });
    return false;
  }

  const localBuffer = options.readSessionBufferSnapshot(options.refreshOptions.sessionId);
  options.runtimeDebug(`session.transport.${options.refreshOptions.source}`, {
    sessionId: options.refreshOptions.sessionId,
    activeSessionId: options.refs.stateRef.current.activeSessionId,
    isActive,
    isLive,
    isRefreshTarget,
    localRevision: localBuffer.revision ?? null,
    localStartIndex: localBuffer.startIndex ?? null,
    localEndIndex: localBuffer.endIndex ?? null,
    transportStale,
    targetKey: transportRuntime?.targetKey || null,
    targetSessionCount: targetRuntime?.sessionIds.length || 0,
    plan: refreshPlan.action,
  });

  if (refreshPlan.action === 'probe-stale-transport') {
    if (ws) {
      options.probeOrReconnectStaleSessionTransport(
        options.refreshOptions.sessionId,
        ws,
        refreshPlan.probeReason,
      );
      return true;
    }
    return false;
  }

  if (refreshPlan.action === 'request-head') {
    if (refreshPlan.resetPullBookkeeping) {
      options.resetSessionTransportPullBookkeeping(
        options.refreshOptions.sessionId,
        options.refreshOptions.source,
      );
    }

    const now = Date.now();
    const cadence = options.resolveTerminalRefreshCadence();
    const lastActiveReentryAt = options.refs.lastActiveReentryAtRef.current.get(options.refreshOptions.sessionId) || 0;
    const shouldForceHeadRequest = Boolean(options.refreshOptions.forceHead);
    const shouldSkipImmediateForcedResumeHead = (
      options.refreshOptions.source === 'active-resume'
      && shouldForceHeadRequest
      && ws?.readyState === WebSocket.OPEN
      && lastActiveReentryAt > 0
      && now - lastActiveReentryAt < cadence.headTickMs
    );

    if (options.refreshOptions.markResumeTail) {
      options.refs.pendingResumeTailRefreshRef.current.add(options.refreshOptions.sessionId);
    }

    if (shouldSkipImmediateForcedResumeHead) {
      return true;
    }

    const requested = options.requestSessionBufferHead(
      options.refreshOptions.sessionId,
      ws,
      { force: options.refreshOptions.forceHead },
    );
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
