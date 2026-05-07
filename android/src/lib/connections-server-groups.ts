import { getResolvedSessionName } from './connection-target';
import {
  buildSessionSemanticOwnerKey,
  sessionSemanticOwnersMatch,
} from './session-semantic-identity';
import type { Host, Session, SessionGroupHistory } from './types';

export interface ServerGroupSessionView {
  id: string;
  sessionName: string;
  host?: Host;
  source: 'saved' | 'history' | 'live';
  lastOpenedAt: number;
  liveSession: Session | null;
}

export interface ServerGroupView {
  id: string;
  name: string;
  bridgeHost: string;
  bridgePort: number;
  daemonHostId?: string;
  authToken?: string;
  sessions: ServerGroupSessionView[];
  defaultSessionNames: string[];
  lastOpenedAt: number;
  liveSessions: Session[];
  savedCount: number;
  openableSessions: string[];
}

interface MutableServerGroup {
  id: string;
  name: string;
  bridgeHost: string;
  bridgePort: number;
  daemonHostId?: string;
  authToken?: string;
  sessionsByName: Map<string, ServerGroupSessionView>;
  hostsBySessionName: Map<string, Host>;
  lastOpenedAt: number;
}

function buildLiveSessionMap(sessions: Session[]) {
  const map = new Map<string, Session>();
  for (const session of sessions) {
    const key = `${buildSessionSemanticOwnerKey({
      daemonHostId: session.daemonHostId,
      bridgeHost: session.bridgeHost,
      bridgePort: session.bridgePort,
    })}::${session.sessionName}`;
    map.set(key, session);
  }
  return map;
}

function hostMatchesGroupTarget(
  host: Host,
  group: Pick<MutableServerGroup, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'authToken'>,
) {
  if (group.daemonHostId?.trim()) {
    return (
      (host.daemonHostId || host.relayHostId || '').trim() === group.daemonHostId.trim()
      && host.bridgeHost === group.bridgeHost
      && host.bridgePort === group.bridgePort
      && (host.authToken || '') === (group.authToken || '')
    );
  }
  return host.bridgeHost === group.bridgeHost && host.bridgePort === group.bridgePort;
}

function pickPreferredHost(
  current: Host | undefined,
  candidate: Host,
  group: Pick<MutableServerGroup, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'authToken'>,
) {
  if (!current) {
    return candidate;
  }
  const currentMatchesGroup = hostMatchesGroupTarget(current, group);
  const candidateMatchesGroup = hostMatchesGroupTarget(candidate, group);
  if (candidateMatchesGroup !== currentMatchesGroup) {
    return candidateMatchesGroup ? candidate : current;
  }
  if (candidate.pinned !== current.pinned) {
    return candidate.pinned ? candidate : current;
  }
  return (candidate.lastConnected || 0) >= (current.lastConnected || 0) ? candidate : current;
}

function findDaemonGroupForBridgeOnlyHistory(
  grouped: Map<string, MutableServerGroup>,
  sessionNames: string[],
) {
  const normalizedSessionNames = [...new Set(sessionNames.map((item) => item.trim()).filter(Boolean))];
  if (normalizedSessionNames.length === 0) {
    return null;
  }

  const candidates = [...grouped.values()].filter((group) => {
    if (!group.daemonHostId?.trim()) {
      return false;
    }
    return normalizedSessionNames.every((sessionName) => group.hostsBySessionName.has(sessionName));
  });

  if (candidates.length === 1) {
    return candidates[0]!;
  }

  return null;
}

function ensureGroup(
  grouped: Map<string, MutableServerGroup>,
  bridgeHost: string,
  bridgePort: number,
  daemonHostId?: string,
  authToken?: string,
) {
  const key = buildSessionSemanticOwnerKey({
    daemonHostId,
    bridgeHost,
    bridgePort,
  });
  const current = grouped.get(key)
    || [...grouped.values()].find((entry) => sessionSemanticOwnersMatch(
      entry,
      { daemonHostId, bridgeHost, bridgePort },
    ))
    || null;
  if (current) {
    const previousId = current.id;
    if (daemonHostId && current.id !== key) {
      current.id = key;
      current.sessionsByName.forEach((entry, sessionName) => {
        entry.id = `${key}:${sessionName}`;
      });
      if (grouped.get(previousId) === current) {
        grouped.delete(previousId);
      }
    }
    if (daemonHostId) {
      current.authToken = authToken || current.authToken;
    } else {
      current.authToken = current.authToken || authToken;
    }
    current.daemonHostId = current.daemonHostId || daemonHostId;
    if (daemonHostId) {
      current.bridgeHost = bridgeHost || current.bridgeHost;
      current.bridgePort = bridgePort || current.bridgePort;
    } else {
      current.bridgeHost = current.bridgeHost || bridgeHost;
      current.bridgePort = current.bridgePort || bridgePort;
    }
    grouped.set(current.id, current);
    return current;
  }

  const created: MutableServerGroup = {
    id: key,
    name: bridgeHost,
    bridgeHost,
    bridgePort,
    daemonHostId,
    authToken,
    sessionsByName: new Map(),
    hostsBySessionName: new Map(),
    lastOpenedAt: 0,
  };
  grouped.set(key, created);
  return created;
}

