import { useEffect, useRef } from 'react';
import { getSessionTransportResource, type SessionTransportRuntimeStore } from '../lib/session-transport-runtime';
import type { SessionHeartbeatStore } from '../lib/session-heartbeat-store';
import type { SessionDebugOverlayMetrics, SessionScheduleState, SessionState } from '../lib/types';
import type { SessionManagerState } from './session-context-core';
import type { SessionReconnectStore } from '../lib/session-reconnect-store';
import { getPrimarySessionPullState, hasActiveSessionPullState } from '../lib/session-pull-state-helpers';


/** Transport health signals for cadence decisions */
export interface TransportHealth {
  /** Bytes buffered in the WebSocket send queue */
  bufferedBytes: number;
  /** True when send queue exceeds 128 KiB threshold */
  backpressured: boolean;
  /** True when session transport is connected */
  connected: boolean;
}

/** Backpressure threshold matching session-render-gate.ts and buffer-runtime */
const PASSIVE_BACKPRESSURE_BYTES = 128 * 1024;


interface SessionDebugMetricsStoreLike {
  refresh: (
    sessions: Array<{
      sessionId: string;
      sessionState: SessionState;
      active: boolean;
      pullStatePurpose: 'tail-refresh' | 'reading-repair' | null;
      bufferPullActive: boolean;
      transportBufferedBytes?: number;
      transportBackpressured?: boolean;
    }>,
    now: number,
  ) => Record<string, SessionDebugOverlayMetrics | undefined>;
}

interface RemoteScreenshotRuntimeLike {
  dispose: (reason: string) => void;
}

interface RemoteWindowMessageRuntimeLike {
  dispose: (reason: string) => void;
}

interface RemoteWindowReceiverRuntimeLike {
  dispose: (reason: string) => void;
}

export function collectNewlyVisibleLiveSessionIds(previousIds: string[], nextIds: string[]) {
  const previousSet = new Set(previousIds.filter(Boolean));
  return nextIds.filter((sessionId) => Boolean(sessionId) && !previousSet.has(sessionId));
}

export function collectNewlyMaterializedLiveSessionIds(
  previousRuntimeSessionIds: string[],
  nextRuntimeSessionIds: string[],
  liveSessionIds: string[],
) {
  const previousSet = new Set(previousRuntimeSessionIds.filter(Boolean));
  const liveSet = new Set(liveSessionIds.filter(Boolean));
  return nextRuntimeSessionIds.filter((sessionId) => liveSet.has(sessionId) && !previousSet.has(sessionId));
}

export function buildLifecycleRefreshTargets(state: Pick<SessionManagerState, 'activeSessionId' | 'liveSessionIds'>) {
  return state.activeSessionId ? [state.activeSessionId] : [];
}

export function buildPassiveVisibleRefreshTargets(state: Pick<SessionManagerState, 'activeSessionId' | 'liveSessionIds'>) {
  return Array.from(new Set(
    (Array.isArray(state.liveSessionIds) ? state.liveSessionIds : [])
      .filter((sessionId) => Boolean(sessionId) && sessionId !== state.activeSessionId),
  ));
}

/**
 * Resolves the passive visible pane refresh cadence in milliseconds.
 *
 * Fast lane (16-50ms): transport connected, no backpressure, low buffered bytes.
 * Medium lane (50-100ms): transport connected, moderate buffered bytes.
 * Slow lane (100-240ms): backpressured, disconnected, or high buffered bytes.
 *
 * Does NOT read active tick multiplied by a fixed factor — passive cadence is
 * driven by transport health, not by the active session's tick rate.
 */
export function resolvePassiveVisibleRefreshTickMs(
  activeHeadRefreshTickMs: number,
  transportHealth?: TransportHealth,
): number {
  const normalizedActiveTickMs = Math.max(16, Math.floor(activeHeadRefreshTickMs || 33));

  // No transport health signal: conservative slow lane (backward compatible)
  if (!transportHealth) {
    return Math.max(160, Math.min(240, normalizedActiveTickMs * 6));
  }

  const { bufferedBytes, backpressured, connected } = transportHealth;

  if (!connected || backpressured || bufferedBytes >= PASSIVE_BACKPRESSURE_BYTES) {
    // Slow lane: disconnected or backpressured — stay conservative
    return Math.max(100, Math.min(240, normalizedActiveTickMs * 6));
  }

  if (bufferedBytes === 0) {
    // Fast lane: clean transport — allow near-active cadence
    return Math.max(16, Math.min(50, normalizedActiveTickMs));
  }

  // Medium lane: some bytes buffered but below backpressure threshold
  return Math.max(50, Math.min(100, normalizedActiveTickMs * 2));
}

