// @vitest-environment jsdom
/**
 * White-box regression: render gate must reproject changed cell content
 * even when window size / revision stays the same.
 *
 * This targets the specific path:
 *   applyBufferSyncToSessionBuffer() -> liveBufferStore.setBuffer()
 *   -> renderGate.scheduleCommit() -> flush() -> projectRenderBuffer()
 *
 * Hypothesis A: projectRenderBuffer clones rows → new cell refs → OK (green)
 * Hypothesis B: row reference is reused → stale content persists (red → fix needed)
 */

import { describe, expect, it, vi } from 'vitest';
import { createSessionBufferStore } from './session-buffer-store';
import { createSessionRenderGate } from './session-render-gate';
import { createSessionBufferState } from './terminal-buffer';
import { createSessionHeadStore } from './session-head-store';

async function flushRender() {
  await vi.runAllTimersAsync();
}

describe('session-render-gate: in-place cell content change reprojection', () => {
  it('publishes lower daemon revisions after daemon restart instead of leaving stale rendered rows', async () => {
    vi.useFakeTimers();
    try {
      const liveBufferStore = createSessionBufferStore();
      const liveHeadStore = createSessionHeadStore();
      const gate = createSessionRenderGate({
        liveBufferStore,
        liveHeadStore,
        recordSessionRenderCommit: vi.fn(),
      });
      const renderStore = gate.getRenderStore();

      const makeRow = (charCode: number) => [
        { char: charCode, fg: 256, bg: 256, flags: 0, width: 1 } as const,
      ];

      liveBufferStore.setBuffer('s-reset', createSessionBufferState({
        lines: [makeRow(78)], // N
        startIndex: 0,
        endIndex: 1,
        bufferHeadStartIndex: 0,
        bufferTailEndIndex: 1,
        rows: 24,
        cols: 80,
        cacheLines: 1000,
        revision: 12,
      }));
      liveHeadStore.setHead('s-reset', { daemonHeadRevision: 12, daemonHeadEndIndex: 1 });
      gate.scheduleCommit('s-reset');
      await flushRender();

      expect(renderStore.getSnapshot('s-reset').buffer.revision).toBe(12);
      expect(renderStore.getSnapshot('s-reset').buffer.lines[0]![0]!.char).toBe(78);

      liveBufferStore.setBuffer('s-reset', createSessionBufferState({
        lines: [makeRow(82)], // R
        startIndex: 0,
        endIndex: 1,
        bufferHeadStartIndex: 0,
        bufferTailEndIndex: 1,
        rows: 24,
        cols: 80,
        cacheLines: 1000,
        revision: 3,
      }));
      liveHeadStore.setHead('s-reset', { daemonHeadRevision: 3, daemonHeadEndIndex: 1 });
      gate.scheduleCommit('s-reset');
      await flushRender();

      const afterRestart = renderStore.getSnapshot('s-reset').buffer;
      expect(afterRestart.revision).toBe(3);
      expect(afterRestart.daemonHeadRevision).toBe(3);
      expect(afterRestart.lines[0]![0]!.char).toBe(82);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not publish a lower buffer revision when daemon head truth did not reset', async () => {
    vi.useFakeTimers();
    try {
      const liveBufferStore = createSessionBufferStore();
      const liveHeadStore = createSessionHeadStore();
      const gate = createSessionRenderGate({
        liveBufferStore,
        liveHeadStore,
        recordSessionRenderCommit: vi.fn(),
      });
      const renderStore = gate.getRenderStore();

      const makeRow = (charCode: number) => [
        { char: charCode, fg: 256, bg: 256, flags: 0, width: 1 } as const,
      ];

      liveBufferStore.setBuffer('s-stale', createSessionBufferState({
        lines: [makeRow(78)], // N
        startIndex: 0,
        endIndex: 1,
        bufferHeadStartIndex: 0,
        bufferTailEndIndex: 1,
        rows: 24,
        cols: 80,
        cacheLines: 1000,
        revision: 12,
      }));
      liveHeadStore.setHead('s-stale', { daemonHeadRevision: 12, daemonHeadEndIndex: 1 });
      gate.scheduleCommit('s-stale');
      await flushRender();

      liveBufferStore.setBuffer('s-stale', createSessionBufferState({
        lines: [makeRow(79)], // O
        startIndex: 0,
        endIndex: 1,
        bufferHeadStartIndex: 0,
        bufferTailEndIndex: 1,
        rows: 24,
        cols: 80,
        cacheLines: 1000,
        revision: 11,
      }));
      liveHeadStore.setHead('s-stale', { daemonHeadRevision: 12, daemonHeadEndIndex: 1 });
      gate.scheduleCommit('s-stale');
      await flushRender();

      const stored = renderStore.getSnapshot('s-stale').buffer;
      expect(stored.revision).toBe(12);
      expect(stored.daemonHeadRevision).toBe(12);
      expect(stored.lines[0]![0]!.char).toBe(78);
    } finally {
      vi.useRealTimers();
    }
  });

  it('must reproject rowE when same absolute index gets new cell content (vim status line scenario)', async () => {
    vi.useFakeTimers();
    try {
      const liveBufferStore = createSessionBufferStore();
      const liveHeadStore = createSessionHeadStore();
      const recordRenderCommit = vi.fn();
      const gate = createSessionRenderGate({
        liveBufferStore,
        liveHeadStore,
        recordSessionRenderCommit: recordRenderCommit,
      });
      const renderStore = gate.getRenderStore();

      // Revision 1: rows [A, B, C, D, E]
      const makeRow = (charCode: number) => [
        { char: charCode, fg: 256, bg: 256, flags: 0, width: 1 } as const,
      ];
      const rA = makeRow(65); // 'A'
      const rB = makeRow(66);
      const rC = makeRow(67);
      const rD = makeRow(68);
      const rE = makeRow(69); // 'E'

      const buffer1 = createSessionBufferState({
        lines: [rA, rB, rC, rD, rE],
        startIndex: 0,
        endIndex: 5,
        bufferHeadStartIndex: 0,
        bufferTailEndIndex: 5,
        rows: 24,
        cols: 80,
        cacheLines: 1000,
        revision: 1,
      });

      liveBufferStore.setBuffer('s-tui', buffer1);
      liveHeadStore.setHead('s-tui', { daemonHeadRevision: 1, daemonHeadEndIndex: 5 });
      gate.scheduleCommit('s-tui');
      await flushRender();

      const snap1 = renderStore.getSnapshot('s-tui').buffer;
      expect(snap1.lines[4][0].char).toBe(69); // 'E'

      // Revision 2: same window [0,5], same absolute index 4,
      // but rowE now has new cell content ('X' instead of 'E')
      const rA2 = makeRow(65);
      const rB2 = makeRow(66);
      const rC2 = makeRow(67);
      const rD2 = makeRow(68);
      const rE2 = makeRow(88); // 'X' — changed

      const buffer2 = createSessionBufferState({
        lines: [rA2, rB2, rC2, rD2, rE2],
        startIndex: 0,
        endIndex: 5,
        bufferHeadStartIndex: 0,
        bufferTailEndIndex: 5,
        rows: 24,
        cols: 80,
        cacheLines: 1000,
        revision: 2,
      });

      liveBufferStore.setBuffer('s-tui', buffer2);
      liveHeadStore.setHead('s-tui', { daemonHeadRevision: 2, daemonHeadEndIndex: 5 });
      gate.scheduleCommit('s-tui');
      await flushRender();

      const snap2 = renderStore.getSnapshot('s-tui').buffer;

      // THE BUG UNDER TEST:
      // If projectRenderBuffer incorrectly reuses the rowE reference (because
      // rowsEqual() returns true for same-length arrays with same content, and
      // the new rowE2 reference is considered "equal" to old rowE), then
      // snap2.lines[4][0].char would still be 69 (stale 'E').
      // Correct behavior: snap2.lines[4][0].char must be 88 ('X')
      expect(snap2.lines[4][0].char).toBe(88);
      expect(snap2.revision).toBe(2);
      // Unchanged rows must stay correct
      expect(snap2.lines[0][0].char).toBe(65);
      expect(snap2.lines[1][0].char).toBe(66);
    } finally {
      vi.useRealTimers();
    }
  });

  it('must not reuse previous row reference when cell content differs', async () => {
    vi.useFakeTimers();
    try {
      const liveBufferStore = createSessionBufferStore();
      const liveHeadStore = createSessionHeadStore();
      const gate = createSessionRenderGate({
        liveBufferStore,
        liveHeadStore,
        recordSessionRenderCommit: vi.fn(),
      });
      const renderStore = gate.getRenderStore();

      const makeRow = (charCode: number) => [
        { char: charCode, fg: 256, bg: 256, flags: 0, width: 1 } as const,
      ];

      // Buffer v1
      const row0 = makeRow(48); // '0'
      const buffer1 = createSessionBufferState({
        lines: [row0],
        startIndex: 0,
        endIndex: 1,
        bufferHeadStartIndex: 0,
        bufferTailEndIndex: 1,
        rows: 24,
        cols: 80,
        cacheLines: 1000,
        revision: 1,
      });
      liveBufferStore.setBuffer('s-ref', buffer1);
      liveHeadStore.setHead('s-ref', { daemonHeadRevision: 1, daemonHeadEndIndex: 1 });
      gate.scheduleCommit('s-ref');
      await flushRender();
      const snap1 = renderStore.getSnapshot('s-ref').buffer;
      expect(snap1.lines[0][0].char).toBe(48);

      // Buffer v2: same array length, DIFFERENT cell content (different char)
      const row0_v2 = makeRow(88); // 'X'
      const buffer2 = createSessionBufferState({
        lines: [row0_v2],
        startIndex: 0,
        endIndex: 1,
        bufferHeadStartIndex: 0,
        bufferTailEndIndex: 1,
        rows: 24,
        cols: 80,
        cacheLines: 1000,
        revision: 2,
      });
      liveBufferStore.setBuffer('s-ref', buffer2);
      liveHeadStore.setHead('s-ref', { daemonHeadRevision: 2, daemonHeadEndIndex: 1 });
      gate.scheduleCommit('s-ref');
      await flushRender();
      const snap2 = renderStore.getSnapshot('s-ref').buffer;

      // If rowsEqual compares cell-by-cell, this should update correctly
      expect(snap2.lines[0][0].char).toBe(88);
    } finally {
      vi.useRealTimers();
    }
  });
});