export function buildConnectionsServerGroups(options: {
  hosts: Host[];
  sessions: Session[];
  sessionGroups: SessionGroupHistory[];
}): ServerGroupView[] {
  const { hosts, sessions, sessionGroups } = options;
  const liveSessionMap = buildLiveSessionMap(sessions);
  const grouped = new Map<string, MutableServerGroup>();

  for (const host of hosts) {
    const group = ensureGroup(
      grouped,
      host.bridgeHost,
      host.bridgePort,
      host.daemonHostId || host.relayHostId,
      host.authToken,
    );
    const sessionName = getResolvedSessionName(host);
    const nextHost = pickPreferredHost(group.hostsBySessionName.get(sessionName), host, group);
    group.hostsBySessionName.set(sessionName, nextHost);
    group.lastOpenedAt = Math.max(group.lastOpenedAt, host.lastConnected || 0);
  }

  for (const groupHistory of sessionGroups) {
    const adoptedDaemonGroup = !groupHistory.daemonHostId
      ? findDaemonGroupForBridgeOnlyHistory(grouped, groupHistory.sessionNames)
      : null;
    const group = adoptedDaemonGroup || ensureGroup(
      grouped,
      groupHistory.bridgeHost,
      groupHistory.bridgePort,
      groupHistory.daemonHostId,
      groupHistory.authToken,
    );
    group.lastOpenedAt = Math.max(group.lastOpenedAt, groupHistory.lastOpenedAt);

    for (const sessionName of groupHistory.sessionNames) {
      const current = group.sessionsByName.get(sessionName);
      const resolvedHost = current?.host || group.hostsBySessionName.get(sessionName);
      group.sessionsByName.set(sessionName, {
        id: `${group.id}:${sessionName}`,
        sessionName,
        host: resolvedHost,
        source: current?.source || (resolvedHost ? 'saved' : 'history'),
        lastOpenedAt: Math.max(current?.lastOpenedAt || 0, groupHistory.lastOpenedAt),
        liveSession: liveSessionMap.get(`${group.id}::${sessionName}`) || current?.liveSession || null,
      });
    }
  }

  for (const liveSession of sessions) {
    const group = ensureGroup(
      grouped,
      liveSession.bridgeHost,
      liveSession.bridgePort,
      liveSession.daemonHostId,
      liveSession.authToken,
    );
    const current = group.sessionsByName.get(liveSession.sessionName);
    group.sessionsByName.set(liveSession.sessionName, {
      id: `${group.id}:${liveSession.sessionName}`,
      sessionName: liveSession.sessionName,
      host: current?.host || group.hostsBySessionName.get(liveSession.sessionName),
      source: current?.source === 'saved' ? 'saved' : 'live',
      lastOpenedAt: Math.max(current?.lastOpenedAt || 0, liveSession.createdAt),
      liveSession,
    });
    group.lastOpenedAt = Math.max(group.lastOpenedAt, liveSession.createdAt);
  }

  for (const group of grouped.values()) {
    for (const [sessionName, entry] of group.sessionsByName.entries()) {
      const preferredHost = hosts
        .filter((host) => (
          getResolvedSessionName(host) === sessionName
          && sessionSemanticOwnersMatch(host, group)
        ))
        .reduce<Host | undefined>((best, host) => pickPreferredHost(best, host, group), undefined);
      if (!preferredHost) {
        continue;
      }
      if (!entry.host || hostMatchesGroupTarget(preferredHost, group)) {
        entry.host = preferredHost;
      }
      if (entry.source === 'saved' && !entry.host) {
        entry.source = 'history';
      }
    }
  }

  return [...grouped.values()]
    .map((group) => {
      const groupSessions = [...group.sessionsByName.values()].sort((a, b) => {
        const aSaved = a.source === 'saved' ? 1 : 0;
        const bSaved = b.source === 'saved' ? 1 : 0;
        if (aSaved !== bSaved) {
          return bSaved - aSaved;
        }
        const aLive = a.liveSession ? 1 : 0;
        const bLive = b.liveSession ? 1 : 0;
        if (aLive !== bLive) {
          return bLive - aLive;
        }
        return b.lastOpenedAt - a.lastOpenedAt || a.sessionName.localeCompare(b.sessionName);
      });
      const liveSessions = groupSessions
        .map((entry) => entry.liveSession)
        .filter((entry): entry is Session => entry !== null);
      const savedSessions = groupSessions.filter((entry) => entry.source === 'saved').map((entry) => entry.sessionName);
      const openableSessions = groupSessions
        .filter((entry) => entry.liveSession || entry.source === 'saved')
        .map((entry) => entry.sessionName);

      return {
        id: group.id,
        name: group.name,
        bridgeHost: group.bridgeHost,
        bridgePort: group.bridgePort,
        daemonHostId: group.daemonHostId,
        authToken: group.authToken,
        sessions: groupSessions,
        defaultSessionNames: savedSessions.length > 0 ? savedSessions : groupSessions.map((entry) => entry.sessionName),
        lastOpenedAt: group.lastOpenedAt,
        liveSessions,
        savedCount: savedSessions.length,
        openableSessions,
      };
    })
    .filter((group) => group.sessions.length > 0)
    .sort((a, b) => {
      if (a.liveSessions.length !== b.liveSessions.length) {
        return b.liveSessions.length - a.liveSessions.length;
      }
      return b.lastOpenedAt - a.lastOpenedAt;
    });
}
