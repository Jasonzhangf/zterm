import { useSyncExternalStore } from 'react';

export interface SessionHeadState {
  daemonHeadRevision: number;
  daemonHeadEndIndex: number;
}

export interface SessionHeadStoreSnapshot extends SessionHeadState {
  revision: number;
}

export interface SessionHeadStore {
  getSnapshot: (sessionId: string) => SessionHeadStoreSnapshot;
  subscribe: (sessionId: string, listener: () => void) => () => void;
  setHead: (sessionId: string, head: SessionHeadState) => boolean;
  deleteSession: (sessionId: string) => void;
}

const EMPTY_HEAD: SessionHeadStoreSnapshot = {
  revision: 0,
  daemonHeadRevision: 0,
  daemonHeadEndIndex: 0,
};

export function createSessionHeadStore(): SessionHeadStore {
  const snapshots = new Map<string, SessionHeadStoreSnapshot>();
  const listeners = new Map<string, Set<() => void>>();

  const getSnapshot = (sessionId: string): SessionHeadStoreSnapshot => {
    return snapshots.get(sessionId) || EMPTY_HEAD;
  };

  const subscribe = (sessionId: string, listener: () => void) => {
    const set = listeners.get(sessionId) || new Set<() => void>();
    set.add(listener);
    listeners.set(sessionId, set);
    return () => {
      const current = listeners.get(sessionId);
      if (!current) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        listeners.delete(sessionId);
      }
    };
  };

  const notify = (sessionId: string) => {
    const set = listeners.get(sessionId);
    if (!set) {
      return;
    }
    for (const listener of Array.from(set)) {
      listener();
    }
  };

  const setHead = (sessionId: string, head: SessionHeadState) => {
    const nextHead = {
      daemonHeadRevision: Math.max(0, Math.floor(head.daemonHeadRevision || 0)),
      daemonHeadEndIndex: Math.max(0, Math.floor(head.daemonHeadEndIndex || 0)),
    };
    const previous = snapshots.get(sessionId);
    if (
      previous
      && previous.daemonHeadRevision === nextHead.daemonHeadRevision
      && previous.daemonHeadEndIndex === nextHead.daemonHeadEndIndex
    ) {
      return false;
    }
    snapshots.set(sessionId, {
      revision: (previous?.revision || 0) + 1,
      ...nextHead,
    });
    notify(sessionId);
    return true;
  };

  const deleteSession = (sessionId: string) => {
    snapshots.delete(sessionId);
    notify(sessionId);
    listeners.delete(sessionId);
  };

  return {
    getSnapshot,
    subscribe,
    setHead,
    deleteSession,
  };
}

export function useSessionHeadSnapshot(store: SessionHeadStore, sessionId: string | null | undefined) {
  return useSyncExternalStore(
    (listener) => (sessionId ? store.subscribe(sessionId, listener) : () => undefined),
    () => (sessionId ? store.getSnapshot(sessionId) : EMPTY_HEAD),
    () => EMPTY_HEAD,
  );
}
