import type { SessionBufferStore } from './session-buffer-store';
import {
  createSessionRenderBufferStore,
  type SessionRenderBufferStore,
} from './session-render-buffer-store';
import { summarizeRenderBufferForDebug, summarizeSessionBufferForDebug } from './terminal-buffer-debug';
import type { SessionBufferState, SessionRenderBufferSnapshot } from './types';
import type { SessionHeadStore } from './session-head-store';

interface RenderGateSessionRuntime {
  flushing: boolean;
  dirty: boolean;
  scheduled: boolean;
  frameTimerId: number | null;
  fallbackTimerId: number | null;
  lastLiveBuffer: SessionBufferState | null;
  lastProjectedBuffer: SessionRenderBufferSnapshot | null;
}

export interface SessionRenderGate {
  getRenderStore: () => SessionRenderBufferStore;
  scheduleCommit: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
}

function projectRenderBuffer(buffer: SessionBufferState): SessionRenderBufferSnapshot {
  return {
    // liveBufferStore already publishes cloned immutable snapshots.
    // Reusing those references here avoids a second full deep-clone on every render commit.
    lines: buffer.lines,
    gapRanges: buffer.gapRanges,
    startIndex: buffer.startIndex,
    endIndex: buffer.endIndex,
    bufferHeadStartIndex: buffer.bufferHeadStartIndex,
    bufferTailEndIndex: buffer.bufferTailEndIndex,
    daemonHeadRevision: 0,
    daemonHeadEndIndex: buffer.bufferTailEndIndex,
    cols: buffer.cols,
    rows: buffer.rows,
    cursorKeysApp: buffer.cursorKeysApp,
    cursor: buffer.cursor,
    revision: buffer.revision,
  };
}

export function createSessionRenderGate(options: {
  liveBufferStore: SessionBufferStore;
  liveHeadStore: SessionHeadStore;
  recordSessionRenderCommit: (sessionId: string) => void;
  runtimeDebug?: (event: string, payload?: Record<string, unknown>) => void;
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
      fallbackTimerId: null,
      lastLiveBuffer: null,
      lastProjectedBuffer: null,
    };
    runtimes.set(sessionId, next);
    return next;
  };

  const clearScheduledTimer = (runtime: RenderGateSessionRuntime) => {
    if (runtime.frameTimerId !== null) {
      if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(runtime.frameTimerId);
      } else {
        clearTimeout(runtime.frameTimerId);
      }
      runtime.frameTimerId = null;
    }
    if (runtime.fallbackTimerId !== null) {
      clearTimeout(runtime.fallbackTimerId);
      runtime.fallbackTimerId = null;
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
        const projectedBuffer = (
          runtime.lastLiveBuffer === liveBuffer
          && runtime.lastProjectedBuffer
        )
          ? runtime.lastProjectedBuffer
          : projectRenderBuffer(liveBuffer);
        if (runtime.lastLiveBuffer !== liveBuffer || runtime.lastProjectedBuffer !== projectedBuffer) {
          runtime.lastLiveBuffer = liveBuffer;
          runtime.lastProjectedBuffer = projectedBuffer;
        }
        const projected = {
          ...projectedBuffer,
          daemonHeadRevision: liveHead.daemonHeadRevision,
          daemonHeadEndIndex: liveHead.daemonHeadEndIndex,
        };
        options.runtimeDebug?.('session.render-gate.flush.inspect', {
          sessionId,
          liveBuffer: summarizeSessionBufferForDebug(liveBuffer),
          liveHead: {
            revision: liveHead.revision,
            daemonHeadRevision: liveHead.daemonHeadRevision,
            daemonHeadEndIndex: liveHead.daemonHeadEndIndex,
          },
          projected: summarizeRenderBufferForDebug(projected),
        });
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
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      runtime.frameTimerId = window.requestAnimationFrame(() => runFlush());
    }
    runtime.fallbackTimerId = setTimeout(runFlush, 34) as unknown as number;
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
