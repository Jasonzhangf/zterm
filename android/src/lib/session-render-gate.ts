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
  sourceStartIndex: number;
  sourceEndIndex: number;
  sourceRows: TerminalCell[][];
}

export interface SessionRenderGate {
  getRenderStore: () => SessionRenderBufferStore;
  scheduleCommit: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
}

function cloneRenderRow(row: TerminalCell[]): TerminalCell[] {
  return row.map((cell) => ({ ...cell }));
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

function projectRenderBuffer(options: {
  buffer: SessionBufferState;
  daemonHeadRevision: number;
  daemonHeadEndIndex: number;
  previousProjected: SessionRenderBufferSnapshot | null;
  previousSourceStartIndex: number;
  previousSourceEndIndex: number;
  previousSourceRows: TerminalCell[][];
}) {
  const { buffer, previousProjected } = options;
  const nextLines = buffer.lines.map((row, offset) => {
    if (!previousProjected) {
      return cloneRenderRow(row);
    }
    const absoluteIndex = buffer.startIndex + offset;
    if (
      absoluteIndex < options.previousSourceStartIndex
      || absoluteIndex >= options.previousSourceEndIndex
    ) {
      return cloneRenderRow(row);
    }
    const previousOffset = absoluteIndex - options.previousSourceStartIndex;
    const previousSourceRow = options.previousSourceRows[previousOffset];
    const previousProjectedRow = previousProjected.lines[previousOffset];
    if (
      previousSourceRow === row
      && previousProjectedRow
      && rowsEqual(row, previousProjectedRow)
    ) {
      return previousProjectedRow;
    }
    return cloneRenderRow(row);
  });

  const nextGapRanges = (
    previousProjected && gapRangesEqual(buffer.gapRanges, previousProjected.gapRanges)
      ? previousProjected.gapRanges
      : cloneRenderGapRanges(buffer.gapRanges)
  );
  const nextCursor = (
    previousProjected && cursorEqual(buffer.cursor, previousProjected.cursor)
      ? previousProjected.cursor
      : cloneRenderCursor(buffer.cursor)
  );

  const canReusePrevious = Boolean(
    previousProjected
    && previousProjected.startIndex === buffer.startIndex
    && previousProjected.endIndex === buffer.endIndex
    && previousProjected.bufferHeadStartIndex === buffer.bufferHeadStartIndex
    && previousProjected.bufferTailEndIndex === buffer.bufferTailEndIndex
    && previousProjected.daemonHeadRevision === options.daemonHeadRevision
    && previousProjected.daemonHeadEndIndex === options.daemonHeadEndIndex
    && previousProjected.cols === buffer.cols
    && previousProjected.rows === buffer.rows
    && previousProjected.cursorKeysApp === buffer.cursorKeysApp
    && previousProjected.cursor === nextCursor
    && previousProjected.gapRanges === nextGapRanges
    && previousProjected.revision === buffer.revision
    && previousProjected.lines.length === nextLines.length
    && previousProjected.lines.every((line, index) => line === nextLines[index])
  );

  return {
    projected: canReusePrevious
      ? previousProjected!
      : {
          lines: nextLines,
          gapRanges: nextGapRanges,
          startIndex: buffer.startIndex,
          endIndex: buffer.endIndex,
          bufferHeadStartIndex: buffer.bufferHeadStartIndex,
          bufferTailEndIndex: buffer.bufferTailEndIndex,
          daemonHeadRevision: options.daemonHeadRevision,
          daemonHeadEndIndex: options.daemonHeadEndIndex,
          cols: buffer.cols,
          rows: buffer.rows,
          cursorKeysApp: buffer.cursorKeysApp,
          cursor: nextCursor,
          revision: buffer.revision,
        },
    sourceStartIndex: buffer.startIndex,
    sourceEndIndex: buffer.endIndex,
    sourceRows: buffer.lines,
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
      sourceStartIndex: 0,
      sourceEndIndex: 0,
      sourceRows: [],
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
        const previousProjected = renderStore.getSnapshot(sessionId).buffer;
        const {
          projected,
          sourceStartIndex,
          sourceEndIndex,
          sourceRows,
        } = projectRenderBuffer({
          buffer: liveBuffer,
          daemonHeadRevision: liveHead.daemonHeadRevision,
          daemonHeadEndIndex: liveHead.daemonHeadEndIndex,
          previousProjected: previousProjected.revision > 0 ? previousProjected : null,
          previousSourceStartIndex: runtime.sourceStartIndex,
          previousSourceEndIndex: runtime.sourceEndIndex,
          previousSourceRows: runtime.sourceRows,
        });
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
        runtime.sourceStartIndex = sourceStartIndex;
        runtime.sourceEndIndex = sourceEndIndex;
        runtime.sourceRows = sourceRows;
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
