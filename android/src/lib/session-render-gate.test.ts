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

  it('reuses committed render lines when only daemon head metadata changes', async () => {
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
      const beforeLines = before.lines;
      const beforeRow0 = before.lines[0];
      const beforeRow1 = before.lines[1];

      liveHeadStore.setHead('session-1', { daemonHeadRevision: 4, daemonHeadEndIndex: 20 });
      gate.scheduleCommit('session-1');
      await flushScheduledRenderCommit();

      const after = renderStore.getSnapshot('session-1').buffer;
      expect(after.daemonHeadRevision).toBe(4);
      expect(after.daemonHeadEndIndex).toBe(20);
      expect(after.lines).toBe(beforeLines);
      expect(after.lines[0]).toBe(beforeRow0);
      expect(after.lines[1]).toBe(beforeRow1);
      expect(recordSessionRenderCommit).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses the last projected buffer when the live buffer reference is unchanged', async () => {
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
      expect(after.lines).toBe(before.lines);
      expect(after.gapRanges).toBe(before.gapRanges);
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

  it('falls back to timeout flushing when requestAnimationFrame is stalled', async () => {
    vi.useFakeTimers();
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const originalCancelAnimationFrame = window.cancelAnimationFrame;
    try {
      let nextFrameId = 0;
      const pendingFrames = new Map<number, FrameRequestCallback>();
      window.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
        nextFrameId += 1;
        pendingFrames.set(nextFrameId, callback);
        return nextFrameId;
      });
      window.cancelAnimationFrame = vi.fn((id: number) => {
        pendingFrames.delete(id);
      });

      const liveBufferStore = createSessionBufferStore();
      const liveHeadStore = createSessionHeadStore();
      const recordSessionRenderCommit = vi.fn();
      const gate = createSessionRenderGate({ liveBufferStore, liveHeadStore, recordSessionRenderCommit });
      const renderStore = gate.getRenderStore();

      liveBufferStore.setBuffer('session-1', makeBuffer(['alpha'], 1));
      liveHeadStore.setHead('session-1', { daemonHeadRevision: 1, daemonHeadEndIndex: 1 });
      gate.scheduleCommit('session-1');

      await vi.advanceTimersByTimeAsync(40);

      expect(renderStore.getSnapshot('session-1').buffer.lines).toEqual(makeBuffer(['alpha'], 1).lines);
      expect(recordSessionRenderCommit).toHaveBeenCalledTimes(1);
      expect(pendingFrames.size).toBe(0);
    } finally {
      window.requestAnimationFrame = originalRequestAnimationFrame;
      window.cancelAnimationFrame = originalCancelAnimationFrame;
      vi.useRealTimers();
    }
  });
});
