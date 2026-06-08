import { getResolvedSessionName } from './connection-target';
import {
  buildSessionSemanticOwnerKey,
  sessionSemanticOwnersMatch,
} from './session-semantic-identity';
import type { Host, Session, SessionGroupHistory, TraversalRelayDeviceSnapshot } from './types';

const STALE_OFFLINE_DAEMON_WITHOUT_SESSIONS_MS = 30 * 60_000;

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
  daemonConnected?: boolean;
  daemonVersion?: string;
  daemonLastSeenAt?: string;
  relayDeviceTruth?: boolean;
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
  daemonConnected?: boolean;
  daemonVersion?: string;
  daemonLastSeenAt?: string;
  relayDeviceTruth?: boolean;
  authToken?: string;
  sessionsByName: Map<string, ServerGroupSessionView>;
  hostsBySessionName: Map<string, Host>;
  lastOpenedAt: number;
}

function normalizeDaemonAlias(input?: string | null) {
  return (input || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildRelayDaemonCanonicalizer(devices?: TraversalRelayDeviceSnapshot[]) {
  const canonicalByAlias = new Map<string, string>();
  for (const device of devices || []) {
    const hostId = device.daemon.hostId.trim();
    if (!hostId) {
      continue;
    }
    [hostId, device.deviceName, device.deviceId].forEach((alias) => {
      const normalized = normalizeDaemonAlias(alias);
      if (normalized) {
        canonicalByAlias.set(normalized, hostId);
      }
    });
  }

  return (daemonHostId?: string | null) => {
    const raw = (daemonHostId || '').trim();
    if (!raw) {
      return '';
    }
    const normalized = normalizeDaemonAlias(raw);
    const exact = canonicalByAlias.get(normalized);
    if (exact) {
      return exact;
    }
    for (const [alias, canonical] of canonicalByAlias.entries()) {
      if (alias.length >= 4 && normalized.includes(alias)) {
        return canonical;
      }
    }
    return raw;
  };
}

function buildLiveSessionMapWithCanonicalizer(
  sessions: Session[],
  canonicalizeDaemonHostId: (daemonHostId?: string | null) => string,
) {
  const map = new Map<string, Session>();
  for (const session of sessions) {
    const key = `${buildSessionSemanticOwnerKey({
      daemonHostId: canonicalizeDaemonHostId(session.daemonHostId),
      bridgeHost: session.bridgeHost,
      bridgePort: session.bridgePort,
    })}::${session.sessionName}`;
    map.set(key, session);
  }
  return map;
}

function isStaleOfflineDaemonWithoutSessions(group: Pick<ServerGroupView, 'relayDeviceTruth' | 'daemonConnected' | 'daemonLastSeenAt' | 'sessions'>) {
  if (!group.relayDeviceTruth || group.daemonConnected !== false || group.sessions.length > 0) {
    return false;
  }
  const lastSeenMs = Date.parse(group.daemonLastSeenAt || '');
  if (!Number.isFinite(lastSeenMs)) {
    return true;
  }
  return Date.now() - lastSeenMs > STALE_OFFLINE_DAEMON_WITHOUT_SESSIONS_MS;
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
  relayDevices?: TraversalRelayDeviceSnapshot[];
}): ServerGroupView[] {
  const { hosts, sessions, sessionGroups } = options;
  const canonicalizeDaemonHostId = buildRelayDaemonCanonicalizer(options.relayDevices);
  const liveSessionMap = buildLiveSessionMapWithCanonicalizer(sessions, canonicalizeDaemonHostId);
  const grouped = new Map<string, MutableServerGroup>();

  for (const device of options.relayDevices || []) {
    const hostId = device.daemon.hostId.trim();
    if (!hostId) {
      continue;
    }
    const group = ensureGroup(grouped, '', 0, hostId, undefined);
    group.name = device.deviceName.trim() || hostId;
    group.daemonConnected = device.daemon.connected;
    group.daemonVersion = device.daemon.version;
    group.daemonLastSeenAt = device.daemon.lastSeenAt;
    group.relayDeviceTruth = true;
    group.lastOpenedAt = Math.max(group.lastOpenedAt, Date.parse(device.daemon.lastSeenAt) || 0);
  }

  for (const host of hosts) {
    const group = ensureGroup(
      grouped,
      host.bridgeHost,
      host.bridgePort,
      canonicalizeDaemonHostId(host.daemonHostId || host.relayHostId),
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
      canonicalizeDaemonHostId(groupHistory.daemonHostId),
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
      canonicalizeDaemonHostId(liveSession.daemonHostId),
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
        daemonConnected: group.daemonConnected,
        daemonVersion: group.daemonVersion,
        daemonLastSeenAt: group.daemonLastSeenAt,
        relayDeviceTruth: group.relayDeviceTruth,
        authToken: group.authToken,
        sessions: groupSessions,
        defaultSessionNames: savedSessions.length > 0 ? savedSessions : groupSessions.map((entry) => entry.sessionName),
        lastOpenedAt: group.lastOpenedAt,
        liveSessions,
        savedCount: savedSessions.length,
        openableSessions,
      };
    })
    .filter((group) => (group.relayDeviceTruth || group.sessions.length > 0) && !isStaleOfflineDaemonWithoutSessions(group))
    .sort((a, b) => {
      const aConnected = a.daemonConnected ? 1 : 0;
      const bConnected = b.daemonConnected ? 1 : 0;
      if (aConnected !== bConnected) {
        return bConnected - aConnected;
      }
      if (a.liveSessions.length !== b.liveSessions.length) {
        return b.liveSessions.length - a.liveSessions.length;
      }
      return b.lastOpenedAt - a.lastOpenedAt;
    });
}
