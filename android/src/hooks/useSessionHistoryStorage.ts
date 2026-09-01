import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeRelayEndpointCandidates, type RelayEndpointCandidate } from '@zterm/shared/relay-directory';
import { normalizeRemoteTmuxSessionNames } from '../lib/tmux-session-list';
import { resolveRelayDaemonCanonicalHostId } from '../lib/relay-account-directory';
import {
  DEFAULT_BRIDGE_PORT,
  STORAGE_KEYS,
  type SessionGroupHistory,
  type TraversalRelayDeviceSnapshot,
} from '../lib/types';
import {
  buildSessionSemanticOwnerKey,
  sessionSemanticOwnersMatch,
} from '../lib/session-semantic-identity';

const MAX_GROUP_ENTRIES = 12;

function mergeRelayEndpointCandidates(
  first: RelayEndpointCandidate[] | undefined,
  second: RelayEndpointCandidate[] | undefined,
) {
  const byId = new Map<string, RelayEndpointCandidate>();
  for (const candidate of [...(first || []), ...(second || [])]) {
    if (!candidate.id.trim()) {
      continue;
    }
    byId.set(candidate.id, candidate);
  }
  return [...byId.values()];
}

function toServerGroupKey(entry: Pick<SessionGroupHistory, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'terminalBackend'>) {
  const ownerKey = buildSessionSemanticOwnerKey({
    daemonHostId: entry.daemonHostId,
    bridgeHost: entry.bridgeHost,
    bridgePort: entry.bridgePort,
  });
  return ownerKey;
}

function sessionGroupOwnersMatch(
  left: Pick<SessionGroupHistory, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'terminalBackend'>,
  right: Pick<SessionGroupHistory, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'terminalBackend'>,
) {
  return sessionSemanticOwnersMatch(left, right);
}

function canonicalizeSessionGroupOwner<T extends {
  daemonHostId?: string;
  bridgeHost: string;
  bridgePort: number;
  authToken?: string;
}>(
  target: T,
  relayDevices: TraversalRelayDeviceSnapshot[],
): T {
  const canonicalDaemonHostId = resolveRelayDaemonCanonicalHostId({
    daemonHostId: target.daemonHostId,
    authToken: target.authToken,
    bridgeHost: target.bridgeHost,
    bridgePort: target.bridgePort,
  }, relayDevices);
  return canonicalDaemonHostId && canonicalDaemonHostId !== target.daemonHostId?.trim()
    ? { ...target, daemonHostId: canonicalDaemonHostId }
    : target;
}

