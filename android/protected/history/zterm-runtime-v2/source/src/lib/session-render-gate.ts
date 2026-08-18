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
  // Track which projected rows can be reused (same reference = unchanged content).
  const reusedRowMask: boolean[] = [];
  const nextLines = buffer.lines.map((row, offset) => {
    if (!previousProjected) {
      reusedRowMask.push(false);
      return cloneRenderRow(row);
    }
    const absoluteIndex = buffer.startIndex + offset;
    if (
      absoluteIndex < options.previousSourceStartIndex
      || absoluteIndex >= options.previousSourceEndIndex
    ) {
      reusedRowMask.push(false);
      return cloneRenderRow(row);
    }
    const previousOffset = absoluteIndex - options.previousSourceStartIndex;
    const previousProjectedRow = previousProjected.lines[previousOffset];
    if (
      previousProjectedRow
      && rowsEqual(row, previousProjectedRow)
    ) {
      reusedRowMask.push(true);
      return previousProjectedRow;
    }
    reusedRowMask.push(false);
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
    && previousProjected.lines.every((line, index) => line === nextLines[index] || reusedRowMask[index])
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
}): SessionRenderGate {
  const renderStore = createSessionRenderBufferStore({ runtimeDebug: options.runtimeDebug });
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
      sourceStartIndex: 0,
      sourceEndIndex: 0,
      sourceRows: [],
    };
    runtimes.set(sessionId, next);
    return next;
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
        const allowRevisionRegression = Boolean(
          previousProjected.revision > 0
          && projected.revision > 0
          && projected.revision < previousProjected.revision
          && projected.daemonHeadRevision < previousProjected.daemonHeadRevision
        );
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
        if (allowRevisionRegression) {
          options.runtimeDebug?.('session.render-gate.revision-reset.publish', {
            sessionId,
            previousRevision: previousProjected.revision,
            nextRevision: projected.revision,
            previousDaemonHeadRevision: previousProjected.daemonHeadRevision,
            nextDaemonHeadRevision: projected.daemonHeadRevision,
            previousStartIndex: previousProjected.startIndex,
            previousEndIndex: previousProjected.endIndex,
            nextStartIndex: projected.startIndex,
            nextEndIndex: projected.endIndex,
          });
        }
        const changed = projected === previousProjected
          ? false
          : renderStore.setBuffer(sessionId, projected, {
              allowRevisionRegression,
              immutableProjection: true,
            });
        if (changed) {
          runtimeDebugPrechecked('terminal.performance.trace', {
            sessionId,
            traceId: `${sessionId}:${Math.max(0, Math.floor(projected.revision || 0))}`,
            mirrorRevision: Math.max(0, Math.floor(projected.revision || 0)),
            subscriberId: sessionId,
            stage: 'render-commit',
            at: Date.now(),
            lineCount: projected.lines.length,
          });
          options.recordSessionRenderCommit(sessionId);
        }
      } while (runtime.dirty);
    } finally {
      runtime.flushing = false;
    }
  };

  // Renderer commit is a pure projection gate: coalesce to one browser frame,
  // then read the current live buffer exactly once. Do not add a second debounce
  // here or a stale scheduled frame can publish old buffer before the latest one.
  let rafTickScheduled = false;
  let rafFallbackTimer: number | null = null;
  const pendingRafSessions = new Set<string>();

  const runRafFrame = () => {
    rafTickScheduled = false;
    if (rafFallbackTimer !== null) {
      clearTimeout(rafFallbackTimer);
      rafFallbackTimer = null;
    }
    const toFlush = Array.from(pendingRafSessions);
    pendingRafSessions.clear();
    for (const sessionId of toFlush) {
      const runtime = runtimes.get(sessionId);
      if (!runtime) {
        continue;
      }
      const liveBuffer = options.liveBufferStore.getSnapshot(sessionId).buffer;
      runtimeDebugPrechecked('terminal.performance.trace', {
        sessionId,
        traceId: `${sessionId}:${Math.max(0, Math.floor(liveBuffer.revision || 0))}`,
        mirrorRevision: Math.max(0, Math.floor(liveBuffer.revision || 0)),
        subscriberId: sessionId,
        stage: 'render-raf',
        at: Date.now(),
        lineCount: liveBuffer.lines.length,
      });
      flush(sessionId);
      if (runtime.dirty && !runtime.scheduled) {
        scheduleFlush(sessionId);
      }
    }
  };

  const scheduleRafFrame = () => {
    if (rafTickScheduled) {
      return;
    }
    rafTickScheduled = true;
    const raf =
      typeof globalThis !== 'undefined' && typeof (globalThis as any).requestAnimationFrame === 'function'
        ? (cb: FrameRequestCallback) => (globalThis as any).requestAnimationFrame(cb)
        : null;
    if (raf) {
      raf(runRafFrame);
    } else {
      rafFallbackTimer = setTimeout(runRafFrame, 16) as unknown as number;
    }
  };

  const enrollSessionIntoRafBatch = (sessionId: string) => {
    const runtime = ensureRuntime(sessionId);
    runtime.scheduled = false;
    pendingRafSessions.add(sessionId);
    scheduleRafFrame();
  };

  const scheduleFlush = (sessionId: string) => {
    const runtime = ensureRuntime(sessionId);
    if (runtime.scheduled) {
      return;
    }
    runtime.scheduled = true;
    enrollSessionIntoRafBatch(sessionId);
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
