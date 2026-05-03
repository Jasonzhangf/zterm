import { runtimeDebug } from './runtime-debug';

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
  reconnectSession: (sessionId: string) => void;
  runtime: ForegroundRefreshRuntime;
  debounceMs?: number;
  log?: (entry: {
    reason: string;
    activeSessionId: string;
    sessionState: string;
    action: 'resume-active-transport' | 'reconnect-active-session';
  }) => void;
}

export function summarizeResumeSessions(sessions: ResumeSessionSnapshot[]) {
  return sessions.map((session) => ({
    id: session.id,
    state: session.state,
  }));
}

export function createForegroundRefreshRuntime(): ForegroundRefreshRuntime {
  return {
    wasHidden: false,
    lastResumeAt: 0,
  };
}

export function markForegroundRuntimeHidden(runtime: ForegroundRefreshRuntime, visibilityState?: string) {
  runtime.wasHidden = true;
  runtimeDebug('app.visibility.hidden', {
    visibilityState: visibilityState || null,
  });
}

export function performForegroundRefresh(options: PerformForegroundRefreshOptions) {
  const currentSessions = options.sessions;
  if (currentSessions.length === 0) {
    runtimeDebug('app.resume.skip', { reason: options.reason, why: 'no-sessions' });
    return false;
  }

  const now = Date.now();
  const debounceMs = typeof options.debounceMs === 'number' ? options.debounceMs : 800;
  if (now - options.runtime.lastResumeAt < debounceMs) {
    runtimeDebug('app.resume.skip', {
      reason: options.reason,
      why: 'debounced',
      deltaMs: now - options.runtime.lastResumeAt,
      sessions: summarizeResumeSessions(currentSessions),
    });
    return false;
  }

  options.runtime.lastResumeAt = now;
  runtimeDebug('app.resume.fire', {
    reason: options.reason,
    sessions: summarizeResumeSessions(currentSessions),
  });

  const activeSessionId = options.activeSessionId;
  if (!activeSessionId) {
    runtimeDebug('app.resume.skip', {
      reason: options.reason,
      why: 'no-active-session',
      sessions: summarizeResumeSessions(currentSessions),
    });
    return false;
  }

  const currentActiveSession = currentSessions.find((session) => session.id === activeSessionId) || null;
  const resumed = options.resumeActiveSessionTransport(activeSessionId);
  options.log?.({
    reason: options.reason,
    activeSessionId,
    sessionState: currentActiveSession?.state || 'missing',
    action: resumed ? 'resume-active-transport' : 'reconnect-active-session',
  });
  if (!resumed) {
    options.reconnectSession(activeSessionId);
  }
  return true;
}
