// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { createSessionBufferStore } from './session-buffer-store';
import { createSessionRenderGate } from './session-render-gate';
import { createSessionBufferState } from './terminal-buffer';
import { createSessionHeadStore } from './session-head-store';

function makeBuffer(lines: string[], revision: number) {
  return createSessionBufferState({
    lines,
    startIndex: 0,
    endIndex: lines.length,
    bufferHeadStartIndex: 0,
    bufferTailEndIndex: lines.length,
    rows: 24,
    cols: 80,
    cacheLines: 1000,
    revision,
  });
}

function cloneRow(row: ReturnType<typeof makeBuffer>['lines'][number]) {
  return row.map((cell) => ({ ...cell }));
}

async function flushScheduledRenderCommit() {
  await vi.runAllTimersAsync();
}

describe('session-render-gate', () => {
  it('publishes render snapshot on the next render frame commit', async () => {
    vi.useFakeTimers();
    try {
    const liveBufferStore = createSessionBufferStore();
    const liveHeadStore = createSessionHeadStore();
    const recordSessionRenderCommit = vi.fn();
    const gate = createSessionRenderGate({ liveBufferStore, liveHeadStore, recordSessionRenderCommit });
    const renderStore = gate.getRenderStore();

    liveBufferStore.setBuffer('session-1', makeBuffer(['alpha'], 1));
    liveHeadStore.setHead('session-1', { daemonHeadRevision: 1, daemonHeadEndIndex: 1 });
    expect(renderStore.getSnapshot('session-1').buffer.lines).toEqual([]);

    gate.scheduleCommit('session-1');
    await flushScheduledRenderCommit();
    expect(renderStore.getSnapshot('session-1').buffer.lines).toEqual(makeBuffer(['alpha'], 1).lines);
    expect(recordSessionRenderCommit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves render cadence with the scheduled session id', async () => {
    vi.useFakeTimers();
    try {
      const liveBufferStore = createSessionBufferStore();
      const liveHeadStore = createSessionHeadStore();
      const recordSessionRenderCommit = vi.fn();
      const resolveRenderCommitMs = vi.fn(() => 16);
      const gate = createSessionRenderGate({
        liveBufferStore,
        liveHeadStore,
        recordSessionRenderCommit,
        resolveRenderCommitMs,
      });

      liveBufferStore.setBuffer('session-fast', makeBuffer(['alpha'], 1));
      liveHeadStore.setHead('session-fast', { daemonHeadRevision: 1, daemonHeadEndIndex: 1 });
      gate.scheduleCommit('session-fast');

      expect(resolveRenderCommitMs).toHaveBeenCalledWith('session-fast');
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces burst commit requests and publishes the latest truth once per frame', async () => {
    vi.useFakeTimers();
    try {
    const liveBufferStore = createSessionBufferStore();
    const liveHeadStore = createSessionHeadStore();
    const recordSessionRenderCommit = vi.fn();
    const gate = createSessionRenderGate({ liveBufferStore, liveHeadStore, recordSessionRenderCommit });
    const renderStore = gate.getRenderStore();

    liveBufferStore.setBuffer('session-1', makeBuffer(['one'], 1));
    liveHeadStore.setHead('session-1', { daemonHeadRevision: 1, daemonHeadEndIndex: 1 });
    gate.scheduleCommit('session-1');
    liveBufferStore.setBuffer('session-1', makeBuffer(['one', 'two'], 2));
    liveHeadStore.setHead('session-1', { daemonHeadRevision: 2, daemonHeadEndIndex: 2 });
    gate.scheduleCommit('session-1');
    liveBufferStore.setBuffer('session-1', makeBuffer(['one', 'two', 'three'], 3));
    liveHeadStore.setHead('session-1', { daemonHeadRevision: 3, daemonHeadEndIndex: 3 });
    gate.scheduleCommit('session-1');

    await flushScheduledRenderCommit();
    const snapshot = renderStore.getSnapshot('session-1');
    expect(snapshot.buffer.revision).toBe(3);
    expect(snapshot.buffer.daemonHeadRevision).toBe(3);
    expect(snapshot.buffer.daemonHeadEndIndex).toBe(3);
    expect(snapshot.buffer.lines).toEqual(makeBuffer(['one', 'two', 'three'], 3).lines);
    expect(recordSessionRenderCommit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not publish a new render snapshot when only daemon head metadata changes without a body commit', async () => {
    vi.useFakeTimers();
    try {
    const liveBufferStore = createSessionBufferStore();
    const liveHeadStore = createSessionHeadStore();
    const recordSessionRenderCommit = vi.fn();
    const gate = createSessionRenderGate({ liveBufferStore, liveHeadStore, recordSessionRenderCommit });
    const renderStore = gate.getRenderStore();

    liveBufferStore.setBuffer('session-1', makeBuffer(['alpha'], 1));
    liveHeadStore.setHead('session-1', { daemonHeadRevision: 1, daemonHeadEndIndex: 1 });
    gate.scheduleCommit('session-1');
    await flushScheduledRenderCommit();

    liveHeadStore.setHead('session-1', { daemonHeadRevision: 2, daemonHeadEndIndex: 20 });
    await flushScheduledRenderCommit();
    const afterFlush = renderStore.getSnapshot('session-1').buffer;
    expect(afterFlush.daemonHeadRevision).toBe(1);
    expect(afterFlush.daemonHeadEndIndex).toBe(1);
    expect(recordSessionRenderCommit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps committed render rows semantically stable when only daemon head metadata changes', async () => {
    vi.useFakeTimers();
    try {
      const liveBufferStore = createSessionBufferStore();
      const liveHeadStore = createSessionHeadStore();
      const recordSessionRenderCommit = vi.fn();
      const gate = createSessionRenderGate({ liveBufferStore, liveHeadStore, recordSessionRenderCommit });
      const renderStore = gate.getRenderStore();

      liveBufferStore.setBuffer('session-1', makeBuffer(['alpha', 'beta'], 3));
      liveHeadStore.setHead('session-1', { daemonHeadRevision: 3, daemonHeadEndIndex: 2 });
      gate.scheduleCommit('session-1');
      await flushScheduledRenderCommit();

      const before = renderStore.getSnapshot('session-1').buffer;
      liveHeadStore.setHead('session-1', { daemonHeadRevision: 4, daemonHeadEndIndex: 20 });
      gate.scheduleCommit('session-1');
      await flushScheduledRenderCommit();

      const after = renderStore.getSnapshot('session-1').buffer;
      expect(after.daemonHeadRevision).toBe(4);
      expect(after.daemonHeadEndIndex).toBe(20);
      expect(after.lines).toEqual(before.lines);
      expect(after.gapRanges).toEqual(before.gapRanges);
      expect(after.cursor).toEqual(before.cursor);
      expect(before.lines[0]?.[0]?.bg).toBe(256);
      expect(recordSessionRenderCommit).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not emit a new render snapshot when the live buffer truth is unchanged', async () => {
    vi.useFakeTimers();
    try {
      const liveBufferStore = createSessionBufferStore();
      const liveHeadStore = createSessionHeadStore();
      const recordSessionRenderCommit = vi.fn();
      const gate = createSessionRenderGate({ liveBufferStore, liveHeadStore, recordSessionRenderCommit });
      const renderStore = gate.getRenderStore();

      liveBufferStore.setBuffer('session-1', makeBuffer(['alpha', 'beta'], 3));
      liveHeadStore.setHead('session-1', { daemonHeadRevision: 3, daemonHeadEndIndex: 2 });
      gate.scheduleCommit('session-1');
      await flushScheduledRenderCommit();

      const before = renderStore.getSnapshot('session-1').buffer;

      gate.scheduleCommit('session-1');
      await flushScheduledRenderCommit();

      const after = renderStore.getSnapshot('session-1').buffer;
      expect(after).toBe(before);
      expect(after.lines).toEqual(before.lines);
      expect(recordSessionRenderCommit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps committed render snapshot isolated from later live buffer updates until the next commit', async () => {
    vi.useFakeTimers();
    try {
    const liveBufferStore = createSessionBufferStore();
    const liveHeadStore = createSessionHeadStore();
    const recordSessionRenderCommit = vi.fn();
    const gate = createSessionRenderGate({ liveBufferStore, liveHeadStore, recordSessionRenderCommit });
    const renderStore = gate.getRenderStore();

    liveBufferStore.setBuffer('session-1', makeBuffer(['alpha'], 1));
    liveHeadStore.setHead('session-1', { daemonHeadRevision: 1, daemonHeadEndIndex: 1 });
    gate.scheduleCommit('session-1');
    await flushScheduledRenderCommit();

    const renderBeforeMutation = renderStore.getSnapshot('session-1').buffer;
    const updatedLiveBuffer = makeBuffer(['alpha'], 1);
    updatedLiveBuffer.lines[0]![0]!.bg = 1;

    const renderAfterLiveMutation = renderStore.getSnapshot('session-1').buffer;
    expect(renderBeforeMutation.lines[0]?.[0]?.bg).toBe(256);
    expect(renderAfterLiveMutation.lines[0]?.[0]?.bg).toBe(256);

    liveBufferStore.setBuffer('session-1', updatedLiveBuffer);
    gate.scheduleCommit('session-1');
    await flushScheduledRenderCommit();
    const renderAfterCommit = renderStore.getSnapshot('session-1').buffer;
    expect(renderAfterCommit.lines[0]?.[0]?.bg).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps committed render snapshot isolated when the same live buffer object is mutated after commit', async () => {
    vi.useFakeTimers();
    try {
      const liveBufferStore = createSessionBufferStore();
      const liveHeadStore = createSessionHeadStore();
      const recordSessionRenderCommit = vi.fn();
      const gate = createSessionRenderGate({ liveBufferStore, liveHeadStore, recordSessionRenderCommit });
      const renderStore = gate.getRenderStore();

      const liveBuffer = makeBuffer(['alpha', 'beta'], 1);
      liveBufferStore.commitBuffer('session-1', liveBuffer);
      liveHeadStore.setHead('session-1', { daemonHeadRevision: 1, daemonHeadEndIndex: 2 });
      gate.scheduleCommit('session-1');
      await flushScheduledRenderCommit();

      const committedBeforeMutation = renderStore.getSnapshot('session-1').buffer;
      expect(committedBeforeMutation.lines[0]?.[0]?.bg).toBe(256);
      expect(committedBeforeMutation.gapRanges).toEqual([]);
      expect(committedBeforeMutation.cursor).toBeNull();

      liveBuffer.lines[0]![0]!.bg = 2;
      liveBuffer.gapRanges.push({ startIndex: 1, endIndex: 2 });
      liveBuffer.cursor = { rowIndex: 1, col: 4, visible: true };

      const committedAfterMutation = renderStore.getSnapshot('session-1').buffer;
      expect(committedAfterMutation).toBe(committedBeforeMutation);
      expect(committedAfterMutation.lines[0]?.[0]?.bg).toBe(256);
      expect(committedAfterMutation.gapRanges).toEqual([]);
      expect(committedAfterMutation.cursor).toBeNull();

      gate.scheduleCommit('session-1');
      await flushScheduledRenderCommit();

      const committedAfterNextFrame = renderStore.getSnapshot('session-1').buffer;
      expect(committedAfterNextFrame.lines[0]?.[0]?.bg).toBe(2);
      expect(committedAfterNextFrame.gapRanges).toEqual([{ startIndex: 1, endIndex: 2 }]);
      expect(committedAfterNextFrame.cursor).toEqual({ rowIndex: 1, col: 4, visible: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps committed render rows isolated when the same live row object is reused across later patches', async () => {
    vi.useFakeTimers();
    try {
      const liveBufferStore = createSessionBufferStore();
      const liveHeadStore = createSessionHeadStore();
      const recordSessionRenderCommit = vi.fn();
      const gate = createSessionRenderGate({ liveBufferStore, liveHeadStore, recordSessionRenderCommit });
      const renderStore = gate.getRenderStore();

      const base = makeBuffer(['alpha', 'beta'], 1);
      liveBufferStore.commitBuffer('session-1', base);
      liveHeadStore.setHead('session-1', { daemonHeadRevision: 1, daemonHeadEndIndex: 2 });
      gate.scheduleCommit('session-1');
      await flushScheduledRenderCommit();

      const committedBeforePatch = renderStore.getSnapshot('session-1').buffer;
      const reusedRow = base.lines[0]!;
      const next = {
        ...base,
        lines: [reusedRow, base.lines[1]!],
        revision: 2,
      };
      liveBufferStore.commitBuffer('session-1', next);
      reusedRow[0]!.fg = 3;

      expect(committedBeforePatch.lines[0]?.[0]?.fg).toBe(256);

      gate.scheduleCommit('session-1');
      await flushScheduledRenderCommit();

      const committedAfterPatch = renderStore.getSnapshot('session-1').buffer;
      expect(committedAfterPatch.lines[0]?.[0]?.fg).toBe(3);
      expect(committedBeforePatch.lines[0]?.[0]?.fg).toBe(256);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses unchanged projected rows across later patches so split panes do not pay full-row clone cost again', async () => {
    vi.useFakeTimers();
    try {
      const liveBufferStore = createSessionBufferStore();
      const liveHeadStore = createSessionHeadStore();
      const recordSessionRenderCommit = vi.fn();
      const gate = createSessionRenderGate({ liveBufferStore, liveHeadStore, recordSessionRenderCommit });
      const renderStore = gate.getRenderStore();

      const base = makeBuffer(['alpha', 'beta', 'gamma'], 1);
      liveBufferStore.commitBuffer('session-1', base);
      liveHeadStore.setHead('session-1', { daemonHeadRevision: 1, daemonHeadEndIndex: 3 });
      gate.scheduleCommit('session-1');
      await flushScheduledRenderCommit();

      const first = renderStore.getSnapshot('session-1').buffer;
      const unchangedRow0 = first.lines[0];
      const unchangedRow2 = first.lines[2];
      const replacementRow1 = cloneRow(makeBuffer(['BETA!'], 2).lines[0]!);

      const patched = {
        ...base,
        lines: [base.lines[0]!, replacementRow1, base.lines[2]!],
        revision: 2,
      };
      liveBufferStore.commitBuffer('session-1', patched);
      liveHeadStore.setHead('session-1', { daemonHeadRevision: 2, daemonHeadEndIndex: 3 });
      gate.scheduleCommit('session-1');
      await flushScheduledRenderCommit();

      const second = renderStore.getSnapshot('session-1').buffer;
      expect(second.lines[0]).toBe(unchangedRow0);
      expect(second.lines[2]).toBe(unchangedRow2);
      expect(second.lines[1]).not.toBe(first.lines[1]);
      expect(second.lines[1]?.[0]?.char).toBe('B'.codePointAt(0));
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses requestAnimationFrame after the per-session debounce when requestAnimationFrame exists', async () => {
    vi.useFakeTimers();
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const originalCancelAnimationFrame = window.cancelAnimationFrame;
    try {
      const rafSpy = vi.fn((callback: FrameRequestCallback) => {
        setTimeout(() => callback(Date.now()), 0);
        return 1;
      });
      const cafSpy = vi.fn();
      window.requestAnimationFrame = rafSpy;
      window.cancelAnimationFrame = cafSpy;

      const liveBufferStore = createSessionBufferStore();
      const liveHeadStore = createSessionHeadStore();
      const recordSessionRenderCommit = vi.fn();
      const gate = createSessionRenderGate({
        liveBufferStore,
        liveHeadStore,
        recordSessionRenderCommit,
        resolveRenderCommitMs: () => 33,
      });
      const renderStore = gate.getRenderStore();

      liveBufferStore.setBuffer('session-1', makeBuffer(['alpha'], 1));
      liveHeadStore.setHead('session-1', { daemonHeadRevision: 1, daemonHeadEndIndex: 1 });
      gate.scheduleCommit('session-1');

      expect(rafSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(32);
      expect(recordSessionRenderCommit).toHaveBeenCalledTimes(0);
      expect(renderStore.getSnapshot('session-1').buffer.lines).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(rafSpy).toHaveBeenCalledTimes(1);
      await vi.runAllTimersAsync();
      expect(recordSessionRenderCommit).toHaveBeenCalledTimes(1);
      expect(renderStore.getSnapshot('session-1').buffer.lines).toEqual(makeBuffer(['alpha'], 1).lines);
      expect(cafSpy).not.toHaveBeenCalled();
    } finally {
      window.requestAnimationFrame = originalRequestAnimationFrame;
      window.cancelAnimationFrame = originalCancelAnimationFrame;
      vi.useRealTimers();
    }
  });

  it('uses timer fallback when requestAnimationFrame is unavailable', async () => {
    vi.useFakeTimers();
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const originalCancelAnimationFrame = window.cancelAnimationFrame;
    try {
      // @ts-expect-error test explicit no-RAF environment case
      window.requestAnimationFrame = undefined;
      // @ts-expect-error test explicit no-RAF environment case
      window.cancelAnimationFrame = undefined;

      const liveBufferStore = createSessionBufferStore();
      const liveHeadStore = createSessionHeadStore();
      const recordSessionRenderCommit = vi.fn();
      const gate = createSessionRenderGate({
        liveBufferStore,
        liveHeadStore,
        recordSessionRenderCommit,
        resolveRenderCommitMs: () => 66,
      });
      const renderStore = gate.getRenderStore();

      liveBufferStore.setBuffer('session-1', makeBuffer(['alpha'], 1));
      liveHeadStore.setHead('session-1', { daemonHeadRevision: 1, daemonHeadEndIndex: 1 });
      gate.scheduleCommit('session-1');

      await vi.advanceTimersByTimeAsync(65);
      expect(recordSessionRenderCommit).toHaveBeenCalledTimes(0);
      expect(renderStore.getSnapshot('session-1').buffer.lines).toEqual([]);

      // debounce timer fires (66ms) -> RAF fallback (16ms) -> flush at 82ms total
      await vi.advanceTimersByTimeAsync(17);
      expect(recordSessionRenderCommit).toHaveBeenCalledTimes(1);
      expect(renderStore.getSnapshot('session-1').buffer.lines).toEqual(makeBuffer(['alpha'], 1).lines);
    } finally {
      window.requestAnimationFrame = originalRequestAnimationFrame;
      window.cancelAnimationFrame = originalCancelAnimationFrame;
      vi.useRealTimers();
    }
  });

  it('uses 16ms fast lane before RAF enrollment when render cadence resolver returns 16ms', async () => {
    vi.useFakeTimers();
    try {
      const liveBufferStore = createSessionBufferStore();
      const liveHeadStore = createSessionHeadStore();
      const recordSessionRenderCommit = vi.fn();
      const gate = createSessionRenderGate({
        liveBufferStore,
        liveHeadStore,
        recordSessionRenderCommit,
        resolveRenderCommitMs: () => 16,
      });
      const renderStore = gate.getRenderStore();

      liveBufferStore.setBuffer('session-1', makeBuffer(['fast'], 1));
      liveHeadStore.setHead('session-1', { daemonHeadRevision: 1, daemonHeadEndIndex: 1 });
      gate.scheduleCommit('session-1');

      await vi.advanceTimersByTimeAsync(15);
      expect(recordSessionRenderCommit).toHaveBeenCalledTimes(0);
      // debounce fires at 16ms, then RAF callback runs (jsdom default uses setTimeout(16))
      await vi.runAllTimersAsync();
      expect(recordSessionRenderCommit).toHaveBeenCalledTimes(1);
      expect(renderStore.getSnapshot('session-1').buffer.lines).toEqual(makeBuffer(['fast'], 1).lines);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('P4 global RAF coalescing', () => {
  it('uses a single requestAnimationFrame tick for multiple dirty sessions in the same frame', async () => {
    vi.useFakeTimers();
    try {
      const liveBufferStore = createSessionBufferStore();
      const liveHeadStore = createSessionHeadStore();
      const recordSessionRenderCommit = vi.fn();
      const gate = createSessionRenderGate({ liveBufferStore, liveHeadStore, recordSessionRenderCommit });
      const renderStore = gate.getRenderStore();

      // Install RAF spy. Current implementation uses per-session setTimeout only,
      // so this test fails until a global RAF coalescing layer is added.
      const rafSpy = vi.fn((cb: FrameRequestCallback) => {
        setTimeout(() => cb(Date.now()), 0);
        return 1;
      });
      const originalRaf = globalThis.requestAnimationFrame;
      // @ts-ignore
      globalThis.requestAnimationFrame = rafSpy;
      try {
        for (const sessionId of ['s1', 's2', 's3', 's4']) {
          liveBufferStore.setBuffer(sessionId, makeBuffer([sessionId], 1));
          liveHeadStore.setHead(sessionId, { daemonHeadRevision: 1, daemonHeadEndIndex: 1 });
          gate.scheduleCommit(sessionId);
        }

        await flushScheduledRenderCommit();

        // Expect exactly one RAF for the batch, not 4 per-session timers.
        expect(rafSpy).toHaveBeenCalledTimes(1);
        expect(recordSessionRenderCommit).toHaveBeenCalledTimes(4);
        expect(renderStore.getSnapshot('s1').buffer.lines).toEqual(makeBuffer(['s1'], 1).lines);
        expect(renderStore.getSnapshot('s4').buffer.lines).toEqual(makeBuffer(['s4'], 1).lines);
      } finally {
        globalThis.requestAnimationFrame = originalRaf;
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces follow-up dirty writes into the next RAF only once', async () => {
    vi.useFakeTimers();
    try {
      const liveBufferStore = createSessionBufferStore();
      const liveHeadStore = createSessionHeadStore();
      const recordSessionRenderCommit = vi.fn();
      const gate = createSessionRenderGate({ liveBufferStore, liveHeadStore, recordSessionRenderCommit });

      const rafSpy = vi.fn((cb: FrameRequestCallback) => {
        setTimeout(() => cb(Date.now()), 0);
        return 1;
      });
      const originalRaf = globalThis.requestAnimationFrame;
      // @ts-ignore
      globalThis.requestAnimationFrame = rafSpy;
      try {
        liveBufferStore.setBuffer('s1', makeBuffer(['one'], 1));
        liveHeadStore.setHead('s1', { daemonHeadRevision: 1, daemonHeadEndIndex: 1 });
        gate.scheduleCommit('s1');
        liveBufferStore.setBuffer('s2', makeBuffer(['two'], 1));
        liveHeadStore.setHead('s2', { daemonHeadRevision: 1, daemonHeadEndIndex: 1 });
        gate.scheduleCommit('s2');

        await flushScheduledRenderCommit();

        // New dirty after first frame
        liveBufferStore.setBuffer('s1', makeBuffer(['one', 'one'], 2));
        liveHeadStore.setHead('s1', { daemonHeadRevision: 2, daemonHeadEndIndex: 2 });
        gate.scheduleCommit('s1');
        liveBufferStore.setBuffer('s2', makeBuffer(['two', 'two'], 2));
        liveHeadStore.setHead('s2', { daemonHeadRevision: 2, daemonHeadEndIndex: 2 });
        gate.scheduleCommit('s2');

        await flushScheduledRenderCommit();

        expect(rafSpy).toHaveBeenCalledTimes(2);
      } finally {
        globalThis.requestAnimationFrame = originalRaf;
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
