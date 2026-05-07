import { useCallback, useEffect, useState } from 'react';
import { normalizeRemoteTmuxSessionNames } from '../lib/tmux-session-list';
import { DEFAULT_BRIDGE_PORT, STORAGE_KEYS, type SessionGroupHistory } from '../lib/types';
import {
  buildSessionSemanticOwnerKey,
  sessionSemanticOwnersMatch,
} from '../lib/session-semantic-identity';

const MAX_GROUP_ENTRIES = 12;

function toServerGroupKey(entry: Pick<SessionGroupHistory, 'daemonHostId' | 'bridgeHost' | 'bridgePort'>) {
  return buildSessionSemanticOwnerKey({
    daemonHostId: entry.daemonHostId,
    bridgeHost: entry.bridgeHost,
    bridgePort: entry.bridgePort,
  });
}

function normalizeGroupEntry(input: unknown): SessionGroupHistory | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const candidate = input as Partial<SessionGroupHistory>;
  const bridgeHost = typeof candidate.bridgeHost === 'string' ? candidate.bridgeHost.trim() : '';
  const sessionNames = Array.isArray(candidate.sessionNames)
    ? candidate.sessionNames.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
    : [];

  if (!bridgeHost || sessionNames.length === 0) {
    return null;
  }

  const sortedSessionNames = [...new Set(sessionNames)].sort((a, b) => a.localeCompare(b));
  const bridgePort =
    typeof candidate.bridgePort === 'number' && Number.isFinite(candidate.bridgePort)
      ? candidate.bridgePort
      : DEFAULT_BRIDGE_PORT;

  return {
    id:
      typeof candidate.id === 'string' && candidate.id.trim()
        ? candidate.id
        : toServerGroupKey({
          daemonHostId: typeof candidate.daemonHostId === 'string' ? candidate.daemonHostId.trim() || undefined : undefined,
          bridgeHost,
          bridgePort,
        }),
    name: typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name : `${bridgeHost} · ${sortedSessionNames.length} sessions`,
    bridgeHost,
    bridgePort,
    daemonHostId: typeof candidate.daemonHostId === 'string' && candidate.daemonHostId.trim()
      ? candidate.daemonHostId.trim()
      : undefined,
    authToken: typeof candidate.authToken === 'string' ? candidate.authToken : undefined,
    sessionNames: sortedSessionNames,
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
    const existingIndex = collapsed.findIndex((item) => sessionSemanticOwnersMatch(item, entry));
    if (existingIndex >= 0) {
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
      const filtered = current.filter(
        (item) => !sessionSemanticOwnersMatch(item, group),
      );

      const normalized = normalizeGroupEntry({
        ...group,
        id: toServerGroupKey(group),
        lastOpenedAt: Date.now(),
      });

      const next = normalized ? collapseServerGroups([normalized, ...filtered]) : filtered;
      saveJson(STORAGE_KEYS.SESSION_GROUPS, next);
      return next;
    });
  }, []);

  const deleteSessionGroup = useCallback((target: Pick<SessionGroupHistory, 'daemonHostId' | 'bridgeHost' | 'bridgePort'>) => {
    setSessionGroups((current) => {
      const next = current.filter(
        (item) => !sessionSemanticOwnersMatch(item, target),
      );
      saveJson(STORAGE_KEYS.SESSION_GROUPS, next);
      return next;
    });
  }, []);

  const pruneSessionGroupSelectionToRemoteTruth = useCallback((
    target: Pick<SessionGroupHistory, 'daemonHostId' | 'bridgeHost' | 'bridgePort'>,
    remoteSessionNames: string[],
  ) => {
    const normalizedRemoteSessionNames = new Set(normalizeRemoteTmuxSessionNames(remoteSessionNames));
    setSessionGroups((current) => {
      let changed = false;
      const next = current.flatMap((item) => {
        if (!sessionSemanticOwnersMatch(item, target)) {
          return [item];
        }
        const nextSessionNames = item.sessionNames.filter((sessionName) => normalizedRemoteSessionNames.has(sessionName));
        if (nextSessionNames.length === item.sessionNames.length) {
          return [item];
        }
        changed = true;
        if (nextSessionNames.length === 0) {
          return [];
        }
        return [{
          ...item,
          sessionNames: nextSessionNames,
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
    deleteSessionGroup,
    pruneSessionGroupSelectionToRemoteTruth,
  };
}
