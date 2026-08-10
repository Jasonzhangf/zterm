import { describe, expect, it } from 'vitest';
import { createSessionBufferStore } from './session-buffer-store';
import { createSessionBufferState } from './terminal-buffer';

describe('session-buffer-store', () => {
  it('isolates committed snapshots from later caller-side mutations', () => {
    const store = createSessionBufferStore();
    const buffer = createSessionBufferState({
      lines: ['abc'],
      cols: 80,
      rows: 24,
      cacheLines: 100,
      revision: 1,
    });

    store.setBuffer('s1', buffer);
    expect(String.fromCodePoint(store.getSnapshot('s1').buffer.lines[0]?.[0]?.char || 32)).toBe('a');

    buffer.lines[0]![0]!.char = 'z'.codePointAt(0)!;
    buffer.gapRanges.push({ startIndex: 0, endIndex: 1 });

    const committed = store.getSnapshot('s1').buffer;
    expect(String.fromCodePoint(committed.lines[0]?.[0]?.char || 32)).toBe('a');
    expect(committed.gapRanges).toEqual([]);
  });

  it('commitBuffer publishes same-object content changes and isolates structural mutations', () => {
    const store = createSessionBufferStore();
    const buffer = createSessionBufferState({
      lines: ['abc'],
      cols: 80,
      rows: 24,
      cacheLines: 100,
      revision: 1,
    });

    expect(store.commitBuffer('s1', buffer)).toBe(true);
    expect(store.getSnapshot('s1').buffer).not.toBe(buffer);
    expect(store.commitBuffer('s1', buffer)).toBe(false);

    // 结构隔离：调用方替换行数组（新行引用）不污染快照
    buffer.lines = [createSessionBufferState({ lines: ['xyz'], cols: 80, rows: 24, cacheLines: 100 }).lines[0]!];
    buffer.revision = 2;

    expect(store.commitBuffer('s1', buffer)).toBe(true);
    expect(String.fromCodePoint(store.getSnapshot('s1').buffer.lines[0]?.[0]?.char || 32)).toBe('x');
  });

  it('reuses unchanged row references across commits (perf contract: no full deep clone)', () => {
    const store = createSessionBufferStore();
    const buffer = createSessionBufferState({
      lines: ['ab', 'cd'],
      cols: 80,
      rows: 24,
      cacheLines: 100,
      revision: 1,
    });

    expect(store.commitBuffer('s1', buffer)).toBe(true);
    const first = store.getSnapshot('s1').buffer;

    // 模拟 immutable apply：只有第二行替换为新引用，第一行保持同一引用
    const next = createSessionBufferState({
      lines: [first.lines[0]!, [{ char: 120, fg: 7, bg: 0, flags: 0, width: 1 }, { char: 121, fg: 7, bg: 0, flags: 0, width: 1 }]],
      cols: 80,
      rows: 24,
      cacheLines: 100,
      revision: 2,
    });
    expect(store.commitBuffer('s1', next)).toBe(true);

    const second = store.getSnapshot('s1').buffer;
    // 未变行必须复用引用（行级不变性，供下游 render memo / signature 缓存使用）
    expect(second.lines[0]).toBe(first.lines[0]);
    // 变化行得到新引用（已隔离）
    expect(second.lines[1]).not.toBe(first.lines[1]);
  });

  it('commitBuffer with skipEqualCheck skips the redundant equality comparison', () => {
    const store = createSessionBufferStore();
    const buffer = createSessionBufferState({
      lines: ['abc'],
      cols: 80,
      rows: 24,
      cacheLines: 100,
      revision: 1,
    });

    expect(store.commitBuffer('s1', buffer)).toBe(true);
    // 调用方（session-context-buffer-runtime）已在 commit 前做过全量比较，
    // skipEqualCheck 时 store 不得再做第二次 O(rows×cols) 比较：内容未变也返回 true 并发布。
    expect(store.commitBuffer('s1', buffer, { skipEqualCheck: true })).toBe(true);
    // store 快照计数必须 +1（skipEqualCheck 跳过比较直接发布）
    expect(store.getSnapshot('s1').revision).toBe(2);
  });
});
