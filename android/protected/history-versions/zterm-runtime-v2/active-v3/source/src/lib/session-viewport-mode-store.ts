import { useSyncExternalStore } from 'react';
import type { TerminalViewportMode } from './types';

export interface SessionViewportModeStoreSnapshot {
  revision: number;
  mode: TerminalViewportMode;
}

export interface SessionViewportModeStore {
  getSnapshot: (sessionId: string) => SessionViewportModeStoreSnapshot;
  subscribe: (sessionId: string, listener: () => void) => () => void;
  setMode: (sessionId: string, mode: TerminalViewportMode) => boolean;
  deleteSession: (sessionId: string) => void;
}

const EMPTY_SNAPSHOT: SessionViewportModeStoreSnapshot = {
  revision: 0,
  mode: 'follow',
};

export function createSessionViewportModeStore(): SessionViewportModeStore {
  const snapshots = new Map<string, SessionViewportModeStoreSnapshot>();
  const listeners = new Map<string, Set<() => void>>();

  const getSnapshot = (sessionId: string): SessionViewportModeStoreSnapshot => {
    return snapshots.get(sessionId) || EMPTY_SNAPSHOT;
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

  const setMode = (sessionId: string, mode: TerminalViewportMode) => {
    const safeMode: TerminalViewportMode = mode === 'reading' ? 'reading' : 'follow';
    const previous = snapshots.get(sessionId);
    if (previous?.mode === safeMode) {
      return false;
    }
    snapshots.set(sessionId, {
      revision: (previous?.revision || 0) + 1,
      mode: safeMode,
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
    setMode,
    deleteSession,
  };
}

export function useSessionViewportModeSnapshot(store: SessionViewportModeStore, sessionId: string | null | undefined) {
  return useSyncExternalStore(
    (listener) => (sessionId ? store.subscribe(sessionId, listener) : () => undefined),
    () => (sessionId ? store.getSnapshot(sessionId) : EMPTY_SNAPSHOT),
    () => EMPTY_SNAPSHOT,
  );
}