function normalizeGroupEntry(
  input: unknown,
  relayDevices: TraversalRelayDeviceSnapshot[] = [],
): SessionGroupHistory | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const candidate = input as Partial<SessionGroupHistory>;
  const bridgeHost = typeof candidate.bridgeHost === 'string' ? candidate.bridgeHost.trim() : '';
  const daemonHostId = typeof candidate.daemonHostId === 'string' && candidate.daemonHostId.trim()
    ? candidate.daemonHostId.trim()
    : undefined;
  const terminalBackend = 'tmux' as const;
  const sessionNames = Array.isArray(candidate.sessionNames)
    ? candidate.sessionNames.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
    : [];
  const sessionCwdByName = candidate.sessionCwdByName && typeof candidate.sessionCwdByName === 'object'
    ? Object.fromEntries(Object.entries(candidate.sessionCwdByName).filter(([name, cwd]) => (
      sessionNames.includes(name) && typeof cwd === 'string' && cwd.trim()
    )).map(([name, cwd]) => [name, (cwd as string).trim()]))
    : {};
  const missingSessionNames = Array.isArray(candidate.missingSessionNames)
    ? candidate.missingSessionNames.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
    : [];
  const relayEndpointCandidates = normalizeRelayEndpointCandidates(
    candidate.relayEndpointCandidates,
    new Date().toISOString(),
  );

  if ((!bridgeHost && !daemonHostId) || sessionNames.length === 0) {
    return null;
  }

  const sortedSessionNames = [...new Set(sessionNames)].sort((a, b) => a.localeCompare(b));
  const sortedMissingSessionNames = [...new Set(missingSessionNames)]
    .filter((item) => sortedSessionNames.includes(item))
    .sort((a, b) => a.localeCompare(b));
  const missingSessionNameSet = new Set(sortedMissingSessionNames);
  const lastOpenedSessionName = typeof candidate.lastOpenedSessionName === 'string'
    ? candidate.lastOpenedSessionName.trim()
    : '';
  const bridgePort =
    typeof candidate.bridgePort === 'number' && Number.isFinite(candidate.bridgePort)
      ? candidate.bridgePort
      : DEFAULT_BRIDGE_PORT;
  const canonicalOwner = canonicalizeSessionGroupOwner({
    daemonHostId,
    authToken: typeof candidate.authToken === 'string' ? candidate.authToken : undefined,
    bridgeHost,
    bridgePort,
  }, relayDevices);
  const canonicalDaemonHostId = canonicalOwner.daemonHostId;

  return {
    id:
      typeof candidate.id === 'string' && candidate.id.trim()
        ? (
          canonicalDaemonHostId !== daemonHostId
            ? toServerGroupKey({
              daemonHostId: canonicalDaemonHostId,
              bridgeHost,
              bridgePort,
              terminalBackend,
            })
            : candidate.id
        )
        : toServerGroupKey({
          daemonHostId: canonicalDaemonHostId,
          bridgeHost,
          bridgePort,
          terminalBackend,
        }),
    name: typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name : `${daemonHostId || bridgeHost} · ${sortedSessionNames.length} sessions`,
    bridgeHost,
    bridgePort,
    daemonHostId: canonicalDaemonHostId || undefined,
    terminalBackend,
    authToken: typeof candidate.authToken === 'string' ? candidate.authToken : undefined,
    ...(relayEndpointCandidates.length > 0 ? { relayEndpointCandidates } : {}),
    sessionNames: sortedSessionNames,
    ...(Object.keys(sessionCwdByName).length > 0 ? { sessionCwdByName } : {}),
    missingSessionNames: sortedMissingSessionNames,
    lastOpenedSessionName:
      lastOpenedSessionName
      && sortedSessionNames.includes(lastOpenedSessionName)
      && !missingSessionNameSet.has(lastOpenedSessionName)
        ? lastOpenedSessionName
        : undefined,
    lastOpenedAt:
      typeof candidate.lastOpenedAt === 'number' && Number.isFinite(candidate.lastOpenedAt)
        ? candidate.lastOpenedAt
        : Date.now(),
  };
}

function saveJson(key: string, value: unknown) {
  if (typeof window === 'undefined') {
    return;
  }
  localStorage.setItem(key, JSON.stringify(value));
}

function mergeSessionGroupEntries(
  primary: SessionGroupHistory,
  supplement: SessionGroupHistory,
) {
  const sessionNames = [...new Set([...primary.sessionNames, ...supplement.sessionNames])]
    .sort((a, b) => a.localeCompare(b));
  const sessionCwdByName = { ...(primary.sessionCwdByName || {}), ...(supplement.sessionCwdByName || {}) };
  const missingSessionNames = [...new Set([
    ...(primary.missingSessionNames || []),
    ...(supplement.missingSessionNames || []),
  ])]
    .filter((sessionName) => sessionNames.includes(sessionName))
    .sort((a, b) => a.localeCompare(b));
  const missingSessionNameSet = new Set(missingSessionNames);
  const lastOpenedSessionName = [primary.lastOpenedSessionName, supplement.lastOpenedSessionName]
    .map((sessionName) => sessionName?.trim() || '')
    .find((sessionName) => sessionNames.includes(sessionName) && !missingSessionNameSet.has(sessionName));
  const relayEndpointCandidates = mergeRelayEndpointCandidates(
    primary.relayEndpointCandidates,
    supplement.relayEndpointCandidates,
  );

  return {
    ...supplement,
    ...primary,
    id: toServerGroupKey(primary),
    relayEndpointCandidates: relayEndpointCandidates.length > 0 ? relayEndpointCandidates : undefined,
    sessionNames,
    ...(Object.keys(sessionCwdByName).length > 0 ? { sessionCwdByName } : {}),
    missingSessionNames,
    ...(lastOpenedSessionName ? { lastOpenedSessionName } : { lastOpenedSessionName: undefined }),
    lastOpenedAt: Math.max(primary.lastOpenedAt, supplement.lastOpenedAt),
  };
}

