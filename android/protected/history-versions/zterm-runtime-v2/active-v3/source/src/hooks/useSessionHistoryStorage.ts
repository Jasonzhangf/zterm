import { useCallback, useEffect, useState } from 'react';
import { normalizeRelayEndpointCandidates, type RelayEndpointCandidate } from '@zterm/shared/relay-directory';
import { normalizeRemoteTmuxSessionNames } from '../lib/tmux-session-list';
import { DEFAULT_BRIDGE_PORT, STORAGE_KEYS, type SessionGroupHistory } from '../lib/types';
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
  return entry.terminalBackend === 'herdr'
    ? `${ownerKey}::backend:herdr`
    : ownerKey;
}

function sessionGroupOwnersMatch(
  left: Pick<SessionGroupHistory, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'terminalBackend'>,
  right: Pick<SessionGroupHistory, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'terminalBackend'>,
) {
  return (
    (left.terminalBackend || 'tmux') === (right.terminalBackend || 'tmux')
    && sessionSemanticOwnersMatch(left, right)
  );
}

function normalizeGroupEntry(input: unknown): SessionGroupHistory | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const candidate = input as Partial<SessionGroupHistory>;
  const bridgeHost = typeof candidate.bridgeHost === 'string' ? candidate.bridgeHost.trim() : '';
  const daemonHostId = typeof candidate.daemonHostId === 'string' && candidate.daemonHostId.trim()
    ? candidate.daemonHostId.trim()
    : undefined;
  const terminalBackend = candidate.terminalBackend === 'herdr' ? 'herdr' : 'tmux';
  const sessionNames = Array.isArray(candidate.sessionNames)
    ? candidate.sessionNames.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
    : [];
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

  return {
    id:
      typeof candidate.id === 'string' && candidate.id.trim()
        ? candidate.id
        : toServerGroupKey({
          daemonHostId,
          bridgeHost,
          bridgePort,
          terminalBackend,
        }),
    name: typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name : `${daemonHostId || bridgeHost} · ${sortedSessionNames.length} sessions`,
    bridgeHost,
    bridgePort,
    daemonHostId,
    terminalBackend,
    authToken: typeof candidate.authToken === 'string' ? candidate.authToken : undefined,
    ...(relayEndpointCandidates.length > 0 ? { relayEndpointCandidates } : {}),
    sessionNames: sortedSessionNames,
    missingSessionNames: sortedMissingSessionNames,
    ...(lastOpenedSessionName
      && sortedSessionNames.includes(lastOpenedSessionName)
      && !missingSessionNameSet.has(lastOpenedSessionName)
      ? { lastOpenedSessionName }
      : {}),
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

function collapseServerGroups(entries: SessionGroupHistory[]) {
  const ordered = [...entries].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  const collapsed: SessionGroupHistory[] = [];

  for (const entry of ordered) {
    const existingIndex = collapsed.findIndex((item) => sessionGroupOwnersMatch(item, entry));
    if (existingIndex >= 0) {
      const mergedRelayEndpointCandidates = mergeRelayEndpointCandidates(
        collapsed[existingIndex]?.relayEndpointCandidates,
        entry.relayEndpointCandidates,
      );
      if (mergedRelayEndpointCandidates.length > 0 && collapsed[existingIndex]) {
        collapsed[existingIndex] = {
          ...collapsed[existingIndex],
          relayEndpointCandidates: mergedRelayEndpointCandidates,
        };
      }
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

export function useSessionHistoryStorage() {
  const [sessionGroups, setSessionGroups] = useState<SessionGroupHistory[]>([]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      const rawGroups = localStorage.getItem(STORAGE_KEYS.SESSION_GROUPS);
      if (rawGroups) {
        const normalized = collapseServerGroups((JSON.parse(rawGroups) as unknown[])
          .map(normalizeGroupEntry)
          .filter((item): item is SessionGroupHistory => item !== null)
        );
        setSessionGroups(normalized);
        saveJson(STORAGE_KEYS.SESSION_GROUPS, normalized);
      }
    } catch (error) {
      console.error('[useSessionHistoryStorage] Failed to load history:', error);
    }
  }, []);

  const setSessionGroupSelection = useCallback((group: Omit<SessionGroupHistory, 'id' | 'lastOpenedAt'>) => {
    setSessionGroups((current) => {
      const existing = current.find(
        (item) => sessionGroupOwnersMatch(item, group),
      );
      const existingLastOpenedSessionName = existing?.lastOpenedSessionName?.trim() || '';
      const groupSessionNameSet = new Set(
        group.sessionNames.map((item) => item.trim()).filter(Boolean),
      );
      const filtered = current.filter(
        (item) => !sessionGroupOwnersMatch(item, group),
      );

      const normalized = normalizeGroupEntry({
        ...group,
        id: toServerGroupKey(group),
        lastOpenedSessionName: group.lastOpenedSessionName?.trim()
          || (existingLastOpenedSessionName && groupSessionNameSet.has(existingLastOpenedSessionName)
            ? existingLastOpenedSessionName
            : undefined),
        lastOpenedAt: Date.now(),
      });

      const next = normalized ? collapseServerGroups([normalized, ...filtered]) : filtered;
      saveJson(STORAGE_KEYS.SESSION_GROUPS, next);
      return next;
    });
  }, []);

  const deleteSessionGroup = useCallback((target: Pick<SessionGroupHistory, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'terminalBackend'>) => {
    setSessionGroups((current) => {
      const next = current.filter(
        (item) => !sessionGroupOwnersMatch(item, target),
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
      const existing = current.find((item) => sessionGroupOwnersMatch(item, target));
      const filtered = current.filter((item) => !sessionGroupOwnersMatch(item, target));
      const normalized = normalizeGroupEntry({
        ...(existing || {}),
        name: target.name?.trim() || existing?.name || target.daemonHostId || target.bridgeHost || normalizedSessionName,
        bridgeHost: target.bridgeHost,
        bridgePort: target.bridgePort,
        daemonHostId: target.daemonHostId,
        terminalBackend: target.terminalBackend,
        authToken: target.authToken ?? existing?.authToken,
        relayEndpointCandidates: mergeRelayEndpointCandidates(
          existing?.relayEndpointCandidates,
          target.relayEndpointCandidates,
        ),
        sessionNames: [...new Set([...(existing?.sessionNames || []), normalizedSessionName])],
        missingSessionNames: (existing?.missingSessionNames || []).filter((item) => item !== normalizedSessionName),
        lastOpenedSessionName: normalizedSessionName,
        lastOpenedAt: Date.now(),
        id: toServerGroupKey(target),
      });
      const next = normalized ? collapseServerGroups([normalized, ...filtered]) : filtered;
      saveJson(STORAGE_KEYS.SESSION_GROUPS, next);
      return next;
    });
  }, []);

  const pruneSessionGroupSelectionToRemoteTruth = useCallback((
    target: Pick<SessionGroupHistory, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'terminalBackend'>,
    remoteSessionNames: string[],
  ) => {
    const normalizedRemoteSessionNames = new Set(normalizeRemoteTmuxSessionNames(remoteSessionNames));
    setSessionGroups((current) => {
      let changed = false;
      const next = current.flatMap((item) => {
        if (!sessionGroupOwnersMatch(item, target)) {
          return [item];
        }
        const nextMissingSessionNames = item.sessionNames.filter((sessionName) => !normalizedRemoteSessionNames.has(sessionName));
        const currentMissingKey = (item.missingSessionNames || []).join('\u0000');
        const nextMissingKey = nextMissingSessionNames.join('\u0000');
        const nextLastOpenedSessionName = item.lastOpenedSessionName && normalizedRemoteSessionNames.has(item.lastOpenedSessionName)
          ? item.lastOpenedSessionName
          : undefined;
        if (currentMissingKey === nextMissingKey && item.lastOpenedSessionName === nextLastOpenedSessionName) {
          return [item];
        }
        changed = true;
        return [{
          ...item,
          missingSessionNames: nextMissingSessionNames,
          lastOpenedSessionName: nextLastOpenedSessionName,
        }];
      });
      if (!changed) {
        return current;
      }
      const collapsed = collapseServerGroups(next);
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
