import type { SessionBufferStore } from './session-buffer-store';
import {
  createSessionRenderBufferStore,
  type SessionRenderBufferStore,
} from './session-render-buffer-store';
import { runtimeDebugPrechecked, shouldCollectRuntimeDebugScope } from './runtime-debug';
import { summarizeRenderBufferForDebug, summarizeSessionBufferForDebug } from './terminal-buffer-debug';
import type { SessionBufferState, SessionRenderBufferSnapshot } from './types';
import type { SessionHeadStore } from './session-head-store';
import type { TerminalCell, TerminalCursorState, TerminalGapRange } from './types';

interface RenderGateSessionRuntime {
  flushing: boolean;
  dirty: boolean;
  scheduled: boolean;
  frameTimerId: number | null;
}

export interface SessionRenderGate {
  getRenderStore: () => SessionRenderBufferStore;
  scheduleCommit: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
}

function cloneRenderLines(lines: TerminalCell[][]): TerminalCell[][] {
  return lines.map((row) => row.map((cell) => ({ ...cell })));
}

function cloneRenderGapRanges(gapRanges: TerminalGapRange[]): TerminalGapRange[] {
  return gapRanges.map((range) => ({ ...range }));
}

function cloneRenderCursor(cursor: TerminalCursorState | null): TerminalCursorState | null {
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
    gapRanges: cloneRenderGapRanges(buffer.gapRanges),
    startIndex: buffer.startIndex,
    endIndex: buffer.endIndex,
    bufferHeadStartIndex: buffer.bufferHeadStartIndex,
    bufferTailEndIndex: buffer.bufferTailEndIndex,
    daemonHeadRevision: 0,
    daemonHeadEndIndex: buffer.bufferTailEndIndex,
    cols: buffer.cols,
    rows: buffer.rows,
    cursorKeysApp: buffer.cursorKeysApp,
    cursor: cloneRenderCursor(buffer.cursor),
    revision: buffer.revision,
  };
}

export function createSessionRenderGate(options: {
  liveBufferStore: SessionBufferStore;
  liveHeadStore: SessionHeadStore;
  recordSessionRenderCommit: (sessionId: string) => void;
  runtimeDebug?: (event: string, payload?: Record<string, unknown>) => void;
  resolveRenderCommitMs?: () => number;
}): SessionRenderGate {
  const renderStore = createSessionRenderBufferStore();
  const runtimes = new Map<string, RenderGateSessionRuntime>();

  const ensureRuntime = (sessionId: string) => {
    const current = runtimes.get(sessionId);
    if (current) {
      return current;
    }
    const next: RenderGateSessionRuntime = {
      flushing: false,
      dirty: false,
      scheduled: false,
      frameTimerId: null,
    };
    runtimes.set(sessionId, next);
    return next;
  };

  const clearScheduledTimer = (runtime: RenderGateSessionRuntime) => {
    if (runtime.frameTimerId !== null) {
      clearTimeout(runtime.frameTimerId);
      runtime.frameTimerId = null;
    }
  };

  const flush = (sessionId: string) => {
    const runtime = ensureRuntime(sessionId);
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
        const projectedBuffer = projectRenderBuffer(liveBuffer);
        const projected = {
          ...projectedBuffer,
          daemonHeadRevision: liveHead.daemonHeadRevision,
          daemonHeadEndIndex: liveHead.daemonHeadEndIndex,
        };
        if (options.runtimeDebug && shouldCollectRuntimeDebugScope('session.render-gate.flush.inspect')) {
          runtimeDebugPrechecked('session.render-gate.flush.inspect', {
            sessionId,
            liveBuffer: summarizeSessionBufferForDebug(liveBuffer),
            liveHead: {
              revision: liveHead.revision,
              daemonHeadRevision: liveHead.daemonHeadRevision,
              daemonHeadEndIndex: liveHead.daemonHeadEndIndex,
            },
            projected: summarizeRenderBufferForDebug(projected),
          });
        }
        const changed = renderStore.setBuffer(sessionId, projected);
        if (changed) {
          options.recordSessionRenderCommit(sessionId);
        }
      } while (runtime.dirty);
    } finally {
      runtime.flushing = false;
    }
  };

  const scheduleFlush = (sessionId: string) => {
    const runtime = ensureRuntime(sessionId);
    if (runtime.scheduled) {
      return;
    }
    runtime.scheduled = true;
    const runFlush = () => {
      clearScheduledTimer(runtime);
      runtime.scheduled = false;
      flush(sessionId);
      if (runtime.dirty && !runtime.scheduled) {
        scheduleFlush(sessionId);
      }
    };
    const renderCommitMs = Math.max(16, Math.floor(options.resolveRenderCommitMs?.() || 33));
    runtime.frameTimerId = setTimeout(runFlush, renderCommitMs) as unknown as number;
  };

  const scheduleCommit = (sessionId: string) => {
    const runtime = ensureRuntime(sessionId);
    runtime.dirty = true;
    if (runtime.flushing) {
      return;
    }
    scheduleFlush(sessionId);
  };

  const deleteSession = (sessionId: string) => {
    const runtime = runtimes.get(sessionId);
    if (runtime) {
      clearScheduledTimer(runtime);
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
