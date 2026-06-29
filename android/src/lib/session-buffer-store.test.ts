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

  it('commitBuffer publishes same-object content changes and isolates the stored snapshot', () => {
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

    buffer.lines[0]![0]!.char = 'z'.codePointAt(0)!;
    buffer.revision = 2;

    expect(store.commitBuffer('s1', buffer)).toBe(true);
    expect(String.fromCodePoint(store.getSnapshot('s1').buffer.lines[0]?.[0]?.char || 32)).toBe('z');

    buffer.lines[0]![0]!.char = 'x'.codePointAt(0)!;
    expect(String.fromCodePoint(store.getSnapshot('s1').buffer.lines[0]?.[0]?.char || 32)).toBe('z');
  });
});
