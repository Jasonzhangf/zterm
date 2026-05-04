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

describe('session-render-gate', () => {
  it('keeps render snapshot detached from live buffer until frame commit', () => {
    vi.useFakeTimers();
    const liveBufferStore = createSessionBufferStore();
    const liveHeadStore = createSessionHeadStore();
    const recordSessionRenderCommit = vi.fn();
    const gate = createSessionRenderGate({ liveBufferStore, liveHeadStore, recordSessionRenderCommit });
    const renderStore = gate.getRenderStore();

    liveBufferStore.setBuffer('session-1', makeBuffer(['alpha'], 1));
    liveHeadStore.setHead('session-1', { daemonHeadRevision: 1, daemonHeadEndIndex: 1 });
    expect(renderStore.getSnapshot('session-1').buffer.lines).toEqual([]);

    gate.scheduleCommit('session-1');
    expect(renderStore.getSnapshot('session-1').buffer.lines).toEqual([]);

    vi.runAllTimers();

    expect(renderStore.getSnapshot('session-1').buffer.lines).toEqual(makeBuffer(['alpha'], 1).lines);
    expect(recordSessionRenderCommit).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('coalesces multiple live buffer writes into one visible frame commit and publishes latest truth', () => {
    vi.useFakeTimers();
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

    expect(recordSessionRenderCommit).toHaveBeenCalledTimes(0);
    expect(renderStore.getSnapshot('session-1').buffer.lines).toEqual([]);

    vi.runAllTimers();

    const snapshot = renderStore.getSnapshot('session-1');
    expect(snapshot.buffer.revision).toBe(3);
    expect(snapshot.buffer.daemonHeadRevision).toBe(3);
    expect(snapshot.buffer.daemonHeadEndIndex).toBe(3);
    expect(snapshot.buffer.lines).toEqual(makeBuffer(['one', 'two', 'three'], 3).lines);
    expect(recordSessionRenderCommit).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('does not publish live head early before the frame commit', () => {
    vi.useFakeTimers();
    const liveBufferStore = createSessionBufferStore();
    const liveHeadStore = createSessionHeadStore();
    const recordSessionRenderCommit = vi.fn();
    const gate = createSessionRenderGate({ liveBufferStore, liveHeadStore, recordSessionRenderCommit });
    const renderStore = gate.getRenderStore();

    liveBufferStore.setBuffer('session-1', makeBuffer(['alpha'], 1));
    liveHeadStore.setHead('session-1', { daemonHeadRevision: 1, daemonHeadEndIndex: 1 });
    gate.scheduleCommit('session-1');
    vi.runAllTimers();

    liveHeadStore.setHead('session-1', { daemonHeadRevision: 2, daemonHeadEndIndex: 20 });
    gate.scheduleCommit('session-1');
    const beforeFlush = renderStore.getSnapshot('session-1').buffer;
    expect(beforeFlush.daemonHeadRevision).toBe(1);
    expect(beforeFlush.daemonHeadEndIndex).toBe(1);
    expect(beforeFlush.lines).toEqual(makeBuffer(['alpha'], 1).lines);

    vi.runAllTimers();

    const afterFlush = renderStore.getSnapshot('session-1').buffer;
    expect(afterFlush.daemonHeadRevision).toBe(2);
    expect(afterFlush.daemonHeadEndIndex).toBe(20);
    expect(recordSessionRenderCommit).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('keeps committed render snapshot isolated from later live buffer mutations until the next frame commit', () => {
    vi.useFakeTimers();
    const liveBufferStore = createSessionBufferStore();
    const liveHeadStore = createSessionHeadStore();
    const recordSessionRenderCommit = vi.fn();
    const gate = createSessionRenderGate({ liveBufferStore, liveHeadStore, recordSessionRenderCommit });
    const renderStore = gate.getRenderStore();

    liveBufferStore.setBuffer('session-1', makeBuffer(['alpha'], 1));
    liveHeadStore.setHead('session-1', { daemonHeadRevision: 1, daemonHeadEndIndex: 1 });
    gate.scheduleCommit('session-1');
    vi.runAllTimers();

    const liveSnapshot = liveBufferStore.getSnapshot('session-1').buffer;
    const renderBeforeMutation = renderStore.getSnapshot('session-1').buffer;
    liveSnapshot.lines[0]![0]!.bg = 1;

    const renderAfterLiveMutation = renderStore.getSnapshot('session-1').buffer;
    expect(renderBeforeMutation.lines[0]?.[0]?.bg).toBe(256);
    expect(renderAfterLiveMutation.lines[0]?.[0]?.bg).toBe(256);

    gate.scheduleCommit('session-1');
    vi.runAllTimers();

    const renderAfterCommit = renderStore.getSnapshot('session-1').buffer;
    expect(renderAfterCommit.lines[0]?.[0]?.bg).toBe(1);
    vi.useRealTimers();
  });
});
