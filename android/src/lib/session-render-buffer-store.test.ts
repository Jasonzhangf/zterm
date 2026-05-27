import { describe, expect, it } from 'vitest';
import { createSessionRenderBufferStore } from './session-render-buffer-store';
import type { SessionRenderBufferSnapshot, TerminalCell } from './types';

function makeCell(char: string): TerminalCell {
  return {
    char: char.codePointAt(0) || 32,
    fg: 256,
    bg: 256,
    flags: 0,
    width: 1,
  };
}

function makeSnapshot(lines: TerminalCell[][], revision: number): SessionRenderBufferSnapshot {
  return {
    lines,
    gapRanges: [],
    startIndex: 0,
    endIndex: lines.length,
    bufferHeadStartIndex: 0,
    bufferTailEndIndex: lines.length,
    daemonHeadRevision: revision,
    daemonHeadEndIndex: lines.length,
    cols: 80,
    rows: 24,
    cursorKeysApp: false,
    cursor: null,
    revision,
  };
}

describe('session-render-buffer-store', () => {
  it('does not publish again when render-gate reuses the exact same snapshot object', () => {
    const store = createSessionRenderBufferStore();
    const snapshot = makeSnapshot([[makeCell('a')]], 1);

    expect(store.setBuffer('s1', snapshot)).toBe(true);
    expect(store.setBuffer('s1', snapshot)).toBe(false);
    expect(store.getSnapshot('s1').revision).toBe(1);
  });

  it('treats render-gate snapshots as authoritative and does not deep-compare every cell on publish', () => {
    const store = createSessionRenderBufferStore();
    const first = makeSnapshot([[makeCell('a')], [makeCell('b')]], 1);
    expect(store.setBuffer('s1', first)).toBe(true);

    let charReads = 0;
    const expensiveCell = {} as TerminalCell;
    Object.defineProperties(expensiveCell, {
      char: {
        get() {
          charReads += 1;
          return 'c'.codePointAt(0) || 32;
        },
      },
      fg: { value: 256, enumerable: true },
      bg: { value: 256, enumerable: true },
      flags: { value: 0, enumerable: true },
      width: { value: 1, enumerable: true },
    });

    const second = makeSnapshot([[makeCell('a')], [expensiveCell]], 2);
    expect(store.setBuffer('s1', second)).toBe(true);
    expect(charReads).toBe(0);
    expect(store.getSnapshot('s1').buffer).not.toBe(second);
  });

  it('keeps an immutable render snapshot after publish even if the source snapshot mutates later', () => {
    const store = createSessionRenderBufferStore();
    const snapshot = makeSnapshot([[makeCell('a')], [makeCell('b')]], 1);

    expect(store.setBuffer('s1', snapshot)).toBe(true);

    snapshot.lines[0]![0]!.char = 'z'.codePointAt(0) || 32;
    snapshot.gapRanges.push({ startIndex: 1, endIndex: 2 });
    snapshot.cursor = { rowIndex: 3, col: 4, visible: true };

    const stored = store.getSnapshot('s1').buffer;
    expect(String.fromCodePoint(stored.lines[0]![0]!.char)).toBe('a');
    expect(stored.gapRanges).toHaveLength(0);
    expect(stored.cursor).toBeNull();
  });
});