export function resolvePassiveTickTransportHealth(
  sessionId: string,
  sessionState: string,
  transportRuntimeStoreRef: { current: SessionTransportRuntimeStore },
): TransportHealth {
  const socket = getSessionTransportResource(transportRuntimeStoreRef.current, sessionId).socket;
  const bufferedBytes = Number.isFinite(socket?.bufferedAmount)
    ? Math.max(0, Math.floor(socket?.bufferedAmount ?? 0))
    : 0;
  return {
    bufferedBytes,
    backpressured: bufferedBytes >= PASSIVE_BACKPRESSURE_BYTES,
    connected: sessionState === 'connected',
  };
}

export function shouldScheduleActiveTickRefresh(options: {
  state: Pick<SessionManagerState, 'sessions' | 'activeSessionId' | 'liveSessionIds'>;
  sessionId: string;
  heartbeatStore: SessionHeartbeatStore;
  lastConnectedBaselineAtRef?: { current: Map<string, number> };
  headStalePingMs: number;
  now?: number;
}) {
  const session = options.state.sessions.find((item) => item.id === options.sessionId) || null;
  if (!session) {
    return false;
  }
  if (session.state !== 'connected') {
    return true;
  }
  const lastTerminalActivityAt = resolveTerminalActivityAt({
    sessionId: options.sessionId,
    heartbeatStore: options.heartbeatStore,
    lastConnectedBaselineAtRef: options.lastConnectedBaselineAtRef,
  });
  if (lastTerminalActivityAt <= 0) {
    return options.state.activeSessionId === options.sessionId;
  }
  const now = options.now ?? Date.now();
  return now - lastTerminalActivityAt >= Math.max(0, Math.floor(options.headStalePingMs || 0));
}

export function shouldSchedulePassiveVisibleTickRefresh(options: {
  state: Pick<SessionManagerState, 'sessions' | 'activeSessionId' | 'liveSessionIds'>;
  sessionId: string;
  heartbeatStore: SessionHeartbeatStore;
  lastConnectedBaselineAtRef?: { current: Map<string, number> };
  headStalePingMs: number;
  now?: number;
}) {
  const session = options.state.sessions.find((item) => item.id === options.sessionId) || null;
  if (!session) {
    return false;
  }
  if (session.state !== 'connected') {
    return true;
  }
  if (options.state.activeSessionId === options.sessionId) {
    return false;
  }
  const lastTerminalActivityAt = resolveTerminalActivityAt({
    sessionId: options.sessionId,
    heartbeatStore: options.heartbeatStore,
    lastConnectedBaselineAtRef: options.lastConnectedBaselineAtRef,
  });
  if (lastTerminalActivityAt <= 0) {
    return true;
  }
  const now = options.now ?? Date.now();
  return now - lastTerminalActivityAt >= Math.max(0, Math.floor(options.headStalePingMs || 0));
}

export function selectNextPassiveVisibleRefreshCandidate<TSessionId extends string>(
  refreshTargets: TSessionId[],
  cursor: number,
  shouldRefresh: (sessionId: TSessionId) => boolean,
): { sessionId: TSessionId | null; nextCursor: number } {
  if (refreshTargets.length === 0) {
    return { sessionId: null, nextCursor: 0 };
  }
  if (!Number.isFinite(cursor) || !Number.isInteger(cursor) || cursor < 0) {
    throw new Error('[session-context-lifecycle] passive visible refresh cursor must be a non-negative integer.');
  }
  const safeCursor = cursor % refreshTargets.length;
  const orderedRefreshTargets = [
    ...refreshTargets.slice(safeCursor),
    ...refreshTargets.slice(0, safeCursor),
  ];
  const selectedSessionId = orderedRefreshTargets.find((candidateSessionId) => shouldRefresh(candidateSessionId)) || null;
  const selectedIndex = selectedSessionId === null ? -1 : refreshTargets.indexOf(selectedSessionId);
  return {
    sessionId: selectedSessionId,
    nextCursor: selectedIndex >= 0 ? (selectedIndex + 1) % refreshTargets.length : safeCursor,
  };
}

function resolveTerminalActivityAt(options: {
  sessionId: string;
  heartbeatStore: SessionHeartbeatStore;
  lastConnectedBaselineAtRef?: { current: Map<string, number> };
}) {
  return Math.max(
    options.heartbeatStore.readLastTerminalActivityAt(options.sessionId),
    options.lastConnectedBaselineAtRef?.current.get(options.sessionId) || 0,
  );
}

