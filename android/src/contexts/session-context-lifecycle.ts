import { useEffect, useRef } from 'react';
import type { SessionDebugOverlayMetrics, SessionScheduleState, SessionState } from '../lib/types';
import type { SessionManagerState, SessionReconnectRuntime } from './session-context-core';
import { getPrimarySessionPullState, hasActiveSessionPullState } from './session-pull-state-helpers';

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

export function collectNewlyVisibleLiveSessionIds(previousIds: string[], nextIds: string[]) {
  const previousSet = new Set(previousIds.filter(Boolean));
  return nextIds.filter((sessionId) => Boolean(sessionId) && !previousSet.has(sessionId));
}

export function buildLifecycleRefreshTargets(state: Pick<SessionManagerState, 'activeSessionId' | 'liveSessionIds'>) {
  return Array.from(new Set([
    ...(state.activeSessionId ? [state.activeSessionId] : []),
    ...(Array.isArray(state.liveSessionIds) ? state.liveSessionIds : []),
  ]));
}

export function shouldScheduleActiveTickRefresh(options: {
  state: Pick<SessionManagerState, 'sessions' | 'activeSessionId' | 'liveSessionIds'>;
  sessionId: string;
  lastServerActivityAtRef: { current: Map<string, number> };
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
  const lastServerActivityAt = options.lastServerActivityAtRef.current.get(options.sessionId) || 0;
  if (lastServerActivityAt <= 0) {
    return options.state.activeSessionId === options.sessionId
      || (Array.isArray(options.state.liveSessionIds) && options.state.liveSessionIds.includes(options.sessionId));
  }
  const now = options.now ?? Date.now();
  return now - lastServerActivityAt >= Math.max(0, Math.floor(options.headStalePingMs || 0));
}

export function useSessionContextLifecycle(options: {
  appForegroundActive?: boolean;
  state: SessionManagerState;
  scheduleStates: Record<string, SessionScheduleState>;
  refs: {
    foregroundActiveRef: { current: boolean };
    stateRef: { current: SessionManagerState };
    scheduleStatesRef: { current: Record<string, SessionScheduleState> };
    sessionDebugMetricsStoreRef: { current: SessionDebugMetricsStoreLike };
    transportRuntimeStoreRef: { current: { sessions: Map<string, { activeSocket?: { bufferedAmount?: number } | null }> } };
    sessionPullStateRef: { current: Map<string, unknown> };
    lastActivatedSessionIdRef: { current: string | null };
    lastActiveReentryAtRef: { current: Map<string, number> };
    lastConnectedBaselineAtRef: { current: Map<string, number> };
    lastServerActivityAtRef: { current: Map<string, number> };
    remoteScreenshotRuntimeRef: { current: RemoteScreenshotRuntimeLike };
    pingIntervalsRef: { current: Map<string, ReturnType<typeof setInterval>> };
    handshakeTimeoutsRef: { current: Map<string, number> };
    reconnectRuntimesRef: { current: Map<string, SessionReconnectRuntime> };
    manualCloseRef: { current: Set<string> };
  };
  flushRuntimeDebugLogs: () => void;
  clientRuntimeDebugFlushIntervalMs: number;
  ensureActiveSessionFresh: (options: {
    sessionId: string;
    source: 'explicit-resume' | 'active-resume' | 'active-reentry' | 'active-tick';
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
  const lastLiveSessionIdsRef = useRef<string[]>(options.state.liveSessionIds);
  const lastForegroundActiveRef = useRef(options.appForegroundActive !== false);

  useEffect(() => {
    const nextForegroundActive = options.appForegroundActive !== false;
    options.refs.foregroundActiveRef.current = options.appForegroundActive !== false;
    if (lastForegroundActiveRef.current === nextForegroundActive) {
      return;
    }
    lastForegroundActiveRef.current = nextForegroundActive;
    if (!nextForegroundActive) {
      return;
    }
    const activeSessionId = options.refs.stateRef.current.activeSessionId;
    if (!activeSessionId) {
      return;
    }
    options.ensureActiveSessionFresh({
      sessionId: activeSessionId,
      source: 'active-resume',
      forceHead: true,
      markResumeTail: true,
      allowReconnectIfUnavailable: true,
    });
  }, [options.appForegroundActive]);

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
    const timer = window.setInterval(() => {
      const now = Date.now();
      options.refs.sessionDebugMetricsStoreRef.current.refresh(
        options.refs.stateRef.current.sessions.map((session) => {
          const pullStates = options.refs.sessionPullStateRef.current.get(session.id) || null;
          const pullState = getPrimarySessionPullState(pullStates as any);
          const activeSocket = options.refs.transportRuntimeStoreRef.current.sessions.get(session.id)?.activeSocket || null;
          const transportBufferedBytes = Number.isFinite(activeSocket?.bufferedAmount)
            ? Math.max(0, Math.floor(activeSocket?.bufferedAmount || 0))
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
  }, []);

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
      allowReconnectIfUnavailable: true,
    });
  }, [options.ensureActiveSessionFresh, options.state.activeSessionId]);

  useEffect(() => {
    const nextLiveSessionIds = Array.isArray(options.state.liveSessionIds)
      ? options.state.liveSessionIds
      : [];
    const previousLiveSessionIds = lastLiveSessionIdsRef.current;
    lastLiveSessionIdsRef.current = nextLiveSessionIds;
    collectNewlyVisibleLiveSessionIds(previousLiveSessionIds, nextLiveSessionIds).forEach((sessionId) => {
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
  }, [options.ensureActiveSessionFresh, options.state.liveSessionIds]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      flushRuntimeDebugLogsRef.current();
    }, options.clientRuntimeDebugFlushIntervalMs);
    return () => window.clearInterval(timer);
  }, [options.clientRuntimeDebugFlushIntervalMs]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    const scheduleNext = () => {
      if (cancelled) {
        return;
      }
      timer = window.setTimeout(() => {
        if (cancelled) {
          return;
        }
        if (!options.refs.foregroundActiveRef.current) {
          scheduleNext();
          return;
        }
        const refreshTargets = buildLifecycleRefreshTargets(options.refs.stateRef.current);
        if (refreshTargets.length === 0) {
          scheduleNext();
          return;
        }
        const now = Date.now();
        refreshTargets.forEach((sessionId) => {
          const headStalePingMs = options.resolveHeadStalePingMs(sessionId);
          if (!shouldScheduleActiveTickRefresh({
            state: options.refs.stateRef.current,
            sessionId,
            lastServerActivityAtRef: options.refs.lastServerActivityAtRef,
            headStalePingMs,
            now,
          })) {
            return;
          }
          options.ensureActiveSessionFresh({
            sessionId,
            source: 'active-tick',
            allowReconnectIfUnavailable: true,
          });
        });
        scheduleNext();
      }, Math.max(16, options.resolveActiveHeadRefreshTickMs(options.refs.stateRef.current.activeSessionId)));
    };

    scheduleNext();

    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [options.ensureActiveSessionFresh, options.resolveActiveHeadRefreshTickMs, options.resolveHeadStalePingMs]);

  useEffect(() => () => {
    options.refs.remoteScreenshotRuntimeRef.current.dispose(
      'Session provider disposed before remote screenshot completed',
    );
    for (const timer of options.refs.pingIntervalsRef.current.values()) {
      clearInterval(timer);
    }
    for (const sessionId of options.refs.handshakeTimeoutsRef.current.keys()) {
      options.clearSessionHandshakeTimeout(sessionId);
    }
    for (const reconnectRuntime of options.refs.reconnectRuntimesRef.current.values()) {
      if (reconnectRuntime.timer) {
        clearTimeout(reconnectRuntime.timer);
      }
    }
    for (const session of options.refs.stateRef.current.sessions) {
      options.refs.manualCloseRef.current.add(session.id);
      options.cleanupSocket(session.id, true);
      options.cleanupControlSocket(session.id, true);
    }
  }, [options.cleanupControlSocket, options.cleanupSocket, options.clearSessionHandshakeTimeout]);
}
