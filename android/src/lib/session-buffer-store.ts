import { useSyncExternalStore } from 'react';
import type { SessionBufferState } from './types';
import { createSessionBufferState, sessionBuffersEqual } from './terminal-buffer';

export interface SessionBufferStoreSnapshot {
  revision: number;
  buffer: SessionBufferState;
}

export interface SessionBufferStore {
  getSnapshot: (sessionId: string) => SessionBufferStoreSnapshot;
  subscribe: (sessionId: string, listener: () => void) => () => void;
  setBuffer: (sessionId: string, buffer: SessionBufferState) => boolean;
  deleteSession: (sessionId: string) => void;
}

const EMPTY_BUFFER = createSessionBufferState({
  lines: [],
  cols: 80,
  rows: 24,
  cacheLines: 1000,
});

const EMPTY_SNAPSHOT: SessionBufferStoreSnapshot = {
  revision: 0,
  buffer: EMPTY_BUFFER,
};

function cloneBufferLines(lines: SessionBufferState['lines']) {
  return lines.map((row) => row.map((cell) => ({ ...cell })));
}

function cloneGapRanges(gapRanges: SessionBufferState['gapRanges']) {
  return gapRanges.map((range) => ({ ...range }));
}

function cloneCursor(cursor: SessionBufferState['cursor']) {
  if (!cursor) {
    return null;
  }
  return {
    rowIndex: cursor.rowIndex,
    col: cursor.col,
    visible: cursor.visible,
  };
}

function cloneSessionBuffer(buffer: SessionBufferState): SessionBufferState {
  return {
    ...buffer,
    lines: cloneBufferLines(buffer.lines),
    gapRanges: cloneGapRanges(buffer.gapRanges),
    cursor: cloneCursor(buffer.cursor),
  };
}

export function createSessionBufferStore(): SessionBufferStore {
  const snapshots = new Map<string, SessionBufferStoreSnapshot>();
  const listeners = new Map<string, Set<() => void>>();

  const getSnapshot = (sessionId: string): SessionBufferStoreSnapshot => {
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

  const setBuffer = (sessionId: string, buffer: SessionBufferState) => {
    const previous = snapshots.get(sessionId);
    if (previous && sessionBuffersEqual(previous.buffer, buffer)) {
      return false;
    }
    snapshots.set(sessionId, {
      revision: (previous?.revision || 0) + 1,
      buffer: cloneSessionBuffer(buffer),
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
    setBuffer,
    deleteSession,
  };
}

export function useSessionBufferSnapshot(store: SessionBufferStore, sessionId: string | null | undefined) {
  return useSyncExternalStore(
    (listener) => (sessionId ? store.subscribe(sessionId, listener) : () => undefined),
    () => (sessionId ? store.getSnapshot(sessionId) : EMPTY_SNAPSHOT),
    () => EMPTY_SNAPSHOT,
  );
}
