import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildStoredHost,
  getResolvedSessionName,
  normalizeHost,
} from '../connection/connection-target';
import { STORAGE_KEYS, type EditableHost, type Host } from '../connection/types';

const DEFAULT_HOSTS: Host[] = [];

function loadHosts() {
  if (typeof window === 'undefined') {
    return DEFAULT_HOSTS;
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEYS.HOSTS);
    if (!stored) {
      return DEFAULT_HOSTS;
    }

    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      return DEFAULT_HOSTS;
    }

    return parsed
      .map((item) => normalizeHost(item))
      .filter((item): item is Host => item !== null);
  } catch (error) {
    console.error('[useHostStorage] Failed to load hosts:', error);
    return DEFAULT_HOSTS;
  }
}

function normalizeEditableUpdates(current: Host, updates: Partial<EditableHost>) {
  const normalized = normalizeHost({
    ...current,
    ...updates,
  });

  return normalized
    ? {
        ...normalized,
        id: current.id,
        createdAt: current.createdAt,
      }
    : current;
}

export function useHostStorage() {
  const [hosts, setHosts] = useState<Host[]>(DEFAULT_HOSTS);
  const [isLoaded, setIsLoaded] = useState(false);
  const hostsRef = useRef<Host[]>(DEFAULT_HOSTS);

  useEffect(() => {
    const normalized = loadHosts();
    hostsRef.current = normalized;
    setHosts(normalized);
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.HOSTS, JSON.stringify(normalized));
    }
    setIsLoaded(true);
  }, []);

  const saveHosts = useCallback((updater: Host[] | ((current: Host[]) => Host[])) => {
    const currentHosts = hostsRef.current;
    const nextHosts = typeof updater === 'function' ? updater(currentHosts) : updater;
    hostsRef.current = nextHosts;
    setHosts(nextHosts);
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.HOSTS, JSON.stringify(nextHosts));
    }
    return nextHosts;
  }, []);

  const addHost = useCallback(
    (host: EditableHost) => {
      let created!: Host;
      saveHosts((current) => {
        created = buildStoredHost(host);
        return [...current, created];
      });
      return created;
    },
    [saveHosts],
  );

  const updateHost = useCallback(
    (id: string, updates: Partial<EditableHost>) => {
      saveHosts((current) =>
        current.map((item) =>
          item.id === id
            ? normalizeEditableUpdates(item, updates)
            : item,
        ),
      );
    },
    [saveHosts],
  );

  const upsertHost = useCallback(
    (host: EditableHost) => {
      let nextHost!: Host;
      saveHosts((current) => {
        const targetSessionName = getResolvedSessionName(host);
        const existing = current.find(
          (item) =>
            item.bridgeHost === host.bridgeHost &&
            item.bridgePort === host.bridgePort &&
            getResolvedSessionName(item) === targetSessionName,
        );

        if (existing) {
          nextHost = normalizeEditableUpdates(existing, host);
          return current.map((item) => (item.id === existing.id ? (nextHost as Host) : item));
        }

        nextHost = buildStoredHost(host);
        return [...current, nextHost];
      });
      return nextHost;
    },
    [saveHosts],
  );

  const deleteHost = useCallback(
    (id: string) => {
      saveHosts((current) => current.filter((item) => item.id !== id));
    },
    [saveHosts],
  );

  const getHost = useCallback((id: string) => hosts.find((item) => item.id === id), [hosts]);

  const pinnedHosts = useMemo(() => hosts.filter((host) => host.pinned), [hosts]);
  const recentHosts = useMemo(
    () =>
      [...hosts]
        .filter((host) => host.lastConnected)
        .sort((a, b) => (b.lastConnected || 0) - (a.lastConnected || 0))
        .slice(0, 3),
    [hosts],
  );

  return {
    hosts,
    isLoaded,
    addHost,
    upsertHost,
    updateHost,
    deleteHost,
    getHost,
    pinnedHosts,
    recentHosts,
  };
}
