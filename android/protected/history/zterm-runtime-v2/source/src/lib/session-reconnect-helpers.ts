import { buildSessionSemanticReuseKey } from '../lib/session-semantic-identity';
// NOTE: findReusableManagedSession switched to exact client-owned sessionId lookup.
// session-semantic-identity is intentionally not used for *reuse*; host-aggregate
// matching (useSessionHistoryStorage / useSessionOpenActions) keeps that module
// as its truth. We still import buildSessionSemanticReuseKey here because
// buildManagedSessionReuseKey is a UI projection helper consumed by the picker /
// open-tab persistence for stable display keys, not for session reuse authority.
import type { Session, SessionState } from '../lib/types';

export function orderSessionsForReconnect(sessions: Session[], activeSessionId: string | null) {
  if (!activeSessionId) {
    return sessions;
  }
  return [...sessions].sort((left, right) => {
    if (left.id === activeSessionId) {
      return -1;
    }
    if (right.id === activeSessionId) {
      return 1;
    }
    return 0;
  });
}

export function buildManagedSessionReuseKey(input: {
  daemonHostId?: string;
  relayHostId?: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
}) {
  return buildSessionSemanticReuseKey({
    daemonHostId: input.daemonHostId,
    relayHostId: input.relayHostId,
    bridgeHost: input.bridgeHost,
    bridgePort: input.bridgePort,
    sessionName: input.sessionName,
  });
}

export function scoreReusableManagedSession(session: Session, activeSessionId: string | null) {
  return (
    (session.id === activeSessionId ? 1000 : 0)
    + (session.state === 'connected' ? 100 : session.state === 'connecting' || session.state === 'reconnecting' ? 50 : 0)
    + session.createdAt
  );
}

export interface FindReusableManagedSessionOptions {
  /**
   * client-owned session identity. Required: sessionId is the only authority for
   * reusing an existing session. Reusing by host/sessionName would collapse two
   * distinct tmux sessions (e.g. rcc vs rcc2-rename) into one buffer store entry
   * and cause session identity cross-display bugs.
   */
  sessionId: string;
  sessions: Session[];
  activeSessionId: string | null;
}

/**
 * Look up a managed session by exact client-owned sessionId. Returns null when the
 * caller did not supply a sessionId or no session matches. Callers that have only
 * host + sessionName must mint a sessionId via SessionContext.createSession and
 * then re-enter with that id; never collapse two tmux sessions by host name.
 */
export function findReusableManagedSession(options: FindReusableManagedSessionOptions) {
  const sessionId = options.sessionId?.trim();
  if (!sessionId) {
    return null;
  }
  const matches = options.sessions.filter((session) => session.id === sessionId);
  if (matches.length === 0) {
    return null;
  }
  // Tie-break by score (active/connected recency) so duplicate ids (defensive only)
  // collapse deterministically to one winner.
  matches.sort((left, right) => (
    scoreReusableManagedSession(right, options.activeSessionId)
    - scoreReusableManagedSession(left, options.activeSessionId)
  ));
  return matches[0] || null;
}

export function shouldOpenManagedSessionTransport(options: {
  readyState: number | null;
  hasPendingOpenIntent: boolean;
  sessionState: SessionState;
}) {
  const hasUsableTransport = (
    options.readyState === WebSocket.OPEN
    || options.readyState === WebSocket.CONNECTING
  );
  const isAlreadyOpening = (
    options.sessionState === 'connecting'
    || options.sessionState === 'reconnecting'
  );
  return (
    !hasUsableTransport
    && !options.hasPendingOpenIntent
    && !isAlreadyOpening
  );
}

export function shouldAutoReconnectSession(options: {
  sessionId: string;
  activeSessionId: string | null;
  liveSessionIds?: string[] | null;
  force?: boolean;
}) {
  if (options.force) {
    return true;
  }
  if (options.sessionId === options.activeSessionId) {
    return true;
  }
  return Array.isArray(options.liveSessionIds)
    && options.liveSessionIds.includes(options.sessionId);
}
