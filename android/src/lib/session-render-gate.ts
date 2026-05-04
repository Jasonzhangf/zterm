import type { SessionBufferStore } from './session-buffer-store';
import {
  createSessionRenderBufferStore,
  type SessionRenderBufferStore,
} from './session-render-buffer-store';
import type { SessionBufferState, SessionRenderBufferSnapshot } from './types';
import type { SessionHeadStore } from './session-head-store';

interface RenderGateSessionRuntime {
  scheduled: boolean;
  flushing: boolean;
  dirty: boolean;
  handle: ReturnType<typeof setTimeout> | number | null;
}

export interface SessionRenderGate {
  getRenderStore: () => SessionRenderBufferStore;
  scheduleCommit: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
}

function cloneRenderLines(lines: SessionBufferState['lines']) {
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

function projectRenderBuffer(buffer: SessionBufferState): SessionRenderBufferSnapshot {
  return {
    lines: cloneRenderLines(buffer.lines),
    gapRanges: cloneGapRanges(buffer.gapRanges),
    startIndex: buffer.startIndex,
    endIndex: buffer.endIndex,
    bufferHeadStartIndex: buffer.bufferHeadStartIndex,
    bufferTailEndIndex: buffer.bufferTailEndIndex,
    daemonHeadRevision: 0,
    daemonHeadEndIndex: buffer.bufferTailEndIndex,
    cols: buffer.cols,
    rows: buffer.rows,
    cursorKeysApp: buffer.cursorKeysApp,
    cursor: cloneCursor(buffer.cursor),
    revision: buffer.revision,
  };
}

function scheduleFrame(callback: () => void) {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return globalThis.requestAnimationFrame(() => callback());
  }
  return globalThis.setTimeout(callback, 0);
}

function cancelFrame(handle: ReturnType<typeof setTimeout> | number | null) {
  if (handle === null) {
    return;
  }
  if (typeof handle === 'number' && typeof globalThis.cancelAnimationFrame === 'function') {
    globalThis.cancelAnimationFrame(handle);
    return;
  }
  globalThis.clearTimeout(handle);
}

export function createSessionRenderGate(options: {
  liveBufferStore: SessionBufferStore;
  liveHeadStore: SessionHeadStore;
  recordSessionRenderCommit: (sessionId: string) => void;
}): SessionRenderGate {
  const renderStore = createSessionRenderBufferStore();
  const runtimes = new Map<string, RenderGateSessionRuntime>();

  const ensureRuntime = (sessionId: string) => {
    const current = runtimes.get(sessionId);
    if (current) {
      return current;
    }
    const next: RenderGateSessionRuntime = {
      scheduled: false,
      flushing: false,
      dirty: false,
      handle: null,
    };
    runtimes.set(sessionId, next);
    return next;
  };

  const flush = (sessionId: string) => {
    const runtime = ensureRuntime(sessionId);
    runtime.handle = null;
    runtime.scheduled = false;
    if (runtime.flushing) {
      runtime.dirty = true;
      return;
    }
    runtime.flushing = true;
    try {
      do {
        runtime.dirty = false;
        const liveBuffer = options.liveBufferStore.getSnapshot(sessionId).buffer;
        const liveHead = options.liveHeadStore.getSnapshot(sessionId);
        const changed = renderStore.setBuffer(sessionId, {
          ...projectRenderBuffer(liveBuffer),
          daemonHeadRevision: liveHead.daemonHeadRevision,
          daemonHeadEndIndex: liveHead.daemonHeadEndIndex,
        });
        if (changed) {
          options.recordSessionRenderCommit(sessionId);
        }
      } while (runtime.dirty);
    } finally {
      runtime.flushing = false;
    }
  };

  const scheduleCommit = (sessionId: string) => {
    const runtime = ensureRuntime(sessionId);
    runtime.dirty = true;
    if (runtime.scheduled) {
      return;
    }
    runtime.scheduled = true;
    runtime.handle = scheduleFrame(() => flush(sessionId));
  };

  const deleteSession = (sessionId: string) => {
    const runtime = runtimes.get(sessionId);
    if (runtime) {
      cancelFrame(runtime.handle);
      runtimes.delete(sessionId);
    }
    renderStore.deleteSession(sessionId);
  };

  return {
    getRenderStore: () => renderStore,
    scheduleCommit,
    deleteSession,
  };
}
