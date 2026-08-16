import { useSyncExternalStore } from 'react';
import type { SessionBufferState } from './types';
import { createSessionBufferState, sessionBuffersEqual } from './terminal-buffer';

export interface SessionBufferStoreSnapshot {
  revision: number;
  buffer: SessionBufferState;
}

export interface SessionBufferStoreCommitOptions {
  /**
   * 跳过 store 内第二次 sessionBuffersEqual 全量比较。
   * 调用方（session-context-buffer-runtime）已在 commit 前比较过，
   * 传 true 可省一次 O(rows×cols) 逐 cell 比较。
   */
  skipEqualCheck?: boolean;
}

export interface SessionBufferStore {
  getSnapshot: (sessionId: string) => SessionBufferStoreSnapshot;
  subscribe: (sessionId: string, listener: () => void) => () => void;
  commitBuffer: (sessionId: string, buffer: SessionBufferState, options?: SessionBufferStoreCommitOptions) => boolean;
  setBuffer: (sessionId: string, buffer: SessionBufferState, options?: SessionBufferStoreCommitOptions) => boolean;
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

function cloneGapRanges(gapRanges: SessionBufferState['gapRanges']) {
  return gapRanges.map((range) => ({ ...range }));
}

function gapRangesEqual(
  left: SessionBufferState['gapRanges'],
  right: SessionBufferState['gapRanges'],
) {
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

function cursorEqual(
  left: SessionBufferState['cursor'],
  right: SessionBufferState['cursor'],
) {
  if (left === right) {
    return true;
  }
  return (
    (left?.rowIndex ?? null) === (right?.rowIndex ?? null)
    && (left?.col ?? null) === (right?.col ?? null)
    && (left?.visible ?? null) === (right?.visible ?? null)
  );
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

/**
 * 行级复用 clone：未变行（引用相同）复用 previous 引用，变化行才深拷贝。
 * 前置契约：commit 的 buffer 必须来自 immutable 的 applyBufferSyncToSessionBuffer，
 * 调用方 commit 后不得原地修改任何行内容。行引用不变 = 内容不变。
 * 与 session-render-buffer-store.cloneRenderBuffer 保持一致。
 */
function cloneSessionBuffer(
  buffer: SessionBufferState,
  previous?: SessionBufferStoreSnapshot | null,
): SessionBufferState {
  return {
    ...buffer,
    lines: buffer.lines.map((row, index) => {
      const previousRow = previous?.buffer.lines[index] || null;
      return previousRow && row === previousRow
        ? previousRow
        : row.map((cell) => ({ ...cell }));
    }),
    gapRanges: previous && gapRangesEqual(buffer.gapRanges, previous.buffer.gapRanges)
      ? previous.buffer.gapRanges
      : cloneGapRanges(buffer.gapRanges),
    cursor: previous && cursorEqual(buffer.cursor, previous.buffer.cursor)
      ? previous.buffer.cursor
      : cloneCursor(buffer.cursor),
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

  const commitBuffer = (sessionId: string, buffer: SessionBufferState, options?: SessionBufferStoreCommitOptions) => {
    const previous = snapshots.get(sessionId);
    if (!options?.skipEqualCheck && previous && sessionBuffersEqual(previous.buffer, buffer)) {
      return false;
    }
    snapshots.set(sessionId, {
      revision: (previous?.revision || 0) + 1,
      buffer: cloneSessionBuffer(buffer, previous),
    });
    notify(sessionId);
    return true;
  };

  const setBuffer = (sessionId: string, buffer: SessionBufferState, options?: SessionBufferStoreCommitOptions) => {
    const previous = snapshots.get(sessionId);
    if (!options?.skipEqualCheck && previous && sessionBuffersEqual(previous.buffer, buffer)) {
      return false;
    }
    snapshots.set(sessionId, {
      revision: (previous?.revision || 0) + 1,
      buffer: cloneSessionBuffer(buffer, previous),
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
    commitBuffer,
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