export function useSessionContextLifecycle(options: {
  appForegroundActive?: boolean;
  foregroundResumeEpoch?: number;
  state: SessionManagerState;
  scheduleStates: Record<string, SessionScheduleState>;
  refs: {
    foregroundActiveRef: { current: boolean };
    stateRef: { current: SessionManagerState };
    scheduleStatesRef: { current: Record<string, SessionScheduleState> };
    sessionDebugMetricsStoreRef: { current: SessionDebugMetricsStoreLike };
    transportRuntimeStoreRef: { current: SessionTransportRuntimeStore };
    sessionPullStateRef: { current: Map<string, unknown> };
    lastActivatedSessionIdRef: { current: string | null };
    lastActiveReentryAtRef: { current: Map<string, number> };
    lastConnectedBaselineAtRef: { current: Map<string, number> };
    heartbeatStore: SessionHeartbeatStore;
    remoteScreenshotRuntimeRef: { current: RemoteScreenshotRuntimeLike };
    remoteWindowMessageRuntimeRef: { current: RemoteWindowMessageRuntimeLike };
    remoteWindowReceiverRuntimeRef?: { current: RemoteWindowReceiverRuntimeLike };
    handshakeTimeoutsRef: { current: Map<string, number> };
    reconnectStore: SessionReconnectStore;
  };
  flushRuntimeDebugLogs: () => void;
  clientRuntimeDebugFlushIntervalMs: number;
  ensureActiveSessionFresh: (options: {
    sessionId: string;
    source: 'explicit-resume' | 'active-reentry' | 'active-tick';
    forceHead?: boolean;
    markResumeTail?: boolean;
    allowReconnectIfUnavailable?: boolean;
  }) => boolean;
  resolveActiveHeadRefreshTickMs: (sessionId?: string | null) => number;
  resolveHeadStalePingMs: (sessionId?: string | null) => number;
  clearSessionHandshakeTimeout: (sessionId: string) => void;
  cleanupSocket: (sessionId: string, shouldClose?: boolean) => void;
  cleanupControlSocket: (sessionId: string, shouldClose?: boolean) => void;
}) {
  const flushRuntimeDebugLogsRef = useRef(options.flushRuntimeDebugLogs);
  const lastLiveSessionIdsRef = useRef<string[]>([]);
  const lastRuntimeSessionIdsRef = useRef<string[]>([]);
  const passiveVisibleRefreshCursorRef = useRef(0);
  const lastForegroundActiveRef = useRef(options.appForegroundActive !== false);
  const lastForegroundResumeEpochRef = useRef<number | null>(
    Number.isFinite(options.foregroundResumeEpoch)
      ? Number(options.foregroundResumeEpoch)
      : null,
  );
  const cleanupSocketRef = useRef(options.cleanupSocket);
  const cleanupControlSocketRef = useRef(options.cleanupControlSocket);
  const clearSessionHandshakeTimeoutRef = useRef(options.clearSessionHandshakeTimeout);

  useEffect(() => {
    cleanupSocketRef.current = options.cleanupSocket;
  }, [options.cleanupSocket]);

  useEffect(() => {
    cleanupControlSocketRef.current = options.cleanupControlSocket;
  }, [options.cleanupControlSocket]);

  useEffect(() => {
    clearSessionHandshakeTimeoutRef.current = options.clearSessionHandshakeTimeout;
  }, [options.clearSessionHandshakeTimeout]);

  useEffect(() => {
    const nextForegroundActive = options.appForegroundActive !== false;
    const previousForegroundActive = lastForegroundActiveRef.current;
    options.refs.foregroundActiveRef.current = nextForegroundActive;
    lastForegroundActiveRef.current = nextForegroundActive;
    if (!nextForegroundActive) {
      return;
    }
    const nextForegroundResumeEpoch = Number.isFinite(options.foregroundResumeEpoch)
      ? Number(options.foregroundResumeEpoch)
      : null;
    if (nextForegroundResumeEpoch !== null) {
      if (lastForegroundResumeEpochRef.current === nextForegroundResumeEpoch) {
        return;
      }
      lastForegroundResumeEpochRef.current = nextForegroundResumeEpoch;
    } else if (previousForegroundActive === nextForegroundActive) {
      return;
    }
    const activeSessionId = options.refs.stateRef.current.activeSessionId;
    if (!activeSessionId) {
      return;
    }
    options.ensureActiveSessionFresh({
      sessionId: activeSessionId,
      source: 'explicit-resume',
      forceHead: true,
      markResumeTail: true,
      allowReconnectIfUnavailable: false,
    });
  }, [options.appForegroundActive, options.foregroundResumeEpoch]);

  useEffect(() => {
    options.refs.stateRef.current = options.state;
  }, [options.state]);

  useEffect(() => {
    options.refs.scheduleStatesRef.current = options.scheduleStates;
  }, [options.scheduleStates]);

  useEffect(() => {
    flushRuntimeDebugLogsRef.current = options.flushRuntimeDebugLogs;
  }, [options.flushRuntimeDebugLogs]);

  useEffect(() => {
    if (options.appForegroundActive === false) {
      return;
    }
    const timer = window.setInterval(() => {
      const now = Date.now();
      options.refs.sessionDebugMetricsStoreRef.current.refresh(
        options.refs.stateRef.current.sessions.map((session) => {
          const pullStates = options.refs.sessionPullStateRef.current.get(session.id) || null;
          const pullState = getPrimarySessionPullState(pullStates as any);
          const effectiveSocket = getSessionTransportResource(options.refs.transportRuntimeStoreRef.current, session.id).socket;
          const transportBufferedBytes = Number.isFinite(effectiveSocket?.bufferedAmount)
            ? Math.max(0, Math.floor(effectiveSocket?.bufferedAmount || 0))
            : 0;
          return {
            sessionId: session.id,
            sessionState: session.state,
            active: options.refs.stateRef.current.activeSessionId === session.id,
            pullStatePurpose: pullState?.purpose || null,
            bufferPullActive: hasActiveSessionPullState((pullStates as any) || null),
            transportBufferedBytes,
            transportBackpressured: transportBufferedBytes >= 128 * 1024,
          };
        }),
        now,
      );
    }, 500);

    return () => window.clearInterval(timer);
  }, [options.appForegroundActive]);

  useEffect(() => {
    if (!options.state.activeSessionId) {
      options.refs.lastActivatedSessionIdRef.current = null;
      return;
    }
    if (options.refs.lastActivatedSessionIdRef.current === options.state.activeSessionId) {
      return;
    }
    options.refs.lastActivatedSessionIdRef.current = options.state.activeSessionId;
    options.ensureActiveSessionFresh({
      sessionId: options.state.activeSessionId,
      source: 'active-reentry',
      forceHead: true,
      markResumeTail: true,
      allowReconnectIfUnavailable: true,
    });
  }, [options.ensureActiveSessionFresh, options.state.activeSessionId]);

  useEffect(() => {
    const nextLiveSessionIds = Array.isArray(options.state.liveSessionIds)
      ? options.state.liveSessionIds
      : [];
    const previousLiveSessionIds = lastLiveSessionIdsRef.current;
    const previousRuntimeSessionIds = lastRuntimeSessionIdsRef.current;
    const nextRuntimeSessionIds = options.state.sessions.map((session) => session.id);
    const nextRuntimeSessionIdsSet = new Set(nextRuntimeSessionIds);
    lastLiveSessionIdsRef.current = nextLiveSessionIds;
    lastRuntimeSessionIdsRef.current = nextRuntimeSessionIds;
    const refreshTargets = Array.from(new Set([
      ...collectNewlyVisibleLiveSessionIds(previousLiveSessionIds, nextLiveSessionIds)
        .filter((sessionId) => nextRuntimeSessionIdsSet.has(sessionId)),
      ...collectNewlyMaterializedLiveSessionIds(
        previousRuntimeSessionIds,
        nextRuntimeSessionIds,
        nextLiveSessionIds,
      ),
    ]));
    refreshTargets.forEach((sessionId) => {
      if (sessionId === options.state.activeSessionId) {
        return;
      }
      options.ensureActiveSessionFresh({
        sessionId,
        source: 'explicit-resume',
        forceHead: true,
        allowReconnectIfUnavailable: true,
      });
    });
  }, [options.ensureActiveSessionFresh, options.state.liveSessionIds, options.state.sessions]);

  useEffect(() => {
    if (options.appForegroundActive === false) {
      return;
    }
    const timer = window.setInterval(() => {
      flushRuntimeDebugLogsRef.current();
    }, options.clientRuntimeDebugFlushIntervalMs);
    return () => window.clearInterval(timer);
  }, [options.appForegroundActive, options.clientRuntimeDebugFlushIntervalMs]);

  useEffect(() => {
    if (options.appForegroundActive === false) {
      return;
    }
    let cancelled = false;
    let timer: number | null = null;

    const scheduleNext = () => {
      if (cancelled) {
        return;
      }
      if (!options.refs.foregroundActiveRef.current) {
        return;
      }
      const nextDelay = Math.max(16, options.resolveActiveHeadRefreshTickMs(options.refs.stateRef.current.activeSessionId));
      timer = window.setTimeout(() => {
        if (cancelled) {
          return;
        }
        if (!options.refs.foregroundActiveRef.current) {
          return;
        }
        const activeSessionId = options.refs.stateRef.current.activeSessionId;
        if (!activeSessionId) {
          scheduleNext();
          return;
        }
        const now = Date.now();
        const headStalePingMs = options.resolveHeadStalePingMs(activeSessionId);
        if (shouldScheduleActiveTickRefresh({
          state: options.refs.stateRef.current,
          sessionId: activeSessionId,
          heartbeatStore: options.refs.heartbeatStore,
          lastConnectedBaselineAtRef: options.refs.lastConnectedBaselineAtRef,
          headStalePingMs,
          now,
        })) {
          options.ensureActiveSessionFresh({
            sessionId: activeSessionId,
            source: 'active-tick',
            allowReconnectIfUnavailable: options.refs.foregroundActiveRef.current,
          });
        }
        scheduleNext();
      }, nextDelay);
    };

    scheduleNext();

    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [options.appForegroundActive, options.ensureActiveSessionFresh, options.resolveActiveHeadRefreshTickMs, options.resolveHeadStalePingMs]);

  useEffect(() => {
    if (options.appForegroundActive === false) {
      return;
    }
    let cancelled = false;
    let timer: number | null = null;

    const scheduleNext = () => {
      if (cancelled) {
        return;
      }
      if (!options.refs.foregroundActiveRef.current) {
        return;
      }
      const refreshTargets = buildPassiveVisibleRefreshTargets(options.refs.stateRef.current);
      const nextDelay = refreshTargets.length === 0
        ? Math.max(100, resolvePassiveVisibleRefreshTickMs(
            options.resolveActiveHeadRefreshTickMs(options.refs.stateRef.current.activeSessionId),
          ))
        : Math.min(...refreshTargets.map((sessionId) => {
            const session = options.refs.stateRef.current.sessions.find((item) => item.id === sessionId);
            return resolvePassiveVisibleRefreshTickMs(
              options.resolveActiveHeadRefreshTickMs(options.refs.stateRef.current.activeSessionId),
              resolvePassiveTickTransportHealth(
                sessionId,
                session?.state || 'disconnected',
                options.refs.transportRuntimeStoreRef,
              ),
            );
          }));

      timer = window.setTimeout(() => {
        if (cancelled) {
          return;
        }
        if (refreshTargets.length === 0) {
          scheduleNext();
          return;
        }
        const now = Date.now();
        const candidate = selectNextPassiveVisibleRefreshCandidate(
          refreshTargets,
          passiveVisibleRefreshCursorRef.current,
          (candidateSessionId) => {
            const headStalePingMs = options.resolveHeadStalePingMs(candidateSessionId);
            return shouldSchedulePassiveVisibleTickRefresh({
              state: options.refs.stateRef.current,
              sessionId: candidateSessionId,
              heartbeatStore: options.refs.heartbeatStore,
              lastConnectedBaselineAtRef: options.refs.lastConnectedBaselineAtRef,
              headStalePingMs,
              now,
            });
          },
        );
        passiveVisibleRefreshCursorRef.current = candidate.nextCursor;
        const sessionId = candidate.sessionId;
        if (sessionId) {
          options.ensureActiveSessionFresh({
            sessionId,
            source: 'active-tick',
            allowReconnectIfUnavailable: options.refs.foregroundActiveRef.current,
          });
        }
        scheduleNext();
      }, nextDelay);
    };

    scheduleNext();

    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [options.appForegroundActive, options.ensureActiveSessionFresh, options.resolveActiveHeadRefreshTickMs, options.resolveHeadStalePingMs]);

  useEffect(() => () => {
    options.refs.remoteScreenshotRuntimeRef.current.dispose(
      'Session provider disposed before remote screenshot completed',
    );
    options.refs.remoteWindowMessageRuntimeRef.current.dispose(
      'Session provider disposed before remote window request completed',
    );
    options.refs.remoteWindowReceiverRuntimeRef?.current.dispose(
      'Session provider disposed before remote window receiver completed',
    );
    options.refs.heartbeatStore.clearAllPingIntervals();
    for (const sessionId of options.refs.handshakeTimeoutsRef.current.keys()) {
      clearSessionHandshakeTimeoutRef.current(sessionId);
    }
    options.refs.reconnectStore.clearAllReconnectRuntimes();
    for (const session of options.refs.stateRef.current.sessions) {
      options.refs.reconnectStore.markManualClosed(session.id);
      cleanupSocketRef.current(session.id, true);
      cleanupControlSocketRef.current(session.id, true);
    }
  }, []);
}
