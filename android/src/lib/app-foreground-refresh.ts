import { runtimeDebug } from './runtime-debug';
import {
  createForegroundResumeState as createSharedForegroundState,
  markHidden as markHiddenPure,
  shouldResumeForeground,
  type ForegroundResumeState,
} from '@zterm/shared/terminal/foreground-resume';

export interface ResumeSessionSnapshot {
  id: string;
  state: string;
}

export interface ForegroundRefreshRuntime {
  wasHidden: boolean;
  lastResumeAt: number;
}

export interface PerformForegroundRefreshOptions {
  reason: 'visibilitychange' | 'resume' | 'appStateChange';
  sessions: ResumeSessionSnapshot[];
  activeSessionId: string | null;
  resumeActiveSessionTransport: (sessionId: string) => boolean;
  runtime: ForegroundRefreshRuntime;
  debounceMs?: number;
  log?: (entry: {
    reason: string;
    activeSessionId: string;
    sessionState: string;
    action: 'delegate-active-session-refresh' | 'skip-active-session-refresh';
  }) => void;
}

export function summarizeResumeSessions(sessions: ResumeSessionSnapshot[]) {
  return sessions.map((session) => ({
    id: session.id,
    state: session.state,
  }));
}

export function createForegroundRefreshRuntime(): ForegroundRefreshRuntime {
  return createSharedForegroundState();
}

export function markForegroundRuntimeHidden(runtime: ForegroundRefreshRuntime, visibilityState?: string) {
  const updated = markHiddenPure(runtime);
  runtime.wasHidden = updated.wasHidden;
  runtimeDebug('app.visibility.hidden', {
    visibilityState: visibilityState || null,
  });
}

export function performForegroundRefresh(options: PerformForegroundRefreshOptions) {
  const currentSessions = options.sessions;
  const now = Date.now();
  const debounceMs = typeof options.debounceMs === 'number' ? options.debounceMs : 800;
  const decision = shouldResumeForeground(
    now,
    options.runtime.lastResumeAt,
    debounceMs,
    options.runtime.wasHidden,
    currentSessions.length > 0,
    Boolean(options.activeSessionId),
  );

  if (!decision.shouldResume) {
    runtimeDebug('app.resume.skip', {
      reason: options.reason,
      why: decision.skipReason,
      sessions: summarizeResumeSessions(currentSessions),
    });
    return false;
  }

  options.runtime.lastResumeAt = now;
  runtimeDebug('app.resume.fire', {
    reason: options.reason,
    sessions: summarizeResumeSessions(currentSessions),
  });

  const activeSessionId = options.activeSessionId!;
  const currentActiveSession = currentSessions.find((session) => session.id === activeSessionId) || null;
  const resumed = options.resumeActiveSessionTransport(activeSessionId);
  options.log?.({
    reason: options.reason,
    activeSessionId,
    sessionState: currentActiveSession?.state || 'missing',
    action: resumed ? 'delegate-active-session-refresh' : 'skip-active-session-refresh',
  });
  return resumed;
}