function collapseServerGroups(
  entries: SessionGroupHistory[],
  relayDevices: TraversalRelayDeviceSnapshot[] = [],
) {
  const ordered = entries
    .map((entry) => normalizeGroupEntry(entry, relayDevices))
    .filter((entry): entry is SessionGroupHistory => entry !== null)
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  const collapsed: SessionGroupHistory[] = [];

  for (const entry of ordered) {
    const existingIndex = collapsed.findIndex((item) => sessionGroupOwnersMatch(item, entry));
    if (existingIndex >= 0) {
      collapsed[existingIndex] = mergeSessionGroupEntries(collapsed[existingIndex]!, entry);
      continue;
    }
    collapsed.push({
      ...entry,
      id: toServerGroupKey(entry),
    });
  }

  return collapsed
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .slice(0, MAX_GROUP_ENTRIES);
}

export function useSessionHistoryStorage(
  relayDevices: TraversalRelayDeviceSnapshot[] = [],
) {
  const [sessionGroups, setSessionGroups] = useState<SessionGroupHistory[]>([]);
  const relayDevicesRef = useRef(relayDevices);
  relayDevicesRef.current = relayDevices;

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      const rawGroups = localStorage.getItem(STORAGE_KEYS.SESSION_GROUPS);
      if (rawGroups) {
        const parsed = JSON.parse(rawGroups) as unknown;
        if (!Array.isArray(parsed)) {
          throw new Error('stored session groups must be an array');
        }
        const normalized = collapseServerGroups(
          parsed
            .map((item) => normalizeGroupEntry(item, relayDevicesRef.current))
            .filter((item): item is SessionGroupHistory => item !== null),
          relayDevicesRef.current,
        );
        setSessionGroups((current) => {
          if (JSON.stringify(current) === JSON.stringify(normalized)) {
            return current;
          }
          saveJson(STORAGE_KEYS.SESSION_GROUPS, normalized);
          return normalized;
        });
      }
    } catch (error) {
      console.error('[useSessionHistoryStorage] Failed to load history:', error);
    }
  }, [relayDevices]);

  const setSessionGroupSelection = useCallback((group: Omit<SessionGroupHistory, 'id' | 'lastOpenedAt'>) => {
    setSessionGroups((current) => {
      const canonicalGroup = normalizeGroupEntry(group, relayDevicesRef.current);
      if (!canonicalGroup) {
        return current;
      }
      const canonicalCurrent = collapseServerGroups(current, relayDevicesRef.current);
      const existing = canonicalCurrent.find(
        (item) => sessionGroupOwnersMatch(item, canonicalGroup),
      );
      const existingLastOpenedSessionName = existing?.lastOpenedSessionName?.trim() || '';
      const mergedSessionNames = [...new Set([
        ...(existing?.sessionNames || []),
        ...canonicalGroup.sessionNames,
      ])];
      const groupSessionNameSet = new Set(mergedSessionNames);
      const filtered = canonicalCurrent.filter(
        (item) => !sessionGroupOwnersMatch(item, canonicalGroup),
      );

      const normalized = normalizeGroupEntry({
        ...(existing || {}),
        ...canonicalGroup,
        id: toServerGroupKey(canonicalGroup),
        relayEndpointCandidates: mergeRelayEndpointCandidates(
          existing?.relayEndpointCandidates,
          canonicalGroup.relayEndpointCandidates,
        ),
        sessionNames: mergedSessionNames,
        sessionCwdByName: { ...(existing?.sessionCwdByName || {}), ...(canonicalGroup.sessionCwdByName || {}) },
        missingSessionNames: (existing?.missingSessionNames || []).filter((sessionName) => (
          mergedSessionNames.includes(sessionName)
        )),
        lastOpenedSessionName: canonicalGroup.lastOpenedSessionName?.trim()
          || (existingLastOpenedSessionName && groupSessionNameSet.has(existingLastOpenedSessionName)
            ? existingLastOpenedSessionName
            : undefined),
        lastOpenedAt: Date.now(),
      }, relayDevicesRef.current);

      const next = normalized ? collapseServerGroups([normalized, ...filtered], relayDevicesRef.current) : filtered;
      saveJson(STORAGE_KEYS.SESSION_GROUPS, next);
      return next;
    });
  }, []);

  const deleteSessionGroup = useCallback((target: Pick<SessionGroupHistory, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'terminalBackend'>) => {
    setSessionGroups((current) => {
      const canonicalTarget = canonicalizeSessionGroupOwner(target, relayDevicesRef.current);
      const next = collapseServerGroups(current, relayDevicesRef.current).filter(
        (item) => !sessionGroupOwnersMatch(item, canonicalTarget),
      );
      saveJson(STORAGE_KEYS.SESSION_GROUPS, next);
      return next;
    });
  }, []);

  const markSessionGroupEntered = useCallback((target: {
    name?: string;
    bridgeHost: string;
    bridgePort: number;
    daemonHostId?: string;
    terminalBackend?: 'tmux' | 'herdr';
    authToken?: string;
    relayEndpointCandidates?: RelayEndpointCandidate[];
  }, sessionName: string) => {
    const normalizedSessionName = sessionName.trim();
    if (!normalizedSessionName) {
      return;
    }

    setSessionGroups((current) => {
      const canonicalTarget = normalizeGroupEntry({
        ...target,
        sessionNames: [normalizedSessionName],
      }, relayDevicesRef.current) || target;
      const canonicalCurrent = collapseServerGroups(current, relayDevicesRef.current);
      const existing = canonicalCurrent.find((item) => sessionGroupOwnersMatch(item, canonicalTarget));
      const filtered = canonicalCurrent.filter((item) => !sessionGroupOwnersMatch(item, canonicalTarget));
      const normalized = normalizeGroupEntry({
        ...(existing || {}),
        name: canonicalTarget.name?.trim() || existing?.name || canonicalTarget.daemonHostId || canonicalTarget.bridgeHost || normalizedSessionName,
        bridgeHost: canonicalTarget.bridgeHost,
        bridgePort: canonicalTarget.bridgePort,
        daemonHostId: canonicalTarget.daemonHostId,
        terminalBackend: canonicalTarget.terminalBackend,
        authToken: canonicalTarget.authToken ?? existing?.authToken,
        relayEndpointCandidates: mergeRelayEndpointCandidates(
          existing?.relayEndpointCandidates,
          canonicalTarget.relayEndpointCandidates,
        ),
        sessionNames: [...new Set([...(existing?.sessionNames || []), normalizedSessionName])],
        missingSessionNames: (existing?.missingSessionNames || []).filter((item) => item !== normalizedSessionName),
        lastOpenedSessionName: normalizedSessionName,
        lastOpenedAt: Date.now(),
        id: toServerGroupKey(canonicalTarget),
      }, relayDevicesRef.current);
      const next = normalized ? collapseServerGroups([normalized, ...filtered], relayDevicesRef.current) : filtered;
      saveJson(STORAGE_KEYS.SESSION_GROUPS, next);
      return next;
    });
  }, []);

  const pruneSessionGroupSelectionToRemoteTruth = useCallback((
    target: Pick<SessionGroupHistory, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'terminalBackend'>,
    remoteSessionNames: string[],
  ) => {
    const normalizedRemoteSessionNames = normalizeRemoteTmuxSessionNames(remoteSessionNames);
    const remoteSessionNameSet = new Set(normalizedRemoteSessionNames);
    setSessionGroups((current) => {
      const canonicalTarget = canonicalizeSessionGroupOwner(target, relayDevicesRef.current);
      let changed = false;
      const next = collapseServerGroups(current, relayDevicesRef.current).flatMap((item) => {
        if (!sessionGroupOwnersMatch(item, canonicalTarget)) {
          return [item];
        }
        if (normalizedRemoteSessionNames.length === 0) {
          changed = true;
          return [];
        }
        const nextLastOpenedSessionName = item.lastOpenedSessionName && remoteSessionNameSet.has(item.lastOpenedSessionName)
          ? item.lastOpenedSessionName
          : undefined;
        if (item.sessionNames.join('\u0000') === normalizedRemoteSessionNames.join('\u0000')
          && (item.missingSessionNames || []).length === 0
          && item.lastOpenedSessionName === nextLastOpenedSessionName) {
          return [item];
        }
        changed = true;
        return [{
          ...item,
          sessionNames: normalizedRemoteSessionNames,
          sessionCwdByName: Object.fromEntries(
            Object.entries(item.sessionCwdByName || {}).filter(([name]) => remoteSessionNameSet.has(name)),
          ),
          missingSessionNames: [],
          lastOpenedSessionName: nextLastOpenedSessionName,
        }];
      });
      if (!changed) {
        return current;
      }
      const collapsed = collapseServerGroups(next, relayDevicesRef.current);
      saveJson(STORAGE_KEYS.SESSION_GROUPS, collapsed);
      return collapsed;
    });
  }, []);

  return {
    sessionGroups,
    setSessionGroupSelection,
    markSessionGroupEntered,
    deleteSessionGroup,
    pruneSessionGroupSelectionToRemoteTruth,
  };
}
