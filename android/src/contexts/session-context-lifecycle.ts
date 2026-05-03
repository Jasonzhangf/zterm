import { useEffect } from 'react';
import type { SessionDebugOverlayMetrics, SessionScheduleState, SessionState } from '../lib/types';
import type { SessionManagerState, SessionReconnectRuntime } from './session-context-core';
import { getPrimarySessionPullState, hasActiveSessionPullState } from './session-sync-helpers';

interface SessionDebugMetricsStoreLike {
  refresh: (
    sessions: Array<{
      sessionId: string;
      sessionState: SessionState;
      active: boolean;
      pullStatePurpose: 'tail-refresh' | 'reading-repair' | null;
      bufferPullActive: boolean;
    }>,
    now: number,
  ) => Record<string, SessionDebugOverlayMetrics | undefined>;
}

interface RemoteScreenshotRuntimeLike {
  dispose: (reason: string) => void;
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
    sessionPullStateRef: { current: Map<string, unknown> };
    lastActivatedSessionIdRef: { current: string | null };
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
    source: 'active-resume' | 'active-reentry' | 'active-tick';
    forceHead?: boolean;
    markResumeTail?: boolean;
    allowReconnectIfUnavailable?: boolean;
  }) => boolean;
  activeHeadRefreshTickMs: number;
  clearSessionHandshakeTimeout: (sessionId: string) => void;
  cleanupSocket: (sessionId: string, shouldClose?: boolean) => void;
  cleanupControlSocket: (sessionId: string, shouldClose?: boolean) => void;
}) {
  useEffect(() => {
    options.refs.foregroundActiveRef.current = options.appForegroundActive !== false;
  }, [options.appForegroundActive]);

  useEffect(() => {
    options.refs.stateRef.current = options.state;
  }, [options.state]);

  useEffect(() => {
    options.refs.scheduleStatesRef.current = options.scheduleStates;
  }, [options.scheduleStates]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      options.refs.sessionDebugMetricsStoreRef.current.refresh(
        options.refs.stateRef.current.sessions.map((session) => {
          const pullStates = options.refs.sessionPullStateRef.current.get(session.id) || null;
          const pullState = getPrimarySessionPullState(pullStates as any);
          return {
            sessionId: session.id,
            sessionState: session.state,
            active: options.refs.stateRef.current.activeSessionId === session.id,
            pullStatePurpose: pullState?.purpose || null,
            bufferPullActive: hasActiveSessionPullState((pullStates as any) || null),
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
    const timer = window.setInterval(() => {
      options.flushRuntimeDebugLogs();
    }, options.clientRuntimeDebugFlushIntervalMs);
    return () => window.clearInterval(timer);
  }, [options.flushRuntimeDebugLogs, options.clientRuntimeDebugFlushIntervalMs]);

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
        const activeSessionId = options.refs.stateRef.current.activeSessionId;
        if (!activeSessionId) {
          scheduleNext();
          return;
        }
        options.ensureActiveSessionFresh({
          sessionId: activeSessionId,
          source: 'active-tick',
          allowReconnectIfUnavailable: false,
        });
        scheduleNext();
      }, options.activeHeadRefreshTickMs);
    };

    scheduleNext();

    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [options.ensureActiveSessionFresh, options.activeHeadRefreshTickMs]);

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
