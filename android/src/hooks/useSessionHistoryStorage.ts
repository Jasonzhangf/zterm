import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_BRIDGE_PORT, STORAGE_KEYS, type SessionGroupHistory, type SessionHistoryEntry } from '../lib/types';

const MAX_HISTORY_ENTRIES = 24;
const MAX_GROUP_ENTRIES = 12;

function toServerGroupKey(entry: Pick<SessionGroupHistory, 'bridgeHost' | 'bridgePort'>) {
  return `${entry.bridgeHost}:${entry.bridgePort}`;
}

function normalizeHistoryEntry(input: unknown): SessionHistoryEntry | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const candidate = input as Partial<SessionHistoryEntry>;
  const bridgeHost = typeof candidate.bridgeHost === 'string' ? candidate.bridgeHost.trim() : '';
  const sessionName = typeof candidate.sessionName === 'string' ? candidate.sessionName.trim() : '';
  const connectionName = typeof candidate.connectionName === 'string' ? candidate.connectionName.trim() : '';

  if (!bridgeHost || !sessionName) {
    return null;
  }

  return {
    id:
      typeof candidate.id === 'string' && candidate.id.trim()
        ? candidate.id
        : `${bridgeHost}:${candidate.bridgePort || DEFAULT_BRIDGE_PORT}:${sessionName}`,
    connectionName: connectionName || sessionName,
    bridgeHost,
    bridgePort:
      typeof candidate.bridgePort === 'number' && Number.isFinite(candidate.bridgePort)
        ? candidate.bridgePort
        : DEFAULT_BRIDGE_PORT,
    sessionName,
    authToken: typeof candidate.authToken === 'string' ? candidate.authToken : undefined,
    lastOpenedAt:
      typeof candidate.lastOpenedAt === 'number' && Number.isFinite(candidate.lastOpenedAt)
        ? candidate.lastOpenedAt
        : Date.now(),
  };
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
        : `${bridgeHost}:${bridgePort}`,
    name: typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name : `${bridgeHost} · ${sortedSessionNames.length} tabs`,
    bridgeHost,
    bridgePort,
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
  const collapsed = new Map<string, SessionGroupHistory>();

  for (const entry of ordered) {
    const key = toServerGroupKey(entry);
    if (collapsed.has(key)) {
      continue;
    }
    collapsed.set(key, {
      ...entry,
      id: key,
    });
  }

  return [...collapsed.values()]
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .slice(0, MAX_GROUP_ENTRIES);
}

export function useSessionHistoryStorage() {
  const [sessionHistory, setSessionHistory] = useState<SessionHistoryEntry[]>([]);
  const [sessionGroups, setSessionGroups] = useState<SessionGroupHistory[]>([]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      const rawHistory = localStorage.getItem(STORAGE_KEYS.SESSION_HISTORY);
      if (rawHistory) {
        const normalized = (JSON.parse(rawHistory) as unknown[])
          .map(normalizeHistoryEntry)
          .filter((item): item is SessionHistoryEntry => item !== null)
          .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
          .slice(0, MAX_HISTORY_ENTRIES);
        setSessionHistory(normalized);
        saveJson(STORAGE_KEYS.SESSION_HISTORY, normalized);
      }

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

  const recordSessionOpen = useCallback((entry: Omit<SessionHistoryEntry, 'id' | 'lastOpenedAt'>) => {
    setSessionHistory((current) => {
      const normalized = normalizeHistoryEntry({
        ...entry,
        id: `${entry.bridgeHost}:${entry.bridgePort}:${entry.sessionName}`,
        lastOpenedAt: Date.now(),
      });
      if (!normalized) {
        return current;
      }

      const next = [
        normalized,
        ...current.filter(
          (item) =>
            !(
              item.bridgeHost === normalized.bridgeHost &&
              item.bridgePort === normalized.bridgePort &&
              item.sessionName === normalized.sessionName
            ),
        ),
      ].slice(0, MAX_HISTORY_ENTRIES);

      saveJson(STORAGE_KEYS.SESSION_HISTORY, next);
      return next;
    });
  }, []);

  const recordSessionGroupOpen = useCallback((group: Omit<SessionGroupHistory, 'id' | 'lastOpenedAt'>) => {
    setSessionGroups((current) => {
      const normalized = normalizeGroupEntry({
        ...group,
        id: `${group.bridgeHost}:${group.bridgePort}`,
        lastOpenedAt: Date.now(),
      });
      if (!normalized) {
        return current;
      }

      const next = collapseServerGroups([
        normalized,
        ...current.filter(
          (item) =>
            !(
              item.bridgeHost === normalized.bridgeHost &&
              item.bridgePort === normalized.bridgePort
            ),
        ),
      ]);

      saveJson(STORAGE_KEYS.SESSION_GROUPS, next);
      return next;
    });
  }, []);

  const setSessionGroupSelection = useCallback((group: Omit<SessionGroupHistory, 'id' | 'lastOpenedAt'>) => {
    setSessionGroups((current) => {
      const filtered = current.filter(
        (item) => !(item.bridgeHost === group.bridgeHost && item.bridgePort === group.bridgePort),
      );

      const normalized = normalizeGroupEntry({
        ...group,
        id: `${group.bridgeHost}:${group.bridgePort}`,
        lastOpenedAt: Date.now(),
      });

      const next = normalized ? collapseServerGroups([normalized, ...filtered]) : filtered;
      saveJson(STORAGE_KEYS.SESSION_GROUPS, next);
      return next;
    });
  }, []);

  const deleteSessionGroup = useCallback((target: Pick<SessionGroupHistory, 'bridgeHost' | 'bridgePort'>) => {
    setSessionGroups((current) => {
      const next = current.filter(
        (item) => !(item.bridgeHost === target.bridgeHost && item.bridgePort === target.bridgePort),
      );
      saveJson(STORAGE_KEYS.SESSION_GROUPS, next);
      return next;
    });
  }, []);

  return {
    sessionHistory,
    sessionGroups,
    recordSessionOpen,
    recordSessionGroupOpen,
    setSessionGroupSelection,
    deleteSessionGroup,
  };
}
