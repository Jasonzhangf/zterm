import type { Host, Session, SessionState } from '../lib/types';
import { buildSessionSemanticReuseKey } from '../lib/session-semantic-identity';

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

export function findReusableManagedSession(options: {
  sessions: Session[];
  host: Host;
  resolvedSessionName: string;
  activeSessionId: string | null;
}) {
  const reuseKey = buildManagedSessionReuseKey({
    daemonHostId: options.host.daemonHostId,
    relayHostId: options.host.relayHostId,
    bridgeHost: options.host.bridgeHost,
    bridgePort: options.host.bridgePort,
    sessionName: options.resolvedSessionName,
  });
  return options.sessions
    .filter((session) => buildManagedSessionReuseKey({
      daemonHostId: session.daemonHostId,
      bridgeHost: session.bridgeHost,
      bridgePort: session.bridgePort,
      sessionName: session.sessionName,
    }) === reuseKey)
    .sort((left, right) => (
      scoreReusableManagedSession(right, options.activeSessionId)
      - scoreReusableManagedSession(left, options.activeSessionId)
    ))[0] || null;
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
