import { useSyncExternalStore } from 'react';
import type { SessionRenderBufferSnapshot, TerminalCell, TerminalCursorState, TerminalGapRange } from './types';

export interface SessionRenderStoreSnapshot {
  revision: number;
  buffer: SessionRenderBufferSnapshot;
}

export interface SessionRenderBufferStore {
  getSnapshot: (sessionId: string) => SessionRenderStoreSnapshot;
  subscribe: (sessionId: string, listener: () => void) => () => void;
  setBuffer: (sessionId: string, buffer: SessionRenderBufferSnapshot) => boolean;
  deleteSession: (sessionId: string) => void;
}

const EMPTY_LINES: TerminalCell[][] = [];
const EMPTY_GAPS: TerminalGapRange[] = [];

const EMPTY_BUFFER: SessionRenderBufferSnapshot = {
  lines: EMPTY_LINES,
  gapRanges: EMPTY_GAPS,
  startIndex: 0,
  endIndex: 0,
  bufferHeadStartIndex: 0,
  bufferTailEndIndex: 0,
  daemonHeadRevision: 0,
  daemonHeadEndIndex: 0,
  cols: 80,
  rows: 24,
  cursorKeysApp: false,
  cursor: null,
  revision: 0,
};

const EMPTY_SNAPSHOT: SessionRenderStoreSnapshot = {
  revision: 0,
  buffer: EMPTY_BUFFER,
};

function cursorEqual(left: TerminalCursorState | null, right: TerminalCursorState | null) {
  return (
    (left?.rowIndex ?? null) === (right?.rowIndex ?? null)
    && (left?.col ?? null) === (right?.col ?? null)
    && (left?.visible ?? null) === (right?.visible ?? null)
  );
}

function gapRangesEqual(left: TerminalGapRange[], right: TerminalGapRange[]) {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (
      left[index]?.startIndex !== right[index]?.startIndex
      || left[index]?.endIndex !== right[index]?.endIndex
    ) {
      return false;
    }
  }
  return true;
}

function rowsEqual(left: TerminalCell[], right: TerminalCell[]) {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (!a || !b) {
      return false;
    }
    if (
      a.char !== b.char
      || a.fg !== b.fg
      || a.bg !== b.bg
      || a.flags !== b.flags
      || a.width !== b.width
    ) {
      return false;
    }
  }
  return true;
}

function renderBuffersEqual(left: SessionRenderBufferSnapshot, right: SessionRenderBufferSnapshot) {
  if (
    left.revision !== right.revision
    || left.startIndex !== right.startIndex
    || left.endIndex !== right.endIndex
    || left.bufferHeadStartIndex !== right.bufferHeadStartIndex
    || left.bufferTailEndIndex !== right.bufferTailEndIndex
    || left.daemonHeadRevision !== right.daemonHeadRevision
    || left.daemonHeadEndIndex !== right.daemonHeadEndIndex
    || left.cols !== right.cols
    || left.rows !== right.rows
    || left.cursorKeysApp !== right.cursorKeysApp
    || left.lines.length !== right.lines.length
    || !cursorEqual(left.cursor, right.cursor)
    || !gapRangesEqual(left.gapRanges, right.gapRanges)
  ) {
    return false;
  }

  for (let index = 0; index < left.lines.length; index += 1) {
    if (!rowsEqual(left.lines[index] || [], right.lines[index] || [])) {
      return false;
    }
  }
  return true;
}

export function createSessionRenderBufferStore(): SessionRenderBufferStore {
  const snapshots = new Map<string, SessionRenderStoreSnapshot>();
  const listeners = new Map<string, Set<() => void>>();

  const getSnapshot = (sessionId: string): SessionRenderStoreSnapshot => {
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

  const setBuffer = (sessionId: string, buffer: SessionRenderBufferSnapshot) => {
    const previous = snapshots.get(sessionId);
    if (previous && renderBuffersEqual(previous.buffer, buffer)) {
      return false;
    }
    snapshots.set(sessionId, {
      revision: (previous?.revision || 0) + 1,
      buffer,
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

export function useSessionRenderBufferSnapshot(
  store: SessionRenderBufferStore,
  sessionId: string | null | undefined,
) {
  return useSyncExternalStore(
    (listener) => (sessionId ? store.subscribe(sessionId, listener) : () => undefined),
    () => (sessionId ? store.getSnapshot(sessionId) : EMPTY_SNAPSHOT),
    () => EMPTY_SNAPSHOT,
  );
}
