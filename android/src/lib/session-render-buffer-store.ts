import { useSyncExternalStore } from 'react';
import type { SessionRenderBufferSnapshot, TerminalCell, TerminalCursorState, TerminalGapRange } from './types';

export interface SessionRenderStoreSnapshot {
  revision: number;
  buffer: SessionRenderBufferSnapshot;
}

export interface SessionRenderBufferStore {
  getSnapshot: (sessionId: string) => SessionRenderStoreSnapshot;
  subscribe: (sessionId: string, listener: () => void) => () => void;
  setBuffer: (
    sessionId: string,
    buffer: SessionRenderBufferSnapshot,
    options?: { allowRevisionRegression?: boolean; immutableProjection?: boolean },
  ) => boolean;
  deleteSession: (sessionId: string) => void;
}

export interface SessionRenderBufferStoreOptions {
  runtimeDebug?: (event: string, payload?: Record<string, unknown>) => void;
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

function cloneRenderGapRanges(gapRanges: SessionRenderBufferSnapshot['gapRanges']) {
  return gapRanges.map((range) => ({ ...range }));
}

function cloneRenderCursor(cursor: SessionRenderBufferSnapshot['cursor']) {
  if (!cursor) {
    return null;
  }
  return {
    rowIndex: cursor.rowIndex,
    col: cursor.col,
    visible: cursor.visible,
  };
}

function cloneRenderBuffer(
  buffer: SessionRenderBufferSnapshot,
  previous?: SessionRenderBufferSnapshot | null,
  previousSourceRows?: Map<TerminalCell[], TerminalCell[]> | null,
  nextSourceRows?: Map<TerminalCell[], TerminalCell[]>,
): SessionRenderBufferSnapshot {
  // Buffer rows are immutable by reference: a changed row must be a new array,
  // so an unchanged source row can reuse its previous deep clone safely.
  return {
    ...buffer,
    lines: buffer.lines.map((row, index) => {
      const reusedClone = previousSourceRows?.get(row)
        || (previous && row === previous.lines[index] ? row : null);
      if (reusedClone) {
        nextSourceRows?.set(row, reusedClone);
        return reusedClone;
      }
      const clonedRow = row.map((cell) => ({ ...cell }));
      nextSourceRows?.set(row, clonedRow);
      return clonedRow;
    }),
    gapRanges: previous && gapRangesEqual(buffer.gapRanges, previous.gapRanges)
      ? previous.gapRanges
      : cloneRenderGapRanges(buffer.gapRanges),
    cursor: previous && cursorEqual(buffer.cursor, previous.cursor)
      ? previous.cursor
      : cloneRenderCursor(buffer.cursor),
  };
}

function cursorEqual(left: TerminalCursorState | null, right: TerminalCursorState | null) {
  if (left === right) {
    return true;
  }
  return (
    (left?.rowIndex ?? null) === (right?.rowIndex ?? null)
    && (left?.col ?? null) === (right?.col ?? null)
    && (left?.visible ?? null) === (right?.visible ?? null)
  );
}

function gapRangesEqual(left: TerminalGapRange[], right: TerminalGapRange[]) {
  if (left === right) {
    return true;
  }
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
  if (left === right) {
    return true;
  }
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
  if (left === right) {
    return true;
  }
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

export function createSessionRenderBufferStore(
  options: SessionRenderBufferStoreOptions = {},
): SessionRenderBufferStore {
  const snapshots = new Map<string, SessionRenderStoreSnapshot>();
  const listeners = new Map<string, Set<() => void>>();
  const sourceRowClonesBySession = new Map<string, Map<TerminalCell[], TerminalCell[]>>();

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

  const setBuffer = (
    sessionId: string,
    buffer: SessionRenderBufferSnapshot,
    setOptions?: { allowRevisionRegression?: boolean; immutableProjection?: boolean },
  ) => {
    const previous = snapshots.get(sessionId);
    if (
      previous
      && previous.buffer.revision > 0
      && buffer.revision > 0
      && buffer.revision < previous.buffer.revision
      && !setOptions?.allowRevisionRegression
    ) {
      options.runtimeDebug?.('session.render-store.revision-regression-drop', {
        sessionId,
        previousRevision: previous.buffer.revision,
        incomingRevision: buffer.revision,
        previousStartIndex: previous.buffer.startIndex,
        previousEndIndex: previous.buffer.endIndex,
        incomingStartIndex: buffer.startIndex,
        incomingEndIndex: buffer.endIndex,
      });
      return false;
    }
    if (previous && !setOptions?.immutableProjection && renderBuffersEqual(previous.buffer, buffer)) {
      return false;
    }
    const previousSourceRows = sourceRowClonesBySession.get(sessionId) || null;
    const nextSourceRows = new Map<TerminalCell[], TerminalCell[]>();
    let nextSnapshot: SessionRenderStoreSnapshot;
    if (setOptions?.immutableProjection) {
      for (const row of buffer.lines) {
        nextSourceRows.set(row, row);
      }
      nextSnapshot = {
        revision: (previous?.revision || 0) + 1,
        buffer: { ...buffer },
      };
    } else {
      nextSnapshot = {
        revision: (previous?.revision || 0) + 1,
        buffer: cloneRenderBuffer(
          buffer,
          previous?.buffer || null,
          previousSourceRows,
          nextSourceRows,
        ),
      };
    }
    snapshots.set(sessionId, nextSnapshot);
    sourceRowClonesBySession.set(sessionId, nextSourceRows);
    notify(sessionId);
    return true;
  };

  const deleteSession = (sessionId: string) => {
    snapshots.delete(sessionId);
    sourceRowClonesBySession.delete(sessionId);
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
  store: SessionRenderBufferStore | null | undefined,
  sessionId: string | null | undefined,
) {
  return useSyncExternalStore(
    (listener) => (sessionId && store ? store.subscribe(sessionId, listener) : () => undefined),
    () => (sessionId && store ? store.getSnapshot(sessionId) : EMPTY_SNAPSHOT),
    () => EMPTY_SNAPSHOT,
  );
}
